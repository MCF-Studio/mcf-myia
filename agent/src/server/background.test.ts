import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { afterAll, describe, expect, it, vi } from "vitest";

// Dossier MyIA jetable : paths.ts lit MYIA_HOME à l'import.
const home = vi.hoisted(() => {
  const p = require("node:path").join(require("node:os").tmpdir(), `myia-bg-${process.pid}-${Date.now()}`);
  process.env.MYIA_HOME = p;
  return p;
});

import { clearBackground, MAX_BACKGROUND_BYTES, readBackground, setBackground } from "./background.js";

const src = fs.mkdtempSync(path.join(os.tmpdir(), "myia-bg-src-"));
const write = (name: string, data: Buffer) => {
  const p = path.join(src, name);
  fs.writeFileSync(p, data);
  return p;
};
const GIF = Buffer.concat([Buffer.from("GIF89a"), Buffer.alloc(32)]);
const PNG = Buffer.concat([Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]), Buffer.alloc(32)]);
const stored = () => fs.readdirSync(path.join(home, "data", "backgrounds"));

afterAll(() => {
  fs.rmSync(home, { recursive: true, force: true });
  fs.rmSync(src, { recursive: true, force: true });
});

describe("image de fond", () => {
  it("copie un GIF et le rend en data: URL", () => {
    const res = setBackground(write("anim.gif", GIF));
    expect(res.mime).toBe("image/gif");
    expect(res.file).toMatch(/^wallpaper-[0-9a-f]{16}\.gif$/);
    expect(readBackground(res.file)?.dataUrl.startsWith("data:image/gif;base64,")).toBe(true);
  });

  it("reconnaît le type à la signature, pas à l'extension", () => {
    expect(setBackground(write("trompeur.gif", PNG)).mime).toBe("image/png");
    expect(() => setBackground(write("faux.png", Buffer.from("pas une image du tout")))).toThrow(/format non reconnu/);
  });

  it("remplace l'image précédente au lieu d'empiler les copies", () => {
    setBackground(write("a.gif", GIF));
    const { file } = setBackground(write("b.png", PNG));
    expect(stored()).toEqual([file]);
  });

  it("refuse une image trop lourde et un chemin relatif", () => {
    expect(() => setBackground(write("lourd.gif", Buffer.concat([GIF, Buffer.alloc(MAX_BACKGROUND_BYTES)])))).toThrow(/trop lourde/);
    expect(() => setBackground("relatif.png")).toThrow(/invalide/);
  });

  it("ne lit que ses propres fichiers", () => {
    expect(() => readBackground("../app-settings.json")).toThrow(/invalide/);
    expect(readBackground("wallpaper-0000000000000000.png")).toBeNull();
  });

  it("retire tout", () => {
    clearBackground();
    expect(stored()).toEqual([]);
  });
});
