import fs from "node:fs";
import { z } from "zod";
import { runProcess } from "../core/proc.js";
import { defaultTarget, type Project, type ProjectRegistry } from "../core/projects.js";
import { defineTool, type Service } from "../core/types.js";

function describe(p: Project, withTargets: boolean): string {
  const head = `- ${p.name} [${p.kinds.join("+")}${p.godotVersion ? ` ${p.godotVersion}` : ""}] ${p.path}${p.description ? ` — ${p.description}` : ""}`;
  if (!withTargets) return head;
  const targets = Object.keys(p.targets).filter((t) => !t.endsWith(" [debug]"));
  const debug = Object.keys(p.targets).length > targets.length ? " (chaque export Godot existe aussi en « [debug] »)" : "";
  const lines = [head, `  cibles : ${targets.join(", ") || "aucune"}${debug}`];
  if (p.notes.length) lines.push(`  ⚠ ${p.notes.join(" ; ")}`);
  return lines.join("\n");
}

export function projectsService(reg: ProjectRegistry): Service {
  const pickTarget = (p: Project, target?: string) => {
    const t = target ?? defaultTarget(p);
    if (t && p.targets[t]) return t;
    const list = Object.keys(p.targets);
    const why = p.notes.length ? ` (${p.notes.join(" ; ")})` : "";
    throw new Error(
      list.length
        ? `${t ? `cible "${t}" inconnue` : "plusieurs cibles possibles"} pour ${p.name}. Cibles : ${list.join(", ")}. Demande à l'utilisateur laquelle.`
        : `${p.name} n'a aucune cible de build${why}.`,
    );
  };

  return {
    id: "projects",
    label: "Projets (build)",
    async available() {
      return reg.all.length ? { ok: true } : { ok: false, reason: "aucun projet trouvé (config > projectRoots / projects)" };
    },
    tools() {
      return [
        defineTool({
          name: "projects_find",
          description:
            "Cherche les projets de l'utilisateur (Godot, Tauri, Rust) par nom et donne leurs cibles de build. Sans requête : liste tout (noms seulement).",
          schema: z.object({
            query: z.string().default("").describe("Partie du nom du projet (ex. \"peche\", \"launcher\")"),
            kind: z.enum(["godot", "tauri", "rust", "node"]).optional(),
          }),
          risk: "read",
          preview: () => "",
          async run(a) {
            const res = reg.find(a.query, a.kind);
            if (!res.length) return `Aucun projet ne correspond à "${a.query}".`;
            if (!a.query && res.length > 15) return `${res.length} projets :\n${res.map((p) => p.name).join(", ")}`;
            return res.slice(0, 15).map((p) => describe(p, true)).join("\n") + (res.length > 15 ? `\n… et ${res.length - 15} autres` : "");
          },
        }),
        defineTool({
          name: "project_build",
          description:
            "Lance une cible de build d'un projet. Godot : la cible est le nom d'un preset d'export (ajoute « [debug] » pour un export debug). " +
            "Tauri/Rust : build, build-debug, check, test, front. Les cibles d'un sous-dossier sont préfixées (ex. \"backend:build\").",
          schema: z.object({
            project: z.string().min(1).describe("Nom du projet seulement (ex. \"mcf-2d-rp-\"), sans la cible"),
            target: z.string().optional().describe("Cible ; absente = cible par défaut si elle est évidente"),
          }),
          risk: "local",
          projectOf: (a) => {
            try {
              return reg.resolve(a.project).name;
            } catch {
              return undefined;
            }
          },
          check(a) {
            const p = reg.resolve(a.project);
            pickTarget(p, a.target);
            if (!fs.existsSync(p.path)) throw new Error(`dossier introuvable : ${p.path}`);
          },
          preview(a) {
            const p = reg.resolve(a.project);
            const t = p.targets[pickTarget(p, a.target)]!;
            return `Projet ${p.name} (${p.path})\nDossier : ${t.cwd}\nCommande : ${t.argv.join(" ")}`;
          },
          async run(a, ctx) {
            const p = reg.resolve(a.project);
            const name = pickTarget(p, a.target);
            const t = p.targets[name]!;
            if (t.ensureDir) fs.mkdirSync(t.ensureDir, { recursive: true });
            ctx.ui.progress(`build ${p.name}/${name} : ${t.argv.join(" ")}`);
            const t0 = Date.now();
            const r = await runProcess(t.argv, {
              cwd: t.cwd,
              timeoutMs: 30 * 60_000,
              keep: 40,
              signal: ctx.signal,
              onLine: (l) => ctx.ui.progress(`  ${l}`),
            });
            const secs = Math.round((Date.now() - t0) / 1000);
            const status = r.timedOut ? "interrompu (délai dépassé)" : r.code === 0 ? "réussi" : `échoué (code ${r.code})`;
            return `Build ${p.name}/${name} ${status} en ${secs}s.\nDernières lignes :\n${r.tail.join("\n")}`;
          },
        }),
      ];
    },
  };
}
