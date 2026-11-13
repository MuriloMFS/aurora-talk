import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { DatabaseSync } from "node:sqlite";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { AddressInfo } from "node:net";
import type { FastifyInstance } from "fastify";
import type { AuthResponse, Channel, Guild, Invite, VoiceToken } from "@aurora/schema";
import { buildApp } from "./http.ts";
import { Gateway } from "./gateway.ts";
import { Store } from "./store.ts";
import { GatewayTestClient, request } from "./test-utils.ts";

let app: FastifyInstance;
let store: Store;
let base = "";
const api = <T = unknown>(method: string, path: string, token?: string, body?: unknown) => request<T>(base, method, path, token, body);
const identify = (token: string) => GatewayTestClient.identify(base, token);

beforeAll(async () => {
  store = new Store(":memory:");
  app = await buildApp({ store, gateway: new Gateway(store), voice: { apiKey: "devkey", apiSecret: "secret" } });
  await app.listen({ port: 0, host: "127.0.0.1" });
  base = `http://127.0.0.1:${(app.server.address() as AddressInfo).port}`;
});

afterAll(async () => {
  await app.close();
  store.close();
});

const decodeJwt = (jwt: string) => JSON.parse(Buffer.from(jwt.split(".")[1]!, "base64url").toString("utf8")) as Record<string, unknown>;

describe("canais de voz", () => {
  let ana: AuthResponse;
  let beto: AuthResponse;
  let estranho: AuthResponse;
  let guild: Guild;
  let voice: Channel;
  let text: Channel;

  it("servidor novo vem com #geral (texto) e 'Sala de voz'", async () => {
    ana = (await api<AuthResponse>("POST", "/api/auth/register", undefined, { username: "ana", password: "senha-forte-1" })).data;
    beto = (await api<AuthResponse>("POST", "/api/auth/register", undefined, { username: "beto", password: "senha-forte-2" })).data;
    estranho = (await api<AuthResponse>("POST", "/api/auth/register", undefined, { username: "estranho", password: "senha-forte-3" })).data;
    guild = (await api<Guild>("POST", "/api/guilds", ana.token, { name: "Voz Teste" })).data;
    text = guild.channels.find((c) => c.type === "text")!;
    voice = guild.channels.find((c) => c.type === "voice")!;
    expect(text.name).toBe("geral");
    expect(voice.name).toBe("Sala de voz");
    expect(guild.voiceStates).toEqual([]);
    const invite = (await api<Invite>("POST", `/api/guilds/${guild.id}/invites`, ana.token)).data;
    await api("POST", `/api/invites/${invite.code}`, beto.token);
  });

  it("token de voz: só membros, só em canal de voz, com a sala e a identidade certas", async () => {
    const ok = await api<VoiceToken>("POST", `/api/channels/${voice.id}/voice`, ana.token);
    expect(ok.status).toBe(200);
    expect(ok.data.room).toBe(`aurora-voice-${voice.id}`);
    expect(ok.data.url).toBe("ws://127.0.0.1:7880");
    expect(ok.data.iceServers).toBeUndefined(); // sem retransmissor configurado: conexão direta
    const claims = decodeJwt(ok.data.token);
    expect(claims.sub).toBe(ana.user.id);
    expect(claims.iss).toBe("devkey");
    expect(claims.video).toMatchObject({ room: ok.data.room, roomJoin: true, canPublish: true, canSubscribe: true });

    expect((await api("POST", `/api/channels/${voice.id}/voice`, estranho.token)).status).toBe(404);
    expect((await api("POST", `/api/channels/${text.id}/voice`, ana.token)).status).toBe(400);
    // 1.13: a sala de voz também tem chat
    expect((await api("GET", `/api/channels/${voice.id}/messages`, ana.token)).status).toBe(200);
    expect((await api("POST", `/api/channels/${voice.id}/messages`, ana.token, { content: "oi" })).status).toBe(201);
  });

  it("dono cria canal de voz mantendo espaços e maiúsculas", async () => {
    const created = await api<Channel>("POST", `/api/guilds/${guild.id}/channels`, ana.token, { name: "  Sala   de Estar ", type: "voice" });
    expect(created.data).toMatchObject({ name: "Sala de Estar", type: "voice" });
  });

  it("entrar, mutar e sair da voz chega a todos; READY já traz quem está na sala", async () => {
    const { client: anaWs } = await identify(ana.token);
    const { client: betoWs } = await identify(beto.token);

    anaWs.send({ op: "voice_join", channelId: voice.id, muted: false, deafened: false });
    const joined = await betoWs.event("VOICE_STATE_UPDATE");
    expect(joined.d).toEqual({ guildId: guild.id, userId: ana.user.id, channelId: voice.id, muted: false, deafened: false, streaming: false, serverMuted: false });

    const late = await identify(beto.token);
    expect(late.ready.guilds[0]!.voiceStates).toEqual([{ userId: ana.user.id, channelId: voice.id, muted: false, deafened: false, streaming: false, serverMuted: false }]);
    late.client.close();

    anaWs.send({ op: "voice_state", muted: false, deafened: false, streaming: true });
    expect((await betoWs.event("VOICE_STATE_UPDATE")).d).toMatchObject({ streaming: true }); // AO VIVO

    anaWs.send({ op: "voice_state", muted: false, deafened: true, streaming: false });
    const deaf = await betoWs.event("VOICE_STATE_UPDATE");
    expect(deaf.d).toMatchObject({ muted: true, deafened: true, streaming: false }); // ensurdecer também muta

    anaWs.send({ op: "voice_leave" });
    expect((await betoWs.event("VOICE_STATE_UPDATE")).d).toMatchObject({ userId: ana.user.id, channelId: null, streaming: false });

    anaWs.send({ op: "voice_join", channelId: text.id, muted: false, deafened: false });
    await betoWs.expectNoEvent("VOICE_STATE_UPDATE"); // canal de texto: ignorado

    anaWs.send({ op: "voice_join", channelId: voice.id, muted: true, deafened: false });
    expect((await betoWs.event("VOICE_STATE_UPDATE")).d).toMatchObject({ channelId: voice.id, muted: true });
    anaWs.close(); // a conexão cai: sai da voz sozinha
    expect((await betoWs.event("VOICE_STATE_UPDATE")).d).toMatchObject({ userId: ana.user.id, channelId: null });
    betoWs.close();
  });
});

describe("migração do banco", () => {
  it("banco antigo (sem coluna type) abre e trata canais existentes como texto", () => {
    const dir = mkdtempSync(join(tmpdir(), "aurora-migracao-"));
    const path = join(dir, "antigo.db");
    const old = new DatabaseSync(path);
    old.exec(`CREATE TABLE users (id INTEGER PRIMARY KEY, username TEXT NOT NULL UNIQUE, display_name TEXT NOT NULL, password_hash TEXT NOT NULL, created_at INTEGER NOT NULL);
      CREATE TABLE guilds (id INTEGER PRIMARY KEY, name TEXT NOT NULL, owner_id INTEGER NOT NULL, created_at INTEGER NOT NULL);
      CREATE TABLE channels (id INTEGER PRIMARY KEY, guild_id INTEGER NOT NULL, name TEXT NOT NULL, position INTEGER NOT NULL);
      INSERT INTO users VALUES (1, 'velho', 'Velho', 'x', 0);
      INSERT INTO guilds VALUES (10, 'Antigo', 1, 0);
      INSERT INTO channels VALUES (20, 10, 'geral', 0);`);
    old.close();

    const migrated = new Store(path);
    expect(migrated.getChannel("20")).toMatchObject({ type: "text", name: "geral" });
    migrated.close();
    rmSync(dir, { recursive: true, force: true });
  });
});
