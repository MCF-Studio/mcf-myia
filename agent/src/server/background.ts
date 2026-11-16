import crypto from "node:crypto";
import fs from "node:fs";
import path from "node:path";
import { paths } from "../core/paths.js";

/**
 * Image de fond de l'app (PNG, JPEG, WebP ou GIF animé).
 * L'image choisie est COPIÉE dans data/backgrounds/ : l'app ne dépend pas du fichier d'origine (déplacé, supprimé)
 * et le sidecar ne relit jamais un chemin arbitraire après le choix. Le type est reconnu à la signature du fichier,
 * pas à son extension : un fichier qui n'est pas une image est refusé, ce qui empêche de s'en servir pour lire
 * autre chose. L'image est rendue à l'interface en data: URL (la CSP n'autorise que 'self' et data: pour les images).
 */

/** 12 Mo : un GIF animé raisonnable ; au-delà, la data: URL (≈ +33 %) alourdit trop le passage par le relais. */
export const MAX_BACKGROUND_BYTES = 12 * 1024 * 1024;

const TYPES = [
  { ext: "png", mime: "image/png", test: (b: Buffer) => b.subarray(0, 8).equals(Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a])) },
  { ext: "jpg", mime: "image/jpeg", test: (b: Buffer) => b[0] === 0xff && b[1] === 0xd8 && b[2] === 0xff },
  { ext: "gif", mime: "image/gif", test: (b: Buffer) => /^GIF8[79]a$/.test(b.subarray(0, 6).toString("latin1")) },
  {
    ext: "webp",
    mime: "image/webp",
    test: (b: Buffer) => b.subarray(0, 4).toString("latin1") === "RIFF" && b.subarray(8, 12).toString("latin1") === "WEBP",
  },
] as const;

const FILE_RE = /^wallpaper-[0-9a-f]{16}\.(png|jpg|gif|webp)$/;

const dir = () => path.join(paths.home, "data", "backgrounds");

function detect(head: Buffer) {
  return TYPES.find((t) => t.test(head));
}

/** Copie l'image choisie et remplace la précédente. Renvoie le nom du fichier stocké (à garder dans les réglages). */
export function setBackground(source: string): { file: string; mime: string; bytes: number } {
  if (!path.isAbsolute(source)) throw new Error("chemin d'image invalide");
  const st = fs.statSync(source, { throwIfNoEntry: false });
  if (!st?.isFile()) throw new Error("image introuvable");
  if (st.size > MAX_BACKGROUND_BYTES) throw new Error(`image trop lourde (${(st.size / 1048576).toFixed(1)} Mo, 12 Mo max)`);
  const data = fs.readFileSync(source);
  const type = detect(data.subarray(0, 16));
  if (!type) throw new Error("format non reconnu : PNG, JPEG, WebP ou GIF uniquement");

  fs.mkdirSync(dir(), { recursive: true });
  const file = `wallpaper-${crypto.randomBytes(8).toString("hex")}.${type.ext}`;
  const tmp = path.join(dir(), `${file}.tmp`);
  fs.writeFileSync(tmp, data);
  fs.renameSync(tmp, path.join(dir(), file));
  clearBackground(file);
  return { file, mime: type.mime, bytes: data.length };
}

/** L'image stockée en data: URL, ou null si elle n'existe plus (réglage d'une autre installation, fichier effacé). */
export function readBackground(file: string): { dataUrl: string } | null {
  if (!FILE_RE.test(file)) throw new Error("nom d'image invalide");
  const p = path.join(dir(), file);
  if (!fs.existsSync(p)) return null;
  const data = fs.readFileSync(p);
  const type = detect(data.subarray(0, 16));
  if (!type) return null;
  return { dataUrl: `data:${type.mime};base64,${data.toString("base64")}` };
}

/** Supprime les images de fond stockées, sauf `keep`. */
export function clearBackground(keep?: string) {
  if (!fs.existsSync(dir())) return;
  for (const f of fs.readdirSync(dir())) {
    if (f === keep) continue;
    if (FILE_RE.test(f) || /^wallpaper-[0-9a-f]{16}\.(png|jpg|gif|webp)\.tmp$/.test(f)) fs.rmSync(path.join(dir(), f), { force: true });
  }
}
