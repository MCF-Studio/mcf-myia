import { McfAccount, vaultStoreFor, type Account, type TokenStore } from "./mcf-account.js";
import { sha256Text, WORKFLOW_MAX_BYTES } from "./workflow.js";

/**
 * Marketplace de workflows de mcfstudio.fr (spec du site : docs/superpowers/specs/2026-11-14-workflows-myia-design.md).
 *
 * - Parcourir et installer un workflow public : sans compte, en lecture seule.
 * - Publier, modifier, retirer : autorisation OAuth de portée `workflows`, séparée de la Guilde et de la carte
 *   (jeton de renouvellement dans le coffre, secret `mcfstudio_workflows_refresh`).
 * - L'auteur choisit privé (lui seul) ou public ; un workflow public n'est listé qu'après validation par un admin.
 *
 * Rien de ce qui vient du site n'est de confiance : l'empreinte du paquet est recalculée ici, et le paquet repasse par
 * la validation complète (core/workflow.ts) et par l'accord de l'utilisateur sur les scripts avant toute installation.
 */

export const WORKFLOWS_REFRESH_SECRET = "mcfstudio_workflows_refresh";

export interface WorkflowSummary {
  id: number;
  name: string;
  description: string | null;
  author: { id: number; name: string; certified: boolean };
  agents: number;
  scripts: number;
  sha256: string;
  visibility: "private" | "public";
  review: "none" | "pending" | "approved" | "rejected";
  rejectReason: string | null;
  downloads: number;
  updatedAt: string;
}

export interface WorkflowPage {
  workflows: WorkflowSummary[];
  page: number;
  pages: number;
  total: number;
}

const str = (v: unknown, max: number) => (typeof v === "string" ? v.slice(0, max) : "");
const int = (v: unknown) => (typeof v === "number" && Number.isFinite(v) ? Math.max(0, Math.trunc(v)) : 0);

/** Ne garde d'une réponse du site que les champs attendus, bornés : ce qui s'affiche vient d'ici, pas du site tel quel. */
export function cleanSummary(raw: unknown): WorkflowSummary {
  const r = (raw ?? {}) as Record<string, unknown>;
  const a = (r.author ?? {}) as Record<string, unknown>;
  const id = int(r.id);
  const sha256 = str(r.sha256, 64);
  if (!id || !/^[a-f0-9]{64}$/.test(sha256)) throw new Error("réponse du site illisible");
  const review = str(r.review, 12);
  return {
    id,
    name: str(r.name, 60) || "(sans nom)",
    description: str(r.description, 300) || null,
    author: { id: int(a.id), name: str(a.name, 60) || "?", certified: a.certified === true },
    agents: int(r.agents),
    scripts: int(r.scripts),
    sha256,
    visibility: r.visibility === "public" ? "public" : "private",
    review: review === "pending" || review === "approved" || review === "rejected" ? review : "none",
    rejectReason: str(r.rejectReason, 300) || null,
    downloads: int(r.downloads),
    updatedAt: str(r.updatedAt, 40),
  };
}

export class Market {
  readonly account: McfAccount;

  constructor(
    private readonly siteUrl: string,
    openBrowser: (url: string) => void,
    store: TokenStore = vaultStoreFor(WORKFLOWS_REFRESH_SECRET),
  ) {
    this.account = new McfAccount(siteUrl, { scope: "workflows", store, openBrowser });
  }

  private async request(method: string, route: string, opts: { auth?: boolean; body?: unknown } = {}): Promise<unknown> {
    const headers: Record<string, string> = {};
    if (opts.auth) {
      const token = await this.account.accessToken();
      if (!token) throw new Error("connecte d'abord MyIA au marketplace (bouton « Se connecter »)");
      headers.authorization = `Bearer ${token}`;
    }
    if (opts.body !== undefined) headers["content-type"] = "application/json";
    let r: Response;
    try {
      r = await fetch(`${this.siteUrl}${route}`, {
        method,
        headers,
        ...(opts.body !== undefined ? { body: JSON.stringify(opts.body) } : {}),
        signal: AbortSignal.timeout(30_000),
        redirect: "error",
      });
    } catch {
      throw new Error("mcfstudio.fr injoignable");
    }
    if (r.status === 204) return undefined;
    const data = (await r.json().catch(() => ({}))) as { message?: string; error?: string; code?: string };
    if (r.ok) return data;
    const code = data.code ?? data.error;
    if (r.status === 404 && code !== "workflow_not_found") throw new Error("le site n'a pas encore le marketplace de workflows (fonction en cours de déploiement)");
    if (r.status === 413) throw new Error("workflow refusé par le site : trop volumineux");
    throw new Error(str(data.message, 300) || `refusé par le site (${r.status})`);
  }

  /** Workflows publics validés. */
  async list(q: string, page: number): Promise<WorkflowPage> {
    const params = new URLSearchParams({ page: String(Math.max(1, page)) });
    if (q.trim()) params.set("q", q.trim().slice(0, 60));
    const d = (await this.request("GET", `/api/workflows?${params}`)) as Record<string, unknown>;
    const list = Array.isArray(d.workflows) ? d.workflows : [];
    return { workflows: list.slice(0, 100).map(cleanSummary), page: int(d.page) || 1, pages: int(d.pages) || 1, total: int(d.total) };
  }

  private async fetchPackage(route: string, auth: boolean, expected?: string): Promise<{ json: string; sha256: string }> {
    const d = (await this.request("GET", route, { auth })) as { package?: unknown; sha256?: unknown };
    if (typeof d.package !== "string" || Buffer.byteLength(d.package, "utf8") > WORKFLOW_MAX_BYTES) throw new Error("paquet reçu illisible ou trop volumineux");
    const sha256 = sha256Text(d.package);
    // L'empreinte annoncée (celle que l'utilisateur a vue dans la liste) doit être celle du paquet reçu.
    if (sha256 !== d.sha256 || (expected && sha256 !== expected)) throw new Error("empreinte du paquet différente de celle annoncée : installation refusée");
    return { json: d.package, sha256 };
  }

  /** Paquet d'un workflow public validé. */
  download(id: number, expected?: string) {
    return this.fetchPackage(`/api/workflows/${id}/package`, false, expected);
  }

  /** Paquet d'un de ses propres workflows (privé compris). */
  downloadMine(id: number, expected?: string) {
    return this.fetchPackage(`/api/apps/workflows/${id}/package`, true, expected);
  }

  async mine(): Promise<WorkflowSummary[]> {
    const d = (await this.request("GET", "/api/apps/workflows", { auth: true })) as { workflows?: unknown[] };
    return (Array.isArray(d.workflows) ? d.workflows : []).slice(0, 100).map(cleanSummary);
  }

  async publish(json: string, visibility: "private" | "public", id?: number): Promise<WorkflowSummary> {
    const d = (await this.request(id ? "PUT" : "POST", id ? `/api/apps/workflows/${id}` : "/api/apps/workflows", {
      auth: true,
      body: { package: json, visibility },
    })) as { workflow?: unknown };
    return cleanSummary(d.workflow);
  }

  async setVisibility(id: number, visibility: "private" | "public"): Promise<WorkflowSummary> {
    const d = (await this.request("PUT", `/api/apps/workflows/${id}`, { auth: true, body: { visibility } })) as { workflow?: unknown };
    return cleanSummary(d.workflow);
  }

  async remove(id: number): Promise<void> {
    await this.request("DELETE", `/api/apps/workflows/${id}`, { auth: true });
  }

  /** Compte connecté pour publier ; undefined si pas d'autorisation `workflows`. */
  async who(): Promise<Account | undefined> {
    try {
      return await this.account.account();
    } catch {
      return undefined;
    }
  }
}
