import type { Config } from "../core/config.js";
import { ProjectRegistry } from "../core/projects.js";
import type { Service } from "../core/types.js";
import { claudeService } from "./claude.js";
import { discordService } from "./discord.js";
import { godotService } from "./godot.js";
import { mcpService } from "./mcp.js";
import { fileWriteService } from "./file-write.js";
import { filesService } from "./files.js";
import { memoryService } from "./memory.js";
import { programsService } from "./programs.js";
import { projectsService } from "./projects.js";
import { telegramService } from "./telegram.js";
import { webService } from "./web.js";

/** Tous les services connus. Pour en ajouter un : un fichier dans services/ + une ligne ici, ou une entrée mcpServers. */
export function buildServices(cfg: Config): Service[] {
  const reg = new ProjectRegistry(cfg);
  return [
    telegramService(cfg),
    discordService(cfg),
    projectsService(reg),
    godotService(cfg, reg),
    claudeService(cfg, reg),
    webService(cfg),
    programsService(),
    filesService(cfg),
    fileWriteService(cfg),
    memoryService(cfg),
    ...Object.entries(cfg.mcpServers).map(([name, s]) => mcpService(name, s)),
  ];
}
