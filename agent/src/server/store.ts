import crypto from "node:crypto";
import fs from "node:fs";
import path from "node:path";
import type { ChatMessage } from "../core/llm.js";
import { paths } from "../core/paths.js";
import { writeJsonAtomic } from "../core/profiles.js";

/** Ce que l'interface affiche (distinct de l'historique brut envoyé au modèle). */
export interface DisplayMessage {
  id: string;
  role: "user" | "assistant" | "progress" | "confirm" | "error";
  text: string;
  ts: string;
  /** Confirmations : titre et décision. */
  title?: string;
  decision?: "pending" | "approved" | "refused";
}

export interface Conversation {
  id: string;
  agentId: string;
  /** Conversation avec une équipe : agentId est alors l'agent racine (le chef). */
  teamId?: string;
  title: string;
  createdAt: string;
  updatedAt: string;
  pinned?: boolean;
  messages: DisplayMessage[];
  history: ChatMessage[];
}

export type ConversationSummary = Omit<Conversation, "messages" | "history"> & {
  messageCount: number;
  lastMessage?: string;
};

const ID = /^[a-f0-9-]{36}$/;
const MAX_DISPLAY = 2000;

/** Conversations : un fichier JSON par conversation sous data/conversations (hors git). */
export class ConversationStore {
  private cache = new Map<string, Conversation>();

  constructor(private readonly dir = path.join(paths.home, "data", "conversations")) {
    fs.mkdirSync(dir, { recursive: true });
    for (const f of fs.readdirSync(dir)) {
      if (!f.endsWith(".json")) continue;
      try {
        const c = JSON.parse(fs.readFileSync(path.join(dir, f), "utf8")) as Conversation;
        if (ID.test(c.id)) this.cache.set(c.id, c);
      } catch {
        process.stderr.write(`[store] conversation illisible ignorée : ${f}\n`);
      }
    }
  }

  list(): ConversationSummary[] {
    return [...this.cache.values()]
      .map(({ messages, history: _h, ...rest }) => ({
        ...rest,
        messageCount: messages.filter((m) => m.role === "user" || m.role === "assistant").length,
        lastMessage: [...messages].reverse().find((m) => m.role === "assistant" || m.role === "user")?.text.slice(0, 160),
      }))
      .sort((a, b) => b.updatedAt.localeCompare(a.updatedAt));
  }

  get(id: string): Conversation {
    if (typeof id !== "string" || !ID.test(id)) throw new Error("id de conversation invalide");
    const c = this.cache.get(id);
    if (!c) throw new Error("conversation introuvable");
    return c;
  }

  create(agentId: string, title?: string, teamId?: string): Conversation {
    const now = new Date().toISOString();
    const c: Conversation = {
      id: crypto.randomUUID(),
      agentId,
      ...(teamId ? { teamId } : {}),
      title: title?.trim().slice(0, 80) || "Nouvelle conversation",
      createdAt: now,
      updatedAt: now,
      messages: [],
      history: [],
    };
    this.cache.set(c.id, c);
    this.save(c);
    return c;
  }

  push(c: Conversation, msg: Omit<DisplayMessage, "id" | "ts">): DisplayMessage {
    const full: DisplayMessage = { id: crypto.randomUUID(), ts: new Date().toISOString(), ...msg };
    c.messages.push(full);
    if (c.messages.length > MAX_DISPLAY) c.messages.splice(0, c.messages.length - MAX_DISPLAY);
    c.updatedAt = full.ts;
    this.save(c);
    return full;
  }

  save(c: Conversation) {
    writeJsonAtomic(path.join(this.dir, `${c.id}.json`), c);
  }

  delete(id: string) {
    this.get(id);
    this.cache.delete(id);
    fs.rmSync(path.join(this.dir, `${id}.json`), { force: true });
  }
}
