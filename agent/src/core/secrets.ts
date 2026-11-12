import { Entry } from "@napi-rs/keyring";

/** Coffre : Gestionnaire d'identification Windows, service "MyIA". */
const SERVICE = "MyIA";
const NAME = /^[a-z0-9_]{2,64}$/;

/** Secrets connus (pour `myia secret list`). D'autres noms sont permis (serveurs MCP). */
export const KNOWN_SECRETS: Record<string, string> = {
  telegram_bot_token: "Jeton du bot Telegram (BotFather)",
  discord_bot_token: "Jeton du bot Discord (Developer Portal > Bot)",
  anthropic_api_key: "Clé d'API Anthropic des agents sur l'API Claude (platform.claude.com)",
};

function entry(name: string): Entry {
  if (!NAME.test(name)) throw new Error(`Nom de secret invalide : "${name}" (attendu : [a-z0-9_])`);
  return new Entry(SERVICE, name);
}

export function getSecret(name: string): string | undefined {
  try {
    return entry(name).getPassword() ?? undefined;
  } catch {
    return undefined;
  }
}

export function setSecret(name: string, value: string): void {
  entry(name).setPassword(value);
}

export function deleteSecret(name: string): boolean {
  try {
    return entry(name).deletePassword();
  } catch {
    return false;
  }
}

/** Remplace toute occurrence d'un secret par [secret] (messages d'erreur, journaux). */
export function redact(text: string, ...secrets: (string | undefined)[]): string {
  let out = text;
  for (const s of secrets) if (s && s.length >= 6) out = out.split(s).join("[secret]");
  return out;
}
