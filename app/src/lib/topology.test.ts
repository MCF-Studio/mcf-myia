// Tests de la carte des agents. Lancés par `npm test` (node --test, types retirés par Node).
import { strict as assert } from "node:assert";
import { describe, it } from "node:test";
import { agentStatus, agentsGraph, layout, teamGraph, type NodeStatus } from "./topology.ts";

const ok = () => ({ status: "ok" as NodeStatus });
const agent = (id: string, master = false) => ({ id, name: id.toUpperCase(), ...(master ? { master } : {}) });
const node = (agentId: string, subagents: any[] = [], teammates: any[] = []) => ({ id: `n-${agentId}`, agentId, subagents, teammates });
const team = (root: any) => ({ id: "t", name: "Équipe", root, maxCalls: 6, maxDepth: 2 });

describe("graphe des agents", () => {
  const agents = [agent("master", true), agent("chef"), agent("dev"), agent("graph"), agent("seul")];
  const teams = [team(node("chef", [node("dev")], [node("graph")]))];
  const g = agentsGraph(agents, teams, ok);

  it("relie le chef à ses sous-agents et coéquipiers", () => {
    assert.ok(g.edges.some((e) => e.from === "chef" && e.to === "dev" && e.kind === "sub"));
    assert.ok(g.edges.some((e) => e.from === "chef" && e.to === "graph" && e.kind === "mate"));
  });

  it("MASTER pilote les chefs et les agents hors équipe, pas les membres", () => {
    const pilot = g.edges.filter((e) => e.kind === "pilot").map((e) => e.to).sort();
    assert.deepEqual(pilot, ["chef", "seul"]);
  });

  it("les chefs et MASTER sont des nœuds majeurs", () => {
    assert.deepEqual(g.nodes.filter((n) => n.major).map((n) => n.id).sort(), ["chef", "master"]);
  });

  it("une seule arête par paire même si deux équipes relient les mêmes agents", () => {
    const g2 = agentsGraph(agents, [...teams, team(node("dev", [node("chef")]))], ok);
    assert.equal(g2.edges.filter((e) => [e.from, e.to].sort().join() === "chef,dev").length, 1);
  });
});

describe("graphe d'une équipe", () => {
  it("signale un membre dont l'agent a été supprimé", () => {
    const g = teamGraph(team(node("chef", [node("fantome")])), [agent("chef")], ok);
    assert.equal(g.nodes.find((n) => n.id === "fantome")?.status, "error");
  });
});

describe("état d'un agent", () => {
  const ctx = { busy: new Map([["occupe", 1]]), defaultModel: "qwen3:8b", installed: new Set(["qwen3:8b"]), localEngineOk: true, claudeApiKey: false };
  it("répond, prêt, modèle absent, clé manquante, moteur arrêté", () => {
    assert.equal(agentStatus({ id: "occupe", name: "x" }, ctx).status, "busy");
    assert.equal(agentStatus({ id: "a", name: "x" }, ctx).status, "ok");
    assert.equal(agentStatus({ id: "a", name: "x", model: "llama3" }, ctx).status, "error");
    assert.equal(agentStatus({ id: "a", name: "x", model: "claude-api:opus" }, ctx).status, "warn");
    assert.equal(agentStatus({ id: "a", name: "x", model: "claude:sonnet" }, { ...ctx, localEngineOk: false }).status, "ok");
    assert.equal(agentStatus({ id: "a", name: "x" }, { ...ctx, localEngineOk: false }).status, "error");
  });
});

describe("placement", () => {
  const g = agentsGraph([agent("master", true), agent("a"), agent("b"), agent("c"), agent("d")], [], ok);

  it("reste dans [0,1] et sépare les nœuds", () => {
    const p = layout(g);
    for (const n of p) assert.ok(n.x >= 0 && n.x <= 1 && n.y >= 0 && n.y <= 1);
    for (let i = 0; i < p.length; i++)
      for (let j = i + 1; j < p.length; j++) assert.ok(Math.hypot(p[i]!.x - p[j]!.x, p[i]!.y - p[j]!.y) > 0.05);
  });

  it("est reproductible", () => {
    assert.deepEqual(layout(g), layout(g));
  });

  it("un seul nœud au centre", () => {
    const [only] = layout({ nodes: [{ id: "x", label: "X", status: "ok", major: false }], edges: [] });
    assert.equal(only!.x, 0.5);
  });
});
