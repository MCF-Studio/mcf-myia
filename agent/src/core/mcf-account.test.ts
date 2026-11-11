import crypto from "node:crypto";
import http from "node:http";
import { afterEach, describe, expect, it } from "vitest";
import { deviceLabel, McfAccount, type TokenStore } from "./mcf-account.js";

/** Faux site mcfstudio.fr : point de jeton qui vérifie vraiment PKCE, rotation, révocation. */
function fakeSite() {
  const codes = new Map<string, { challenge: string; redirect: string }>();
  const refreshes = new Map<string, number>(); // jeton de renouvellement → n° de version
  const revoked: string[] = [];
  let version = 0;
  const jwt = (claims: object) =>
    `e30.${Buffer.from(JSON.stringify({ sub: "42", name: "Léa", avatar: null, certified: true, ...claims })).toString("base64url")}.sig`;
  const issue = () => {
    const refresh = `r${++version}`;
    refreshes.set(refresh, version);
    return { access_token: jwt({ v: version }), refresh_token: refresh, expires_in: 900, token_type: "Bearer" };
  };
  const server = http.createServer((req, res) => {
    let body = "";
    req.on("data", (c) => (body += c));
    req.on("end", () => {
      const json = (status: number, data: object) => res.writeHead(status, { "content-type": "application/json" }).end(JSON.stringify(data));
      const b = body ? (JSON.parse(body) as Record<string, string>) : {};
      if (req.url === "/api/oauth/token" && b.grant_type === "authorization_code") {
        const c = codes.get(b.code!);
        codes.delete(b.code!);
        const pkce = crypto.createHash("sha256").update(b.code_verifier ?? "").digest("base64url");
        if (!c || c.challenge !== pkce || c.redirect !== b.redirect_uri || b.client_id !== "myia") return json(400, { error: "invalid_grant" });
        return json(200, issue());
      }
      if (req.url === "/api/oauth/token" && b.grant_type === "refresh_token") {
        if (!refreshes.has(b.refresh_token!)) return json(400, { error: "invalid_grant", message: "Autorisation invalide" });
        refreshes.delete(b.refresh_token!);
        return json(200, issue());
      }
      if (req.url === "/api/oauth/revoke") {
        revoked.push(b.token!);
        refreshes.delete(b.token!);
        return json(200, { ok: true });
      }
      json(404, { error: "not_found" });
    });
  });
  return {
    server,
    codes,
    revoked,
    refreshes,
    start: () => new Promise<string>((r) => server.listen(0, "127.0.0.1", () => r(`http://127.0.0.1:${(server.address() as { port: number }).port}`))),
  };
}

const memoryStore = (): TokenStore & { value?: string } => {
  const s: TokenStore & { value?: string } = {
    get: () => s.value,
    set: (t) => (s.value = t),
    clear: () => (s.value = undefined),
  };
  return s;
};

/** Faux navigateur : le membre autorise sur le site, qui redirige vers la boucle locale de MyIA. */
function browser(site: ReturnType<typeof fakeSite>, behavior: "approve" | "deny" | "attack-then-approve" = "approve") {
  const opened: URL[] = [];
  return {
    opened,
    open: (raw: string) => {
      const url = new URL(raw);
      opened.push(url);
      const redirect = url.searchParams.get("redirect_uri")!;
      const state = url.searchParams.get("state")!;
      void (async () => {
        if (behavior === "attack-then-approve") {
          // Un tiers tente d'injecter SON code (état inconnu) : refusé, la connexion attend toujours.
          const r = await fetch(`${redirect}?code=code-pirate&state=faux`);
          expect(r.status).toBe(400);
        }
        if (behavior === "deny") {
          await fetch(`${redirect}?error=access_denied&state=${state}`);
          return;
        }
        const code = crypto.randomBytes(16).toString("hex");
        site.codes.set(code, { challenge: url.searchParams.get("code_challenge")!, redirect });
        const r = await fetch(`${redirect}?code=${code}&state=${state}`);
        expect(await r.text()).toContain("Connecté à MyIA");
      })();
    },
  };
}

let site: ReturnType<typeof fakeSite> | undefined;
afterEach(() => site?.server.close());

describe("connexion à mcfstudio.fr (OAuth + PKCE, boucle locale)", () => {
  it("connecte : bonnes demandes au site, jeton de renouvellement au coffre, compte lu dans le jeton", async () => {
    site = fakeSite();
    const url = await site.start();
    const store = memoryStore();
    const nav = browser(site);
    const account = await new McfAccount(url, { store, openBrowser: nav.open }).login();

    expect(account).toEqual({ id: 42, name: "Léa", avatar: null, certified: true });
    expect(store.value).toBe("r1");
    const asked = nav.opened[0]!;
    expect(asked.pathname).toBe("/autoriser");
    expect(Object.fromEntries(asked.searchParams)).toMatchObject({
      client_id: "myia",
      response_type: "code",
      scope: "guild",
      code_challenge_method: "S256",
    });
    expect(asked.searchParams.get("redirect_uri")).toMatch(/^http:\/\/127\.0\.0\.1:\d+\/callback$/);
    expect(asked.searchParams.get("code_challenge")).toMatch(/^[A-Za-z0-9_-]{43}$/);
  });

  it("ignore un code injecté avec un autre état, puis accepte la vraie réponse", async () => {
    site = fakeSite();
    const url = await site.start();
    const account = await new McfAccount(url, { store: memoryStore(), openBrowser: browser(site, "attack-then-approve").open }).login();
    expect(account.name).toBe("Léa");
  });

  it("refus sur le site : erreur claire, rien n'est stocké", async () => {
    site = fakeSite();
    const url = await site.start();
    const store = memoryStore();
    await expect(new McfAccount(url, { store, openBrowser: browser(site, "deny").open }).login()).rejects.toThrow(/refusée/);
    expect(store.value).toBeUndefined();
  });

  it("renouvelle à l'expiration avec rotation ; accès retiré sur le site = oubli local", async () => {
    site = fakeSite();
    const url = await site.start();
    const store = memoryStore();
    let now = 1_000_000;
    const acc = new McfAccount(url, { store, openBrowser: browser(site).open, now: () => now });
    await acc.login();
    const first = await acc.accessToken();
    expect(await acc.accessToken()).toBe(first); // encore valide : pas d'appel

    now += 15 * 60_000;
    const second = await acc.accessToken();
    expect(second).not.toBe(first);
    expect(store.value).toBe("r2");

    // L'utilisateur retire l'accès depuis sa page Compte.
    site.refreshes.clear();
    now += 15 * 60_000;
    await expect(acc.accessToken()).rejects.toThrow();
    expect(store.value).toBeUndefined();
    expect(await acc.account()).toBeUndefined();
  });

  it("déconnexion : révoque sur le site puis oublie", async () => {
    site = fakeSite();
    const url = await site.start();
    const store = memoryStore();
    const acc = new McfAccount(url, { store, openBrowser: browser(site).open });
    await acc.login();
    await acc.logout();
    expect(site.revoked).toEqual(["r1"]);
    expect(store.value).toBeUndefined();
  });

  it("site sans la fonction (pas encore déployée) : message explicite", async () => {
    site = fakeSite();
    const url = await site.start();
    const store = memoryStore();
    store.set("ancien");
    const acc = new McfAccount(`${url}/inexistant`, { store, openBrowser: () => undefined });
    await expect(acc.accessToken()).rejects.toThrow(/pas encore/);
    expect(store.value).toBe("ancien"); // une panne du site ne déconnecte pas
  });

  it("nom d'appareil accepté par le site", () => {
    expect(deviceLabel("DESKTOP-ABC123")).toBe("MyIA sur DESKTOP-ABC123");
    expect(deviceLabel("pc<script>")).toBe("MyIA sur pcscript");
    expect(deviceLabel("x".repeat(100)).length).toBeLessThanOrEqual(60);
  });
});
