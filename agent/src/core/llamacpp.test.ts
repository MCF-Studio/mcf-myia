import { describe, expect, it } from "vitest";
import { fromOpenAI, toOpenAI } from "./llamacpp.js";
import type { ChatMessage } from "./llm.js";

describe("llama.cpp : conversion des messages", () => {
  it("relie chaque résultat d'outil à l'identifiant de son appel", () => {
    const history: ChatMessage[] = [
      { role: "system", content: "règles" },
      { role: "user", content: "crée deux fichiers" },
      {
        role: "assistant",
        content: "",
        tool_calls: [
          { function: { name: "file_write", arguments: { path: "a.md", content: "A" } } },
          { function: { name: "open_path", arguments: '{"path":"a.md"}' } },
        ],
      },
      { role: "tool", tool_name: "open_path", content: "ouvert" },
      { role: "tool", tool_name: "file_write", content: "créé" },
    ];
    const out = toOpenAI(history);
    const calls = out[2]!.tool_calls!;
    expect(calls.map((c) => c.function)).toEqual([
      { name: "file_write", arguments: '{"path":"a.md","content":"A"}' },
      { name: "open_path", arguments: '{"path":"a.md"}' },
    ]);
    expect(out[3]).toEqual({ role: "tool", content: "ouvert", tool_call_id: calls[1]!.id });
    expect(out[4]).toEqual({ role: "tool", content: "créé", tool_call_id: calls[0]!.id });
    expect(new Set(calls.map((c) => c.id)).size).toBe(2);
  });

  it("relit les appels d'outils de la réponse (arguments JSON décodés)", () => {
    expect(
      fromOpenAI({ content: "", tool_calls: [{ function: { name: "file_write", arguments: '{"path":"notes.md","content":"bonjour"}' } }] }),
    ).toEqual({ role: "assistant", content: "", tool_calls: [{ function: { name: "file_write", arguments: { path: "notes.md", content: "bonjour" } } }] });
    expect(fromOpenAI({ content: "Salut", tool_calls: [] })).toEqual({ role: "assistant", content: "Salut" });
    expect(fromOpenAI({ content: null, tool_calls: [{ function: { name: "x", arguments: "pas du json" } }] }).tool_calls![0]!.function.arguments).toBe("pas du json");
  });
});
