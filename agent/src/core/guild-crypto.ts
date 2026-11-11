import crypto from "node:crypto";
import { getSecret, setSecret } from "./secrets.js";

/**
 * Chiffrement de bout en bout de la Guilde (spec relais §4) : clé X25519 PAR APPAREIL (privée dans le coffre Windows),
 * scellement façon HPKE « base » : clé éphémère X25519, ECDH avec la clé de l'appareil destinataire, HKDF-SHA256
 * (info « mcf-guild-v1 », sel = clé éphémère ‖ clé destinataire), AES-256-GCM avec données associées = id de la demande
 * ‖ sens. Un message rejoué dans une autre demande, ou dans l'autre sens, ne s'ouvre pas.
 * Format : éphémère (32 o) ‖ nonce (12 o) ‖ chiffré ‖ étiquette (16 o), en base64url.
 */

const SECRET = "guild_device_key";
const INFO = Buffer.from("mcf-guild-v1");
const RAW_PREFIX = Buffer.from("302e020100300506032b656e04220420", "hex"); // PKCS#8 X25519
const SPKI_PREFIX = Buffer.from("302a300506032b656e032100", "hex");

export type Direction = "payload" | "answer";

export interface DeviceKeys {
  privateKey: crypto.KeyObject;
  /** Clé publique brute (32 octets) en base64url : envoyée au relais. */
  publicKey: string;
}

const pub = (raw: Buffer) => crypto.createPublicKey({ key: Buffer.concat([SPKI_PREFIX, raw]), format: "der", type: "spki" });
const rawPublic = (k: crypto.KeyObject) => k.export({ format: "der", type: "spki" }).subarray(SPKI_PREFIX.length);

function fromPrivate(raw: Buffer): DeviceKeys {
  const privateKey = crypto.createPrivateKey({ key: Buffer.concat([RAW_PREFIX, raw]), format: "der", type: "pkcs8" });
  return { privateKey, publicKey: rawPublic(crypto.createPublicKey(privateKey)).toString("base64url") };
}

export function generateDeviceKeys(): DeviceKeys {
  const { privateKey } = crypto.generateKeyPairSync("x25519");
  const raw = privateKey.export({ format: "der", type: "pkcs8" }).subarray(RAW_PREFIX.length);
  return fromPrivate(Buffer.from(raw));
}

/** Clé de cet appareil : créée au premier usage, gardée dans le coffre Windows (jamais sur disque en clair). */
export function deviceKeys(store = { get: () => getSecret(SECRET), set: (v: string) => setSecret(SECRET, v) }): DeviceKeys {
  const saved = store.get();
  if (saved) return fromPrivate(Buffer.from(saved, "base64url"));
  const k = generateDeviceKeys();
  const raw = k.privateKey.export({ format: "der", type: "pkcs8" }).subarray(RAW_PREFIX.length);
  store.set(Buffer.from(raw).toString("base64url"));
  return k;
}

/** Empreinte d'une clé publique, à comparer à l'oral entre membres (parade à un relais qui substituerait les clés). */
export function fingerprint(publicKey: string): string {
  const h = crypto.createHash("sha256").update(Buffer.from(publicKey, "base64url")).digest("hex").slice(0, 20).toUpperCase();
  return h.match(/.{4}/g)!.join(" ");
}

function key(shared: Buffer, eph: Buffer, recipient: Buffer) {
  return Buffer.from(crypto.hkdfSync("sha256", shared, Buffer.concat([eph, recipient]), INFO, 32));
}

const aad = (id: string, dir: Direction) => Buffer.from(`${id}\u0000${dir}`);

export function seal(text: string, recipientPublicKey: string, id: string, dir: Direction): string {
  const recipient = Buffer.from(recipientPublicKey, "base64url");
  if (recipient.length !== 32) throw new Error("clé de l'appareil destinataire invalide");
  const e = crypto.generateKeyPairSync("x25519");
  const eph = rawPublic(e.publicKey);
  const shared = crypto.diffieHellman({ privateKey: e.privateKey, publicKey: pub(recipient) });
  const nonce = crypto.randomBytes(12);
  const c = crypto.createCipheriv("aes-256-gcm", key(shared, eph, recipient), nonce);
  c.setAAD(aad(id, dir));
  const body = Buffer.concat([c.update(text, "utf8"), c.final(), c.getAuthTag()]);
  return Buffer.concat([eph, nonce, body]).toString("base64url");
}

export function open(sealed: string, keys: DeviceKeys, id: string, dir: Direction): string {
  const buf = Buffer.from(sealed, "base64url");
  if (buf.length < 32 + 12 + 16) throw new Error("message scellé trop court");
  const eph = buf.subarray(0, 32);
  const nonce = buf.subarray(32, 44);
  const body = buf.subarray(44, buf.length - 16);
  const tag = buf.subarray(buf.length - 16);
  const recipient = Buffer.from(keys.publicKey, "base64url");
  const shared = crypto.diffieHellman({ privateKey: keys.privateKey, publicKey: pub(eph) });
  const d = crypto.createDecipheriv("aes-256-gcm", key(shared, eph, recipient), nonce);
  d.setAAD(aad(id, dir));
  d.setAuthTag(tag);
  try {
    return Buffer.concat([d.update(body), d.final()]).toString("utf8");
  } catch {
    throw new Error("message scellé illisible (mauvaise clé, demande ou sens)");
  }
}
