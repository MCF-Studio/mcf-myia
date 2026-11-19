// Tests des petits formats d'affichage. Lancés par `npm test` (node --test, types retirés par Node).
import { strict as assert } from "node:assert";
import { describe, it } from "node:test";
import { stripAnsi } from "./format.ts";

describe("stripAnsi", () => {
  it("retire les couleurs d'une sortie de tests", () => {
    assert.equal(stripAnsi("\x1b[2m Test Files \x1b[22m \x1b[1m\x1b[32m54 passed\x1b[39m\x1b[22m"), " Test Files  54 passed");
  });
  it("retire un titre de fenêtre et garde le texte normal", () => {
    assert.equal(stripAnsi("\x1b]0;titre\x07ok [33m reste"), "ok [33m reste");
  });
});
