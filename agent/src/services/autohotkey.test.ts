import { describe, expect, it } from "vitest";
import { imageToScreen, parseInfo, toAhkKeys } from "./autohotkey.js";

describe("contrôle de l'écran (AutoHotkey)", () => {
  it("touches : seulement des combinaisons connues, jamais de syntaxe AutoHotkey libre", () => {
    expect(toAhkKeys("ctrl+s")).toBe("^s");
    expect(toAhkKeys("Ctrl+Shift+T")).toBe("^+t");
    expect(toAhkKeys("alt+tab")).toBe("!{Tab}");
    expect(toAhkKeys("win+d")).toBe("#d");
    expect(toAhkKeys("entrée".normalize("NFD").replace(/\p{M}/gu, ""))).toBe("{Enter}");
    expect(toAhkKeys("f5")).toBe("{F5}");
    for (const bad of ["{Enter}", "^s", "ctrl+{Raw}x", "Run notepad", "ctrl+alt+delete", "hyper+a", "a+b", "", "ctrl+"]) {
      expect(() => toAhkKeys(bad), bad).toThrow();
    }
  });

  it("lit la réponse d'AutoHotkey", () => {
    expect(parseInfo(["0 -768 4480 2208 3 450 950", "Bloc-notes"])).toEqual({
      left: 0, top: -768, width: 4480, height: 2208, monitors: 3, mouseX: 450, mouseY: 950, activeWindow: "Bloc-notes",
    });
    expect(() => parseInfo(["oups"])).toThrow();
  });

  it("position dans la capture réduite → coordonnées du bureau", () => {
    const screen = { left: 0, top: -768, width: 4480, height: 2208 };
    expect(imageToScreen(644, 317, { width: 1288, height: 635 }, screen)).toEqual({ x: 2240, y: 334 });
    expect(imageToScreen(-5, 9999, { width: 1288, height: 635 }, screen)).toEqual({ x: 0, y: 1439 });
  });
});
