// Contrat avec le sidecar (agent/src/server). À garder aligné avec le code serveur.

export interface AgentProfile {
  id: string;
  name: string;
  description?: string;
  model?: string;
  color?: string;
  /** Photo en data URL (PNG/JPEG/WebP, 256 px max). */
  avatar?: string;
  instructions?: string;
  services?: string[];
  /** Agent MASTER : l'assistant principal, qui pilote l'app (un seul). */
  master?: boolean;
  /** Espace de travail : dossier dans lequel l'agent travaille (propre à cette machine, jamais exporté). */
  workspace?: string;
}

export interface DisplayMessage {
  id: string;
  role: "user" | "assistant" | "progress" | "confirm" | "error";
  text: string;
  ts: string;
  /** Écrit par un autre agent (ex. MASTER) au lieu de l'utilisateur. */
  from?: string;
  title?: string;
  decision?: "pending" | "approved" | "refused";
}

export interface TeamNode {
  id: string;
  agentId: string;
  subagents: TeamNode[];
  teammates: TeamNode[];
}

export interface Team {
  id: string;
  name: string;
  description?: string;
  /** Espace de travail de l'équipe : tous ses membres y travaillent. */
  workspace?: string;
  /** Espace de coordination : dossier à part pour les règles communes et le journal de l'équipe (jamais exporté). */
  coordination?: string;
  root: TeamNode;
  maxCalls: number;
  maxDepth: number;
  /** Scripts de l'équipe (ids) : des outils en plus pour tous ses membres. */
  scripts?: string[];
}

export interface ConversationSummary {
  id: string;
  agentId: string;
  teamId?: string;
  title: string;
  createdAt: string;
  updatedAt: string;
  pinned?: boolean;
  messageCount: number;
  lastMessage?: string;
}

export interface ConversationFull extends Omit<ConversationSummary, "messageCount" | "lastMessage"> {
  messages: DisplayMessage[];
  busy: boolean;
}

export interface RunningModel {
  name: string;
  size: number;
  sizeVram: number;
  expiresAt?: string;
}

export interface ModelInfo {
  name: string;
  size: number;
  modifiedAt: string;
  family?: string;
  parameterSize?: string;
  quantization?: string;
}

export interface ServiceStatus {
  id: string;
  label: string;
  ok: boolean;
  reason?: string;
  tools: string[];
}

export interface Overview {
  ollama: { ok: boolean; baseUrl: string; engine?: "ollama" | "llamacpp"; version?: string; running?: RunningModel[]; installedCount?: number; error?: string };
  defaultModel: string;
  agents: (AgentProfile & { model: string; conversations: number; busy: number })[];
  conversations: { total: number; busy: number };
  teams: { id: string; name: string }[];
  services: ServiceStatus[];
}

export interface SystemMetrics {
  cpuUsage: number;
  cpuCores: number;
  cpuBrand: string;
  memoryUsed: number;
  memoryTotal: number;
  gpus: { name: string; utilization: number; memoryUsedMb: number; memoryTotalMb: number; temperatureC?: number }[];
  processes: { name: string; pid: number; cpu: number; memory: number }[];
  os: string;
  uptimeSecs: number;
}

export interface SidecarStatus {
  running: boolean;
  pid?: number;
  home: string;
  error?: string;
}

export const THEME_TOKENS = [
  "bg",
  "bg-elevated",
  "surface",
  "surface-2",
  "border",
  "text",
  "text-muted",
  "accent",
  "accent-2",
  "accent-contrast",
  "glow",
  "success",
  "warning",
  "danger",
] as const;
export type ThemeToken = (typeof THEME_TOKENS)[number];

export interface Theme {
  id: string;
  name: string;
  author?: string;
  version: string;
  mode: "dark" | "light";
  colors: Record<ThemeToken, string>;
  radius: "sharp" | "normal" | "round";
  builtin?: boolean;
}

// ─── scripts d'équipe, workflows et marketplace (agent/src/core/{scripts,workflow,market}.ts) ───

export interface ScriptFile {
  path: string;
  content: string;
}

export interface ScriptInfo {
  id: string;
  name: string;
  description?: string;
  entry: string;
  sha256: string;
  approvedSha256?: string;
  origin?: string;
  addedAt: string;
  /** approved : peut tourner ; pending : jamais accepté ; changed : modifié depuis l'accord ; missing : fichiers absents. */
  state: "approved" | "pending" | "changed" | "missing";
  diskSha256: string | null;
  /** Équipes qui l'utilisent. */
  teams: string[];
}

export interface ScriptsStatus {
  scripts: ScriptInfo[];
  runtime: { kind: "uv" | "python"; label: string } | null;
  canInstallRuntime: boolean;
  installing: boolean;
  uv: { version: string; sizeMb: number };
}

/** Workflow examiné (workflows.inspect / market.preview) : ce qui serait installé, sans rien avoir écrit. */
export interface WorkflowPreview {
  sha256: string;
  origin: string;
  name: string;
  description: string | null;
  team: { root: TeamNode; nodes: number; maxCalls: number; maxDepth: number };
  agents: (AgentProfile & { reused: boolean })[];
  scripts: { id: string; name: string; description?: string; entry: string; sha256: string; files: ScriptFile[]; reused: boolean }[];
  /** Fiches de l'espace de coordination jointes par l'auteur (règles, méthode) : posées dans un dossier choisi à l'import. */
  fiches: ScriptFile[];
  renamed: { kind: "agent" | "script"; from: string; to: string }[];
  warnings: string[];
}

export interface WorkflowInstalled {
  team: Team;
  addedAgents: string[];
  reusedAgents: number;
  scriptsPending: number;
  fiches: { dir: string; created: string[]; kept: string[] } | null;
  fichesSkipped: number;
}

export interface WorkflowSummary {
  id: number;
  name: string;
  description: string | null;
  author: { id: number; name: string; certified: boolean };
  agents: number;
  scripts: number;
  sha256: string;
  visibility: "private" | "public";
  review: "none" | "pending" | "approved" | "rejected";
  rejectReason: string | null;
  downloads: number;
  updatedAt: string;
}

export interface WorkflowPage {
  workflows: WorkflowSummary[];
  page: number;
  pages: number;
  total: number;
}

export interface MarketAccount {
  site: string;
  account: { id: number; name: string; avatar: string | null; certified: boolean } | null;
}
