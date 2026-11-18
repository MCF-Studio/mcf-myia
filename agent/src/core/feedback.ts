import { z } from "zod";

/**
 * « Signaler un bug » et « Notes de mise à jour ».
 *
 * Signaler : le rapport part vers le site MCF Studio (POST /api/myia/bug-reports), qui le transmet au salon Discord
 * des bugs et à Aroun sur Telegram. Ni jeton de bot ni webhook ici : l'app est publique, un secret embarqué serait
 * extrait. Le site limite (5 rapports par heure et par adresse, 100 par jour) et ne garde pas le contenu.
 *
 * Notes : les releases publiques du dépôt GitHub (texte affiché tel quel, jamais interprété comme du HTML).
 */

export const BugReportSchema = z.object({
  title: z.string().trim().min(4, "titre trop court (4 caractères au moins)").max(120),
  description: z.string().trim().min(10, "décris le problème en quelques mots (10 caractères au moins)").max(4000),
  contact: z.string().trim().max(64).default(""),
  /** Joindre la fin du journal technique de MyIA (erreurs récentes, sans le contenu des conversations). */
  log: z.string().max(48 * 1024).nullable().default(null),
});
export type BugReport = z.infer<typeof BugReportSchema>;

export async function sendBugReport(
  siteUrl: string,
  report: BugReport,
  meta: { appVersion: string; os: string },
  fetchFn: typeof fetch = fetch,
): Promise<void> {
  let res: Response;
  try {
    res = await fetchFn(`${siteUrl}/api/myia/bug-reports`, {
      method: "POST",
      headers: { "content-type": "application/json", "user-agent": `MyIA/${meta.appVersion}` },
      body: JSON.stringify({ ...report, appVersion: meta.appVersion, os: meta.os }),
      signal: AbortSignal.timeout(20_000),
      redirect: "error",
    });
  } catch {
    throw new Error("le site MCF Studio ne répond pas : vérifie ta connexion, ou passe par le Discord");
  }
  if (res.ok) return;
  const body = (await res.json().catch(() => ({}))) as { message?: unknown; error?: unknown };
  const msg = typeof body.message === "string" ? body.message.slice(0, 300) : undefined;
  if (res.status === 404) throw new Error("le signalement depuis l'app n'est pas encore ouvert sur le site : passe par le Discord");
  if (res.status === 429) throw new Error(msg ?? "trop de rapports envoyés : réessaie plus tard");
  throw new Error(msg ?? `envoi refusé (${res.status})`);
}

/** Journal joint : les dernières erreurs du journal d'audit, réduites à date, événement et message. */
export function errorDigest(lines: string[], max = 40): string {
  const out: string[] = [];
  for (const line of lines.slice(-2000)) {
    try {
      const e = JSON.parse(line) as { ts?: unknown; event?: unknown; error?: unknown; tool?: unknown };
      if (typeof e.error !== "string" || !e.error) continue;
      out.push(`${String(e.ts ?? "").slice(0, 19)} ${String(e.event ?? "")}${e.tool ? ` ${String(e.tool)}` : ""} : ${e.error.replace(/\s+/g, " ").slice(0, 300)}`);
    } catch {
      /* ligne illisible */
    }
  }
  return out.slice(-max).join("\n");
}

// ─── notes de mise à jour ─────────────────────────────────────────────────────

export interface ReleaseNote {
  version: string;
  name: string;
  date: string;
  notes: string;
  url: string;
}

const Release = z.object({
  tag_name: z.string().max(40),
  name: z.string().max(200).nullable().optional(),
  published_at: z.string().nullable().optional(),
  body: z.string().max(20_000).nullable().optional(),
  html_url: z.string().max(300),
  draft: z.boolean().optional(),
  prerelease: z.boolean().optional(),
});

export const RELEASES_URL = "https://api.github.com/repos/MCF-Studio/mcf-myia/releases?per_page=20";

export function parseReleases(raw: unknown): ReleaseNote[] {
  if (!Array.isArray(raw)) return [];
  const out: ReleaseNote[] = [];
  for (const r of raw) {
    const p = Release.safeParse(r);
    if (!p.success || p.data.draft || !/^v?\d+\.\d+\.\d+$/.test(p.data.tag_name)) continue;
    if (!p.data.html_url.startsWith("https://github.com/")) continue;
    // Le corps des releases contient l'empreinte de l'installateur : utile sur GitHub, pas dans l'app.
    const notes = (p.data.body ?? "").split(/\n(?:#+\s*)?(?:SHA-?256|Empreinte)/i)[0]!.trim();
    out.push({
      version: p.data.tag_name.replace(/^v/, ""),
      name: p.data.name?.trim() || p.data.tag_name,
      date: (p.data.published_at ?? "").slice(0, 10),
      notes,
      url: p.data.html_url,
    });
  }
  return out;
}

let cache: { at: number; notes: ReleaseNote[] } | undefined;

export async function fetchReleases(fetchFn: typeof fetch = fetch): Promise<ReleaseNote[]> {
  if (cache && Date.now() - cache.at < 15 * 60_000) return cache.notes;
  const res = await fetchFn(RELEASES_URL, {
    headers: { accept: "application/vnd.github+json", "user-agent": "MyIA" },
    signal: AbortSignal.timeout(15_000),
    redirect: "error",
  });
  if (!res.ok) throw new Error(`notes de mise à jour indisponibles (GitHub ${res.status})`);
  const notes = parseReleases(await res.json());
  cache = { at: Date.now(), notes };
  return notes;
}
