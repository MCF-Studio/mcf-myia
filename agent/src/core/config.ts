import fs from "node:fs";
import { z } from "zod";
import { paths } from "./paths.js";

const LOOPBACK = /^https?:\/\/(127\.0\.0\.1|localhost|\[::1\])(:\d+)?\/?$/;

const argv = z.array(z.string().min(1)).min(1);

const ProjectSchema = z.object({
  path: z.string().min(1),
  description: z.string().optional(),
  /** Cibles de build : nom → argv lancé SANS shell (ex. ["cmd","/d","/c","npm","run","build"]). */
  build: z.record(z.string(), argv).default({}),
  /** Actions `local` sur ce projet exécutées sans confirmation (jamais les `external`). */
  autoApprove: z.boolean().default(false),
  /** Outils accordés à Claude Code quand il travaille sur ce projet. */
  claudeAllowedTools: z.array(z.string()).optional(),
});

const McpServerSchema = z.object({
  command: z.string().min(1),
  args: z.array(z.string()).default([]),
  /** Valeurs "secret:<nom>" résolues depuis le coffre Windows au démarrage. */
  env: z.record(z.string(), z.string()).default({}),
  cwd: z.string().optional(),
  description: z.string().optional(),
  enabled: z.boolean().default(true),
  /** Risque par défaut des outils de ce serveur. */
  risk: z.enum(["read", "local", "external"]).default("external"),
  /** Outils de ce serveur considérés en lecture seule (aucune confirmation). */
  readOnlyTools: z.array(z.string()).default([]),
});

export const ConfigSchema = z.object({
  /** Site MCF Studio (compte de la Guilde). https obligatoire, sauf boucle locale (site de développement). */
  site: z
    .object({
      url: z
        .string()
        .regex(/^(https:\/\/[a-z0-9.-]+|http:\/\/(127\.0\.0\.1|localhost)(:\d+)?)$/i, "adresse https du site attendue (sans / final)")
        .default("https://mcfstudio.fr"),
      /** Relais de la Guilde (WebSocket). wss obligatoire, sauf boucle locale (relais de développement). */
      relayUrl: z
        .string()
        .regex(/^(wss:\/\/[a-z0-9.-]+(\/[a-z0-9]+)*|ws:\/\/(127\.0\.0\.1|localhost)(:\d+)?(\/[a-z0-9]+)*)$/i, "adresse wss du relais attendue")
        .default("wss://guilde.mcfstudio.fr/v1"),
    })
    .prefault({}),
  /** Comment l'agent appelle son utilisateur (prompts système). */
  user: z.object({ name: z.string().min(1).max(60).default("l'utilisateur") }).prefault({}),
  llm: z
    .object({
      baseUrl: z
        .string()
        .regex(LOOPBACK, "Ollama doit rester local (127.0.0.1 / localhost), voir SPEC §3")
        .default("http://127.0.0.1:11434"),
      model: z.string().default("qwen3:8b"),
      numCtx: z.number().int().min(2048).max(131072).default(8192),
      temperature: z.number().min(0).max(2).default(0.4),
      keepAlive: z.string().default("30m"),
      /** Lance Ollama (runtime\ollama\ollama.exe) s'il ne répond pas. */
      autoStart: z.boolean().default(true),
      /**
       * Réglages du moteur llama.cpp sous Ollama, appliqués quand MyIA lance Ollama lui-même : flash attention (calcul
       * de l'attention plus rapide et plus sobre) et mémoire de contexte compressée (q8_0 : environ moitié moins de
       * VRAM pour le contexte, perte de qualité négligeable ; q4_0 : encore moins, perte sensible ; f16 : sans
       * compression). La compression exige flash attention.
       */
      flashAttention: z.boolean().default(true),
      kvCache: z.enum(["f16", "q8_0", "q4_0"]).default("q8_0"),
    })
    .prefault({}),
  maxSteps: z.number().int().min(1).max(20).default(8),
  historyMessages: z.number().int().min(4).max(200).default(30),
  telegram: z
    .object({
      /** Nom lisible → chat_id (ex. "annonces": "-1001234567890"). */
      destinations: z.record(z.string(), z.union([z.string(), z.number()])).default({}),
    })
    .prefault({}),
  discord: z
    .object({
      /** Nom lisible → ID du salon. */
      channels: z.record(z.string(), z.string()).default({}),
    })
    .prefault({}),
  claude: z
    .object({
      command: z.string().default("claude"),
      model: z.string().optional(),
      /** Choisir Haiku/Sonnet/Opus selon la difficulté de chaque tâche (prioritaire sur `model`). */
      autoModel: z.boolean().default(true),
      /**
       * Consoles Claude Code de l'app lancées avec `--dangerously-skip-permissions` : Claude n'y demande plus
       * d'accord avant de modifier des fichiers ou de lancer des commandes. Désactivé par défaut (SPEC §3 bis).
       * Ne concerne pas `claude_delegate`, qui garde ses outils autorisés et sa confirmation.
       */
      bypassPermissions: z.boolean().default(false),
      maxTurns: z.number().int().min(1).max(200).default(40),
      timeoutMinutes: z.number().min(1).max(240).default(30),
      defaultAllowedTools: z
        .array(z.string())
        .default(["Read", "Glob", "Grep", "Edit", "Write", "Bash(git status:*)", "Bash(git diff:*)", "Bash(git log:*)"]),
    })
    .prefault({}),
  projects: z.record(z.string(), ProjectSchema).default({}),
  /** Dossiers parcourus pour trouver les projets automatiquement (depth = niveaux de sous-dossiers). */
  projectRoots: z
    .array(z.object({ path: z.string().min(1), depth: z.number().int().min(1).max(5).default(3) }))
    .default([]),
  godot: z
    .object({
      /** Dossier où sont créés les nouveaux projets Godot. */
      projectsRoot: z.string().optional(),
      /** Dossier contenant les Godot_vX.Y.Z-stable_win64.exe : détectés automatiquement. */
      versionsDir: z.string().optional(),
      /** Version → exécutable, prioritaire sur la détection (ex. "4.7": "D:/…/Godot_v4.7.2-stable_win64.exe"). */
      executables: z.record(z.string(), z.string()).default({}),
      defaultVersion: z.string().default("4.7"),
    })
    .prefault({}),
  web: z
    .object({
      enabled: z.boolean().default(true),
      /** Taille max d'une page lue (octets). */
      maxPageBytes: z.number().int().min(10_000).max(10_000_000).default(2_000_000),
    })
    .prefault({}),
  mcpServers: z.record(z.string(), McpServerSchema).default({}),
  /** Mémoire : dossiers de documents (Markdown, texte) où les agents puisent (voir core/memory.ts). */
  memory: z.object({ folders: z.array(z.string().min(3).max(500)).max(20).default([]) }).prefault({}),
  /** Programmes que l'IA peut lancer : nom → exécutable (voir core/programs.ts). */
  programs: z
    .record(
      z.string().min(1).max(40),
      z.object({
        path: z.string().min(1).max(500),
        description: z.string().max(200).optional(),
        sha256: z.string().regex(/^[a-f0-9]{64}$/).optional(),
      }),
    )
    .default({}),
});

export type Config = z.infer<typeof ConfigSchema>;
export type ProjectConfig = z.infer<typeof ProjectSchema>;
export type McpServerConfig = z.infer<typeof McpServerSchema>;

export function parseConfig(raw: unknown): Config {
  const res = ConfigSchema.safeParse(raw);
  if (!res.success) {
    const lines = res.error.issues.map((i) => `  - ${i.path.join(".")} : ${i.message}`);
    throw new Error(`Configuration invalide :\n${lines.join("\n")}`);
  }
  return res.data;
}

export function loadConfig(file = paths.config): Config {
  if (!fs.existsSync(file)) {
    throw new Error(`Configuration introuvable : ${file}`);
  }
  let raw: unknown;
  try {
    raw = JSON.parse(fs.readFileSync(file, "utf8"));
  } catch (e) {
    throw new Error(`JSON invalide dans ${file} : ${(e as Error).message}`);
  }
  return parseConfig(raw);
}
