// Prépare le cœur MyIA pour l'installateur : app/src-tauri/resources/sidecar/
//   main.mjs      tout le cœur en un fichier (esbuild)
//   node.exe      le runtime Node (celui qui exécute ce script, ou NODE_EXE)
//   node_modules/ seulement le module natif du coffre Windows (@napi-rs/keyring)
import { build } from "esbuild";
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

const agent = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const out = path.resolve(agent, "..", "app", "src-tauri", "resources", "sidecar");
fs.rmSync(out, { recursive: true, force: true });
fs.mkdirSync(out, { recursive: true });

const pkg = JSON.parse(fs.readFileSync(path.join(agent, "package.json"), "utf8"));
await build({
  entryPoints: [path.join(agent, "src", "server", "main.ts")],
  outfile: path.join(out, "main.mjs"),
  bundle: true,
  platform: "node",
  format: "esm",
  target: "node22",
  minify: true,
  sourcemap: false,
  legalComments: "external",
  external: ["@napi-rs/keyring"],
  // Des dépendances CommonJS appellent require() : on le fournit dans le module ESM.
  banner: { js: "import{createRequire as __cr}from'module';const require=__cr(import.meta.url);" },
  define: { "process.env.MYIA_BUNDLE_VERSION": JSON.stringify(pkg.version) },
  logLevel: "warning",
});

// Module natif : copié tel quel (esbuild ne peut pas l'inclure).
for (const dep of ["@napi-rs/keyring", "@napi-rs/keyring-win32-x64-msvc"]) {
  const src = path.join(agent, "node_modules", dep);
  if (!fs.existsSync(src)) throw new Error(`dépendance manquante : ${dep} (npm ci dans agent/)`);
  fs.cpSync(src, path.join(out, "node_modules", dep), { recursive: true });
}

const nodeExe = process.env.NODE_EXE ?? process.execPath;
fs.copyFileSync(nodeExe, path.join(out, "node.exe"));
const major = Number(process.versions.node.split(".")[0]);
if (!process.env.NODE_EXE && major < 22) throw new Error(`Node ${process.versions.node} trop ancien (22+ requis)`);

const size = (f) => (fs.statSync(path.join(out, f)).size / 1048576).toFixed(1);
console.log(`sidecar prêt dans ${out} : main.mjs ${size("main.mjs")} Mo, node.exe ${size("node.exe")} Mo (Node ${process.versions.node})`);
