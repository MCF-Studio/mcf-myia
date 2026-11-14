import { describe, expect, it } from "vitest";
import type { AgentProfile } from "./profiles.js";
import { scriptHash, type ScriptPack } from "./scripts.js";
import type { Team } from "./teams.js";
import { exportWorkflow, freeId, parseWorkflow, planImport, WORKFLOW_MAX_BYTES, WORKFLOW_SCHEMA } from "./workflow.js";

const profiles: AgentProfile[] = [
  { id: "chef", name: "Chef", instructions: "Tu coordonnes.", master: true, workspace: "D:\\projets\\secret" },
  { id: "modeleur", name: "Modeleur 3D", model: "qwen3:8b", services: ["godot", "files"] },
  { id: "hors-equipe", name: "Autre" },
];

const team: Team = {
  id: "studio-3d",
  name: "Studio 3D",
  description: "Scènes Godot",
  workspace: "D:\\projets\\jeu",
  root: { id: "n-chef", agentId: "chef", subagents: [{ id: "n-mod", agentId: "modeleur", subagents: [], teammates: [] }], teammates: [] },
  maxCalls: 6,
  maxDepth: 2,
  scripts: ["godot-pont"],
};

const script: ScriptPack = { id: "godot-pont", name: "Pont Godot", entry: "server.py", files: [{ path: "server.py", content: "print('x')\n" }] };

const emptyState = { profiles: [{ id: "myia", name: "MyIA" }] as AgentProfile[], teams: [] as Team[], scripts: new Map<string, string>() };

describe("export d'une équipe en workflow", () => {
  const { json } = exportWorkflow(team, profiles, [script]);
  const raw = JSON.parse(json) as Record<string, any>;

  it("embarque l'équipe, ses agents et ses scripts, et rien d'autre", () => {
    expect(raw.$schema).toBe(WORKFLOW_SCHEMA);
    expect(raw.name).toBe("Studio 3D");
    expect(raw.agents.map((a: AgentProfile) => a.id)).toEqual(["chef", "modeleur"]);
    expect(raw.scripts).toHaveLength(1);
    expect(raw.scripts[0].files[0].content).toBe("print('x')\n");
  });

  it("ne laisse sortir ni espace de travail ni rôle MASTER", () => {
    expect(json).not.toContain("D:\\\\projets");
    expect(json).not.toContain("workspace");
    expect(json).not.toContain("master");
  });

  it("refuse d'exporter une équipe dont un agent a disparu", () => {
    expect(() => exportWorkflow(team, profiles.slice(0, 1), [])).toThrow(/introuvable/);
  });

  it("retire les photos plutôt que de dépasser la taille maximale", () => {
    const avatar = `data:image/png;base64,${"A".repeat(149_000)}`;
    const many: AgentProfile[] = Array.from({ length: 6 }, (_, i) => ({ id: `a${i}`, name: `A${i}`, avatar }));
    const big: Team = { id: "t", name: "Grande", maxCalls: 8, maxDepth: 3, root: { id: "n-00", agentId: "a0", teammates: [], subagents: many.slice(1).map((a, i) => ({ id: `n-0${i + 1}`, agentId: a.id, subagents: [], teammates: [] })) } };
    const r = exportWorkflow(big, many, []);
    expect(r.avatarsDropped).toBe(true);
    expect(Buffer.byteLength(r.json)).toBeLessThan(WORKFLOW_MAX_BYTES);
  });
});

describe("lecture d'un workflow reçu", () => {
  const { json } = exportWorkflow(team, profiles, [script]);
  const edit = (f: (raw: Record<string, any>) => void) => {
    const raw = JSON.parse(json) as Record<string, any>;
    f(raw);
    return JSON.stringify(raw);
  };

  it("accepte ce que l'app exporte", () => {
    expect(parseWorkflow(json).agents).toHaveLength(2);
  });

  it("refuse ce qui n'est pas un workflow, ou trop gros", () => {
    expect(() => parseWorkflow("{")).toThrow(/JSON/);
    expect(() => parseWorkflow(JSON.stringify({ id: "x", name: "agent" }))).toThrow(/pas un workflow/);
    expect(() => parseWorkflow(edit((r) => (r.$schema = "myia/workflow@2")))).toThrow(/pas un workflow/);
    expect(() => parseWorkflow(" ".repeat(WORKFLOW_MAX_BYTES + 1))).toThrow(/volumineux/);
  });

  it("ignore un espace de travail ou un rôle MASTER glissé dans le fichier", () => {
    const wf = parseWorkflow(edit((r) => Object.assign(r.agents[0], { master: true, workspace: "C:\\Users" })));
    expect(wf.agents[0]).not.toHaveProperty("master");
    expect(wf.agents[0]).not.toHaveProperty("workspace");
  });

  it("refuse une équipe incohérente", () => {
    expect(() => parseWorkflow(edit((r) => (r.team.root.agentId = "absent")))).toThrow(/absent du fichier/);
    expect(() => parseWorkflow(edit((r) => r.agents.push(r.agents[0])))).toThrow(/agent en double/);
    expect(() => parseWorkflow(edit((r) => (r.team.root.subagents[0].id = "n-chef")))).toThrow(/nœud en double/);
    expect(() => parseWorkflow(edit((r) => r.scripts.push(r.scripts[0])))).toThrow(/script en double/);
  });

  it("refuse un script piégé (chemin qui sort du dossier, exécutable, mauvais point d'entrée)", () => {
    expect(() => parseWorkflow(edit((r) => (r.scripts[0].files[0].path = "../../config/agent.json")))).toThrow(/invalide/);
    expect(() => parseWorkflow(edit((r) => r.scripts[0].files.push({ path: "outil.exe", content: "MZ" })))).toThrow(/invalide/);
    expect(() => parseWorkflow(edit((r) => (r.scripts[0].entry = "absent.py")))).toThrow(/invalide/);
    expect(() => parseWorkflow(edit((r) => (r.agents[1].model = "http://evil/model")))).toThrow(/invalide/);
  });
});

describe("plan d'installation", () => {
  const wf = parseWorkflow(exportWorkflow(team, profiles, [script]).json);

  it("sur une installation vierge : tout est ajouté sous les mêmes ids", () => {
    const plan = planImport(wf, emptyState);
    expect(plan.newProfiles.map((p) => p.id)).toEqual(["chef", "modeleur"]);
    expect(plan.newScripts.map((s) => s.id)).toEqual(["godot-pont"]);
    expect(plan.team).toMatchObject({ id: "studio-3d", name: "Studio 3D", maxCalls: 6, maxDepth: 2, scripts: ["godot-pont"] });
    expect(plan.team.workspace).toBeUndefined();
    expect(plan.renamed).toEqual([]);
  });

  it("réutilise un agent et un script déjà présents à l'identique", () => {
    const state = {
      profiles: [...emptyState.profiles, { ...profiles[1]!, workspace: "E:\\ici" }],
      teams: [],
      scripts: new Map([["godot-pont", scriptHash(script)]]),
    };
    const plan = planImport(wf, state);
    expect(plan.reusedAgents).toEqual(["modeleur"]);
    expect(plan.reusedScripts).toEqual(["godot-pont"]);
    expect(plan.newProfiles.map((p) => p.id)).toEqual(["chef"]);
    expect(plan.newScripts).toEqual([]);
  });

  it("n'écrase jamais : un id pris par un contenu différent donne un nouvel id, reporté dans l'arbre", () => {
    const state = {
      profiles: [...emptyState.profiles, { id: "chef", name: "Mon chef à moi" }, { id: "modeleur", name: "Autre modeleur" }],
      teams: [{ ...team, id: "studio-3d" }],
      scripts: new Map([["godot-pont", "0".repeat(64)]]),
    };
    const plan = planImport(wf, state);
    expect(plan.newProfiles.map((p) => p.id)).toEqual(["chef-2", "modeleur-2"]);
    expect(plan.team.id).toBe("studio-3d-2");
    expect(plan.team.root.agentId).toBe("chef-2");
    expect(plan.team.root.subagents[0]!.agentId).toBe("modeleur-2");
    expect(plan.team.scripts).toEqual(["godot-pont-2"]);
    expect(plan.newScripts[0]!.id).toBe("godot-pont-2");
    expect(plan.renamed).toHaveLength(3);
  });

  it("refuse de dépasser la limite d'agents", () => {
    const full = { ...emptyState, profiles: Array.from({ length: 99 }, (_, i) => ({ id: `x${i}`, name: `X${i}` })) };
    expect(() => planImport(wf, full)).toThrow(/trop d'agents/);
  });

  it("freeId reste dans la limite de 40 caractères", () => {
    const base = "a".repeat(40);
    const id = freeId(base, new Set([base]));
    expect(id).toHaveLength(40);
    expect(id.endsWith("-2")).toBe(true);
  });
});
