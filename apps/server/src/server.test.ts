import { afterAll, beforeAll, describe, expect, it } from "vitest";
import type { AddressInfo } from "node:net";
import type { FastifyInstance } from "fastify";
import type { AuthResponse, Channel, Guild, Invite, Message } from "@aurora/schema";
import { buildApp } from "./http.ts";
import { Gateway } from "./gateway.ts";
import { Store } from "./store.ts";
import { GatewayTestClient, request } from "./test-utils.ts";

let app: FastifyInstance;
let store: Store;
let base = "";

beforeAll(async () => {
  store = new Store(":memory:");
  app = await buildApp({ store, gateway: new Gateway(store) });
  await app.listen({ port: 0, host: "127.0.0.1" });
  base = `http://127.0.0.1:${(app.server.address() as AddressInfo).port}`;
});

afterAll(async () => {
  await app.close();
  store.close();
});

const api = <T = unknown>(method: string, path: string, token?: string, body?: unknown) => request<T>(base, method, path, token, body);

const identify = (token: string) => GatewayTestClient.identify(base, token);

describe("servidor 1.0 (REST + gateway)", () => {
  let alice: AuthResponse;
  let bob: AuthResponse;
  let carol: AuthResponse;
  let guild: Guild;
  let general: Channel;
  let aliceWs: GatewayTestClient;
  let bobWs: GatewayTestClient;

  it("cadastra, recusa duplicado e valida senha", async () => {
    const a = await api<AuthResponse>("POST", "/api/auth/register", undefined, { username: "Alice", password: "senha-forte-1", displayName: "Alice A." });
    expect(a.status).toBe(201);
    expect(a.data.user).toMatchObject({ username: "alice", displayName: "Alice A." });
    alice = a.data;
    bob = (await api<AuthResponse>("POST", "/api/auth/register", undefined, { username: "bob", password: "senha-forte-2" })).data;
    carol = (await api<AuthResponse>("POST", "/api/auth/register", undefined, { username: "carol", password: "senha-forte-3" })).data;

    const dup = await api<{ error: { code: string } }>("POST", "/api/auth/register", undefined, { username: "ALICE", password: "outra-senha-1" });
    expect(dup.status).toBe(409);
    const weak = await api<{ error: { message: string } }>("POST", "/api/auth/register", undefined, { username: "dave", password: "123" });
    expect(weak.status).toBe(400);
    expect(weak.data.error.message).toContain("pelo menos 8");
  });

  it("login confere a senha e rotas exigem token", async () => {
    expect((await api("POST", "/api/auth/login", undefined, { username: "alice", password: "errada-123" })).status).toBe(401);
    const ok = await api<AuthResponse>("POST", "/api/auth/login", undefined, { username: "alice", password: "senha-forte-1" });
    expect(ok.status).toBe(200);
    expect(ok.data.token).not.toBe(alice.token);
    expect((await api("GET", "/api/users/@me")).status).toBe(401);
    expect((await api<{ username: string }>("GET", "/api/users/@me", alice.token)).data.username).toBe("alice");
  });

  it("gateway recusa sessão inválida", async () => {
    const client = new GatewayTestClient(base);
    await new Promise((r) => setTimeout(r, 50));
    client.send({ op: "identify", token: "token-falso" });
    expect((await client.next((f) => f.op === "invalid_session")).op).toBe("invalid_session");
    expect(await client.closed).toBe(4004);
  });

  it("cria servidor com #geral e entrega no READY", async () => {
    const created = await api<Guild>("POST", "/api/guilds", alice.token, { name: "Aurora Labs" });
    expect(created.status).toBe(201);
    guild = created.data;
    general = guild.channels[0]!;
    expect(general.name).toBe("geral");

    ({ client: aliceWs } = await identify(alice.token));
    const { client, ready } = await identify(bob.token);
    bobWs = client;
    expect(ready.guilds).toHaveLength(0);
    const aliceReady = await identify(alice.token);
    expect(aliceReady.ready.guilds.map((g) => g.id)).toEqual([guild.id]);
    aliceReady.client.close();
  });

  it("convite: bob entra, recebe o servidor e alice vê o novo membro online", async () => {
    const invite = await api<Invite>("POST", `/api/guilds/${guild.id}/invites`, alice.token);
    expect(invite.status).toBe(201);
    expect((await api("POST", "/api/invites/codigoinexistente", bob.token)).status).toBe(404);

    const joined = await api<Guild>("POST", `/api/invites/${invite.data.code}`, bob.token);
    expect(joined.status).toBe(200);
    expect((await bobWs.event("GUILD_CREATE")).d.id).toBe(guild.id);
    const added = await aliceWs.event("MEMBER_ADD");
    expect(added.d.member).toMatchObject({ user: { username: "bob" }, online: true });
  });

  it("mensagens chegam em tempo real, com nonce, e aparecem no histórico", async () => {
    const sent = await api<Message>("POST", `/api/channels/${general.id}/messages`, bob.token, { content: "  oi, alice!  ", nonce: "n-1" });
    expect(sent.status).toBe(201);
    expect(sent.data.content).toBe("oi, alice!");
    const live = await aliceWs.event("MESSAGE_CREATE");
    expect(live.d).toMatchObject({ id: sent.data.id, nonce: "n-1", author: { username: "bob" } });

    const history = await api<Message[]>("GET", `/api/channels/${general.id}/messages`, alice.token);
    expect(history.data.map((m) => m.id)).toEqual([sent.data.id]);
    expect((await api("POST", `/api/channels/${general.id}/messages`, bob.token, { content: "   " })).status).toBe(400);
  });

  it("só o autor edita; o dono do servidor pode apagar", async () => {
    const msg = (await api<Message>("POST", `/api/channels/${general.id}/messages`, bob.token, { content: "versão 1" })).data;
    await aliceWs.event("MESSAGE_CREATE");
    expect((await api("PATCH", `/api/messages/${msg.id}`, alice.token, { content: "hackeado" })).status).toBe(403);

    const edited = await api<Message>("PATCH", `/api/messages/${msg.id}`, bob.token, { content: "versão 2" });
    expect(edited.data.editedAt).not.toBeNull();
    expect((await aliceWs.event("MESSAGE_UPDATE")).d.content).toBe("versão 2");

    expect((await api("DELETE", `/api/messages/${msg.id}`, alice.token)).status).toBe(204);
    expect((await bobWs.event("MESSAGE_DELETE")).d).toEqual({ id: msg.id, channelId: general.id });
  });

  it("quem não é membro não vê nem escreve (404 em vez de 403)", async () => {
    expect((await api("GET", `/api/channels/${general.id}/messages`, carol.token)).status).toBe(404);
    expect((await api("POST", `/api/channels/${general.id}/messages`, carol.token, { content: "oi" })).status).toBe(404);
    expect((await api("POST", `/api/guilds/${guild.id}/invites`, carol.token)).status).toBe(404);
  });

  it("só o dono cria canais, com nome normalizado", async () => {
    expect((await api("POST", `/api/guilds/${guild.id}/channels`, bob.token, { name: "meu canal" })).status).toBe(403);
    const created = await api<Channel>("POST", `/api/guilds/${guild.id}/channels`, alice.token, { name: "  Fora do Tópico!  " });
    expect(created.data.name).toBe("fora-do-tópico");
    expect((await bobWs.event("CHANNEL_CREATE")).d.id).toBe(created.data.id);
  });

  it("digitando chega aos outros membros", async () => {
    bobWs.send({ op: "typing", channelId: general.id });
    expect((await aliceWs.event("TYPING_START")).d).toEqual({ channelId: general.id, userId: bob.user.id });
  });

  it("pagina o histórico com before, em ordem cronológica", async () => {
    const author = bob.user;
    const ids: string[] = [];
    for (let i = 0; i < 60; i++) ids.push(store.createMessage(general.id, author, `m${i}`).id);
    const latest = (await api<Message[]>("GET", `/api/channels/${general.id}/messages`, alice.token)).data;
    expect(latest).toHaveLength(50);
    expect(latest.at(-1)!.id).toBe(ids.at(-1));
    const older = (await api<Message[]>("GET", `/api/channels/${general.id}/messages?before=${latest[0]!.id}`, alice.token)).data;
    expect(older.length).toBeGreaterThan(0);
    expect(Number(older.at(-1)!.id)).toBeLessThan(Number(latest[0]!.id));
    const sorted = [...older].sort((a, b) => Number(a.id) - Number(b.id));
    expect(older.map((m) => m.id)).toEqual(sorted.map((m) => m.id));
  });

  it("presença: quando bob sai, alice recebe offline", async () => {
    bobWs.close();
    // (1.10: a própria pessoa também recebe a sua presença, para os outros aparelhos dela)
    const presence = await aliceWs.next((f) => f.op === "dispatch" && f.t === "PRESENCE_UPDATE" && f.d.userId === bob.user.id && !f.d.online);
    expect(presence).toMatchObject({ d: { userId: bob.user.id, online: false, status: "offline", customStatus: null } });
  });

  it("logout invalida o token e derruba a conexão", async () => {
    expect((await api("POST", "/api/auth/logout", alice.token)).status).toBe(204);
    expect(await aliceWs.closed).toBe(4004);
    expect((await api("GET", "/api/users/@me", alice.token)).status).toBe(401);
  });
});
