import { spawn } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { z } from "zod";
import type { Config } from "../core/config.js";
import { isInside, paths } from "../core/paths.js";
import { assertLocalPath } from "../core/programs.js";
import { defineTool, type Service } from "../core/types.js";

/**
 * Ouvrir des dossiers et des fichiers avec l'application par défaut, trouver et lancer de la musique.
 * Règles (SPEC §3) : jamais d'exécutable ni de script par cette voie (c'est le rôle de program_launch, liste fermée) ;
 * chemins locaux uniquement ; hors des dossiers habituels de l'utilisateur, ouverture confirmée.
 */

/** Extensions qui exécutent du code quand on les « ouvre » : refusées. */
const EXECUTABLE = new Set(
  (
    "exe com bat cmd ps1 psm1 psd1 vbs vbe js jse wsf wsh hta msi msp mst scr lnk url reg cpl jar pif application " +
    "appref-ms gadget inf scf msc sh py pyw rb pl php ahk au3 dll sys ocx drv settingcontent-ms library-ms search-ms " +
    "diagcab xbap xll website iqy slk"
  ).split(" "),
);

const AUDIO = new Set("mp3 flac wav ogg opus m4a aac wma aiff alac".split(" "));
const PLAYLIST = new Set("m3u m3u8 wpl pls".split(" "));
const VIDEO = new Set("mp4 mkv avi mov webm wmv m4v".split(" "));
const IMAGE = new Set("png jpg jpeg gif webp bmp tif tiff heic svg".split(" "));
const DOCUMENT = new Set("pdf txt md doc docx odt xls xlsx ods ppt pptx odp csv rtf epub".split(" "));

const ext = (p: string) => path.extname(p).slice(1).toLowerCase();

/** Dossiers « chez toi » : ouverture sans confirmation. */
export function knownPlaces(cfg: Config): string[] {
  const home = os.homedir();
  const names = ["Desktop", "Documents", "Downloads", "Music", "Pictures", "Videos"];
  const dirs = [
    ...names.map((n) => path.join(home, n)),
    ...names.map((n) => path.join(home, "OneDrive", n)),
    paths.workspace,
    ...cfg.projectRoots.map((r) => r.path),
    ...Object.values(cfg.projects).map((p) => p.path),
    ...(cfg.godot.projectsRoot ? [cfg.godot.projectsRoot] : []),
  ];
  return [...new Set(dirs.filter((d) => fs.existsSync(d)).map((d) => path.resolve(d)))];
}

function musicDirs(): string[] {
  const home = os.homedir();
  return [path.join(home, "Music"), path.join(home, "OneDrive", "Music")].filter((d) => fs.existsSync(d));
}

function checkOpenable(p: string): string {
  const abs = assertLocalPath(p);
  if (!fs.existsSync(abs)) throw new Error(`introuvable : ${abs}`);
  const real = fs.realpathSync.native(abs);
  if (fs.statSync(real).isFile() && EXECUTABLE.has(ext(real))) {
    throw new Error(`${path.basename(real)} est un programme ou un script : il ne s'ouvre pas par ici (voir program_launch)`);
  }
  return real;
}

/** Ouvre avec l'application par défaut, via l'Explorateur (pas de shell : aucune interprétation de commande). */
function openWithDefault(p: string) {
  const child = spawn("explorer.exe", [p], { detached: true, stdio: "ignore", windowsHide: false });
  child.on("error", () => undefined);
  child.unref();
}

type Kind = "musique" | "vidéo" | "image" | "document" | "dossier" | "tout";

function matchesKind(file: string, isDir: boolean, kind: Kind) {
  if (kind === "dossier") return isDir;
  if (isDir) return kind === "tout" || kind === "musique";
  const e = ext(file);
  if (EXECUTABLE.has(e)) return false;
  switch (kind) {
    case "musique":
      return AUDIO.has(e) || PLAYLIST.has(e);
    case "vidéo":
      return VIDEO.has(e);
    case "image":
      return IMAGE.has(e);
    case "document":
      return DOCUMENT.has(e);
    default:
      return true;
  }
}

const norm = (s: string) =>
  s
    .normalize("NFD")
    .replace(/[̀-ͯ]/g, "")
    .toLowerCase()
    .replace(/[^a-z0-9]/g, "");

/** Recherche bornée (profondeur, durée, nombre d'entrées) dans des dossiers donnés. */
export function findFiles(roots: string[], query: string, kind: Kind, max = 15): { path: string; dir: boolean }[] {
  const q = norm(query);
  const out: { path: string; dir: boolean; score: number }[] = [];
  const t0 = Date.now();
  let seen = 0;
  const walk = (dir: string, depth: number) => {
    if (depth < 0 || Date.now() - t0 > 3000 || seen > 40_000) return;
    let entries: fs.Dirent[];
    try {
      entries = fs.readdirSync(dir, { withFileTypes: true });
    } catch {
      return;
    }
    for (const e of entries) {
      seen++;
      if (e.name.startsWith(".") || /^(node_modules|\$recycle\.bin|appdata)$/i.test(e.name)) continue;
      const full = path.join(dir, e.name);
      const isDir = e.isDirectory();
      const n = norm(e.name);
      if ((!q || n.includes(q)) && matchesKind(full, isDir, kind)) {
        out.push({ path: full, dir: isDir, score: (n === q ? 3 : n.startsWith(q) ? 2 : 1) + (PLAYLIST.has(ext(full)) ? 1 : 0) });
      }
      if (isDir) walk(full, depth - 1);
    }
  };
  for (const r of roots) walk(r, 4);
  return out.sort((a, b) => b.score - a.score).slice(0, max).map(({ path: p, dir }) => ({ path: p, dir }));
}

function shuffle<T>(a: T[]): T[] {
  for (let i = a.length - 1; i > 0; i--) {
    const j = Math.floor(Math.random() * (i + 1));
    [a[i], a[j]] = [a[j]!, a[i]!];
  }
  return a;
}

/** Playlist M3U de tous les morceaux d'un dossier (récursif, 2000 max), écrite dans workspace\playlists. */
function playlistFromDir(dir: string, shuffled: boolean): { file: string; count: number } {
  const tracks: string[] = [];
  const walk = (d: string, depth: number) => {
    if (depth < 0 || tracks.length >= 2000) return;
    for (const e of fs.readdirSync(d, { withFileTypes: true })) {
      const full = path.join(d, e.name);
      if (e.isDirectory()) walk(full, depth - 1);
      else if (AUDIO.has(ext(full))) tracks.push(full);
    }
  };
  walk(dir, 4);
  if (!tracks.length) throw new Error(`aucun morceau audio dans ${dir}`);
  const list = shuffled ? shuffle(tracks) : tracks.sort((a, b) => a.localeCompare(b));
  const outDir = path.join(paths.workspace, "playlists");
  fs.mkdirSync(outDir, { recursive: true });
  const file = path.join(outDir, `${path.basename(dir).replace(/[^\p{L}\p{N} _-]/gu, "_")}.m3u8`);
  fs.writeFileSync(file, "#EXTM3U\n" + list.join("\n") + "\n", "utf8");
  return { file, count: list.length };
}

export function filesService(cfg: Config): Service {
  const places = () => knownPlaces(cfg);
  const isKnown = (p: string) => places().some((k) => isInside(k, p));

  return {
    id: "files",
    label: "Fichiers et musique",
    async available() {
      return process.platform === "win32" ? { ok: true } : { ok: false, reason: "Windows uniquement pour l'instant" };
    },
    tools() {
      return [
        defineTool({
          name: "open_path",
          description:
            "Ouvre un dossier dans l'Explorateur, ou un fichier (document, image, vidéo, musique…) avec son application par défaut. " +
            "Chemin complet requis : trouve-le d'abord avec files_find. Les programmes et scripts ne s'ouvrent pas ici (program_launch).",
          schema: z.object({ path: z.string().min(3).max(500).describe("Chemin complet du fichier ou du dossier") }),
          risk: "launch",
          // Dans les dossiers habituels (Documents, Musique, projets…) : direct. Ailleurs : confirmation.
          confirmIf: (a) => {
            try {
              return !isKnown(checkOpenable(a.path));
            } catch {
              return true;
            }
          },
          check: (a) => void checkOpenable(a.path),
          preview: (a) => `Ouvrir :\n${checkOpenable(a.path)}\n(en dehors de tes dossiers habituels)`,
          async run(a) {
            const p = checkOpenable(a.path);
            openWithDefault(p);
            return `Ouvert : ${p}`;
          },
        }),
        defineTool({
          name: "files_find",
          description:
            "Cherche des fichiers ou dossiers par nom dans les dossiers de l'utilisateur (Bureau, Documents, Téléchargements, Musique, Images, Vidéos, projets). Ne lit pas les fichiers.",
          schema: z.object({
            query: z.string().max(80).describe("Partie du nom (vide = tout lister, avec un type)"),
            kind: z.enum(["musique", "vidéo", "image", "document", "dossier", "tout"]).default("tout"),
          }),
          risk: "read",
          preview: () => "",
          async run(a) {
            if (!a.query.trim() && a.kind === "tout") return "Précise un nom ou un type de fichier.";
            const res = findFiles(places(), a.query, a.kind);
            if (!res.length) return `Rien trouvé pour « ${a.query} » (${a.kind}).`;
            return res.map((r, i) => `${i + 1}. ${r.dir ? "[dossier] " : ""}${r.path}`).join("\n");
          },
        }),
        defineTool({
          name: "music_play",
          description:
            "Lance de la musique avec le lecteur par défaut : une playlist, un morceau ou tout un dossier (playlist créée automatiquement), " +
            "cherchés dans le dossier Musique. Sans requête : tout le dossier Musique.",
          schema: z.object({
            query: z.string().max(80).default("").describe("Nom d'une playlist, d'un artiste, d'un album, d'un dossier ou d'un morceau"),
            shuffle: z.boolean().default(false).describe("Lecture aléatoire (pour un dossier)"),
          }),
          risk: "launch",
          preview: () => "",
          async run(a) {
            const roots = musicDirs();
            if (!roots.length) return "Pas de dossier Musique trouvé. Demande à l'utilisateur où est sa musique, puis utilise open_path.";
            if (!a.query.trim()) {
              const { file, count } = playlistFromDir(roots[0]!, a.shuffle);
              openWithDefault(file);
              return `Lecture de tout le dossier Musique (${count} morceaux${a.shuffle ? ", aléatoire" : ""}).`;
            }
            const hit = findFiles(roots, a.query, "musique", 1)[0];
            if (!hit) return `Rien trouvé pour « ${a.query} » dans la musique.`;
            if (hit.dir) {
              const { file, count } = playlistFromDir(hit.path, a.shuffle);
              openWithDefault(file);
              return `Lecture du dossier ${path.basename(hit.path)} (${count} morceaux${a.shuffle ? ", aléatoire" : ""}).`;
            }
            openWithDefault(checkOpenable(hit.path));
            return `Lecture : ${path.basename(hit.path)}`;
          },
        }),
      ];
    },
  };
}
