import { execFileSync } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import type { Config } from "./config.js";
import { isInside, paths } from "./paths.js";
import { assertLocalPath } from "./programs.js";

/**
 * Où les agents peuvent lire, chercher et (avec confirmation) écrire.
 *
 * Par défaut : les dossiers habituels de l'utilisateur, ses projets et ses dossiers de mémoire. Avec l'option
 * « accès à tout le PC » (files.fullAccess, désactivée par défaut, Paramètres → Accès), tous les disques locaux.
 * Dans les deux cas, certains emplacements restent TOUJOURS fermés (voir sensitivePlaces) : ils contiennent des
 * secrets (mots de passe de navigateur, clés SSH, jetons) ou le système, et une IA n'a aucune raison de les lire.
 */

/** Disques locaux fixes (C:\, D:\…), sans lecteurs réseau ni amovibles. */
export function localDrives(): string[] {
  if (process.platform !== "win32") return ["/"];
  try {
    // DriveType 3 = disque local fixe.
    const out = execFileSync(
      "powershell.exe",
      ["-NoProfile", "-NonInteractive", "-Command", "(Get-CimInstance Win32_LogicalDisk -Filter 'DriveType=3').DeviceID -join ','"],
      { encoding: "utf8", timeout: 8000, windowsHide: true },
    );
    const drives = out
      .trim()
      .split(",")
      .filter((d) => /^[A-Z]:$/i.test(d))
      .map((d) => `${d.toUpperCase()}\\`);
    return drives.length ? drives : ["C:\\"];
  } catch {
    return ["C:\\"];
  }
}

let drivesCache: string[] | undefined;
const drives = () => (drivesCache ??= localDrives());

/** MyIA lui-même (configuration, journal d'audit, conversations) : fermé dans tous les cas. */
function myiaPlaces(): string[] {
  return [path.join(paths.home, "config"), path.join(paths.home, "data")].map((p) => path.resolve(p));
}

/** Emplacements fermés par défaut, y compris avec l'accès à tout le PC. */
export function sensitivePlaces(): string[] {
  const home = os.homedir();
  const env = (k: string) => process.env[k];
  return [
    // Système et programmes installés.
    env("SystemRoot") ?? "C:\\Windows",
    env("ProgramFiles") ?? "C:\\Program Files",
    env("ProgramFiles(x86)") ?? "C:\\Program Files (x86)",
    env("ProgramData") ?? "C:\\ProgramData",
    "C:\\$Recycle.Bin",
    "C:\\System Volume Information",
    // Données d'applications : profils de navigateur (mots de passe, cookies), jetons, coffres.
    path.join(home, "AppData"),
    // Clés et identifiants d'outils.
    ...[".ssh", ".gnupg", ".aws", ".azure", ".kube", ".docker", ".config", ".claude", ".anthropic", ".npmrc", ".git-credentials", ".netrc"].map((n) =>
      path.join(home, n),
    ),
    ...myiaPlaces(),
  ].map((p) => path.resolve(p));
}

/**
 * Vrai si le chemin (réel) est fermé aux agents.
 * - La configuration et les données de MyIA, et `denied` (dossiers de mémoire pour un agent en ligne), sont fermés
 *   dans tous les cas.
 * - Un emplacement fermé par défaut ne s'ouvre que si l'utilisateur a choisi un dossier À L'INTÉRIEUR de cet
 *   emplacement (ex. un dossier de mémoire sous AppData). Choisir un dossier plus large (son dossier personnel, un
 *   disque) ne rouvre pas ce qu'il contient (.ssh, AppData…).
 */
export function isSensitive(real: string, explicit: string[] = [], denied: string[] = []): boolean {
  const p = path.resolve(real);
  if (myiaPlaces().some((s) => isInside(s, p))) return true;
  if (denied.some((d) => isInside(path.resolve(d), p))) return true;
  return sensitivePlaces().some((s) => isInside(s, p) && !explicit.some((d) => isInside(s, d) && isInside(d, p)));
}

/** Dossiers fermés à un agent en ligne : ses échanges partent chez Anthropic, la mémoire ne quitte jamais le PC. */
export function deniedFor(cfg: Config, cloud: boolean): string[] {
  if (!cloud) return [];
  // Forme écrite ET chemin réel (lien, jonction, nom court) : comparés comme les dossiers autorisés.
  return [
    ...new Set(
      cfg.memory.folders.flatMap((d) => {
        const abs = path.resolve(d);
        try {
          return [abs, fs.realpathSync.native(abs)];
        } catch {
          return [abs];
        }
      }),
    ),
  ];
}

/**
 * Espace de travail d'un agent ou d'une équipe : un dossier local existant, choisi par l'utilisateur. Refusés : un
 * disque entier, le dossier personnel (ou plus large) et les emplacements protégés. Renvoie le chemin réel.
 */
export function checkWorkspace(p: string, what = "espace de travail"): string {
  const abs = assertLocalPath(p);
  if (!fs.statSync(abs, { throwIfNoEntry: false })?.isDirectory()) throw new Error(`dossier introuvable : ${abs}`);
  const real = fs.realpathSync.native(abs);
  if (path.parse(real).root === real) throw new Error(`un ${what} est un dossier, pas un disque entier`);
  if (isInside(real, os.homedir())) throw new Error(`dossier trop large pour un ${what} : choisis un dossier précis`);
  if (isSensitive(real)) throw new Error(`${real} est un emplacement protégé (système, données d'applications, clés ou config de MyIA)`);
  return real;
}

/** Sous-dossier de l'espace de coordination où les membres écrivent sans confirmation (comptes rendus, état). */
export const COORDINATION_JOURNAL = "journal";

/**
 * Espace de coordination d'une équipe : un dossier À PART, choisi par l'utilisateur, où l'équipe garde ses règles
 * communes et sa mémoire de travail (journal, état). Mêmes contrôles qu'un espace de travail, plus : ce n'est pas un
 * projet (pas un dépôt git) et il ne recoupe pas l'espace de travail de l'équipe. Sans cela, l'écriture sans
 * confirmation du journal s'appliquerait à un dossier de projet.
 */
export function checkCoordination(p: string, workspace?: string): string {
  const real = checkWorkspace(p, "espace de coordination");
  if (fs.existsSync(path.join(real, ".git"))) {
    throw new Error("ce dossier est un dépôt git (un projet) : choisis un dossier à part pour la coordination de l'équipe");
  }
  const ws = usableWorkspace(workspace);
  if (ws && (isInside(ws, real) || isInside(real, ws))) {
    throw new Error("l'espace de coordination doit être en dehors de l'espace de travail de l'équipe (et inversement)");
  }
  return real;
}

/** L'espace de coordination s'il est utilisable MAINTENANT (disque débranché, dossier déplacé ou devenu un projet : non). */
export function usableCoordination(p: string | undefined, workspace?: string): string | undefined {
  if (!p) return undefined;
  try {
    return checkCoordination(p, workspace);
  } catch {
    return undefined;
  }
}

/** L'espace de travail s'il est utilisable MAINTENANT (le disque peut être débranché, le dossier déplacé). */
export function usableWorkspace(p: string | undefined): string | undefined {
  if (!p) return undefined;
  try {
    return checkWorkspace(p);
  } catch {
    return undefined;
  }
}

/** Dossiers choisis par l'utilisateur (sans les disques entiers de l'accès à tout le PC ; sans la mémoire en ligne). */
export function explicitRoots(cfg: Config, base: string[], cloud = false): string[] {
  const roots = [...base, ...(cloud ? [] : cfg.memory.folders)];
  return [...new Set(roots.filter((d) => fs.existsSync(d)).map((d) => path.resolve(d)))];
}

/** Dossiers ouverts aux agents (lecture, recherche ; écriture avec les contrôles de file_write). */
export function accessRoots(cfg: Config, base: string[], cloud = false): string[] {
  return [...new Set([...explicitRoots(cfg, base, cloud), ...(cfg.files.fullAccess ? drives() : [])])];
}
