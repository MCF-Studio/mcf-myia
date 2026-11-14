import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { needsConfirmation } from "../core/agent.js";
import { parseConfig } from "../core/config.js";
import type { Tool, ToolContext, ToolScope } from "../core/types.js";
import { toolboxService, type ManagerReply, type ManagerRunner, type ToolboxEntry } from "./toolbox.js";

const CATALOG: ToolboxEntry[] = [
  {
    name: "image_color_replace",
    category: "images",
    description: "Remplace une couleur par une autre sur une image ou tout un dossier.",
    risk: "local",
    needs_confirmation: true,
    enabled: true,
    permissions: ["filesystem.read", "filesystem.write"],
    parameters: {
      path: { type: "string", required: true, kind: "path" },
      output: { type: "string", required: true, kind: "path", access: "write" },
      from: { type: "string" },
      to: { type: "string" },
    },
  },
  {
    name: "texture_info",
    category: "textures",
    description: "Dimensions et format d'une texture.",
    risk: "read",
    needs_confirmation: false,
    enabled: true,
    permissions: ["filesystem.read"],
    parameters: { path: { type: "string", required: true } },
  },
  {
    name: "cargo_build",
    category: "rust",
    description: "Compile un projet Rust.",
    risk: "local",
    needs_confirmation: true,
    enabled: false,
    permissions: ["process.exec"],
    parameters: { project: { type: "string", required: true } },
  },
  {
    name: "git_status",
    category: "git",
    description: "État git.",
    risk: "read",
    needs_confirmation: false,
    enabled: true,
    permissions: ["process.exec.readonly"],
    parameters: { repo: { type: "string", required: true } },
  },
];

interface Call {
  args: string[];
  params: unknown;
}

let dir: string;
let calls: Call[] = [];
let dryRunReply: ManagerReply | undefined;

const ok = (data: unknown, code = 0): ManagerReply => ({ success: true, data, error: null, warnings: [], code });

const runner: ManagerRunner = async (args, stdin) => {
  calls.push({ args, params: stdin === undefined ? undefined : JSON.parse(stdin) });
  if (args[0] === "list") return ok(CATALOG);
  if (args.includes("--confirmed") || args[1] === "texture_info") return ok({ done: args[1] });
  return (
    dryRunReply ?? {
      success: false,
      data: { preview: { action: "image_color_replace (risque local)\ncrée : I:\\out.png", params: JSON.parse(stdin!) } },
      error: { type: "ConfirmationRequired", message: "rien n'a été exécuté" },
      warnings: [],
      code: 2,
    }
  );
};

const ui = { confirm: async () => true, progress: () => undefined };

async function setup(extra: object = {}) {
  const cfg = parseConfig({ toolbox: { dir }, ...extra });
  const svc = toolboxService(cfg, { runner });
  const status = await svc.available();
  const tools = Object.fromEntries(svc.tools().map((t) => [t.name, t])) as Record<string, Tool>;
  return { cfg, svc, status, tools };
}

/** Rejoue la séquence de l'agent (core/agent.ts → execute) : parse, check, confirmation éventuelle, run. */
async function call(tools: Record<string, Tool>, cfg: ReturnType<typeof parseConfig>, raw: object, scope: ToolScope = {}) {
  const t = tools.toolbox_run!;
  const args = t.parse(raw);
  await t.check!(args, scope);
  const confirm = needsConfirmation(t, undefined, cfg, args, undefined, scope);
  const preview = confirm ? await t.preview(args, scope) : undefined;
  const out = await t.run(args, { ui, ...scope } as unknown as ToolContext);
  return { confirm, preview, out };
}

beforeAll(() => {
  dir = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), "myia-toolbox-")));
  fs.writeFileSync(path.join(dir, "tool_manager.py"), "# faux\n");
});
afterAll(() => fs.rmSync(dir, { recursive: true, force: true }));

describe("boîte à outils", () => {
  it("indisponible sans tool_manager.py", async () => {
    const svc = toolboxService(parseConfig({ toolbox: { dir: path.join(dir, "absent") } }), { runner });
    const st = await svc.available();
    expect(st.ok).toBe(false);
    expect(st.reason).toMatch(/tool_manager\.py introuvable/);
  });

  it("indisponible si le gestionnaire refuse de démarrer (politique absente)", async () => {
    const refusing: ManagerRunner = async () => ({
      success: false,
      data: null,
      error: { type: "PolicyMissing", message: "tools/policy.json absent" },
      warnings: [],
      code: 1,
    });
    const st = await toolboxService(parseConfig({ toolbox: { dir } }), { runner: refusing }).available();
    expect(st).toEqual({ ok: false, reason: "PolicyMissing : tools/policy.json absent" });
  });

  it("deux outils seulement sont montrés au modèle", async () => {
    const { status, tools } = await setup();
    expect(status.ok).toBe(true);
    expect(Object.keys(tools).sort()).toEqual(["toolbox_find", "toolbox_run"]);
  });

  it("toolbox_find détaille les paramètres de l'outil qui correspond", async () => {
    const { tools } = await setup();
    calls = [];
    const out = await tools.toolbox_find!.run(tools.toolbox_find!.parse({ query: "changer la couleur d'une image" }), { ui } as unknown as ToolContext);
    expect(out).toMatch(/^image_color_replace/);
    expect(out).toMatch(/output \(string, obligatoire, chemin écrit\)/);
    // ni l'outil en double avec l'app, ni l'outil désactivé
    expect(out).not.toMatch(/git_status|cargo_build/);
  });

  it("outil `read` : ni confirmation ni --confirmed", async () => {
    const { cfg, tools } = await setup();
    calls = [];
    const r = await call(tools, cfg, { tool: "texture_info", params: { path: "I:/a.png" } });
    expect(r.confirm).toBe(false);
    expect(calls).toEqual([{ args: ["run", "texture_info", "-"], params: { path: "I:/a.png" } }]);
  });

  it("outil `local` : essai sans --confirmed, aperçu du gestionnaire, puis --confirmed seulement au lancement", async () => {
    const { cfg, tools } = await setup();
    calls = [];
    dryRunReply = undefined;
    const params = { path: "I:/a.png", output: "I:/out.png", from: "white", to: "#ff69b4" };
    const r = await call(tools, cfg, { tool: "image_color_replace", params });
    expect(r.confirm).toBe(true);
    expect(r.preview).toMatch(/crée : I:\\out\.png/);
    expect(r.preview).toMatch(/to = "#ff69b4"/);
    expect(calls.map((c) => c.args)).toEqual([
      ["run", "image_color_replace", "-"],
      ["run", "image_color_replace", "-", "--confirmed"],
    ]);
  });

  it("autoApprove d'un projet ne dispense jamais de la confirmation", async () => {
    const { tools } = await setup();
    const cfg = parseConfig({ toolbox: { dir }, projects: { p: { path: dir, autoApprove: true } } });
    const t = tools.toolbox_run!;
    const args = t.parse({ tool: "image_color_replace", params: {} });
    expect(needsConfirmation(t, t.projectOf?.(args), cfg, args)).toBe(true);
  });

  it("refus du gestionnaire à l'essai : erreur avant toute confirmation", async () => {
    const { cfg, tools } = await setup();
    dryRunReply = { success: false, data: null, error: { type: "PathDenied", message: "hors des dossiers autorisés" }, warnings: [], code: 1 };
    await expect(call(tools, cfg, { tool: "image_color_replace", params: { path: "C:/x.png", output: "C:/y.png" } })).rejects.toThrow(
      /PathDenied : hors des dossiers autorisés/,
    );
    dryRunReply = undefined;
  });

  it("paramètre manquant ou inconnu : refusé sans appeler le gestionnaire", async () => {
    const { cfg, tools } = await setup();
    calls = [];
    await expect(call(tools, cfg, { tool: "image_color_replace", params: { path: "I:/a.png" } })).rejects.toThrow(/manquants.*output/);
    await expect(call(tools, cfg, { tool: "texture_info", params: { path: "I:/a.png", shell: "x" } })).rejects.toThrow(/inconnus.*shell/);
    expect(calls).toEqual([]);
  });

  it("outil exclu (doublon de l'app) ou désactivé par la politique : refusé", async () => {
    const { cfg, tools } = await setup();
    await expect(call(tools, cfg, { tool: "git_status", params: { repo: "I:/x" } })).rejects.toThrow(/outil équivalent de l'app/);
    await expect(call(tools, cfg, { tool: "cargo_build", params: { project: "I:/x" } })).rejects.toThrow(/process\.exec.*policy\.json/);
    await expect(call(tools, cfg, { tool: "inexistant", params: {} })).rejects.toThrow(/toolbox_find/);
  });

  it("chemin relatif : résolu dans l'espace de travail de l'agent", async () => {
    const { cfg, tools } = await setup();
    calls = [];
    await call(tools, cfg, { tool: "texture_info", params: { path: "sprites/a.png" } }, { workspace: dir });
    expect(calls[0]!.params).toEqual({ path: path.join(dir, "sprites", "a.png") });
  });

  it("agent sur un modèle en ligne : aucun chemin dans les dossiers de mémoire", async () => {
    const mem = path.join(dir, "notes");
    fs.mkdirSync(mem, { recursive: true });
    const { cfg, tools } = await setup({ memory: { folders: [mem] } });
    calls = [];
    await expect(call(tools, cfg, { tool: "texture_info", params: { path: path.join(mem, "a.png") } }, { cloud: true })).rejects.toThrow(/mémoire/);
    expect(calls).toEqual([]);
    // un agent local, lui, peut
    await call(tools, cfg, { tool: "texture_info", params: { path: path.join(mem, "a.png") } }, {});
    // ni un dossier PARENT de la mémoire (un outil récursif la parcourrait)
    await expect(call(tools, cfg, { tool: "texture_info", params: { path: dir } }, { cloud: true })).rejects.toThrow(/mémoire/);
    expect(calls.length).toBe(1);
    // et un agent en ligne garde tout le reste de la boîte
    const other = path.join(dir, "autre");
    fs.mkdirSync(other, { recursive: true });
    await call(tools, cfg, { tool: "texture_info", params: { path: path.join(other, "a.png") } }, { cloud: true });
  });

  it("chemin relatif sans espace de travail : refusé sans appeler le gestionnaire", async () => {
    const { cfg, tools } = await setup();
    calls = [];
    await expect(call(tools, cfg, { tool: "texture_info", params: { path: "sprites/a.png" } })).rejects.toThrow(/chemin complet/);
    await expect(call(tools, cfg, { tool: "texture_info", params: { path: "C:a.png" } })).rejects.toThrow(/chemin complet/);
    if (process.platform === "win32") {
      await expect(call(tools, cfg, { tool: "texture_info", params: { path: "\\data\\a.png" } }, { workspace: dir })).rejects.toThrow(/lettre du disque/);
    }
    expect(calls).toEqual([]);
  });
});
