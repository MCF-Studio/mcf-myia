import { describe, expect, it } from "vitest";
import { reorderProfiles, type AgentProfile } from "./profiles.js";

const list: AgentProfile[] = [
  { id: "myia", name: "MyIA", master: true },
  { id: "redac", name: "Rédac'" },
  { id: "forgeron", name: "Forgeron" },
];

describe("reorderProfiles", () => {
  it("réordonne sans rien changer aux profils", () => {
    const out = reorderProfiles(list, ["forgeron", "myia", "redac"]);
    expect(out.map((p) => p.id)).toEqual(["forgeron", "myia", "redac"]);
    expect(out[1]).toBe(list[0]);
  });

  it("refuse une liste qui n'est pas une permutation exacte", () => {
    for (const ids of [["myia", "redac"], ["myia", "redac", "redac"], ["myia", "redac", "inconnu"], ["myia", "redac", "forgeron", "x"]]) {
      expect(() => reorderProfiles(list, ids)).toThrow(/ordre des agents invalide/);
    }
  });
});
