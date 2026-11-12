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
  root: TeamNode;
  maxCalls: number;
  maxDepth: number;
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
