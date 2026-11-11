import crypto from "node:crypto";
import fs from "node:fs";
import path from "node:path";
import AdmZip from "adm-zip";
import { isInside } from "./paths.js";

/**
 * Téléchargements de la chaîne d'approvisionnement (moteurs whisper.cpp et llama.cpp, modèles) : versions figées,
 * empreinte SHA-256 vérifiée au vol, fichier gardé seulement si elle correspond ; archives extraites sans sortir du
 * dossier cible.
 */

export interface Progress {
  what: string;
  received: number;
  total?: number;
}

/** Téléchargement en flux, empreinte calculée au vol ; le fichier n'est gardé que si l'empreinte correspond. */
export async function download(url: string, dest: string, sha256: string, onProgress: (p: Progress) => void, what: string, signal?: AbortSignal) {
  fs.mkdirSync(path.dirname(dest), { recursive: true });
  const tmp = `${dest}.part`;
  const r = await fetch(url, { signal, redirect: "follow" });
  if (!r.ok || !r.body) throw new Error(`téléchargement impossible (${r.status}) : ${url}`);
  const total = Number(r.headers.get("content-length")) || undefined;
  const hash = crypto.createHash("sha256");
  const out = fs.createWriteStream(tmp);
  let received = 0;
  let last = 0;
  try {
    for await (const chunk of r.body as unknown as AsyncIterable<Uint8Array>) {
      hash.update(chunk);
      received += chunk.length;
      if (!out.write(chunk)) await new Promise((res) => out.once("drain", res));
      if (Date.now() - last > 250) {
        last = Date.now();
        onProgress({ what, received, total });
      }
    }
    await new Promise<void>((res, rej) => out.end((err?: Error | null) => (err ? rej(err) : res())));
  } catch (e) {
    out.destroy();
    fs.rmSync(tmp, { force: true });
    throw e;
  }
  const got = hash.digest("hex");
  if (got !== sha256) {
    fs.rmSync(tmp, { force: true });
    throw new Error(`empreinte invalide pour ${path.basename(dest)} : fichier rejeté (attendu ${sha256.slice(0, 12)}…, reçu ${got.slice(0, 12)}…)`);
  }
  fs.renameSync(tmp, dest);
  onProgress({ what, received, total: received });
}

/** `clean` : vider le dossier avant (faux pour compléter une extraction, ex. bibliothèques CUDA). */
export function extractZip(zipFile: string, dir: string, clean = true) {
  if (clean) fs.rmSync(dir, { recursive: true, force: true });
  fs.mkdirSync(dir, { recursive: true });
  const zip = new AdmZip(zipFile);
  let total = 0;
  for (const e of zip.getEntries()) {
    if (e.isDirectory) continue;
    const target = path.resolve(dir, e.entryName);
    if (!isInside(dir, target)) throw new Error(`chemin suspect dans l'archive : ${e.entryName}`);
    total += e.header.size;
    if (total > 4 * 1024 * 1024 * 1024) throw new Error("archive suspecte (plus de 4 Go décompressés)");
    fs.mkdirSync(path.dirname(target), { recursive: true });
    fs.writeFileSync(target, e.getData());
  }
}
