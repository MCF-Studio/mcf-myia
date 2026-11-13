import crypto from "node:crypto";
import { execFile } from "node:child_process";
import { fingerprint, open, seal, type DeviceKeys } from "./guild-crypto.js";
import { decide, journal, readJournal, type Guild, type Offer } from "./guild.js";

/**
 * Lien de cette machine avec le relais de la Guilde (wss://myia.mcfstudio.fr/guilde/v1, spec relais §3).
 * - Fournisseur : publie les offres activées (métadonnées seulement), se propose quand les règles locales le
 *   permettent, déchiffre la demande, la traite dans le bac à sable (mode auto) ou la soumet au propriétaire.
 * - Demandeur : envoie une demande, choisit le premier fournisseur qui se propose, chiffre pour SON appareil.
 * Le relais ne voit jamais un texte en clair : tout contenu passe par seal()/open().
 */

export interface SocketLike {
  readonly readyState: number;
  send(data: string): void;
  close(code?: number, reason?: string): void;
  onopen: ((ev: unknown) => void) | null;
  onmessage: ((ev: { data: unknown }) => void) | null;
  onclose: ((ev: { code: number; reason: string }) => void) | null;
  onerror: ((ev: unknown) => void) | null;
}

export interface Member {
  id: number;
  name: string;
  certified: boolean;
}

export type LinkState =
  | { state: "off"; reason: string }
  | { state: "connecting" }
  | { state: "online"; member: Member; device: number; fingerprint: string }
  | { state: "error"; reason: string; retryAt?: string };

export interface PendingRequest {
  id: string;
  from: Member;
  offerId: string;
  offerName: string;
  text: string;
  reason: string;
  receivedAt: string;
  /** Empreinte de la clé de l'appareil demandeur, à comparer à l'oral au besoin. */
  fingerprint: string;
}

export interface AskResult {
  answer: string;
  provider: Member;
  offer: { id: string; name: string; model: string };
  fingerprint: string;
}

export interface GuildLinkDeps {
  relayUrl: string;
  keys: DeviceKeys;
  token(): Promise<string | undefined>;
  loadGuild(): Guild;
  run(offer: Offer, text: string, maxSeconds: number, signal: AbortSignal): Promise<string>;
  /** Événements pour l'interface (état, demande à valider, demande traitée). */
  emit(event: string, data: unknown): void;
  connect?(url: string): SocketLike;
  gpu?(): Promise<number | undefined>;
  appVersion?: string;
  now?(): Date;
}

type Msg = Record<string, unknown> & { type: string; id?: string };

const REAUTH_MS = 13 * 60_000;
const OPEN = 1;
/** Demandes traitées en même temps, et en attente de validation, au plus (en plus des limites du relais). */
const MAX_RUNNING = 2;
const MAX_PENDING = 10;

/** Taux d'utilisation du GPU NVIDIA (nvidia-smi) ; undefined si inconnu (les règles du mode auto restent prudentes). */
export function nvidiaGpu(): Promise<number | undefined> {
  return new Promise((resolve) => {
    execFile("nvidia-smi", ["--query-gpu=utilization.gpu", "--format=csv,noheader,nounits"], { timeout: 3000, windowsHide: true }, (err, out) => {
      const n = Number(String(out).trim().split(/\r?\n/)[0]);
      resolve(err || !Number.isFinite(n) ? undefined : n);
    });
  });
}

/**
 * Demandes traitées (auto ou validées) pour un membre dans l'heure, et aujourd'hui pour tous (quotas locaux), plus
 * celles déjà acceptées mais pas encore journalisées (`inFlight` : en cours ou en attente de validation) : sinon une
 * rafale de demandes passerait toute entière avant que le journal ne compte la première.
 */
function usage(member: number, now: Date, inFlight: number[] = []) {
  const hour = now.getTime() - 3_600_000;
  const midnight = new Date(now);
  midnight.setHours(0, 0, 0, 0);
  let memberLastHour = 0;
  let today = 0;
  for (const e of readJournal(1000)) {
    // Une demande acceptée compte même si son traitement a échoué (« erreur ») : sinon des échecs provoqués
    // permettraient de dépasser le quota.
    if (e.kind !== "demande" || e.decision === "refuse") continue;
    const t = Date.parse(e.ts);
    if (t >= midnight.getTime()) today++;
    if (t >= hour && e.fromId === member) memberLastHour++;
  }
  for (const m of inFlight) {
    today++;
    if (m === member) memberLastHour++;
  }
  return { memberLastHour, today };
}

export class GuildLink {
  private ws?: SocketLike;
  private stopped = true;
  private backoff = 2000;
  private retry?: NodeJS.Timeout;
  private reauth?: NodeJS.Timeout;
  status: LinkState = { state: "off", reason: "non connecté à mcfstudio.fr" };
  /** Demandes reçues en attente de la validation du propriétaire. */
  private readonly pending = new Map<string, PendingRequest & { deviceKey: string }>();
  /** Demandes pour lesquelles on s'est proposé, ou en cours de traitement. */
  private readonly offered = new Map<string, { from: Member; offerId: string }>();
  private readonly running = new Map<string, AbortController>();
  /** Membre à l'origine de chaque demande acceptée et pas encore journalisée (quotas). */
  private readonly inFlight = new Map<string, number>();
  /** Demandes envoyées par cette machine, en attente d'un événement du relais. */
  private readonly waiting = new Map<string, (m: Msg) => void>();

  constructor(private readonly deps: GuildLinkDeps) {}

  private now() {
    return this.deps.now?.() ?? new Date();
  }

  private setStatus(s: LinkState) {
    this.status = s;
    this.deps.emit("guild.status", s);
  }

  // ─── connexion ─────────────────────────────────────────────────────────────

  start() {
    this.stopped = false;
    this.backoff = 2000;
    void this.connect();
  }

  stop(reason = "déconnecté") {
    this.stopped = true;
    clearTimeout(this.retry);
    clearInterval(this.reauth);
    for (const c of this.running.values()) c.abort();
    this.ws?.close(1000, "arrêt");
    this.ws = undefined;
    this.pending.clear();
    this.offered.clear();
    this.inFlight.clear();
    for (const w of this.waiting.values()) w({ type: "expired", reason: "connexion au relais coupée" });
    this.waiting.clear();
    this.setStatus({ state: "off", reason });
  }

  private async connect() {
    if (this.stopped) return;
    let token: string | undefined;
    try {
      token = await this.deps.token();
    } catch (e) {
      return this.fail(`compte mcfstudio.fr : ${(e as Error).message}`);
    }
    if (!token) return this.stop("non connecté à mcfstudio.fr");
    this.setStatus({ state: "connecting" });
    const ws = this.deps.connect ? this.deps.connect(this.deps.relayUrl) : (new WebSocket(this.deps.relayUrl) as unknown as SocketLike);
    this.ws = ws;
    ws.onopen = () => {
      this.send({ type: "hello", v: 1, token, deviceKey: this.deps.keys.publicKey, app: `myia/${this.deps.appVersion ?? "0.0.0"}` });
    };
    ws.onmessage = (ev) => {
      let m: Msg;
      try {
        m = JSON.parse(String(ev.data)) as Msg;
      } catch {
        return;
      }
      void this.onMessage(m).catch(() => undefined);
    };
    ws.onerror = () => undefined;
    ws.onclose = (ev) => {
      if (this.ws !== ws) return;
      this.ws = undefined;
      clearInterval(this.reauth);
      for (const c of this.running.values()) c.abort();
      this.offered.clear();
      this.pending.clear();
      this.inFlight.clear();
      for (const w of this.waiting.values()) w({ type: "expired", reason: "connexion au relais coupée" });
      this.waiting.clear();
      if (this.stopped) return;
      if (ev.code === 4403) return this.stopWith("compte banni ou supprimé sur mcfstudio.fr");
      if (ev.code === 4409) return this.stopWith("MyIA s'est connecté à la Guilde depuis une autre fenêtre de ce PC");
      this.fail(ev.reason || `relais injoignable (code ${ev.code})`);
    };
  }

  private stopWith(reason: string) {
    this.stopped = true;
    this.setStatus({ state: "error", reason });
  }

  private fail(reason: string) {
    if (this.stopped) return;
    const wait = this.backoff;
    this.backoff = Math.min(this.backoff * 2, 60_000);
    this.setStatus({ state: "error", reason, retryAt: new Date(Date.now() + wait).toISOString() });
    clearTimeout(this.retry);
    this.retry = setTimeout(() => void this.connect(), wait);
  }

  private send(m: Msg) {
    if (this.ws?.readyState === OPEN) this.ws.send(JSON.stringify(m));
  }

  /** Offres publiées : seulement si la Guilde est activée ; métadonnées, jamais les consignes. */
  publishOffers() {
    if (this.status.state !== "online") return;
    const g = this.deps.loadGuild();
    const items = g.enabled
      ? g.offers
          .filter((o) => o.enabled)
          .map((o) => ({
            id: o.id,
            name: o.name,
            tags: o.tags,
            model: o.model,
            // Le relais ne connaît pas la liste blanche : il ne filtre que ce qu'il peut (membres certifiés).
            certifiedOnly: g.serve === "certified" && g.whitelist.length === 0,
            maxSeconds: g.limits.maxSeconds,
          }))
      : [];
    this.send({ type: "offers", items });
  }

  // ─── messages du relais ────────────────────────────────────────────────────

  private async onMessage(m: Msg) {
    const id = typeof m.id === "string" ? m.id : undefined;
    switch (m.type) {
      case "welcome": {
        this.backoff = 2000;
        const member = m.member as Member;
        this.setStatus({ state: "online", member, device: m.device as number, fingerprint: fingerprint(this.deps.keys.publicKey) });
        clearInterval(this.reauth);
        this.reauth = setInterval(() => void this.renew(), REAUTH_MS);
        this.publishOffers();
        return;
      }
      case "ask":
        return this.onAsk(m);
      case "payload":
        return this.onPayload(m);
      case "taken":
      case "cancelled":
      case "expired":
        if (id && this.offered.has(id)) {
          this.offered.delete(id);
          this.running.get(id)?.abort();
          if (this.pending.delete(id)) {
            this.inFlight.delete(id);
            this.deps.emit("guild.pending", this.pendingList());
          }
        }
        break;
    }
    if (id) this.waiting.get(id)?.(m);
  }

  private async renew() {
    try {
      const token = await this.deps.token();
      if (token) this.send({ type: "reauth", token });
    } catch {
      /* le relais coupera à l'expiration ; la reconnexion réessaiera */
    }
  }

  /** Une demande circule : on ne se propose que si nos règles l'autorisent (la taille tient lieu de texte). */
  private async onAsk(m: Msg) {
    const id = m.id as string;
    const from = m.from as Member;
    const offerId = m.offerId as string;
    const g = this.deps.loadGuild();
    if (this.running.size >= MAX_RUNNING && this.pending.size >= MAX_PENDING) return;
    // Taille annoncée (bornée par le relais, mais revérifiée) : seule la longueur compte pour les règles.
    const size = Number(m.size);
    if (!Number.isSafeInteger(size) || size < 1 || size > g.limits.maxChars * 4) return;
    const d = decide(g, { from, offerId, text: "x".repeat(Math.min(size, g.limits.maxChars + 1)) }, this.usageFor(from.id), this.now(), undefined);
    if (d.kind === "refuse") return;
    this.offered.set(id, { from, offerId });
    this.send({ type: "canDo", id, offerId });
  }

  private async onPayload(m: Msg) {
    const id = m.id as string;
    const from = m.from as Member;
    const offerId = m.offerId as string;
    const deviceKey = m.deviceKey as string;
    if (!this.offered.has(id)) return this.send({ type: "refuse", id, reason: "demande inattendue" });
    let text: string;
    try {
      text = open(m.sealed as string, this.deps.keys, id, "payload");
    } catch (e) {
      this.offered.delete(id);
      return this.send({ type: "refuse", id, reason: (e as Error).message });
    }
    const g = this.deps.loadGuild();
    const gpu = await (this.deps.gpu ?? nvidiaGpu)();
    let d = decide(g, { from, offerId, text }, this.usageFor(from.id), this.now(), gpu);
    const offer = g.offers.find((o) => o.id === offerId);
    if (d.kind === "auto" && this.running.size >= MAX_RUNNING) d = { kind: "ask", reason: "déjà deux demandes en cours" };
    if (d.kind === "ask" && this.pending.size >= MAX_PENDING) d = { kind: "refuse", reason: "trop de demandes en attente" };
    if (d.kind === "refuse" || !offer) {
      this.offered.delete(id);
      journal({ kind: "demande", offerId, from: from.name, fromId: from.id, decision: "refuse", reason: d.reason, chars: text.length });
      return this.send({ type: "refuse", id, reason: d.reason });
    }
    // Place réservée dès l'acceptation (auto ou mise en attente), libérée à la journalisation ou à l'abandon.
    this.inFlight.set(id, from.id);
    if (d.kind === "auto") return this.process(id, from, offer, text, deviceKey, "auto", d.reason);
    this.pending.set(id, {
      id,
      from,
      offerId,
      offerName: offer.name,
      text,
      reason: d.reason,
      receivedAt: this.now().toISOString(),
      fingerprint: fingerprint(deviceKey),
      deviceKey,
    });
    this.deps.emit("guild.pending", this.pendingList());
  }

  private async process(id: string, from: Member, offer: Offer, text: string, deviceKey: string, decision: "auto" | "ask", reason: string) {
    const ctrl = new AbortController();
    this.running.set(id, ctrl);
    const t0 = Date.now();
    try {
      const g = this.deps.loadGuild();
      const answer = await this.deps.run(offer, text, g.limits.maxSeconds, ctrl.signal);
      if (ctrl.signal.aborted) throw new Error("demande annulée ou expirée");
      this.send({ type: "answer", id, sealed: seal(answer, deviceKey, id, "answer") });
      journal({ kind: "demande", offerId: offer.id, from: from.name, fromId: from.id, decision, reason, chars: text.length, ms: Date.now() - t0 });
      this.deps.emit("guild.served", { id, from: from.name, offerId: offer.id, ms: Date.now() - t0 });
    } catch (e) {
      // Détail de l'erreur dans le journal local seulement : le demandeur reçoit un motif générique.
      const msg = (e as Error).message;
      this.send({ type: "refuse", id, reason: ctrl.signal.aborted ? "demande annulée ou expirée" : "traitement impossible chez ce membre" });
      journal({ kind: "demande", offerId: offer.id, from: from.name, fromId: from.id, decision: "erreur", reason: msg, chars: text.length });
    } finally {
      this.running.delete(id);
      this.offered.delete(id);
      this.inFlight.delete(id);
    }
  }

  // ─── validation par le propriétaire ────────────────────────────────────────

  private usageFor(member: number) {
    return usage(member, this.now(), [...this.inFlight.values()]);
  }

  pendingList(): PendingRequest[] {
    return [...this.pending.values()].map(({ deviceKey: _k, ...p }) => p);
  }

  async accept(id: string) {
    const p = this.pending.get(id);
    if (!p) throw new Error("demande introuvable (expirée ou annulée)");
    this.pending.delete(id);
    this.deps.emit("guild.pending", this.pendingList());
    const offer = this.deps.loadGuild().offers.find((o) => o.id === p.offerId);
    if (!offer) {
      this.inFlight.delete(id);
      this.send({ type: "refuse", id, reason: "offre retirée" });
      throw new Error("cette offre n'existe plus");
    }
    void this.process(id, p.from, offer, p.text, p.deviceKey, "ask", "acceptée par toi");
  }

  reject(id: string, reason = "refusée par le propriétaire") {
    const p = this.pending.get(id);
    if (!p) throw new Error("demande introuvable (expirée ou annulée)");
    this.pending.delete(id);
    this.offered.delete(id);
    this.inFlight.delete(id);
    this.send({ type: "refuse", id, reason });
    journal({ kind: "demande", offerId: p.offerId, from: p.from.name, fromId: p.from.id, decision: "refuse", reason, chars: p.text.length });
    this.deps.emit("guild.pending", this.pendingList());
  }

  // ─── demandeur ─────────────────────────────────────────────────────────────

  /** Demande à la Guilde : premier fournisseur qui se propose, contenu chiffré pour son appareil. */
  async ask(target: { tag?: string; to?: number; offerId?: string }, text: string, signal?: AbortSignal): Promise<AskResult> {
    if (this.status.state !== "online") throw new Error("pas connecté au relais de la Guilde");
    const id = crypto.randomBytes(18).toString("base64url");
    const size = Buffer.byteLength(text, "utf8");
    const events: Msg[] = [];
    let wake: (() => void) | undefined;
    this.waiting.set(id, (m) => {
      events.push(m);
      wake?.();
    });
    const next = async (types: string[], ms: number): Promise<Msg> => {
      const end = Date.now() + ms;
      for (;;) {
        const i = events.findIndex((e) => types.includes(e.type) || e.type === "error" || e.type === "expired" || e.type === "refused");
        if (i >= 0) return events.splice(i, 1)[0]!;
        if (signal?.aborted) throw new Error("demande annulée");
        const left = end - Date.now();
        if (left <= 0) throw new Error("pas de réponse du relais à temps");
        await new Promise<void>((r) => {
          wake = r;
          setTimeout(r, Math.min(left, 500));
        });
      }
    };
    const fail = (m: Msg): never => {
      throw new Error(String(m.reason ?? m.message ?? "demande refusée"));
    };
    try {
      this.send({ type: "ask", id, size, ...target });
      const can = await next(["canDo"], 35_000);
      if (can.type !== "canDo") fail(can);
      const deviceKey = can.deviceKey as string;
      const offer = can.offer as AskResult["offer"] & { maxSeconds: number };
      this.send({ type: "payload", id, to: can.device, sealed: seal(text, deviceKey, id, "payload") });
      const res = await next(["answer"], (offer.maxSeconds + 45) * 1000);
      if (res.type !== "answer") fail(res);
      return {
        answer: open(res.sealed as string, this.deps.keys, id, "answer"),
        provider: can.provider as Member,
        offer: { id: offer.id, name: offer.name, model: offer.model },
        fingerprint: fingerprint(deviceKey),
      };
    } catch (e) {
      if (signal?.aborted) this.send({ type: "cancel", id });
      throw e;
    } finally {
      this.waiting.delete(id);
    }
  }
}
