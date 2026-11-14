import fs from "node:fs";
import path from "node:path";
import { z } from "zod";
import { commandWorks, runProcess } from "../core/proc.js";
import type { ProjectRegistry } from "../core/projects.js";
import { defineTool, truncate, type Service } from "../core/types.js";

/**
 * Git natif pour les agents : le modèle choisit un PROJET connu (jamais un chemin ni une commande git libre).
 * Lecture (status, log, diff, show, branches) sans confirmation ; commit et changement de branche = `local` ;
 * push = `external` (confirmation toujours). Jamais de force, jamais de push ni de commit sur main/master,
 * jamais de fichier de secrets dans un commit (le dépôt GitHub est public).
 *
 * Durcissement : pas de shell, pas de pager ni de pilote de diff externe (config de dépôt qui exécuterait une
 * commande), pas d'invite de mot de passe, pathspecs littéraux, transport `ext::` interdit.
 */

const BASE = [
  "git",
  "--no-pager",
  "--literal-pathspecs",
  "-c", "core.fsmonitor=false",
  "-c", "core.quotepath=false",
  "-c", "core.pager=cat",
  "-c", "color.ui=never",
  "-c", "protocol.ext.allow=never",
];
const PROTECTED = /^(main|master)$/i;
const BRANCH = /^[A-Za-z0-9][A-Za-z0-9_./-]{0,99}$/;
const REF = /^[A-Za-z0-9][A-Za-z0-9_.\/~^@{}-]{0,99}$/;
const DEFAULT_CHARS = 12_000;
const MAX_CHARS = 40_000;

export interface GitResult {
  code: number | null;
  out: string;
  err: string;
  timedOut: boolean;
}

export async function runGit(
  cwd: string,
  args: string[],
  o: { timeoutMs?: number; stdin?: string; maxChars?: number } = {},
): Promise<GitResult> {
  const env: NodeJS.ProcessEnv = { ...process.env, GIT_TERMINAL_PROMPT: "0", GIT_PAGER: "cat", GIT_EDITOR: "true" };
  delete env.GIT_EXTERNAL_DIFF;
  const max = o.maxChars ?? 200_000;
  let out = "";
  let err = "";
  const r = await runProcess([...BASE, ...args], {
    cwd,
    timeoutMs: o.timeoutMs ?? 60_000,
    stdin: o.stdin,
    env,
    keep: 1,
    onLine(line, stream) {
      if (stream === "out") {
        if (out.length < max) out += line + "\n";
      } else if (err.length < 20_000) err += line + "\n";
    },
  });
  return { code: r.code, out, err, timedOut: r.timedOut };
}

function must(r: GitResult, what: string): string {
  if (r.timedOut) throw new Error(`${what} : délai dépassé`);
  if (r.code !== 0) throw new Error(r.err.trim() || `${what} a échoué (code ${r.code})`);
  return r.out;
}

/** Chemin relatif sûr pour un filtre ou un ajout : pas d'option, pas de chemin absolu, pas de « .. ». */
export function safeRel(p: string): string {
  const s = p.replaceAll("\\", "/").trim();
  if (!s || s.startsWith("-") || s.startsWith(":") || s.includes("\0") || path.isAbsolute(s) || /^[A-Za-z]:/.test(s) || s.split("/").includes("..")) {
    throw new Error(`chemin invalide : ${JSON.stringify(p)} (relatif au projet, sans « .. »)`);
  }
  return s;
}

export function safeRef(ref: string, what = "référence"): string {
  if (!REF.test(ref)) {
    throw new Error(`${what} invalide : ${JSON.stringify(ref)}`);
  }
  return ref;
}

export function safeBranch(name: string): string {
  if (!BRANCH.test(name) || name.includes("..") || name.includes("//") || /[./]$/.test(name) || name.endsWith(".lock") || name.includes("@{")) {
    throw new Error(`nom de branche invalide : ${JSON.stringify(name)}`);
  }
  return name;
}

/** Fichiers qui ne doivent jamais entrer dans un commit (clés, secrets, config propre à la machine). */
export function isSecretFile(file: string): boolean {
  const base = file.replaceAll("\\", "/").split("/").pop() ?? "";
  if (/^\.env\.(example|sample|template)$/i.test(base)) return false;
  return /^(\.env(\..*)?|\.npmrc|\.netrc|credentials(\.json)?|secrets?\.(json|ya?ml|toml)|(agents?|teams|guild)\.json)$/i.test(base) ||
    /^id_(rsa|dsa|ecdsa|ed25519)(\.pub)?$/i.test(base) ||
    /\.(pem|key|pfx|p12|kdbx|keystore|jks)$/i.test(base);
}

/** Retire l'identifiant éventuel d'une URL de remote avant de l'afficher. */
export function redactRemote(url: string): string {
  return url.trim().replace(/\/\/[^/@\s]+@/, "//");
}

export function gitService(reg: ProjectRegistry): Service {
  const repo = (name: string): string => {
    const p = reg.resolve(name);
    if (!fs.existsSync(path.join(p.path, ".git"))) throw new Error(`${p.name} n'est pas un dépôt git (pas de .git à la racine du projet)`);
    return p.path;
  };
  const projectOf = (a: { project: string }) => {
    try {
      return reg.resolve(a.project).name;
    } catch {
      return undefined;
    }
  };
  const currentBranch = async (cwd: string): Promise<string> => {
    const r = await runGit(cwd, ["symbolic-ref", "--short", "-q", "HEAD"]);
    const b = r.out.trim();
    if (r.code !== 0 || !b) throw new Error("HEAD détachée : passe sur une branche (git_switch) avant d'enregistrer ou de pousser");
    return b;
  };
  const project = z.string().min(1).describe("Nom du projet (voir projects_find), jamais un chemin");
  const maxChars = z.number().int().min(500).max(MAX_CHARS).default(DEFAULT_CHARS).describe("Taille maximale de la sortie");

  const requireNotProtected = (branch: string, action: string) => {
    if (PROTECTED.test(branch)) {
      throw new Error(`${action} directement sur « ${branch} » refusé : crée d'abord une branche (git_switch avec create=true), puis passe par une pull request.`);
    }
  };

  const stagedSecrets = async (cwd: string): Promise<string[]> => {
    const r = await runGit(cwd, ["diff", "--cached", "--name-only", "--no-renames", "--diff-filter=ACMR"]);
    return must(r, "git diff --cached").split("\n").filter((f) => f && isSecretFile(f));
  };

  return {
    id: "git",
    label: "Git (dépôts des projets)",
    async available() {
      return (await commandWorks(["git", "--version"], process.cwd())) ? { ok: true } : { ok: false, reason: "git n'est pas installé ou pas dans le PATH" };
    },
    tools() {
      return [
        defineTool({
          name: "git_status",
          description: "État git d'un projet : branche (avance/retard sur le distant) et fichiers modifiés, ajoutés, supprimés ou non suivis.",
          schema: z.object({ project }),
          risk: "read",
          preview: () => "",
          async run(a) {
            const lines = must(await runGit(repo(a.project), ["status", "--porcelain=v1", "-b"]), "git status").split("\n").filter(Boolean);
            const head = (lines[0] ?? "").replace(/^## /, "");
            const files = lines.slice(1);
            const shown = files.slice(0, 200).map((l) => `${l.slice(0, 2).trim() || "?"}  ${l.slice(3)}`);
            return [`Branche : ${head}`, files.length ? `${files.length} fichier(s) :` : "Aucune modification (dépôt propre).", ...shown, files.length > 200 ? `… et ${files.length - 200} autres` : ""]
              .filter(Boolean)
              .join("\n");
          },
        }),
        defineTool({
          name: "git_log",
          description: "Derniers commits d'un projet (hash, date, auteur, titre), éventuellement d'une branche ou limités à un fichier.",
          schema: z.object({
            project,
            count: z.number().int().min(1).max(50).default(10),
            ref: z.string().optional().describe("Branche ou commit de départ (défaut : la branche courante)"),
            path: z.string().optional().describe("Limiter à ce fichier ou dossier (relatif au projet)"),
          }),
          risk: "read",
          preview: () => "",
          async run(a) {
            const args = ["log", `-n${a.count}`, "--no-ext-diff", "--date=short", "--pretty=tformat:%h  %ad  %an  %s"];
            if (a.ref) args.push(safeRef(a.ref));
            if (a.path) args.push("--", safeRel(a.path));
            const out = must(await runGit(repo(a.project), args, { maxChars: 20_000 }), "git log");
            return out.trim() || "Aucun commit.";
          },
        }),
        defineTool({
          name: "git_diff",
          description:
            "Différences d'un projet : fichiers touchés (+/-) puis le détail. Par défaut le travail non enregistré ; staged=true pour ce qui est prêt à commiter ; against=<branche> pour comparer à une branche (ex. main).",
          schema: z.object({
            project,
            staged: z.boolean().default(false),
            against: z.string().optional().describe("Branche ou commit de comparaison (ex. main, ou main...HEAD)"),
            path: z.string().optional().describe("Limiter à ce fichier ou dossier (relatif au projet)"),
            max_chars: maxChars,
          }),
          risk: "read",
          preview: () => "",
          async run(a) {
            const cwd = repo(a.project);
            const base = ["diff", "--no-ext-diff", "--no-textconv", "--no-color", ...(a.staged ? ["--cached"] : []), ...(a.against ? [safeRef(a.against, "against")] : [])];
            const tail = a.path ? ["--", safeRel(a.path)] : [];
            const stat = must(await runGit(cwd, [...base, "--numstat", ...tail], { maxChars: 20_000 }), "git diff").trim();
            if (!stat) return "Aucune différence.";
            const patch = must(await runGit(cwd, [...base, ...tail], { maxChars: a.max_chars + 1 }), "git diff");
            const files = stat.split("\n").map((l) => {
              const [add, del, ...f] = l.split("\t");
              return `${f.join("\t")}  (+${add} −${del})`;
            });
            return `${files.length} fichier(s) :\n${files.slice(0, 100).join("\n")}\n\n${truncate(patch, a.max_chars)}`;
          },
        }),
        defineTool({
          name: "git_show",
          description: "Détail d'un commit (message, fichiers, modifications).",
          schema: z.object({ project, ref: z.string().default("HEAD").describe("Commit, branche ou tag"), max_chars: maxChars }),
          risk: "read",
          preview: () => "",
          async run(a) {
            const out = must(await runGit(repo(a.project), ["show", "--no-ext-diff", "--no-textconv", "--no-color", "--stat", "--patch", safeRef(a.ref), "--"], { maxChars: a.max_chars + 1 }), "git show");
            return truncate(out, a.max_chars);
          },
        }),
        defineTool({
          name: "git_branches",
          description: "Branches locales d'un projet avec leur dernier commit et leur suivi du distant ; la courante est marquée « * ».",
          schema: z.object({ project }),
          risk: "read",
          preview: () => "",
          async run(a) {
            const lines = must(await runGit(repo(a.project), ["branch", "--list", "-vv", "--no-color"], { maxChars: 20_000 }), "git branch").split("\n").filter(Boolean);
            return lines.slice(0, 100).join("\n") + (lines.length > 100 ? `\n… et ${lines.length - 100} autres` : "");
          },
        }),
        defineTool({
          name: "git_switch",
          description:
            "Change de branche, ou en crée une (create=true, depuis la branche courante ou `from`). À utiliser avant de modifier un projet : on ne commite pas sur main/master. Git refuse tout seul si des modifications seraient écrasées.",
          schema: z.object({
            project,
            branch: z.string().min(1).describe("Nom de branche, ex. feat/mon-sujet"),
            create: z.boolean().default(false),
            from: z.string().optional().describe("create seulement : branche ou commit de départ"),
          }),
          risk: "local",
          projectOf,
          check(a) {
            repo(a.project);
            safeBranch(a.branch);
            if (a.from) safeRef(a.from, "from");
            if (a.from && !a.create) throw new Error("`from` n'a de sens qu'avec create=true");
          },
          preview: (a) => `${a.create ? "Créer et passer sur" : "Passer sur"} la branche ${a.branch}${a.from ? ` (depuis ${a.from})` : ""} dans ${a.project}`,
          async run(a) {
            const args = a.create ? ["switch", "-c", safeBranch(a.branch), ...(a.from ? [safeRef(a.from, "from")] : [])] : ["switch", safeBranch(a.branch)];
            const r = await runGit(repo(a.project), args);
            must(r, "git switch");
            return `Sur la branche ${a.branch}.`;
          },
        }),
        defineTool({
          name: "git_commit",
          description:
            "Enregistre un commit sur la branche courante (jamais main/master : utilise git_switch create=true d'abord). Indique les fichiers (paths) ou all=true pour tout ; sans les deux, commite ce qui est déjà préparé. " +
            "Refuse les fichiers de secrets (.env, clés, config propre à la machine). Les hooks du dépôt s'exécutent.",
          schema: z.object({
            project,
            message: z.string().min(3).max(4000).describe("Message de commit : titre court à la première ligne, puis le pourquoi"),
            paths: z.array(z.string()).max(200).optional().describe("Fichiers ou dossiers à inclure (relatifs au projet)"),
            all: z.boolean().default(false).describe("Inclure toutes les modifications, y compris les nouveaux fichiers"),
          }),
          risk: "local",
          projectOf,
          async check(a) {
            const cwd = repo(a.project);
            if (a.all && a.paths?.length) throw new Error("paths et all=true s'excluent");
            for (const p of a.paths ?? []) {
              const rel = safeRel(p);
              if (isSecretFile(rel)) throw new Error(`${rel} est un fichier de secrets ou de config locale : il n'entre pas dans un commit`);
            }
            requireNotProtected(await currentBranch(cwd), "Commit");
          },
          async preview(a) {
            const cwd = repo(a.project);
            const st = must(await runGit(cwd, ["status", "--short"], { maxChars: 8000 }), "git status").trim();
            const what = a.all ? "TOUT (y compris les nouveaux fichiers)" : a.paths?.length ? a.paths.join(", ") : "ce qui est déjà préparé";
            return `Projet ${a.project}, branche ${await currentBranch(cwd)}\nInclus : ${what}\nMessage :\n${a.message}\n\nÉtat actuel :\n${st || "(rien)"}`;
          },
          async run(a) {
            const cwd = repo(a.project);
            requireNotProtected(await currentBranch(cwd), "Commit");
            if (a.all) {
              const st = must(await runGit(cwd, ["status", "--porcelain=v1", "-uall"], { maxChars: 400_000 }), "git status")
                .split("\n")
                .filter((l) => l && !l.startsWith(" D") && !l.startsWith("D "))
                .map((l) => l.slice(3).split(" -> ").pop()!);
              const bad = st.filter(isSecretFile);
              if (bad.length) throw new Error(`Commit refusé, fichiers de secrets ou de config locale : ${bad.slice(0, 5).join(", ")}. Ajoute-les à .gitignore ou liste les fichiers voulus avec paths.`);
              must(await runGit(cwd, ["add", "-A"]), "git add");
            } else if (a.paths?.length) {
              must(await runGit(cwd, ["add", "--", ...a.paths.map(safeRel)]), "git add");
            }
            const bad = await stagedSecrets(cwd);
            if (bad.length) throw new Error(`Commit refusé, fichiers de secrets préparés : ${bad.slice(0, 5).join(", ")} (git restore --staged pour les retirer).`);
            if ((await runGit(cwd, ["diff", "--cached", "--quiet"])).code === 0) throw new Error("Rien à enregistrer : aucune modification préparée.");
            const r = await runGit(cwd, ["commit", "-F", "-"], { stdin: a.message, timeoutMs: 120_000 });
            must(r, "git commit");
            const head = must(await runGit(cwd, ["log", "-1", "--date=short", "--pretty=tformat:%h  %s"]), "git log").trim();
            return `Commit créé : ${head}`;
          },
        }),
        defineTool({
          name: "git_push",
          description:
            "Envoie la branche courante vers `origin` (jamais main/master, jamais de force). Sort de la machine : demande toujours confirmation à l'utilisateur.",
          schema: z.object({ project }),
          risk: "external",
          projectOf,
          async check(a) {
            const cwd = repo(a.project);
            requireNotProtected(await currentBranch(cwd), "Push");
            must(await runGit(cwd, ["remote", "get-url", "origin"]), "remote origin");
          },
          async preview(a) {
            const cwd = repo(a.project);
            const branch = await currentBranch(cwd);
            const url = redactRemote(must(await runGit(cwd, ["remote", "get-url", "origin"]), "remote origin"));
            const ahead = await runGit(cwd, ["log", "--no-ext-diff", "--pretty=tformat:%h  %s", "@{u}..HEAD"]);
            const list = ahead.code === 0 ? ahead.out.trim() : "(branche pas encore publiée : tous ses commits partent)";
            return `Envoyer la branche ${branch} de ${a.project} vers ${url}\nCommits à envoyer :\n${list || "(aucun nouveau commit)"}`;
          },
          async run(a, ctx) {
            const cwd = repo(a.project);
            const branch = safeBranch(await currentBranch(cwd));
            requireNotProtected(branch, "Push");
            ctx.ui.progress(`git push origin ${branch}`);
            const r = await runGit(cwd, ["push", "-u", "origin", branch], { timeoutMs: 180_000 });
            must(r, "git push");
            const tail = r.err.trim().split("\n").slice(-8).join("\n");
            return `Branche ${branch} envoyée.\n${tail}`.trim();
          },
        }),
      ];
    },
  };
}
