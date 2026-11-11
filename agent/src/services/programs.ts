import { spawn } from "node:child_process";
import fs from "node:fs";
import path from "node:path";
import { z } from "zod";
import { addProgram, checkExecutable, findProgram, listPrograms, PROGRAM_NAME, searchPrograms } from "../core/programs.js";
import { defineTool, type Service } from "../core/types.js";

/** Lancer les programmes enregistrés, et en trouver/ajouter un quand il manque (ajout = confirmation). */
export function programsService(): Service {
  return {
    id: "programs",
    label: "Programmes",
    async available() {
      return process.platform === "win32" ? { ok: true } : { ok: false, reason: "Windows uniquement pour l'instant" };
    },
    tools() {
      const known = listPrograms();
      const names = known.map((p) => p.name).join(", ") || "aucun pour l'instant";
      return [
        defineTool({
          name: "program_launch",
          description:
            `Lance un programme enregistré par l'utilisateur. Programmes : ${names}. ` +
            "Si le programme demandé n'est pas dans la liste, cherche-le avec program_find puis propose de l'ajouter avec program_register.",
          schema: z.object({
            program: z.string().min(1).describe("Nom du programme enregistré"),
            open: z.string().max(500).optional().describe("Fichier ou dossier existant à ouvrir avec (optionnel)"),
          }),
          risk: "launch",
          // Lancer seul : direct. Avec un fichier à ouvrir : confirmation (le fichier pourrait venir d'une page lue).
          confirmIf: (a) => !!a.open,
          check(a) {
            const p = findProgram(a.program);
            if (!p) throw new Error(`« ${a.program} » n'est pas enregistré. Programmes : ${names}. Utilise program_find.`);
            checkExecutable(p.path);
            if (a.open && !fs.existsSync(a.open)) throw new Error(`fichier introuvable : ${a.open}`);
          },
          preview: (a) => `Lancer ${findProgram(a.program)?.path}${a.open ? `\nen ouvrant : ${path.resolve(a.open)}` : ""}`,
          async run(a) {
            const p = findProgram(a.program)!;
            const child = spawn(p.path, a.open ? [path.resolve(a.open)] : [], {
              cwd: path.dirname(p.path),
              detached: true,
              stdio: "ignore",
              windowsHide: false,
            });
            child.on("error", () => undefined);
            child.unref();
            return `${p.name} lancé${a.open ? ` avec ${a.open}` : ""}.`;
          },
        }),
        defineTool({
          name: "program_find",
          description:
            "Cherche un programme installé sur le PC (menu Démarrer, bureau, dossiers d'installation) et renvoie les exécutables candidats. Ne lance rien.",
          schema: z.object({ query: z.string().min(2).max(60).describe("Nom du programme, ex. blender, obs, steam") }),
          risk: "read",
          preview: () => "",
          async run(a) {
            const found = await searchPrograms(a.query);
            if (!found.length) return `Rien trouvé pour « ${a.query} ». Demande à l'utilisateur le chemin de l'exécutable.`;
            return (
              found.map((f, i) => `${i + 1}. ${f.name} — ${f.path} (${f.source})`).join("\n") +
              "\n\nPropose à l'utilisateur le bon candidat, puis enregistre-le avec program_register."
            );
          },
        }),
        defineTool({
          name: "program_register",
          description: "Enregistre un exécutable (.exe) sous un nom pour pouvoir le lancer ensuite. L'utilisateur confirme.",
          schema: z.object({
            name: z.string().regex(PROGRAM_NAME).describe("Nom court, ex. Blender"),
            path: z.string().min(3).max(500).describe("Chemin complet du .exe (venant de program_find)"),
            description: z.string().max(200).optional(),
          }),
          risk: "local",
          check(a) {
            checkExecutable(a.path);
          },
          preview: (a) => `Ajouter le programme « ${a.name} » :\n${path.resolve(a.path)}\n(l'IA pourra ensuite le lancer)`,
          async run(a) {
            const p = addProgram(a.name, a.path, a.description);
            return `Programme « ${p.name} » enregistré (${p.path}). Tu peux maintenant le lancer avec program_launch.`;
          },
        }),
      ];
    },
  };
}
