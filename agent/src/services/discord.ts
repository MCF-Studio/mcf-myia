import { z } from "zod";
import type { Config } from "../core/config.js";
import { getSecret, redact } from "../core/secrets.js";
import { defineTool, nonEmptyEnum, type Service } from "../core/types.js";

export function discordService(cfg: Config): Service {
  const channels = cfg.discord.channels;
  const names = Object.keys(channels);
  const chanEnum = nonEmptyEnum(names);

  return {
    id: "discord",
    label: "Discord",
    async available() {
      if (!getSecret("discord_bot_token")) return { ok: false, reason: "jeton absent : myia secret set discord_bot_token" };
      if (!chanEnum) return { ok: false, reason: "aucun salon dans config > discord.channels" };
      return { ok: true };
    },
    tools() {
      if (!chanEnum) return [];
      return [
        defineTool({
          name: "discord_send",
          description: `Poste un message dans un salon Discord via le bot de l'utilisateur. Salons possibles : ${names.join(", ")}.`,
          schema: z.object({
            channel: chanEnum.describe("Nom du salon déclaré"),
            text: z.string().min(1).max(2000).describe("Texte exact du message"),
            mention_everyone: z.boolean().default(false).describe("Notifier @everyone (seulement si l'utilisateur le demande)"),
          }),
          risk: "external",
          preview: (a) =>
            `Discord → #${a.channel}${a.mention_everyone ? " (notifie @everyone)" : ""}\n────────\n${a.text}\n────────`,
          async run(a) {
            const token = getSecret("discord_bot_token");
            if (!token) throw new Error("jeton Discord absent");
            try {
              const r = await fetch(`https://discord.com/api/v10/channels/${channels[a.channel]}/messages`, {
                method: "POST",
                headers: { "content-type": "application/json", authorization: `Bot ${token}` },
                body: JSON.stringify({
                  content: a.text,
                  // Par défaut, aucune mention ne notifie personne.
                  allowed_mentions: { parse: a.mention_everyone ? ["everyone"] : [] },
                }),
                signal: AbortSignal.timeout(20_000),
              });
              if (!r.ok) throw new Error(`Discord a refusé (${r.status}) : ${(await r.text()).slice(0, 300)}`);
              const data = (await r.json()) as { id: string };
              return `Message posté sur Discord (#${a.channel}), id ${data.id}.`;
            } catch (e) {
              throw new Error(redact((e as Error).message, token));
            }
          },
        }),
      ];
    },
  };
}
