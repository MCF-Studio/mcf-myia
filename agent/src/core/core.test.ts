import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import AdmZip from "adm-zip";
import { describe, expect, it } from "vitest";
import { addonTarget, addonsDepth, enablePlugins, extractAddons, newProjectGodot } from "../services/godot-addons.js";
import { needsConfirmation } from "./agent.js";
import { audit } from "./audit.js";
import { parseConfig } from "./config.js";
import { analyzeProject, godotVersionOf, parseExportPresets, ProjectRegistry } from "./projects.js";
import { clearTrustedUrls, isTrustedUrl, trustUrlsIn } from "./urls.js";
import { htmlToText, isPublicAddress, parseDuckDuckGo } from "../services/web.js";
import { redact } from "./secrets.js";

describe("politique de confirmation (SPEC §3)", () => {
  const cfg = parseConfig({ projects: { auto: { path: "x", autoApprove: true }, manuel: { path: "y" } } });

  it("read : jamais de confirmation", () => {
    expect(needsConfirmation({ risk: "read" }, undefined, cfg)).toBe(false);
  });
  it("external : toujours, même sur un projet autoApprove", () => {
    expect(needsConfirmation({ risk: "external" }, "auto", cfg)).toBe(true);
  });
  it("launch : pas de confirmation, sauf si l'outil la demande pour ces arguments", () => {
    expect(needsConfirmation({ risk: "launch" }, undefined, cfg)).toBe(false);
    expect(needsConfirmation({ risk: "launch", confirmIf: () => true }, undefined, cfg, {})).toBe(true);
  });
  it("local : confirmation sauf projet autoApprove", () => {
    expect(needsConfirmation({ risk: "local" }, "auto", cfg)).toBe(false);
    expect(needsConfirmation({ risk: "local" }, "manuel", cfg)).toBe(true);
    expect(needsConfirmation({ risk: "local" }, undefined, cfg)).toBe(true);
    expect(needsConfirmation({ risk: "local" }, "inconnu", cfg)).toBe(true);
  });
});

describe("configuration", () => {
  it("valeurs par défaut", () => {
    const c = parseConfig({});
    expect(c.llm.model).toBe("qwen3:8b");
    expect(c.llm.baseUrl).toBe("http://127.0.0.1:11434");
  });
  it("refuse un Ollama non local", () => {
    expect(() => parseConfig({ llm: { baseUrl: "http://192.168.1.10:11434" } })).toThrow(/local/);
    expect(() => parseConfig({ llm: { baseUrl: "http://127.0.0.1.evil.com" } })).toThrow();
  });
  it("une commande de build est un argv non vide", () => {
    expect(() => parseConfig({ projects: { p: { path: "x", build: { default: [] } } } })).toThrow();
  });
});

describe("addons Godot : sécurité de l'extraction", () => {
  it("rejette les chemins qui sortent du projet", () => {
    expect(addonTarget("repo/addons/../../evil.gd", 1)).toBeNull();
    expect(addonTarget("/addons/x/a.gd", 0)).toBeNull();
    expect(addonTarget("C:/addons/x/a.gd", 0)).toBeNull();
    expect(addonTarget("repo\\addons\\..\\..\\evil.gd", 1)).toBeNull();
  });
  it("ne garde que addons/<nom>/… au bon niveau", () => {
    expect(addonTarget("repo-main/addons/dlg/plugin.cfg", 1)).toBe("addons/dlg/plugin.cfg");
    expect(addonTarget("repo-main/README.md", 1)).toBeNull();
    expect(addonTarget("repo-main/demo/addons/dlg/x.gd", 1)).toBeNull();
    expect(addonsDepth(["r/demo/addons/a/x.gd", "r/addons/a/x.gd"])).toBe(1);
  });
  it("extrait une archive réaliste et trouve le plugin", () => {
    const zip = new AdmZip();
    zip.addFile("repo-main/README.md", Buffer.from("hi"));
    zip.addFile("repo-main/addons/dlg/plugin.cfg", Buffer.from("[plugin]\nname=\"dlg\""));
    zip.addFile("repo-main/addons/dlg/main.gd", Buffer.from("extends Node"));
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), "myia-"));
    const res = extractAddons(zip.toBuffer(), dir);
    expect(res.folders).toEqual(["dlg"]);
    expect(res.plugins).toEqual(["res://addons/dlg/plugin.cfg"]);
    expect(fs.existsSync(path.join(dir, "README.md"))).toBe(false);
    expect(() => extractAddons(zip.toBuffer(), dir)).toThrow(/existe déjà/);
    fs.rmSync(dir, { recursive: true, force: true });
  });
});

describe("project.godot", () => {
  it("crée puis fusionne editor_plugins sans doublon", () => {
    let p = newProjectGodot("Mon jeu", "4.7", "mobile");
    expect(p).toContain('config/features=PackedStringArray("4.7", "Mobile")');
    expect(p).toContain('renderer/rendering_method="mobile"');
    p = enablePlugins(p, ["res://addons/a/plugin.cfg"]);
    p = enablePlugins(p, ["res://addons/a/plugin.cfg", "res://addons/b/plugin.cfg"]);
    expect(p).toContain('enabled=PackedStringArray("res://addons/a/plugin.cfg", "res://addons/b/plugin.cfg")');
    expect(p.match(/\[editor_plugins\]/g)).toHaveLength(1);
  });
});

describe("secrets et journal", () => {
  it("masque un jeton dans un texte", () => {
    expect(redact("https://api.telegram.org/bot123456:ABCDEF/sendMessage", "123456:ABCDEF")).not.toContain("ABCDEF");
  });
  it("le journal masque les clés sensibles", () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), "myia-audit-"));
    audit({ event: "tool_call", tool: "x", args: { text: "salut", token: "abc", nested: { apiKey: "k" } } }, dir);
    const content = fs.readFileSync(path.join(dir, fs.readdirSync(dir)[0]!), "utf8");
    expect(content).toContain("salut");
    expect(content).not.toContain("abc");
    expect(content).not.toContain('"k"');
    fs.rmSync(dir, { recursive: true, force: true });
  });
});

describe("projets : détection et commandes générées", () => {
  const tmp = () => fs.mkdtempSync(path.join(os.tmpdir(), "myia-proj-"));
  const write = (f: string, c: string) => {
    fs.mkdirSync(path.dirname(f), { recursive: true });
    fs.writeFileSync(f, c);
  };

  it("lit les presets d'export Godot et la version", () => {
    const presets = parseExportPresets(
      `[preset.0]
name="Windows"
platform="Windows Desktop"
export_path="../builds/a.exe"

[preset.0.options]
name="piège"

[preset.1]
name="Linux Server"
platform="Linux"
export_path=""
`,
    );
    expect(presets.map((p) => p.name)).toEqual(["Windows", "Linux Server"]);
    expect(godotVersionOf('config/features=PackedStringArray("4.7", "Forward Plus")')).toBe("4.7");
  });

  it("Godot : une cible par preset (release + debug), avec l'exe de la bonne version", () => {
    const dir = tmp();
    write(path.join(dir, "project.godot"), 'config/features=PackedStringArray("4.6", "Mobile")');
    write(path.join(dir, "export_presets.cfg"), `[preset.0]
name="Windows Client"
export_path="build/x.exe"
`);
    const p = analyzeProject(dir, { "4.6": "G46.exe" })!;
    expect(p.kinds).toEqual(["godot"]);
    expect(p.targets["Windows Client"]!.argv).toEqual(["G46.exe", "--headless", "--path", dir, "--export-release", "Windows Client", path.join(dir, "build", "x.exe")]);
    expect(p.targets["Windows Client [debug]"]!.argv).toContain("--export-debug");
    expect(analyzeProject(dir, {})!.notes.join()).toMatch(/4\.6/);
    fs.rmSync(dir, { recursive: true, force: true });
  });

  it("Tauri + backend Rust : cibles préfixées par sous-dossier, gestionnaire détecté", () => {
    const dir = tmp();
    write(path.join(dir, "README.md"), "x");
    write(path.join(dir, "frontend", "package.json"), JSON.stringify({ scripts: { tauri: "tauri", build: "vite build" } }));
    write(path.join(dir, "frontend", "pnpm-lock.yaml"), "");
    write(path.join(dir, "frontend", "src-tauri", "tauri.conf.json"), "{}");
    write(path.join(dir, "backend", "Cargo.toml"), "[package]");
    const p = analyzeProject(dir, {})!;
    expect(p.kinds.sort()).toEqual(["rust", "tauri"]);
    expect(p.targets["frontend:build"]!.argv.slice(-4)).toEqual(["pnpm", "run", "tauri", "build"]);
    expect(p.targets["frontend:check"]).toMatchObject({ argv: ["cargo", "check"], cwd: path.join(dir, "frontend", "src-tauri") });
    expect(p.targets["backend:build"]!.argv).toEqual(["cargo", "build", "--release"]);
    fs.rmSync(dir, { recursive: true, force: true });
  });

  it("registre : découverte, noms en double préfixés, recherche tolérante", () => {
    const root = tmp();
    write(path.join(root, "Git", "Mon-Jeu", "project.godot"), "");
    write(path.join(root, "protos", "Mon-Jeu", "project.godot"), "");
    write(path.join(root, "protos", "Launcher", "src-tauri", "Cargo.toml"), "");
    write(path.join(root, "Divers", "notes.md"), "");
    const reg = new ProjectRegistry(parseConfig({ projectRoots: [{ path: root, depth: 2 }] }));
    expect(reg.all.map((p) => p.name).sort()).toEqual(["Git/Mon-Jeu", "Launcher", "protos/Mon-Jeu"]);
    expect(reg.resolve("launcher").kinds).toEqual(["tauri"]);
    expect(reg.resolve("protos mon jeu").name).toBe("protos/Mon-Jeu");
    expect(() => reg.resolve("mon jeu")).toThrow(/plusieurs/);
    expect(() => reg.resolve("launcher", "godot")).toThrow(/aucun/);
    fs.rmSync(root, { recursive: true, force: true });
  });
});

describe("web", () => {
  it("refuse les adresses locales et privées", () => {
    for (const ip of ["127.0.0.1", "10.1.2.3", "192.168.1.1", "172.20.0.1", "169.254.169.254", "::1", "fe80::1", "::ffff:127.0.0.1", "0.0.0.0"])
      expect(isPublicAddress(ip), ip).toBe(false);
    expect(isPublicAddress("1.1.1.1")).toBe(true);
    expect(isPublicAddress("2606:4700::1111")).toBe(true);
  });
  it("lit une page de résultats DuckDuckGo", () => {
    const html =
      '<div class="result"><a rel="nofollow" class="result__a" href="//duckduckgo.com/l/?uddg=https%3A%2F%2Fgodotengine.org%2Fa&amp;rut=x">Godot <b>Engine</b></a>' +
      '<a class="result__snippet" href="#">Le <b>moteur</b> libre</a></div>';
    expect(parseDuckDuckGo(html)).toEqual([{ title: "Godot Engine", url: "https://godotengine.org/a", snippet: "Le moteur libre" }]);
  });
  it("HTML → texte sans scripts", () => {
    const r = htmlToText("<title>T &amp; co</title><script>alert(1)</script><p>Bonjour&nbsp;toi</p>");
    expect(r.title).toBe("T & co");
    expect(r.text).toBe("Bonjour toi");
  });
  it("liens de confiance : ceux de l'utilisateur seulement", () => {
    clearTrustedUrls();
    trustUrlsIn("regarde https://exemple.fr/page. merci");
    expect(isTrustedUrl("https://exemple.fr/page")).toBe(true);
    expect(isTrustedUrl("https://autre.fr/")).toBe(false);
    expect(isTrustedUrl("javascript:alert(1)")).toBe(false);
  });
});
