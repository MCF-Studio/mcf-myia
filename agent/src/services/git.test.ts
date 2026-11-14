import { execFileSync } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { needsConfirmation } from "../core/agent.js";
import { parseConfig } from "../core/config.js";
import { ProjectRegistry } from "../core/projects.js";
import type { ToolContext } from "../core/types.js";
import { gitService, isSecretFile, redactRemote, safeBranch, safeRef, safeRel } from "./git.js";

const git = (cwd: string, ...a: string[]) => execFileSync("git", a, { cwd, encoding: "utf8" });
const ctx = { ui: { confirm: async () => true, progress: () => undefined } } as unknown as ToolContext;

let dir: string;
let cfg: ReturnType<typeof parseConfig>;
let tools: Record<string, ReturnType<ReturnType<typeof gitService>["tools"]>[number]>;

const call = async (name: string, raw: object) => {
  const t = tools[name]!;
  const args = t.parse(raw);
  await t.check?.(args);
  return t.run(args, ctx);
};

beforeAll(() => {
  dir = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), "myia-git-")));
  git(dir, "init", "-q", "-b", "main");
  git(dir, "config", "user.email", "t@example.org");
  git(dir, "config", "user.name", "Test");
  git(dir, "config", "commit.gpgsign", "false");
  fs.writeFileSync(path.join(dir, "a.txt"), "un\n");
  git(dir, "add", "-A");
  git(dir, "commit", "-q", "-m", "init");
  cfg = parseConfig({ projects: { demo: { path: dir } } });
  tools = Object.fromEntries(gitService(new ProjectRegistry(cfg)).tools().map((t) => [t.name, t]));
});
afterAll(() => fs.rmSync(dir, { recursive: true, force: true }));

describe("git natif : validations", () => {
  it("refuse options, chemins absolus et remontées", () => {
    for (const p of ["--output=x", "/etc/passwd", "C:\\x", "../x", "a/../../x", ":(top)x", ""]) expect(() => safeRel(p), p).toThrow();
    expect(safeRel("src\\a.ts")).toBe("src/a.ts");
  });
  it("refuse les références et branches louches", () => {
    for (const r of ["--upload-pack=x", "a b", "-x", "a;b"]) expect(() => safeRef(r), r).toThrow();
    for (const b of ["-d", "a..b", "x.lock", "a//b", "fin/", "a b"]) expect(() => safeBranch(b), b).toThrow();
    expect(() => safeBranch("feat/ok-1")).not.toThrow();
  });
  it("reconnaît les fichiers de secrets", () => {
    for (const f of [".env", "app/.env.local", "id_rsa", "k.pem", "config/agent.json", "x/credentials.json"]) expect(isSecretFile(f), f).toBe(true);
    for (const f of [".env.example", "README.md", "src/agent.ts", "package.json"]) expect(isSecretFile(f), f).toBe(false);
  });
  it("masque l'identifiant dans l'URL du distant", () => {
    expect(redactRemote("https://user:tok@github.com/a/b.git\n")).toBe("https://github.com/a/b.git");
  });
});

describe("git natif : niveaux de risque", () => {
  it("lecture libre, commit/switch confirmés, push toujours confirmé même en autoApprove", () => {
    for (const n of ["git_status", "git_log", "git_diff", "git_show", "git_branches"]) expect(needsConfirmation(tools[n]!, "demo", cfg)).toBe(false);
    expect(needsConfirmation(tools.git_commit!, undefined, cfg)).toBe(true);
    const auto = parseConfig({ projects: { demo: { path: dir, autoApprove: true } } });
    expect(needsConfirmation(tools.git_commit!, "demo", auto)).toBe(false);
    expect(needsConfirmation(tools.git_push!, "demo", auto)).toBe(true);
  });
});

describe("git natif : sur un vrai dépôt", () => {
  it("status, log, diff, branches", async () => {
    expect(await call("git_status", { project: "demo" })).toMatch(/Branche : main[\s\S]*propre/);
    expect(await call("git_log", { project: "demo" })).toMatch(/init/);
    fs.writeFileSync(path.join(dir, "a.txt"), "un\ndeux\n");
    expect(await call("git_diff", { project: "demo" })).toMatch(/a\.txt {2}\(\+1 −0\)[\s\S]*\+deux/);
    expect(await call("git_branches", { project: "demo" })).toMatch(/\* main/);
    expect(await call("git_show", { project: "demo" })).toMatch(/init/);
  });

  it("refuse de commiter sur main, puis commite sur une branche", async () => {
    await expect(call("git_commit", { project: "demo", message: "essai", all: true })).rejects.toThrow(/directement sur « main »/);
    await call("git_switch", { project: "demo", branch: "feat/test", create: true });
    expect(await call("git_commit", { project: "demo", message: "feat: deux", paths: ["a.txt"] })).toMatch(/Commit créé : \w+ {2}feat: deux/);
    expect(git(dir, "log", "-1", "--pretty=%s")).toBe("feat: deux\n");
    await expect(call("git_commit", { project: "demo", message: "rien du tout" })).rejects.toThrow(/Rien à enregistrer/);
  });

  it("refuse un fichier de secrets, en paths comme en all=true", async () => {
    fs.writeFileSync(path.join(dir, ".env"), "TOKEN=x\n");
    await expect(call("git_commit", { project: "demo", message: "secret", paths: [".env"] })).rejects.toThrow(/secrets/);
    await expect(call("git_commit", { project: "demo", message: "secret", all: true })).rejects.toThrow(/secrets/);
    expect(git(dir, "status", "--short")).toMatch(/\?\? \.env/); // rien n'a été préparé
    fs.rmSync(path.join(dir, ".env"));
  });

  it("push refusé sur main et sans origin", async () => {
    await expect(call("git_push", { project: "demo" })).rejects.toThrow(/origin/);
    await call("git_switch", { project: "demo", branch: "main" });
    await expect(call("git_push", { project: "demo" })).rejects.toThrow(/directement sur « main »/);
  });

  it("un projet inconnu ou sans .git est refusé", async () => {
    await expect(call("git_status", { project: "inexistant-xyz" })).rejects.toThrow(/aucun projet/);
  });
});
