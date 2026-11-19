// Tests de la grille des conversations. Lancés par `npm test` (node --test, types retirés par Node).
import { strict as assert } from "node:assert";
import { describe, it } from "node:test";
import { flatten, moveTab, normalizeCells, type GridCell } from "./gridCells.ts";

const cell = (...tabs: string[]): GridCell => ({ tabs, active: tabs[0]! });

describe("grille des conversations", () => {
  it("garde les cases enregistrées et ajoute les nouveaux onglets à la fin", () => {
    const out = normalizeCells([cell("b", "a"), cell("x")], ["a", "b", "c"]);
    assert.deepEqual(out, [{ tabs: ["b", "a"], active: "b" }, cell("c")]);
  });
  it("ignore les doublons et un onglet actif fermé", () => {
    const out = normalizeCells([{ tabs: ["a", "b"], active: "z" }, cell("a")], ["a", "b"]);
    assert.deepEqual(out, [{ tabs: ["a", "b"], active: "a" }]);
  });
  it("lâcher dans une case : l'onglet y rejoint les autres et devient affiché", () => {
    const out = moveTab([cell("a"), cell("b"), cell("c")], "c", { cell: 0, mode: "tab" });
    assert.deepEqual(out, [{ tabs: ["a", "c"], active: "c" }, cell("b")]);
  });
  it("lâcher au bord d'une case : nouvelle case avant ou après", () => {
    assert.deepEqual(flatten(moveTab([cell("a"), cell("b"), cell("c")], "c", { cell: 0, mode: "before" })), ["c", "a", "b"]);
    assert.deepEqual(flatten(moveTab([cell("a"), cell("b"), cell("c")], "a", { cell: 2, mode: "after" })), ["b", "c", "a"]);
  });
  it("sortir un onglet d'une case pour le mettre à la fin", () => {
    const out = moveTab([{ tabs: ["a", "b"], active: "b" }, cell("c")], "b", { mode: "end" });
    assert.deepEqual(out, [{ tabs: ["a"], active: "a" }, cell("c"), cell("b")]);
  });
  it("lâcher sur sa propre case seul ne change rien", () => {
    assert.deepEqual(moveTab([cell("a"), cell("b")], "a", { cell: 0, mode: "tab" }), [cell("a"), cell("b")]);
    assert.deepEqual(moveTab([cell("a"), cell("b")], "a", { cell: 0, mode: "after" }), [cell("a"), cell("b")]);
  });
});
