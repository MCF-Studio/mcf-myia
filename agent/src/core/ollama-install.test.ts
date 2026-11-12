import { describe, expect, it } from "vitest";
import { installerEnv, signedByOllama } from "./ollama-install.js";

describe("installation d'Ollama", () => {
  it("n'accepte qu'un script valide et signé par Ollama Inc.", () => {
    expect(signedByOllama("Valid|CN=Ollama Inc., O=Ollama Inc., L=Toronto, S=Ontario, C=CA")).toBe(true);
    expect(signedByOllama("NotSigned|")).toBe(false);
    expect(signedByOllama("HashMismatch|CN=Ollama Inc., O=Ollama Inc.")).toBe(false);
    expect(signedByOllama("Valid|CN=Autre Société, O=Ollama Inc.")).toBe(false);
    expect(signedByOllama("Valid|CN=Ollama Incognito")).toBe(false);
  });

  it("ne transmet pas au script les variables qui le détournent", () => {
    const env = installerEnv({ PATH: "x", OLLAMA_DOWNLOAD_URL: "https://evil.example", Ollama_Uninstall: "1", OLLAMA_HOST: "127.0.0.1" });
    expect(env).toEqual({ PATH: "x", OLLAMA_HOST: "127.0.0.1" });
  });
});
