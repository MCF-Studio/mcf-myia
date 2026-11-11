import { z } from "zod";
import type { Config } from "../core/config.js";
import { getSecret, redact } from "../core/secrets.js";
import { defineTool, nonEmptyEnum, type Service } from "../core/types.js";

export function telegramService(cfg: Config): Service {
  const destinations = cfg.telegram.destinations;
  const names = Object.keys(destinations);
  const destEnum = nonEmptyEnum(names);

  return {
    id: "telegram",
    label: "Telegram",
    async available() {
      if (!getSecret("telegram_bot_token")) return { ok: false, reason: "jeton absent : myia secret set telegram_bot_token" };
      if (!destEnum) return { ok: false, reason: "aucune destination dans config > telegram.destinations" };
      return { ok: true };
    },
    tools() {
      if (!destEnum) return [];
      return [
        defineTool({
          name: "telegram_send",
          description: `Envoie un message Telegram via le bot de l'utilisateur. Destinations possibles : ${names.join(", ")}.`,
          schema: z.object({
            destination: destEnum.describe("Nom de la destination déclarée"),
            text: z.string().min(1).max(4096).describe("Texte exact du message"),
          }),
          risk: "external",
          preview: (a) => `Telegram → ${a.destination}\n────────\n${a.text}\n────────`,
          async run(a) {
            const token = getSecret("telegram_bot_token");
            if (!token) throw new Error("jeton Telegram absent");
            const chatId = destinations[a.destination];
            try {
              const r = await fetch(`https://api.telegram.org/bot${token}/sendMessage`, {
                method: "POST",
                headers: { "content-type": "application/json" },
                body: JSON.stringify({ chat_id: chatId, text: a.text }),
                signal: AbortSignal.timeout(20_000),
              });
              const data = (await r.json()) as { ok: boolean; description?: string; result?: { message_id: number } };
              if (!data.ok) throw new Error(`Telegram a refusé : ${data.description ?? r.status}`);
              return `Message envoyé sur Telegram (${a.destination}), id ${data.result?.message_id}.`;
            } catch (e) {
              throw new Error(redact((e as Error).message, token));
            }
          },
        }),
      ];
    },
  };
}
