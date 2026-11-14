import path from "node:path";
import { findRuntime, scriptCommand, scriptEnv, type ScriptStore } from "../core/scripts.js";
import type { Service } from "../core/types.js";
import { mcpService } from "./mcp.js";

/** Premier lancement : uv peut devoir télécharger Python et les dépendances du script. */
const START_TIMEOUT_MS = 180_000;

/**
 * Un script d'équipe devient un service : un serveur MCP lancé par uv (ou Python) dans le dossier de travail de
 * l'équipe. Avant CHAQUE lancement et à chaque vérification : accord de l'utilisateur présent et empreinte des fichiers
 * inchangée (ScriptStore.blocked). Tous ses outils sont `external` : chaque appel est confirmé avec ses arguments.
 */
export function scriptService(store: ScriptStore, id: string, cwd: string): Service {
  let inner: Service | undefined;
  let innerKey = "";

  const stop = async () => {
    const s = inner;
    inner = undefined;
    innerKey = "";
    await s?.close?.();
  };

  return {
    id: `script:${id}`,
    get label() {
      return `Script ${store.get(id)?.name ?? id}`;
    },
    async available() {
      const blocked = store.blocked(id);
      if (blocked) {
        await stop();
        return { ok: false, reason: blocked };
      }
      const rt = await findRuntime();
      if (!rt) {
        await stop();
        return { ok: false, reason: "Python introuvable : installe le moteur Python (Équipes → Scripts)" };
      }
      const entry = store.get(id)!;
      const key = `${rt.path}|${entry.approvedSha256}`;
      if (!inner || innerKey !== key) {
        await stop();
        const { command, args } = scriptCommand(rt, path.join(store.dir(id), entry.entry));
        inner = mcpService(
          `script_${id}`,
          { command, args, env: {}, cwd, enabled: true, risk: "external", readOnlyTools: [] },
          {
            id: `script:${id}`,
            label: `Script ${entry.name}`,
            shown: `Script « ${entry.name} »`,
            baseEnv: { ...scriptEnv(), MYIA_WORKSPACE: cwd },
            guard: () => store.blocked(id),
            startTimeoutMs: START_TIMEOUT_MS,
          },
        );
        innerKey = key;
      }
      return inner.available();
    },
    tools: () => inner?.tools() ?? [],
    close: stop,
  };
}
