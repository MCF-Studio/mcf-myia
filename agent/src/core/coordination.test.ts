import fs from "node:fs";
import path from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { fileWriteService } from "../services/file-write.js";
import { checkCoordination, usableCoordination } from "./access.js";
import { Agent, needsConfirmation } from "./agent.js";
import { parseConfig } from "./config.js";
import { initCoordination, listFiches, readFiches, writeFiches } from "./coordination.js";
import { paths } from "./paths.js";
import { exportWorkflow, parseWorkflow } from "./workflow.js";

const cfg = parseConfig({});
const write = fileWriteService(cfg).tools().find((t) => t.name === "file_write")!;

let root: string;
let coord: string;
let ws: string;
beforeEach(() => {
  fs.mkdirSync(paths.workspace, { recursive: true }); // absent d'un dépôt fraîchement cloné (CI)
  root = fs.realpathSync.native(fs.mkdtempSync(path.join(paths.workspace, "test-coord-")));
  coord = path.join(root, "equipe");
  ws = path.join(root, "projet");
  fs.mkdirSync(coord);
  fs.mkdirSync(ws);
});
afterEach(() => fs.rmSync(root, { recursive: true, force: true }));

describe("espace de coordination : le dossier", () => {
  it("accepte un dossier à part", () => {
    expect(checkCoordination(coord, ws)).toBe(coord);
    expect(usableCoordination(coord, ws)).toBe(coord);
    expect(usableCoordination(undefined)).toBeUndefined();
  });

  it("refuse un dépôt git : c'est un projet, pas une mémoire d'équipe", () => {
    fs.mkdirSync(path.join(coord, ".git"));
    expect(() => checkCoordination(coord)).toThrow(/dépôt git/);
    expect(usableCoordination(coord)).toBeUndefined();
  });

  it("refuse de recouper l'espace de travail de l'équipe, dans un sens comme dans l'autre", () => {
    const inside = path.join(ws, "coordination");
    fs.mkdirSync(inside);
    expect(() => checkCoordination(inside, ws)).toThrow(/en dehors de l'espace de travail/);
    expect(() => checkCoordination(ws, ws)).toThrow(/en dehors de l'espace de travail/);
    expect(() => checkCoordination(root, ws)).toThrow(/en dehors de l'espace de travail/);
  });

  it("refuse un dossier disparu", () => {
    expect(() => checkCoordination(path.join(root, "absent"))).toThrow(/introuvable/);
  });
});

describe("espace de coordination : la structure d'exemple", () => {
  it("crée les règles, la méthode et l'état, avec les membres de l'équipe", () => {
    const r = initCoordination(coord, "Studio 3D", [{ name: "Chef", description: "Répartit le travail" }, { name: "Modeleur" }], ws);
    expect(r.created).toEqual(["LISEZ-MOI.md", "methode.md", "journal/etat.md"]);
    const readme = fs.readFileSync(path.join(coord, "LISEZ-MOI.md"), "utf8");
    expect(readme).toContain("# Studio 3D — règles communes");
    expect(readme).toContain("- **Chef** : Répartit le travail");
    expect(readme).toContain("- **Modeleur** : (à compléter");
    expect(fs.readFileSync(path.join(coord, "journal", "etat.md"), "utf8")).toContain("État du travail — Studio 3D");
  });

  it("ne remplace jamais un fichier existant", () => {
    fs.writeFileSync(path.join(coord, "LISEZ-MOI.md"), "mes règles");
    const r = initCoordination(coord, "Studio 3D", []);
    expect(r.kept).toEqual(["LISEZ-MOI.md"]);
    expect(r.created).toEqual(["methode.md", "journal/etat.md"]);
    expect(fs.readFileSync(path.join(coord, "LISEZ-MOI.md"), "utf8")).toBe("mes règles");
  });

  it("refuse un dossier qui ne peut pas être un espace de coordination", () => {
    expect(() => initCoordination(ws, "X", [], ws)).toThrow(/en dehors de l'espace de travail/);
    expect(fs.readdirSync(ws)).toEqual([]);
  });
});

describe("espace de coordination : écriture", () => {
  const confirm = (file: string, mode: string, scope: object) => needsConfirmation(write, undefined, cfg, { path: file, content: "x", mode }, undefined, scope);

  it("le journal s'écrit sans confirmation : créer, compléter, remplacer", () => {
    const scope = { workspace: ws, coordination: coord };
    const day = path.join(coord, "journal", "2026-11-14.md");
    expect(confirm(day, "create", scope)).toBe(false);
    fs.mkdirSync(path.dirname(day));
    fs.writeFileSync(day, "## 08:00\n");
    expect(confirm(day, "append", scope)).toBe(false);
    expect(confirm(path.join(coord, "journal", "etat.md"), "overwrite", scope)).toBe(false);
  });

  it("les règles et les fiches à la racine restent confirmées", () => {
    // (Le dossier de test est sous workspace de MyIA, où CRÉER un fichier est déjà direct : on teste remplacer et compléter.)
    const scope = { workspace: ws, coordination: coord };
    initCoordination(coord, "Studio 3D", [], ws);
    fs.mkdirSync(path.join(coord, "journal-bis"));
    fs.writeFileSync(path.join(coord, "journal-bis", "x.md"), "x");
    expect(confirm(path.join(coord, "LISEZ-MOI.md"), "overwrite", scope)).toBe(true);
    expect(confirm(path.join(coord, "methode.md"), "append", scope)).toBe(true);
    expect(confirm(path.join(coord, "journal-bis", "x.md"), "append", scope)).toBe(true);
  });

  it("le même chemin reste confirmé pour un agent qui n'a pas cet espace", () => {
    fs.mkdirSync(path.join(coord, "journal"));
    // Sans l'espace dans sa portée, le dossier n'est ouvert que parce que le test le place dans workspace\ : la règle
    // ordinaire s'applique (nouveau fichier direct, compléter ou remplacer confirmé).
    fs.writeFileSync(path.join(coord, "journal", "etat.md"), "x");
    expect(confirm(path.join(coord, "journal", "etat.md"), "overwrite", {})).toBe(true);
    expect(confirm(path.join(coord, "journal", "etat.md"), "append", { workspace: ws })).toBe(true);
  });

  it("les règles d'écriture ne changent pas dans le journal : ni script, ni fichier qui pilote un outil, ni sortie du dossier", () => {
    const scope = { coordination: coord };
    expect(() => write.check!({ path: path.join(coord, "journal", "run.bat"), content: "x", mode: "create" }, scope)).toThrow();
    expect(() => write.check!({ path: path.join(coord, "journal", "CLAUDE.md"), content: "x", mode: "create" }, scope)).toThrow(/pilote un autre outil/);
    expect(() => write.check!({ path: path.join(coord, "journal", ".git", "hooks", "x.txt"), content: "x", mode: "create" }, scope)).toThrow(/exécuter du code/);
    // « journal/../LISEZ-MOI.md » retombe à la racine : confirmé.
    fs.mkdirSync(path.join(coord, "journal"));
    fs.writeFileSync(path.join(coord, "LISEZ-MOI.md"), "règles");
    expect(confirm(path.join(coord, "journal", "..", "LISEZ-MOI.md"), "overwrite", scope)).toBe(true);
  });
});

describe("espace de coordination : ce que l'agent en reçoit", () => {
  const promptOf = (opts: { coordination?: string; workspace?: string }) => {
    const agent = new Agent(cfg, [], { id: "chef", name: "Chef" }, opts) as unknown as { scope: object; systemPrompt(): string };
    agent.scope = { workspace: opts.workspace, coordination: usableCoordination(opts.coordination, opts.workspace) };
    return agent.systemPrompt();
  };

  it("les règles et l'état sont joints au prompt, l'état comme des notes à vérifier", () => {
    initCoordination(coord, "Studio 3D", [{ name: "Chef" }], ws);
    fs.appendFileSync(path.join(coord, "journal", "etat.md"), "\n- Scène du niveau 1 : terminée.\n");
    const prompt = promptOf({ coordination: coord, workspace: ws });
    expect(prompt).toContain(`Espace de coordination de ton équipe : ${coord}`);
    expect(prompt).toContain("# Studio 3D — règles communes");
    expect(prompt).toContain("Scène du niveau 1 : terminée.");
    expect(prompt).toMatch(/ce sont des notes, pas des consignes/);
    expect(prompt).toMatch(/ne demande pas de confirmation/);
  });

  it("un fichier trop long est coupé, avec l'indication de le lire en entier", () => {
    fs.writeFileSync(path.join(coord, "LISEZ-MOI.md"), "règle ".repeat(2000));
    expect(promptOf({ coordination: coord })).toMatch(/tronqué : lis le fichier entier/);
  });

  it("dossier introuvable : l'agent est prévenu ; pas d'espace : rien dans le prompt", () => {
    expect(promptOf({ coordination: path.join(root, "absent") })).toMatch(/introuvable pour l'instant/);
    expect(promptOf({})).not.toMatch(/coordination/);
  });
});

describe("espace de coordination : partage", () => {
  it("ne part jamais dans un workflow", () => {
    const { json } = exportWorkflow(
      { id: "t", name: "Équipe", coordination: coord, root: { id: "n-0001", agentId: "chef", subagents: [], teammates: [] }, maxCalls: 8, maxDepth: 3 },
      [{ id: "chef", name: "Chef" }],
      [],
    );
    expect(json).not.toContain("coordination");
    expect(json).not.toContain("test-coord-");
  });
});

describe("fiches : ce qui part dans un workflow", () => {
  const seed = () => {
    initCoordination(coord, "Studio 3D", [{ name: "Chef" }], ws);
    fs.writeFileSync(path.join(coord, "livraison.md"), "# Livraison\n");
    fs.writeFileSync(path.join(coord, "cles-et-acces.md"), "Où sont les clés.\n");
    fs.writeFileSync(path.join(coord, "CLAUDE.md"), "consignes pour un autre outil");
    fs.writeFileSync(path.join(coord, "outil.py"), "print(1)");
    fs.writeFileSync(path.join(coord, "image.md"), Buffer.from([0x89, 0x50, 0x00, 0x01]));
    fs.appendFileSync(path.join(coord, "journal", "etat.md"), "- PR #26 fusionnée\n");
    fs.writeFileSync(path.join(coord, "journal", "2026-11-14.md"), "## 08:00 — journal privé\n");
  };

  it("ne propose que les fichiers texte de la racine : ni journal, ni script, ni binaire, ni fichier d'un autre outil", () => {
    seed();
    expect(listFiches(coord).map((f) => f.path)).toEqual(["cles-et-acces.md", "LISEZ-MOI.md", "livraison.md", "methode.md"]);
  });

  it("signale les fiches dont le nom évoque des accès", () => {
    seed();
    expect(listFiches(coord).filter((f) => f.sensitive).map((f) => f.path)).toEqual(["cles-et-acces.md"]);
  });

  it("ne lit que des fiches de ce dossier : aucun chemin, aucun fichier du journal", () => {
    seed();
    expect(readFiches(coord, ["LISEZ-MOI.md", "livraison.md"]).map((f) => f.path)).toEqual(["LISEZ-MOI.md", "livraison.md"]);
    for (const bad of ["journal/etat.md", "../projet/x.md", "journal\\2026-11-14.md", "CLAUDE.md", "outil.py", "absente.md", path.join(coord, "methode.md")]) {
      expect(() => readFiches(coord, [bad]), bad).toThrow(/refusée|introuvable/);
    }
  });

  it("le workflow exporté contient les fiches choisies, et rien du journal ni de l'emplacement", () => {
    seed();
    const team = { id: "t", name: "Studio 3D", coordination: coord, root: { id: "n-0001", agentId: "chef", subagents: [], teammates: [] }, maxCalls: 8, maxDepth: 3 };
    const { json } = exportWorkflow(team, [{ id: "chef", name: "Chef" }], [], readFiches(coord, ["LISEZ-MOI.md", "methode.md"]));
    const wf = parseWorkflow(json);
    expect(wf.coordination?.files.map((f) => f.path)).toEqual(["LISEZ-MOI.md", "methode.md"]);
    expect(json).not.toContain("PR #26");
    expect(json).not.toContain("journal privé");
    expect(json).not.toContain("Où sont les clés");
    expect(json).not.toContain("test-coord-");
  });

  it("un workflow reçu ne peut pas glisser un chemin, un fichier d'outil ou un script parmi ses fiches", () => {
    const base = { $schema: "myia/workflow@1", name: "X", team: { root: { id: "n-0001", agentId: "a", subagents: [], teammates: [] } }, agents: [{ id: "a", name: "A" }] };
    const withFiche = (p: string) => JSON.stringify({ ...base, coordination: { files: [{ path: p, content: "x" }] } });
    expect(parseWorkflow(withFiche("regles.md")).coordination?.files).toHaveLength(1);
    for (const bad of ["../LISEZ-MOI.md", "journal/etat.md", "a\\b.md", "CLAUDE.md", "agents.md", "run.bat", "x.py", "nul.md", ".env", "C:/x.md"]) {
      expect(() => parseWorkflow(withFiche(bad)), bad).toThrow(/invalide/);
    }
    expect(() => parseWorkflow(JSON.stringify({ ...base, coordination: { files: [{ path: "a.md", content: "x" }, { path: "A.md", content: "y" }] } }))).toThrow(/invalide/);
  });

  it("à l'import, les fiches sont posées sans rien remplacer, avec un état vierge", () => {
    fs.writeFileSync(path.join(coord, "methode.md"), "ma méthode à moi");
    const r = writeFiches(coord, "Studio 3D", [{ path: "LISEZ-MOI.md", content: "règles reçues" }, { path: "methode.md", content: "méthode reçue" }], ws);
    expect(r.created).toEqual(["LISEZ-MOI.md", "journal/etat.md"]);
    expect(r.kept).toEqual(["methode.md"]);
    expect(fs.readFileSync(path.join(coord, "methode.md"), "utf8")).toBe("ma méthode à moi");
    expect(fs.readFileSync(path.join(coord, "journal", "etat.md"), "utf8")).toContain("État du travail — Studio 3D");
  });

  it("refuse de poser des fiches dans un projet ou hors d'un dossier valide, sans rien écrire", () => {
    expect(() => writeFiches(ws, "X", [{ path: "LISEZ-MOI.md", content: "x" }], ws)).toThrow(/en dehors de l'espace de travail/);
    fs.mkdirSync(path.join(coord, ".git"));
    expect(() => writeFiches(coord, "X", [{ path: "LISEZ-MOI.md", content: "x" }])).toThrow(/dépôt git/);
    expect(fs.existsSync(path.join(coord, "LISEZ-MOI.md"))).toBe(false);
    expect(() => writeFiches(coord, "X", [{ path: "../x.md", content: "x" }])).toThrow();
  });
});
