import { describe, expect, it } from "vitest";
import { countNodes, parseTeam, reachable, TeamBudget, type TeamNode } from "./teams.js";

const node = (id: string, agentId: string, subagents: TeamNode[] = [], teammates: TeamNode[] = []): TeamNode => ({
  id,
  agentId,
  subagents,
  teammates,
});

// chef ── sous-agents : redac, veille (veille a un coéquipier : analyste, qui a un sous-agent : stats)
const tree = node("n-chef", "chef", [node("n-redac", "redac"), node("n-veil", "veille", [], [node("n-anal", "analyste", [node("n-stat", "stats")])])]);
const team = { id: "studio", name: "Studio", root: tree };

describe("équipes", () => {
  it("valide un arbre et compte ses agents", () => {
    const t = parseTeam(team, new Set(["chef", "redac", "veille", "analyste", "stats"]));
    expect(countNodes(t.root)).toBe(5);
    expect(t.maxCalls).toBe(8);
  });

  it("refuse un agent inconnu ou un nœud en double", () => {
    expect(() => parseTeam(team, new Set(["chef"]))).toThrow(/inconnu/);
    expect(() => parseTeam({ ...team, root: node("n-chef", "chef", [node("n-chef", "redac")]) })).toThrow(/double/);
  });

  it("un agent n'appelle que ses sous-agents et coéquipiers directs", () => {
    const fromChef = reachable(tree, new Set(["n-chef"])).map((r) => `${r.node.agentId}:${r.relation}`);
    expect(fromChef).toEqual(["redac:sous-agent", "veille:sous-agent"]);
    const veille = tree.subagents[1]!;
    expect(reachable(veille, new Set(["n-chef", "n-veil"])).map((r) => `${r.node.agentId}:${r.relation}`)).toEqual(["analyste:coéquipier"]);
  });

  it("pas de boucle : un agent déjà dans la chaîne n'est plus joignable", () => {
    const veille = tree.subagents[1]!;
    expect(reachable(veille, new Set(["n-chef", "n-veil", "n-anal"]))).toEqual([]);
  });

  it("le budget borne les appels et la profondeur", () => {
    const b = new TeamBudget(2, 2);
    expect(b.take(1)).toBeUndefined();
    expect(b.take(3)).toMatch(/profondeur/);
    expect(b.take(2)).toBeUndefined();
    expect(b.take(1)).toMatch(/budget/);
  });
});
