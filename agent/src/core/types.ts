import { z } from "zod";
import type { UrlTrust } from "./urls.js";

/**
 * Niveau de risque d'un outil (voir docs/SPEC.md §3).
 * - read     : exécuté sans demander
 * - local    : confirmation, sauf projet en autoApprove
 * - launch   : ouvre une appli ou une page sur la machine sans rien modifier (éditeur Godot, navigateur) :
 *              pas de confirmation, sauf si l'outil la demande pour ces arguments (confirmIf)
 * - local    : confirmation, sauf projet en autoApprove
 * - external : confirmation toujours (quelque chose sort de la machine)
 */
export type Risk = "read" | "launch" | "local" | "external";

/** Ce que l'interface (console aujourd'hui, Tauri demain) fournit au moteur. */
export interface AgentUI {
  confirm(title: string, details: string): Promise<boolean>;
  progress(message: string): void;
}

export interface ToolContext {
  ui: AgentUI;
  signal?: AbortSignal;
  /** Liens de confiance de la conversation en cours. */
  trust: UrlTrust;
}

export interface Tool {
  /** Nom exposé au modèle : [a-z0-9_], unique. */
  name: string;
  description: string;
  /** JSON Schema des arguments, envoyé au modèle. */
  parameters: Record<string, unknown>;
  risk: Risk;
  /** Valide et normalise les arguments venant du modèle (lève une erreur lisible si invalides). */
  parse(raw: unknown): unknown;
  /** Projet concerné, pour la règle autoApprove. */
  projectOf?(args: unknown): string | undefined;
  /** Outils `launch` : vrai si ces arguments-là exigent quand même une confirmation. */
  confirmIf?(args: unknown, trust: UrlTrust): boolean;
  /** Vérifications préalables (lève une erreur) : faites AVANT de demander une confirmation. */
  check?(args: unknown): void | Promise<void>;
  /** Texte exact montré à l'utilisateur avant confirmation. */
  preview(args: unknown): string | Promise<string>;
  run(args: unknown, ctx: ToolContext): Promise<string>;
}

export interface Availability {
  ok: boolean;
  reason?: string;
}

export interface Service {
  id: string;
  label: string;
  available(): Promise<Availability>;
  tools(): Tool[];
  close?(): Promise<void>;
}

/** Déclare un outil typé à partir d'un schéma zod. */
export function defineTool<S extends z.ZodType>(def: {
  name: string;
  description: string;
  schema: S;
  risk: Risk;
  projectOf?: (args: z.infer<S>) => string | undefined;
  confirmIf?: (args: z.infer<S>, trust: UrlTrust) => boolean;
  check?: (args: z.infer<S>) => void | Promise<void>;
  preview: (args: z.infer<S>) => string | Promise<string>;
  run: (args: z.infer<S>, ctx: ToolContext) => Promise<string>;
}): Tool {
  const { $schema: _ignored, ...parameters } = z.toJSONSchema(def.schema) as Record<string, unknown>;
  return {
    name: def.name,
    description: def.description,
    parameters,
    risk: def.risk,
    parse(raw) {
      const res = def.schema.safeParse(raw ?? {});
      if (!res.success) {
        throw new Error(
          "Arguments invalides : " +
            res.error.issues.map((i) => `${i.path.join(".") || "(racine)"} : ${i.message}`).join(" ; "),
        );
      }
      return res.data;
    },
    projectOf: def.projectOf ? (a) => def.projectOf!(a as z.infer<S>) : undefined,
    confirmIf: def.confirmIf ? (a, t) => def.confirmIf!(a as z.infer<S>, t) : undefined,
    check: def.check ? (a) => def.check!(a as z.infer<S>) : undefined,
    preview: (a) => def.preview(a as z.infer<S>),
    run: (a, ctx) => def.run(a as z.infer<S>, ctx),
  };
}

/** z.enum exige au moins une valeur : renvoie undefined si la liste est vide. */
export function nonEmptyEnum(values: string[]) {
  if (values.length === 0) return undefined;
  return z.enum(values as [string, ...string[]]);
}

export function truncate(text: string, max: number): string {
  if (text.length <= max) return text;
  return text.slice(0, max) + `\n… [tronqué, ${text.length - max} caractères en plus]`;
}
