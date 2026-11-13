import { describe, expect, it } from "vitest";
import type { AuthResponse, Guild, VoiceToken } from "@aurora/schema";
import { buildApp } from "./http.ts";
import { Gateway } from "./gateway.ts";
import { Store } from "./store.ts";
import { TURN_TTL_SECONDS, cloudflareTurn, parseIceServers, type IceServerSource } from "./turn.ts";

/** Resposta no formato documentado do `generate-ice-servers` da Cloudflare (com a porta 53 alternativa). */
const cloudflareResponse = {
  iceServers: [
    { urls: ["stun:stun.cloudflare.com:3478", "stun:stun.cloudflare.com:53"] },
    {
      urls: [
        "turn:turn.cloudflare.com:3478?transport=udp",
        "turn:turn.cloudflare.com:53?transport=udp",
        "turn:turn.cloudflare.com:3478?transport=tcp",
        "turns:turn.cloudflare.com:443?transport=tcp",
      ],
      username: "usuario-temporario",
      credential: "senha-temporaria",
    },
  ],
};

describe("credenciais do retransmissor (Cloudflare TURN)", () => {
  it("normaliza a resposta e tira a porta 53, que os navegadores bloqueiam", () => {
    expect(parseIceServers(cloudflareResponse)).toEqual([
      { urls: ["stun:stun.cloudflare.com:3478"] },
      {
        urls: ["turn:turn.cloudflare.com:3478?transport=udp", "turn:turn.cloudflare.com:3478?transport=tcp", "turns:turn.cloudflare.com:443?transport=tcp"],
        username: "usuario-temporario",
        credential: "senha-temporaria",
      },
    ]);
  });

  it("aceita o formato antigo (um objeto só, urls como texto)", () => {
    const old = { iceServers: { urls: "turn:turn.cloudflare.com:3478", username: "u", credential: "c" } };
    expect(parseIceServers(old)).toEqual([{ urls: ["turn:turn.cloudflare.com:3478"], username: "u", credential: "c" }]);
  });

  it("recusa resposta sem TURN utilizável (sem credencial ou com esquema estranho)", () => {
    expect(() => parseIceServers({ iceServers: [{ urls: ["stun:stun.cloudflare.com:3478"] }] })).toThrow(/TURN/);
    expect(() => parseIceServers({ iceServers: [{ urls: ["turn:turn.cloudflare.com:3478"] }] })).toThrow(/TURN/);
    expect(() => parseIceServers({ iceServers: [{ urls: ["https://evil.example"], username: "u", credential: "c" }] })).toThrow(/TURN/);
    expect(() => parseIceServers({ erro: true })).toThrow();
  });

  it("pede à API certa, com o token só no cabeçalho e validade de 24 h", async () => {
    const calls: { url: string; init: RequestInit }[] = [];
    const source = cloudflareTurn({
      keyId: "chave-123",
      apiToken: "token-secreto",
      fetch: (async (url: string, init: RequestInit) => {
        calls.push({ url, init });
        return new Response(JSON.stringify(cloudflareResponse), { status: 201 });
      }) as typeof fetch,
    });
    const servers = await source();
    expect(servers[1]?.username).toBe("usuario-temporario");
    expect(calls).toHaveLength(1);
    expect(calls[0]!.url).toBe("https://rtc.live.cloudflare.com/v1/turn/keys/chave-123/credentials/generate-ice-servers");
    expect(calls[0]!.init.method).toBe("POST");
    expect(calls[0]!.init.headers).toMatchObject({ Authorization: "Bearer token-secreto" });
    expect(JSON.parse(String(calls[0]!.init.body))).toEqual({ ttl: TURN_TTL_SECONDS });
    expect(TURN_TTL_SECONDS).toBeLessThanOrEqual(48 * 3600); // limite da Cloudflare
  });

  it("chave errada vira erro que diz o que conferir (sem vazar o token)", async () => {
    const source = cloudflareTurn({
      keyId: "chave-errada",
      apiToken: "token-secreto",
      fetch: (async () => new Response("nope", { status: 401 })) as unknown as typeof fetch,
    });
    const error = await source().then(() => null, (e: Error) => e);
    expect(error?.message).toMatch(/HTTP 401.*confira o ID da chave TURN/);
    expect(error?.message).not.toContain("token-secreto");
  });
});

describe("token de voz com retransmissor", () => {
  async function setup(turn: IceServerSource) {
    const store = new Store(":memory:");
    const app = await buildApp({ store, gateway: new Gateway(store), voice: { apiKey: "devkey", apiSecret: "secret", url: "wss://voz.exemplo.dev" }, turn });
    const ana = (await app.inject({ method: "POST", url: "/api/auth/register", payload: { username: "ana", password: "senha-forte-1" } })).json<AuthResponse>();
    const auth = { authorization: `Bearer ${ana.token}` };
    const guild = (await app.inject({ method: "POST", url: "/api/guilds", headers: auth, payload: { name: "Turma" } })).json<Guild>();
    const voice = guild.channels.find((c) => c.type === "voice")!;
    const join = async () => {
      const res = await app.inject({ method: "POST", url: `/api/channels/${voice.id}/voice`, headers: auth });
      return { status: res.statusCode, body: res.json<VoiceToken>() };
    };
    return { app, store, join };
  }

  it("cada entrada na voz leva credenciais novas do retransmissor", async () => {
    let generated = 0;
    const { app, store, join } = await setup(async () => {
      generated++;
      return parseIceServers(cloudflareResponse);
    });
    const first = await join();
    expect(first.status).toBe(200);
    expect(first.body.url).toBe("wss://voz.exemplo.dev");
    expect(first.body.iceServers?.[1]).toMatchObject({ username: "usuario-temporario", credential: "senha-temporaria" });
    await join();
    expect(generated).toBe(2);
    expect((await app.inject({ method: "GET", url: "/api/health" })).json()).toMatchObject({ voiceRelay: true });
    await app.close();
    store.close();
  });

  it("retransmissor fora do ar não impede entrar na voz (segue com conexão direta)", async () => {
    const { app, store, join } = await setup(async () => {
      throw new Error("a Cloudflare não respondeu");
    });
    const res = await join();
    expect(res.status).toBe(200);
    expect(res.body.token).toBeTruthy();
    expect(res.body.iceServers).toBeUndefined();
    await app.close();
    store.close();
  });
});
