import crypto from "node:crypto";
import http from "node:http";
import os from "node:os";
import { deleteSecret, getSecret, setSecret } from "./secrets.js";

/**
 * Compte mcfstudio.fr pour la Guilde : OAuth 2.0 « authorization code » + PKCE avec redirection loopback (RFC 8252),
 * côté application. Spec côté site : docs/superpowers/specs/2026-11-11-guilde-myia-design.md (dépôt du site), §3.
 *
 * - Le navigateur du système s'ouvre sur <site>/autoriser ; le membre s'y connecte comme d'habitude et autorise.
 * - Le site renvoie le navigateur vers http://127.0.0.1:<port>/callback, où MyIA écoute le temps de l'échange.
 * - MyIA échange le code (avec le vérificateur PKCE) contre un jeton d'accès (15 min, en mémoire seulement) et un
 *   jeton de renouvellement (coffre Windows, rotation à chaque usage).
 * MyIA ne voit jamais le mot de passe, le cookie ni l'e-mail du membre.
 */

export const CLIENT_ID = "myia";
const REFRESH_SECRET = "mcfstudio_refresh";
const LOGIN_TIMEOUT_MS = 5 * 60_000;

export interface Account {
  id: number;
  name: string;
  avatar: string | null;
  certified: boolean;
}

export interface TokenStore {
  get(): string | undefined;
  set(token: string): void;
  clear(): void;
}

/** Jeton de renouvellement dans le coffre Windows ; un secret par portée (Guilde, carte des agents). */
export function vaultStoreFor(name: string): TokenStore {
  return {
    get: () => getSecret(name),
    set: (t) => setSecret(name, t),
    clear: () => void deleteSecret(name),
  };
}

export const vaultStore: TokenStore = vaultStoreFor(REFRESH_SECRET);

interface Tokens {
  access_token: string;
  refresh_token: string;
  expires_in: number;
}

const b64url = (buf: Buffer) => buf.toString("base64url");

/** Nom de l'appareil montré au membre sur le site (lettres, chiffres, espaces et ponctuation simple). */
export function deviceLabel(host = os.hostname()): string {
  const clean = `MyIA sur ${host}`.replace(/[^\p{L}\p{N} ._'()-]/gu, "").slice(0, 60).trim();
  return clean || "MyIA";
}

/** Contenu du jeton d'accès, pour l'affichage. La signature est vérifiée par le relais, pas ici. */
export function decodeAccount(accessToken: string): Account {
  const part = accessToken.split(".")[1];
  if (!part) throw new Error("jeton illisible");
  const p = JSON.parse(Buffer.from(part, "base64url").toString("utf8")) as Record<string, unknown>;
  return {
    id: Number(p.sub),
    name: String(p.name ?? "?"),
    avatar: typeof p.avatar === "string" ? p.avatar : null,
    certified: p.certified === true,
  };
}

const PAGE = (title: string, text: string) =>
  `<!doctype html><html lang="fr"><meta charset="utf-8"><title>${title}</title>` +
  `<body style="font-family:system-ui,sans-serif;background:#0d0b0a;color:#f4ede8;display:grid;place-items:center;height:100vh;margin:0">` +
  `<div style="text-align:center"><h1 style="color:#ff7a1a">${title}</h1><p>${text}</p></div></body></html>`;

export class McfAccount {
  private access?: { token: string; exp: number };

  constructor(
    private readonly siteUrl: string,
    private readonly opts: {
      store?: TokenStore;
      openBrowser: (url: string) => void;
      now?: () => number;
      /**
       * Portée demandée : « guild » (défaut), « map » (carte des agents) ou « workflows » (marketplace) ; chacune est une
       * autorisation séparée sur le site.
       */
      scope?: "guild" | "map" | "workflows";
    },
  ) {}

  private get store() {
    return this.opts.store ?? vaultStore;
  }

  private now() {
    return this.opts.now?.() ?? Date.now();
  }

  private async tokenCall(body: Record<string, string>): Promise<Tokens> {
    let r: Response;
    try {
      r = await fetch(`${this.siteUrl}/api/oauth/token`, {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ ...body, client_id: CLIENT_ID }),
        signal: AbortSignal.timeout(20_000),
      });
    } catch {
      throw new Error("mcfstudio.fr injoignable");
    }
    const data = (await r.json().catch(() => ({}))) as Partial<Tokens> & { error?: string; message?: string };
    if (r.status === 404 || r.status === 503) throw new Error("le site n'a pas encore la connexion des applications (fonction en cours de déploiement)");
    if (!r.ok || !data.access_token || !data.refresh_token) {
      const err = new Error(data.message ?? `connexion refusée (${data.error ?? r.status})`);
      (err as Error & { code?: string }).code = data.error;
      throw err;
    }
    return data as Tokens;
  }

  private keep(t: Tokens): Account {
    this.store.set(t.refresh_token); // rotation : l'ancien jeton ne vaut plus rien
    this.access = { token: t.access_token, exp: this.now() + (t.expires_in - 30) * 1000 };
    return decodeAccount(t.access_token);
  }

  /** Connexion : navigateur → consentement sur le site → retour sur la boucle locale → échange du code. */
  async login(signal?: AbortSignal): Promise<Account> {
    const verifier = b64url(crypto.randomBytes(32));
    const challenge = b64url(crypto.createHash("sha256").update(verifier).digest());
    const state = b64url(crypto.randomBytes(24));

    const server = http.createServer();
    await new Promise<void>((resolve, reject) => {
      server.once("error", reject);
      server.listen(0, "127.0.0.1", () => resolve());
    });
    const port = (server.address() as { port: number }).port;
    const redirectUri = `http://127.0.0.1:${port}/callback`;

    try {
      const code = await new Promise<string>((resolve, reject) => {
        const timer = setTimeout(() => reject(new Error("connexion abandonnée (5 min sans réponse)")), LOGIN_TIMEOUT_MS);
        const stop = () => {
          clearTimeout(timer);
          reject(new Error("connexion annulée"));
        };
        signal?.addEventListener("abort", stop, { once: true });
        server.on("request", (req, res) => {
          const url = new URL(req.url ?? "/", redirectUri);
          if (url.pathname !== "/callback") {
            res.writeHead(404).end();
            return;
          }
          const send = (status: number, title: string, text: string) =>
            res.writeHead(status, { "content-type": "text/html; charset=utf-8", "cache-control": "no-store" }).end(PAGE(title, text));
          // L'état doit être celui de CETTE demande : sinon un site tiers pourrait injecter son propre code.
          if (url.searchParams.get("state") !== state) {
            send(400, "Demande inconnue", "Relance la connexion depuis MyIA.");
            return;
          }
          clearTimeout(timer);
          signal?.removeEventListener("abort", stop);
          const error = url.searchParams.get("error");
          const got = url.searchParams.get("code");
          if (error || !got) {
            send(200, "Connexion refusée", "Tu peux fermer cet onglet.");
            reject(new Error(error === "access_denied" ? "autorisation refusée sur le site" : "connexion refusée"));
            return;
          }
          send(200, "Connecté à MyIA", "Tu peux fermer cet onglet et revenir dans MyIA.");
          resolve(got);
        });
        const params = new URLSearchParams({
          client_id: CLIENT_ID,
          redirect_uri: redirectUri,
          response_type: "code",
          scope: this.opts.scope ?? "guild",
          state,
          code_challenge: challenge,
          code_challenge_method: "S256",
          device: deviceLabel(),
        });
        this.opts.openBrowser(`${this.siteUrl}/autoriser?${params}`);
      });
      return this.keep(
        await this.tokenCall({ grant_type: "authorization_code", code, code_verifier: verifier, redirect_uri: redirectUri }),
      );
    } finally {
      server.close();
      server.closeAllConnections?.();
    }
  }

  /** Compte connecté (renouvelle le jeton d'accès au besoin) ; undefined si non connecté ou accès retiré. */
  async account(): Promise<Account | undefined> {
    const token = await this.accessToken();
    return token ? decodeAccount(token) : undefined;
  }

  private refreshing?: Promise<string | undefined>;

  /**
   * Jeton d'accès valide (pour le relais) ; renouvelé avec rotation quand il expire. `fresh` : en obtenir un nouveau
   * même si l'actuel est encore valide (le relais coupe à l'expiration du jeton qu'on lui a présenté : lui renvoyer le
   * même ne prolonge rien).
   */
  async accessToken(opts: { fresh?: boolean } = {}): Promise<string | undefined> {
    if (!opts.fresh && this.access && this.access.exp > this.now()) return this.access.token;
    // Un seul renouvellement à la fois : le jeton de renouvellement ne sert qu'une fois (rotation).
    this.refreshing ??= this.refresh().finally(() => (this.refreshing = undefined));
    return this.refreshing;
  }

  private async refresh(): Promise<string | undefined> {
    const refresh = this.store.get();
    if (!refresh) return undefined;
    try {
      this.keep(await this.tokenCall({ grant_type: "refresh_token", refresh_token: refresh }));
      return this.access!.token;
    } catch (e) {
      // Accès retiré depuis le site, banni ou jeton réutilisé : on oublie le jeton local.
      if ((e as Error & { code?: string }).code === "invalid_grant") this.store.clear();
      throw e;
    }
  }

  /** Déconnexion : révocation sur le site (au mieux), puis oubli local. */
  async logout(): Promise<void> {
    const refresh = this.store.get();
    this.access = undefined;
    this.store.clear();
    if (!refresh) return;
    await fetch(`${this.siteUrl}/api/oauth/revoke`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ token: refresh }),
      signal: AbortSignal.timeout(10_000),
    }).catch(() => undefined);
  }
}
