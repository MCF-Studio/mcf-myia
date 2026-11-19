// Tests du glisser-déposer des listes. Lancés par `npm test` (node --test, types retirés par Node).
import { strict as assert } from "node:assert";
import { describe, it } from "node:test";
import { moveId } from "./reorder.ts";

describe("moveId (glisser-déposer)", () => {
  const ids = ["a", "b", "c", "d"];
  it("place avant ou après la cible", () => {
    assert.deepEqual(moveId(ids, "d", "b", false), ["a", "d", "b", "c"]);
    assert.deepEqual(moveId(ids, "a", "c", true), ["b", "c", "a", "d"]);
    assert.deepEqual(moveId(ids, "a", "d", true), ["b", "c", "d", "a"]);
  });
  it("ne change rien sur soi-même ou un id inconnu", () => {
    assert.deepEqual(moveId(ids, "b", "b", true), ids);
    assert.deepEqual(moveId(ids, "x", "b", true), ids);
    assert.deepEqual(moveId(ids, "b", "x", false), ids);
  });
});
