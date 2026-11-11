#!/usr/bin/env node
import { confirm, input, password } from "@inquirer/prompts";
import { styleText } from "node:util";
import { Agent } from "../core/agent.js";
import { audit } from "../core/audit.js";
import { loadConfig, type Config } from "../core/config.js";
import { paths } from "../core/paths.js";
import { deleteSecret, getSecret, KNOWN_SECRETS, setSecret } from "../core/secrets.js";
import type { AgentUI } from "../core/types.js";
import { buildServices } from "../services/index.js";

const dim = (s: string) => styleText("dim", s);
const bold = (s: string) => styleText("bold", s);
const ok = (s: string) => styleText("green", s);
const warn = (s: string) => styleText("yellow", s);
const err = (s: string) => styleText("red", s);

const consoleUI: AgentUI = {
  async confirm(title, details) {
    console.log("\n" + warn(`┌─ Confirmation : ${title}`));
    for (const line of details.split("\n")) console.log(warn("│ ") + line);
    console.log(warn("└─"));
    try {
      return await confirm({ message: "Exécuter ?", default: false });
    } catch {
      return false;
    }
  },
  progress(message) {
    console.log(dim(`  ⋯ ${message}`));
  },
};

/**
 * Une erreur jamais rattrapée (service en arrière-plan, sous-processus MCP…) tuait la console sans laisser de trace.
 * On la journalise (data/audit, event "crash") et on l'affiche avant de sortir.
 * - uncaughtException : l'état du processus n'est plus fiable, on sort.
 * - unhandledRejection : une promesse oubliée ne doit pas tuer la discussion ; on journalise et on continue.
 */
function installCrashHandlers() {
  const report = (kind: string, e: unknown) => {
    const error = e instanceof Error ? e : new Error(String(e));
    if (isExitError(error)) return false;
    audit({ event: "crash", error: `${kind}: ${error.message}`, stack: error.stack });
    console.error(err(`\n  ${kind} : ${error.message}`) + dim('\n  (détail dans data/audit, event "crash")'));
    return true;
  };
  process.on("uncaughtException", (e) => {
    report("plantage", e);
    process.exit(1);
  });
  process.on("unhandledRejection", (e) => {
    report("erreur non rattrapée", e);
  });
}

function isExitError(e: unknown) {
  return e instanceof Error && (e.name === "ExitPromptError" || e.name === "AbortPromptError");
}

async function makeAgent(): Promise<{ agent: Agent; cfg: Config }> {
  const cfg = loadConfig();
  const agent = new Agent(cfg, buildServices(cfg));
  await agent.client.ensureRunning();
  if (!(await agent.client.hasModel())) {
    throw new Error(`Modèle ${cfg.llm.model} absent. Lance : ${paths.ollamaExe} pull ${cfg.llm.model}`);
  }
  await agent.refreshServices();
  return { agent, cfg };
}

function printServices(agent: Agent) {
  for (const { service, status } of agent.statuses) {
    const mark = status.ok ? ok("●") : dim("○");
    const detail = status.ok ? dim(service.tools().map((t) => t.name).join(", ")) : dim(status.reason ?? "");
    console.log(`  ${mark} ${service.label.padEnd(28)} ${detail}`);
  }
}

async function chat() {
  const { agent, cfg } = await makeAgent();
  console.log(bold("MyIA") + dim(` — modèle ${cfg.llm.model} — /aide pour les commandes`));
  printServices(agent);
  process.stdout.write(dim("  chargement du modèle en mémoire… "));
  await agent.client.warmUp();
  console.log(dim("prêt.\n"));
  audit({ event: "session_start" });

  let running: AbortController | undefined;
  process.on("SIGINT", () => {
    if (running) {
      running.abort();
      console.log(warn("\n  (interrompu)"));
    } else process.exit(0);
  });

  try {
    for (;;) {
      let line: string;
      try {
        line = (await input({ message: "toi ›", theme: { prefix: "" } })).trim();
      } catch (e) {
        if (isExitError(e)) break;
        throw e;
      }
      if (!line) continue;
      if (line === "/quitter" || line === "/q" || line === "/exit") break;
      if (line === "/aide" || line === "/help") {
        console.log(dim("  /services  état des services   /reset  oublier la conversation   /quitter  sortir"));
        continue;
      }
      if (line === "/reset") {
        agent.reset();
        console.log(dim("  conversation effacée."));
        continue;
      }
      if (line === "/services") {
        await agent.refreshServices();
        printServices(agent);
        continue;
      }

      running = new AbortController();
      try {
        const answer = await agent.handle(line, consoleUI, running.signal);
        console.log(`\n${bold("myia ›")} ${answer}\n`);
      } catch (e) {
        if (running.signal.aborted) continue;
        console.log(err(`  erreur : ${(e as Error).message}`));
      } finally {
        running = undefined;
      }
    }
  } finally {
    audit({ event: "session_end" });
    await agent.close();
  }
}

async function secretCmd(action?: string, name?: string) {
  if (action === "list" || !action) {
    for (const [n, desc] of Object.entries(KNOWN_SECRETS)) {
      console.log(`  ${getSecret(n) ? ok("●") : dim("○")} ${n.padEnd(22)} ${dim(desc)}`);
    }
    console.log(dim("\n  myia secret set <nom>   |   myia secret delete <nom>"));
    return;
  }
  if (!name) throw new Error("nom du secret manquant");
  if (action === "set") {
    const value = await password({ message: `Valeur de ${name} (masquée) :`, mask: "•" });
    if (!value.trim()) throw new Error("valeur vide, rien enregistré");
    setSecret(name, value.trim());
    console.log(ok(`  ${name} enregistré dans le Gestionnaire d'identification Windows (service MyIA).`));
  } else if (action === "delete") {
    console.log(deleteSecret(name) ? ok(`  ${name} supprimé.`) : warn(`  ${name} n'existait pas.`));
  } else throw new Error(`action inconnue : ${action}`);
}

async function doctor() {
  const line = (good: boolean, label: string, detail = "") =>
    console.log(`  ${good ? ok("✓") : err("✗")} ${label}${detail ? dim("  " + detail) : ""}`);
  let cfg: Config;
  try {
    cfg = loadConfig();
    line(true, "configuration", paths.config);
  } catch (e) {
    line(false, "configuration", (e as Error).message);
    return;
  }
  const agent = new Agent(cfg, buildServices(cfg));
  try {
    await agent.client.ensureRunning();
    const v = await agent.client.version();
    const [maj = 0, min = 0] = v.split(".").map(Number);
    const recent = maj > 0 || min >= 12;
    line(recent, `Ollama ${v}`, recent ? cfg.llm.baseUrl : `trop ancien : un autre Ollama occupe le port ? Utilise ${paths.ollamaExe}`);
    const has = await agent.client.hasModel();
    line(has, `modèle ${cfg.llm.model}`, has ? "" : `${paths.ollamaExe} pull ${cfg.llm.model}`);
  } catch (e) {
    line(false, "Ollama", (e as Error).message);
  }
  await agent.refreshServices();
  console.log(bold("\n  Services"));
  printServices(agent);
  await agent.close();
}

async function ask(text: string) {
  const { agent } = await makeAgent();
  try {
    console.log(await agent.handle(text, consoleUI));
  } finally {
    await agent.close();
  }
}

async function main() {
  installCrashHandlers();
  const [cmd, ...rest] = process.argv.slice(2);
  switch (cmd) {
    case undefined:
    case "chat":
      return chat();
    case "ask":
      if (!rest.length) throw new Error('usage : myia ask "ta demande"');
      return ask(rest.join(" "));
    case "doctor":
      return doctor();
    case "secret":
      return secretCmd(rest[0], rest[1]);
    case "help":
    case "--help":
    case "-h":
      console.log(`myia               discussion
myia ask "…"       une seule demande
myia doctor        vérifie Ollama, le modèle et les services
myia secret list | set <nom> | delete <nom>`);
      return;
    default:
      throw new Error(`commande inconnue : ${cmd} (myia help)`);
  }
}

main()
  .then(() => process.exit(0))
  .catch((e) => {
    if (isExitError(e)) process.exit(0);
    console.error(err(`erreur : ${(e as Error).message}`));
    process.exit(1);
  });
