import { describe, expect, it, vi } from "vitest";

// Journal de la Guilde dans un dossier jetable (lu à l'import de paths.ts).
await vi.hoisted(async () => {
  const fs = await import("node:fs");
  const os = await import("node:os");
  const path = await import("node:path");
  process.env.MYIA_HOME = fs.mkdtempSync(path.join(os.tmpdir(), "myia-guilde-"));
});

const { fingerprint, generateDeviceKeys, open, seal } = await import("./guild-crypto.js");
const { GuildLink } = await import("./guild-link.js");
const { GuildSchema } = await import("./guild.js");
type SocketLike = import("./guild-link.js").SocketLike;
type Guild = import("./guild.js").Guild;

describe("chiffrement de bout en bout", () => {
  const dest = generateDeviceKeys();

  it("ouvre ce qui a été scellé pour cet appareil, cette demande et ce sens", () => {
    const s = seal("Bonjour la Guilde ✨", dest.publicKey, "demande-1", "payload");
    expect(open(s, dest, "demande-1", "payload")).toBe("Bonjour la Guilde ✨");
  });

  it("refuse un message rejoué dans une autre demande, dans l'autre sens, ou ouvert avec une autre clé", () => {
    const s = seal("secret", dest.publicKey, "demande-1", "payload");
    expect(() => open(s, dest, "demande-2", "payload")).toThrow(/illisible/);
    expect(() => open(s, dest, "demande-1", "answer")).toThrow(/illisible/);
    expect(() => open(s, generateDeviceKeys(), "demande-1", "payload")).toThrow(/illisible/);
    const tampered = Buffer.from(s, "base64url");
    tampered[50]! ^= 1;
    expect(() => open(tampered.toString("base64url"), dest, "demande-1", "payload")).toThrow(/illisible/);
  });

  it("donne une empreinte lisible et stable", () => {
    expect(fingerprint(dest.publicKey)).toMatch(/^[0-9A-F]{4}( [0-9A-F]{4}){4}$/);
    expect(fingerprint(dest.publicKey)).toBe(fingerprint(dest.publicKey));
  });
});

/** Faux relais : la socket du client, côté test. */
class FakeSocket implements SocketLike {
  readyState = 0;
  sent: Record<string, any>[] = [];
  onopen: SocketLike["onopen"] = null;
  onmessage: SocketLike["onmessage"] = null;
  onclose: SocketLike["onclose"] = null;
  onerror: SocketLike["onerror"] = null;
  send(data: string) {
    this.sent.push(JSON.parse(data));
  }
  close() {
    this.readyState = 3;
  }
  openNow() {
    this.readyState = 1;
    this.onopen?.({});
  }
  push(m: unknown) {
    this.onmessage?.({ data: JSON.stringify(m) });
  }
  async next(type: string): Promise<Record<string, any>> {
    for (let i = 0; i < 100; i++) {
      const at = this.sent.findIndex((m) => m.type === type);
      if (at >= 0) return this.sent.splice(at, 1)[0]!;
      await new Promise((r) => setTimeout(r, 10));
    }
    throw new Error(`« ${type} » attendu ; envoyé : ${JSON.stringify(this.sent)}`);
  }
}

const guild = (over: Record<string, unknown> = {}): Guild =>
  GuildSchema.parse({
    enabled: true,
    serve: "everyone",
    whitelist: [{ id: 1, name: "aroun" }],
    offers: [{ id: "relecture", name: "Relecture", model: "qwen3:8b", tags: ["texte"] }],
    auto: { enabled: true, whitelistOnly: true, from: "00:00", to: "00:00", gpuMax: 50 },
    ...over,
  });

async function setup(g: Guild) {
  const socket = new FakeSocket();
  const keys = generateDeviceKeys();
  const events: [string, unknown][] = [];
  const run = vi.fn(async (_o: unknown, text: string) => `relu : ${text}`);
  const link = new GuildLink({
    relayUrl: "wss://guilde.test/v1",
    keys,
    token: async () => "jeton-de-test",
    loadGuild: () => g,
    run,
    emit: (e, d) => events.push([e, d]),
    connect: () => socket,
    gpu: async () => 10,
    appVersion: "0.4.0",
  });
  link.start();
  await vi.waitFor(() => expect(socket.onopen).not.toBeNull());
  socket.openNow();
  expect(await socket.next("hello")).toMatchObject({ v: 1, token: "jeton-de-test", deviceKey: keys.publicKey, app: "myia/0.4.0" });
  socket.push({ type: "welcome", v: 1, member: { id: 7, name: "joaquine", certified: true }, device: 70, limits: {} });
  return { socket, keys, events, run, link };
}

const requester = generateDeviceKeys();
const aroun = { id: 1, name: "aroun", certified: true };
const ID = "demande-0000000000000001";

describe("lien avec le relais (fournisseur)", () => {
  it("publie ses offres (métadonnées seulement), se propose, traite en mode auto et répond chiffré", async () => {
    const { socket, keys, run, link } = await setup(guild());
    const offers = await socket.next("offers");
    expect(offers.items).toEqual([{ id: "relecture", name: "Relecture", tags: ["texte"], model: "qwen3:8b", certifiedOnly: false, maxSeconds: 120 }]);
    expect(JSON.stringify(offers)).not.toContain("instructions");

    socket.push({ type: "ask", id: ID, from: aroun, offerId: "relecture", size: 30 });
    expect(await socket.next("canDo")).toEqual({ type: "canDo", id: ID, offerId: "relecture" });

    socket.push({ type: "payload", id: ID, from: aroun, deviceKey: requester.publicKey, offerId: "relecture", sealed: seal("mon texte", keys.publicKey, ID, "payload") });
    const answer = await socket.next("answer");
    expect(open(answer.sealed, requester, ID, "answer")).toBe("relu : mon texte");
    expect(run).toHaveBeenCalledOnce();
    link.stop();
  });

  it("ne se propose pas quand ses règles refusent (Guilde coupée)", async () => {
    const { socket, link } = await setup(guild({ enabled: false }));
    expect((await socket.next("offers")).items).toEqual([]);
    socket.push({ type: "ask", id: ID, from: aroun, offerId: "relecture", size: 30 });
    await new Promise((r) => setTimeout(r, 50));
    expect(socket.sent.find((m) => m.type === "canDo")).toBeUndefined();
    link.stop();
  });

  it("hors mode auto : la demande attend la validation du propriétaire, puis part chiffrée", async () => {
    const { socket, keys, events, run, link } = await setup(guild({ auto: { enabled: false } }));
    socket.push({ type: "ask", id: ID, from: aroun, offerId: "relecture", size: 30 });
    await socket.next("canDo");
    socket.push({ type: "payload", id: ID, from: aroun, deviceKey: requester.publicKey, offerId: "relecture", sealed: seal("à valider", keys.publicKey, ID, "payload") });
    await vi.waitFor(() => expect(link.pendingList()).toHaveLength(1));
    expect(link.pendingList()[0]).toMatchObject({ id: ID, text: "à valider", from: { name: "aroun" }, offerName: "Relecture" });
    expect(events.some(([e]) => e === "guild.pending")).toBe(true);
    expect(run).not.toHaveBeenCalled();

    await link.accept(ID);
    const answer = await socket.next("answer");
    expect(open(answer.sealed, requester, ID, "answer")).toBe("relu : à valider");
    link.stop();
  });

  it("refuser une demande en attente prévient le demandeur ; une demande expirée disparaît", async () => {
    const { socket, keys, link } = await setup(guild({ auto: { enabled: false } }));
    for (const id of [ID, "demande-0000000000000002"]) {
      socket.push({ type: "ask", id, from: aroun, offerId: "relecture", size: 10 });
      await socket.next("canDo");
      socket.push({ type: "payload", id, from: aroun, deviceKey: requester.publicKey, offerId: "relecture", sealed: seal("x", keys.publicKey, id, "payload") });
    }
    await vi.waitFor(() => expect(link.pendingList()).toHaveLength(2));
    link.reject(ID, "pas ce soir");
    expect(await socket.next("refuse")).toEqual({ type: "refuse", id: ID, reason: "pas ce soir" });
    socket.push({ type: "expired", id: "demande-0000000000000002", reason: "délai dépassé" });
    await vi.waitFor(() => expect(link.pendingList()).toHaveLength(0));
    link.stop();
  });

  it("refuse un contenu qu'il ne peut pas ouvrir (scellé pour un autre appareil)", async () => {
    const { socket, link } = await setup(guild());
    socket.push({ type: "ask", id: ID, from: aroun, offerId: "relecture", size: 10 });
    await socket.next("canDo");
    socket.push({ type: "payload", id: ID, from: aroun, deviceKey: requester.publicKey, offerId: "relecture", sealed: seal("x", requester.publicKey, ID, "payload") });
    expect(await socket.next("refuse")).toMatchObject({ id: ID, reason: expect.stringMatching(/illisible/) });
    link.stop();
  });
});

describe("lien avec le relais (demandeur)", () => {
  it("choisit le premier fournisseur, chiffre pour son appareil et déchiffre la réponse", async () => {
    const { socket, keys, link } = await setup(guild());
    const provider = generateDeviceKeys();
    const pending = link.ask({ tag: "texte" }, "relis-moi ça");
    const ask = await socket.next("ask");
    expect(ask).toMatchObject({ tag: "texte", size: Buffer.byteLength("relis-moi ça") });
    expect(JSON.stringify(ask)).not.toContain("relis-moi");

    socket.push({ type: "canDo", id: ask.id, provider: aroun, device: 12, deviceKey: provider.publicKey, offer: { id: "relecture", name: "Relecture", model: "qwen3:8b", maxSeconds: 60 } });
    const payload = await socket.next("payload");
    expect(payload.to).toBe(12);
    expect(open(payload.sealed, provider, ask.id, "payload")).toBe("relis-moi ça");

    socket.push({ type: "answer", id: ask.id, sealed: seal("c'est relu", keys.publicKey, ask.id, "answer") });
    await expect(pending).resolves.toMatchObject({ answer: "c'est relu", provider: { name: "aroun" }, fingerprint: fingerprint(provider.publicKey) });
    link.stop();
  });

  it("remonte l'échec quand personne ne se propose", async () => {
    const { socket, link } = await setup(guild());
    const pending = link.ask({ tag: "rare" }, "quelqu'un ?");
    const ask = await socket.next("ask");
    socket.push({ type: "expired", id: ask.id, reason: "aucun fournisseur disponible pour le moment" });
    await expect(pending).rejects.toThrow(/aucun fournisseur/);
    link.stop();
  });
});
