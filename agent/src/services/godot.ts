import { spawn } from "node:child_process";
import fs from "node:fs";
import path from "node:path";
import { z } from "zod";
import type { Config } from "../core/config.js";
import { isInside } from "../core/paths.js";
import type { ProjectRegistry } from "../core/projects.js";
import { runProcess } from "../core/proc.js";
import { defineTool, type Service, type ToolContext } from "../core/types.js";
import {
  downloadZip,
  enablePlugins,
  extractAddons,
  newProjectGodot,
  resolveAddon,
  searchAddons,
  type AddonInfo,
} from "./godot-addons.js";

const PROJECT_NAME = /^[A-Za-z0-9][A-Za-z0-9 _-]{0,63}$/;
const addonsField = z
  .array(z.string().min(1))
  .max(15)
  .default([])
  .describe('Addons : id de l\'Asset Library (ex. "1234", trouvé avec godot_search_addons) ou "github:auteur/depot"');

export function godotService(cfg: Config, reg: ProjectRegistry): Service {
  const g = cfg.godot;
  const root = g.projectsRoot;

  const exeFor = (version: string) => reg.godotExes[version];
  const installed = () => Object.keys(reg.godotExes).sort().join(", ") || "aucune";

  const describeAddons = async (specs: string[]) => {
    const lines: string[] = [];
    for (const s of specs) {
      try {
        const a = await resolveAddon(s);
        lines.push(`  - ${a.title} v${a.version} par ${a.author} (${a.license}, Godot ${a.godotVersion})\n    ${a.source}`);
      } catch (e) {
        lines.push(`  - ${s} : ${(e as Error).message}`);
      }
    }
    return lines.length ? lines.join("\n") : "  (aucun)";
  };

  /** Installe les addons dans un projet et active leurs plugins. */
  const install = async (dir: string, specs: string[], ctx: ToolContext) => {
    const report: string[] = [];
    const plugins: string[] = [];
    for (const spec of specs) {
      let info: AddonInfo;
      try {
        info = await resolveAddon(spec);
        ctx.ui.progress(`téléchargement de ${info.title}…`);
        const zip = await downloadZip(info.downloadUrl);
        const res = extractAddons(zip, dir);
        plugins.push(...res.plugins);
        report.push(
          `✓ ${info.title} → addons/${res.folders.join(", addons/")} (${res.files} fichiers${res.plugins.length ? ", plugin activé" : ", pas de plugin.cfg"})`,
        );
      } catch (e) {
        report.push(`✗ ${spec} : ${(e as Error).message}`);
      }
    }
    if (plugins.length) {
      const file = path.join(dir, "project.godot");
      fs.writeFileSync(file, enablePlugins(fs.readFileSync(file, "utf8"), plugins), "utf8");
    }
    return report;
  };

  /** Ouvre le projet en headless pour qu'il importe les ressources (non bloquant en cas d'échec). */
  const importProject = async (dir: string, version: string, ctx: ToolContext) => {
    const exe = exeFor(version);
    if (!exe || !fs.existsSync(exe)) return `Import non lancé (pas d'exécutable Godot ${version} dans la config).`;
    ctx.ui.progress("import initial du projet par Godot (headless)…");
    try {
      const r = await runProcess([exe, "--headless", "--path", dir, "--import"], { cwd: dir, timeoutMs: 180_000, keep: 15 });
      return r.code === 0 ? "Import Godot terminé." : `Import Godot terminé avec le code ${r.code} :\n${r.tail.join("\n")}`;
    } catch (e) {
      return `Import Godot impossible : ${(e as Error).message}`;
    }
  };

  /** Projet Godot existant (config ou détecté sous projectRoots) → dossier contenant project.godot. */
  const findProject = (name: string): string => reg.resolve(name, "godot").godotDir!;

  /** Lance l'éditeur détaché de MyIA : il reste ouvert après la fin de la session. */
  const launchEditor = (version: string, dir?: string) => {
    const exe = exeFor(version);
    if (!exe || !fs.existsSync(exe)) throw new Error(`Godot ${version} n'est pas installé (versions : ${installed()})`);
    const args = dir ? ["--editor", "--path", dir] : ["--project-manager"];
    const child = spawn(exe, args, { cwd: dir ?? path.dirname(exe), detached: true, stdio: "ignore", shell: false });
    child.on("error", () => {});
    child.unref();
    return `${exe} ${args.join(" ")}`;
  };

  return {
    id: "godot",
    label: "Godot",
    async available() {
      if (!root) return { ok: false, reason: "config > godot.projectsRoot non défini" };
      if (!fs.existsSync(root)) return { ok: false, reason: `dossier introuvable : ${root}` };
      return { ok: true };
    },
    tools() {
      return [
        defineTool({
          name: "godot_search_addons",
          description: "Cherche des addons dans l'Asset Library officielle de Godot. Renvoie leurs id.",
          schema: z.object({
            query: z.string().min(2).describe("Mots-clés (nom de l'addon, ex. \"dialogue\", \"camera\")"),
            godot_version: z.string().optional().describe(`Version de Godot (défaut ${g.defaultVersion})`),
          }),
          risk: "read",
          preview: () => "",
          async run(a) {
            const res = await searchAddons(a.query, a.godot_version ?? g.defaultVersion);
            if (!res.length) {
              return `Aucun addon trouvé pour "${a.query}". Essaie d'autres mots-clés, ou un dépôt GitHub ("github:auteur/depot").`;
            }
            return res
              .map((x) => `- id ${x.asset_id} : ${x.title} v${x.version_string} par ${x.author} (${x.cost}, Godot ${x.godot_version})`)
              .join("\n");
          },
        }),
        defineTool({
          name: "godot_create_project",
          description: `Crée un nouveau projet Godot dans ${root ?? "projectsRoot"}, installe et active des addons.`,
          schema: z.object({
            name: z.string().regex(PROJECT_NAME, "lettres, chiffres, espace, _ ou -, 64 caractères max"),
            addons: addonsField,
            renderer: z.enum(["forward_plus", "mobile", "gl_compatibility"]).default("forward_plus"),
            godot_version: z.string().optional().describe(`Version de Godot (défaut ${g.defaultVersion})`),
            open_editor: z.boolean().default(true).describe("Ouvrir l'éditeur sur le projet une fois créé"),
          }),
          risk: "local",
          check(a) {
            const dir = path.join(root ?? "", a.name);
            if (fs.existsSync(dir)) throw new Error(`le dossier existe déjà : ${dir}`);
          },
          async preview(a) {
            const v = a.godot_version ?? g.defaultVersion;
            return [
              `Nouveau projet : ${path.join(root ?? "?", a.name)}`,
              `Godot ${v}, rendu ${a.renderer}${a.open_editor ? ", ouverture de l'éditeur ensuite" : ""}`,
              "Addons téléchargés (code tiers qui s'exécutera dans l'éditeur) :",
              await describeAddons(a.addons),
            ].join("\n");
          },
          async run(a, ctx) {
            if (!root) throw new Error("projectsRoot non défini");
            const dir = path.join(root, a.name);
            if (!isInside(root, dir)) throw new Error("nom de projet invalide");
            if (fs.existsSync(dir)) throw new Error(`le dossier existe déjà : ${dir}`);
            const v = a.godot_version ?? g.defaultVersion;
            fs.mkdirSync(dir, { recursive: true });
            fs.writeFileSync(path.join(dir, "project.godot"), newProjectGodot(a.name, v, a.renderer), "utf8");
            fs.writeFileSync(path.join(dir, ".gitignore"), ".godot/\n/android/\n*.tmp\n", "utf8");
            fs.writeFileSync(path.join(dir, ".gitattributes"), "* text=auto eol=lf\n", "utf8");
            const report = await install(dir, a.addons, ctx);
            const imp = await importProject(dir, v, ctx);
            return [`Projet créé : ${dir}`, ...report, imp].join("\n");
          },
        }),
        defineTool({
          name: "godot_add_addons",
          description: "Installe et active des addons dans un projet Godot existant.",
          schema: z.object({
            project: z.string().min(1).describe("Nom du projet (config ou dossier dans projectsRoot)"),
            addons: addonsField.refine((x) => x.length > 0, "au moins un addon"),
          }),
          risk: "local",
          projectOf: (a) => {
            try {
              const p = reg.resolve(a.project, "godot");
              return p.source === "config" ? p.name : undefined;
            } catch {
              return undefined;
            }
          },
          check: (a) => void findProject(a.project),
          async preview(a) {
            return [`Projet : ${findProject(a.project)}`, "Addons téléchargés (code tiers) :", await describeAddons(a.addons)].join("\n");
          },
          async run(a, ctx) {
            const dir = findProject(a.project);
            return (await install(dir, a.addons, ctx)).join("\n");
          },
        }),
        defineTool({
          name: "godot_open",
          description:
            "Ouvre l'éditeur Godot sur un projet existant, dans la version du projet. Sans projet : ouvre le gestionnaire de projets. " +
            "Pour un NOUVEAU projet, utilise godot_create_project (qui ouvre l'éditeur ensuite).",
          schema: z.object({
            project: z.string().optional().describe("Nom du projet ; absent = gestionnaire de projets"),
            godot_version: z.string().optional().describe("Forcer une version (sinon celle du projet)"),
          }),
          risk: "launch",
          check(a) {
            if (a.project) reg.resolve(a.project, "godot");
          },
          preview: (a) => `Ouvrir Godot${a.project ? ` sur ${a.project}` : ""}`,
          async run(a) {
            if (!a.project) {
              const v = a.godot_version ?? g.defaultVersion;
              launchEditor(v);
              return `Gestionnaire de projets Godot ${v} ouvert.`;
            }
            const p = reg.resolve(a.project, "godot");
            const v = a.godot_version ?? p.godotVersion ?? g.defaultVersion;
            launchEditor(v, p.godotDir);
            return `Éditeur Godot ${v} ouvert sur ${p.name} (${p.godotDir}).`;
          },
        }),
      ];
    },
  };
}
