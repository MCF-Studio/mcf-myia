// Publie une version de MyIA DEPUIS CE PC : construit l'installateur, le signe pour la mise à jour automatique
// et crée la release GitHub. Pas de build sur GitHub Actions (trop long pour le Rust).
//
//   cd app && npm run release               construit, signe et publie la version de tauri.conf.json
//   cd app && npm run release -- --dry-run  construit et signe, sans rien publier
//   cd app && npm run release -- --notes "Ce qui change"
//
// Prérequis : `gh` connecté avec le droit d'écrire sur le dépôt, et la clé privée de signature des mises à jour
// (par défaut %USERPROFILE%\.tauri\myia-updater.key, ou MYIA_UPDATER_KEY, ou TAURI_SIGNING_PRIVATE_KEY).
// Sans cette clé, les apps déjà installées refusent la mise à jour : garde-la en lieu sûr, jamais dans le dépôt.
import { execFileSync } from "node:child_process";
import crypto from "node:crypto";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";

const REPO = "MCF-Studio/mcf-myia";
const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const app = path.join(root, "app");
const args = process.argv.slice(2);
const dryRun = args.includes("--dry-run");
const notesAt = args.indexOf("--notes");
const userNotes = notesAt >= 0 ? args[notesAt + 1] : undefined;

const fail = (msg) => {
  console.error(`\n✗ ${msg}`);
  process.exit(1);
};
const out = (cmd, a, opts = {}) => execFileSync(cmd, a, { cwd: root, encoding: "utf8", ...opts }).trim();
const step = (t) => console.log(`\n▸ ${t}`);

// ─── Version : la même partout ───────────────────────────────────────────────
const version = JSON.parse(fs.readFileSync(path.join(app, "src-tauri", "tauri.conf.json"), "utf8")).version;
const cargoVersion = /^version\s*=\s*"([^"]+)"/m.exec(fs.readFileSync(path.join(app, "src-tauri", "Cargo.toml"), "utf8"))?.[1];
const appVersion = JSON.parse(fs.readFileSync(path.join(app, "package.json"), "utf8")).version;
const agentVersion = JSON.parse(fs.readFileSync(path.join(root, "agent", "package.json"), "utf8")).version;
if (!/^\d+\.\d+\.\d+$/.test(version)) fail(`version invalide dans tauri.conf.json : ${version}`);
for (const [where, v] of [["Cargo.toml", cargoVersion], ["app/package.json", appVersion], ["agent/package.json", agentVersion]]) {
  if (v !== version) fail(`version ${v} dans ${where} ≠ ${version} dans tauri.conf.json`);
}
const tag = `v${version}`;
console.log(`MyIA ${tag}${dryRun ? " (essai : rien ne sera publié)" : ""}`);

// ─── Clé de signature ────────────────────────────────────────────────────────
const keyFile = process.env.MYIA_UPDATER_KEY ?? path.join(os.homedir(), ".tauri", "myia-updater.key");
const privateKey = process.env.TAURI_SIGNING_PRIVATE_KEY ?? (fs.existsSync(keyFile) ? fs.readFileSync(keyFile, "utf8").trim() : undefined);
if (!privateKey) fail(`clé de signature introuvable : ${keyFile} (ou variable TAURI_SIGNING_PRIVATE_KEY)`);

// ─── Dépôt : on publie exactement ce qui est sur GitHub ──────────────────────
const head = out("git", ["rev-parse", "HEAD"]);
if (!dryRun) {
  step("Vérification du dépôt");
  if (out("git", ["status", "--porcelain"])) fail("des modifications ne sont pas commitées : commit d'abord");
  out("git", ["fetch", "origin", "main"]);
  if (out("git", ["rev-parse", "origin/main"]) !== head) fail("HEAD n'est pas origin/main : pousse (ou récupère) d'abord");
  let exists = true;
  try {
    out("gh", ["release", "view", tag, "--repo", REPO], { stdio: ["ignore", "pipe", "ignore"] });
  } catch {
    exists = false;
  }
  if (exists) fail(`la release ${tag} existe déjà : augmente la version (tauri.conf.json, Cargo.toml, les deux package.json)`);
}

// ─── Tests, puis build signé ─────────────────────────────────────────────────
step("Tests du cœur");
execFileSync("npm", ["test"], { cwd: path.join(root, "agent"), stdio: "inherit", shell: true });

step("Construction de l'installateur (quelques minutes)");
execFileSync(process.execPath, [path.join(app, "node_modules", "@tauri-apps", "cli", "tauri.js"), "build", "--config", "src-tauri/tauri.release.conf.json"], {
  cwd: app,
  stdio: "inherit",
  env: { ...process.env, TAURI_SIGNING_PRIVATE_KEY: privateKey, TAURI_SIGNING_PRIVATE_KEY_PASSWORD: process.env.TAURI_SIGNING_PRIVATE_KEY_PASSWORD ?? "" },
});

// ─── Fichiers de la release ──────────────────────────────────────────────────
const nsis = path.join(app, "src-tauri", "target", "release", "bundle", "nsis");
const exeName = `MyIA_${version}_x64-setup.exe`;
const exe = path.join(nsis, exeName);
const sig = `${exe}.sig`;
if (!fs.existsSync(exe)) fail(`installateur introuvable : ${exe}`);
if (!fs.existsSync(sig)) fail(`signature introuvable : ${sig}`);

const dist = path.join(app, "src-tauri", "target", "release", "bundle", "release");
fs.rmSync(dist, { recursive: true, force: true });
fs.mkdirSync(dist, { recursive: true });
const sha = crypto.createHash("sha256").update(fs.readFileSync(exe)).digest("hex");
const notes =
  userNotes ??
  "Installateur Windows (par utilisateur, sans droits admin). Prérequis : Ollama (https://ollama.com). " +
    "Les versions déjà installées se mettent à jour toutes seules au prochain démarrage. " +
    "L'installateur n'est pas encore signé Authenticode : Windows SmartScreen peut afficher un avertissement " +
    "(« Informations complémentaires » → « Exécuter quand même »). Vérifie l'empreinte avec SHA256SUMS.txt.";
// Lu par les apps installées (tauri-plugin-updater) : version, signature et adresse de l'installateur.
const latest = {
  version,
  notes,
  pub_date: new Date().toISOString(),
  platforms: {
    "windows-x86_64": {
      signature: fs.readFileSync(sig, "utf8").trim(),
      url: `https://github.com/${REPO}/releases/download/${tag}/${exeName}`,
    },
  },
};
const latestFile = path.join(dist, "latest.json");
const sumsFile = path.join(dist, "SHA256SUMS.txt");
fs.writeFileSync(latestFile, JSON.stringify(latest, null, 2) + "\n");
fs.writeFileSync(sumsFile, `${sha}  ${exeName}\n`);
console.log(`\n${exeName} : ${(fs.statSync(exe).size / 1048576).toFixed(1)} Mo\nSHA-256 : ${sha}`);

if (dryRun) {
  console.log(`\n✓ Essai terminé, rien n'a été publié. Fichiers :\n  ${exe}\n  ${latestFile}\n  ${sumsFile}`);
  process.exit(0);
}

step(`Publication de ${tag} sur GitHub`);
execFileSync("gh", ["release", "create", tag, exe, latestFile, sumsFile, "--repo", REPO, "--target", head, "--title", `MyIA ${tag}`, "--notes", notes], {
  cwd: root,
  stdio: "inherit",
});
console.log(`\n✓ ${tag} publiée : https://github.com/${REPO}/releases/tag/${tag}`);
