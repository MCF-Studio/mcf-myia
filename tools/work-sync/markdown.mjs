// Fournisseur « exec: » du registre de travail (docs/TRAVAIL.md §7) : un TABLEAU MARKDOWN par équipe, à lire et à
// modifier à la main (Bloc-notes, Obsidian, VS Code…). Rien ne sort du PC.
//
//   Coche une case        → la tâche est fermée dans MyIA
//   Décoche une case      → la tâche est rouverte
//   Ajoute « - [ ] texte » → une nouvelle tâche est créée (étiquette « externe »)
//
// Fichiers : <Documents>\MyIA\travail\<équipe>.md (le tableau) et <équipe>.etat.json (dernier état connu).
// Dossier changeable avec la variable MYIA_WORK_MD_DIR. Lancé par MyIA : `node markdown.mjs push|pull`, JSON sur
// l'entrée standard, réponse JSON sur la sortie standard. Aucune dépendance.
import crypto from "node:crypto";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";

const op = process.argv[2];
const team = (process.env.MYIA_TEAM ?? "").replace(/[^a-z0-9-]/g, "");
if (!team || (op !== "push" && op !== "pull")) {
  process.stderr.write("usage : MYIA_TEAM=<équipe> node markdown.mjs push|pull < requête.json\n");
  process.exit(64);
}
const dir = process.env.MYIA_WORK_MD_DIR || path.join(os.homedir(), "Documents", "MyIA", "travail");
const board = path.join(dir, `${team}.md`);
const stateFile = path.join(dir, `${team}.etat.json`);

const ID = /\bt-[a-z0-9]{6}\b/;
const LINE = /^\s*[-*]\s+\[( |x|X)\]\s+(.*\S)\s*$/;
const oneLine = (s) => String(s ?? "").replace(/\s+/g, " ").trim().slice(0, 200);
/** Référence stable d'une ligne ajoutée à la main : la même ligne n'est importée qu'une fois. */
const extOf = (title) => "md:" + crypto.createHash("sha256").update(oneLine(title).toLowerCase()).digest("hex").slice(0, 12);

function readJson(file, fallback) {
  try {
    return JSON.parse(fs.readFileSync(file, "utf8"));
  } catch {
    return fallback;
  }
}
function writeAtomic(file, text) {
  fs.mkdirSync(path.dirname(file), { recursive: true });
  const tmp = `${file}.${process.pid}.tmp`;
  fs.writeFileSync(tmp, text, "utf8");
  fs.renameSync(tmp, file);
}

/** Lignes de tâche du tableau : cochée ou non, id MyIA s'il y en a un, texte. */
function readBoard() {
  let text = "";
  try {
    text = fs.readFileSync(board, "utf8");
  } catch {
    return [];
  }
  const out = [];
  for (const raw of text.split(/\r?\n/)) {
    const m = LINE.exec(raw);
    if (!m) continue;
    const id = ID.exec(m[2])?.[0];
    // Le texte d'une ligne MyIA : après l'id, sans le « — responsable ».
    const title = id ? m[2].slice(m[2].indexOf(id) + id.length).replace(/\s+—\s+[^—]*$/, "") : m[2];
    out.push({ checked: m[1] !== " ", id, title: oneLine(title) });
  }
  return out;
}

const state = readJson(stateFile, { items: {} });
if (!state.items || typeof state.items !== "object") state.items = {};

let input = "";
for await (const chunk of process.stdin) input += chunk;
const req = input.trim() ? JSON.parse(input) : {};

function render(lines) {
  const items = Object.values(state.items);
  const known = new Set(items.map((i) => i.ext).filter(Boolean));
  const manual = lines.filter((l) => !l.id && !known.has(extOf(l.title)));
  const sorted = (list) => list.sort((a, b) => String(a.createdAt ?? "").localeCompare(String(b.createdAt ?? "")));
  const line = (i, done) => `- [${done ? "x" : " "}] ${i.id} ${oneLine(i.title)}${i.assignee ? ` — ${oneLine(i.assignee)}` : ""}`;
  const doing = sorted(items.filter((i) => i.status === "en_cours"));
  const todo = sorted(items.filter((i) => i.status === "ouverte"));
  const done = items
    .filter((i) => i.status === "fermee")
    .sort((a, b) => String(b.closedAt ?? b.updatedAt ?? "").localeCompare(String(a.closedAt ?? a.updatedAt ?? "")))
    .slice(0, 30);
  const out = [
    `# Travail de l'équipe « ${team} »`,
    "",
    "<!-- Tableau synchronisé par MyIA. Coche une case pour fermer une tâche, décoche-la pour la rouvrir, ajoute une ligne",
    "     « - [ ] ta tâche » pour en créer une. Les identifiants t-… font le lien avec MyIA : ne les modifie pas. -->",
    "",
    "## En cours",
    ...(doing.length ? doing.map((i) => line(i, false)) : ["_rien en cours_"]),
    "",
    "## À faire",
    ...(todo.length ? todo.map((i) => line(i, false)) : ["_rien à faire_"]),
    "",
    "## Nouvelles (seront importées dans MyIA)",
    ...manual.map((l) => `- [${l.checked ? "x" : " "}] ${l.title}`),
    "",
    "## Fermées (30 dernières)",
    ...done.map((i) => line(i, true)),
    "",
  ];
  writeAtomic(board, out.join("\n"));
  writeAtomic(stateFile, JSON.stringify(state, null, 1) + "\n");
}

if (op === "push") {
  for (const e of Array.isArray(req.events) ? req.events : []) {
    const i = e?.item;
    if (i && typeof i.id === "string" && ID.test(i.id)) state.items[i.id] = { ...state.items[i.id], ...i };
  }
  render(readBoard());
  process.stdout.write("{}");
} else {
  const lines = readBoard();
  // Ce que MyIA connaît maintenant (tâches non fermées et tâches liées) : mise à jour de l'état.
  const known = new Map();
  for (const i of Array.isArray(req.items) ? req.items : []) {
    if (!i || !ID.test(String(i.id))) continue;
    known.set(i.id, i);
    state.items[i.id] = { ...state.items[i.id], ...i };
  }
  const byExt = new Map([...Object.values(state.items), ...known.values()].filter((i) => i.ext).map((i) => [i.ext, i]));
  const changes = [];
  for (const l of lines) {
    if (l.id) {
      const cur = state.items[l.id];
      if (!cur) continue;
      // MyIA ne renvoie pas les changements faits par la synchronisation : l'état local suit tout de suite, sinon la
      // case cochée réapparaîtrait décochée au prochain rafraîchissement du tableau.
      if (l.checked && cur.status !== "fermee") {
        changes.push({ op: "close", id: l.id, reason: "Coché dans le tableau Markdown" });
        cur.status = "fermee";
        cur.closedAt = new Date().toISOString();
      }
      if (!l.checked && cur.status === "fermee") {
        changes.push({ op: "reopen", id: l.id, reason: "Décoché dans le tableau Markdown" });
        cur.status = "ouverte";
        delete cur.assignee;
      }
    } else if (l.title.length >= 3) {
      const ext = extOf(l.title);
      const cur = byExt.get(ext);
      if (!cur) changes.push({ op: "create", ext, title: l.title.slice(0, 200) });
      if (l.checked && (!cur || cur.status !== "fermee")) changes.push({ op: "close", ext, reason: "Coché dans le tableau Markdown" });
    }
  }
  render(lines);
  process.stdout.write(JSON.stringify({ changes: changes.slice(0, 100) }));
}
