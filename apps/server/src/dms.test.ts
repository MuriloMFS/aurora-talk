import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { DatabaseSync } from "node:sqlite";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { AddressInfo } from "node:net";
import type { FastifyInstance } from "fastify";
import type { AuthResponse, DmChannel, Guild, Invite, Message, Relationship, ServerFrame } from "@aurora/schema";
import { buildApp } from "./http.ts";
import { Gateway } from "./gateway.ts";
import { Store } from "./store.ts";
import { GatewayTestClient, request } from "./test-utils.ts";

let app: FastifyInstance;
let store: Store;
let base = "";
const api = <T = unknown>(method: string, path: string, token?: string, body?: unknown) => request<T>(base, method, path, token, body);
const ws = (token: string) => GatewayTestClient.identify(base, token, 2);
const eventWhere = <T extends string>(client: GatewayTestClient, t: T, match: (d: Record<string, unknown>) => boolean = () => true) =>
  client.next((f) => f.op === "dispatch" && f.t === t && match((f as unknown as { d: Record<string, unknown> }).d)) as Promise<Extract<ServerFrame, { op: "dispatch"; t: T }>>;

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

describe("amigos, bloqueio e conversas diretas", () => {
  let ana: AuthResponse;
  let beto: AuthResponse;
  let caio: AuthResponse; // divide servidor com a Ana, mas não é amigo
  let duda: AuthResponse;
  let estranho: AuthResponse; // não divide nada com ninguém
  let dm: DmChannel;

  it("pedido de amizade por @usuário: os dois ficam sabendo; aceitar vira amizade", async () => {
    const reg = (u: string) => api<AuthResponse>("POST", "/api/auth/register", undefined, { username: u, password: "senha-forte-1" }).then((r) => r.data);
    [ana, beto, caio, duda, estranho] = await Promise.all([reg("ana5"), reg("beto5"), reg("caio5"), reg("duda5"), reg("estranho5")]);
    const guild = (await api<Guild>("POST", "/api/guilds", ana.token, { name: "Turma" })).data;
    const invite = (await api<Invite>("POST", `/api/guilds/${guild.id}/invites`, ana.token)).data;
    await api("POST", `/api/invites/${invite.code}`, caio.token);

    const { client: betoWs } = await ws(beto.token);
    const sent = await api<Relationship>("POST", "/api/users/@me/relationships", ana.token, { username: "@Beto5" });
    expect(sent.data).toMatchObject({ type: "outgoing", user: { id: beto.user.id }, online: true });
    expect((await eventWhere(betoWs, "RELATIONSHIP_UPDATE")).d).toMatchObject({ type: "incoming", user: { id: ana.user.id } });
    // pedir de volta = aceitar
    expect((await api<Relationship>("POST", "/api/users/@me/relationships", beto.token, { userId: ana.user.id })).data.type).toBe("friend");
    expect((await api<Relationship[]>("GET", "/api/users/@me/relationships", ana.token)).data).toEqual([expect.objectContaining({ type: "friend", user: expect.objectContaining({ id: beto.user.id }) })]);
    expect((await api<{ error: { code: string } }>("POST", "/api/users/@me/relationships", ana.token, { username: "beto5" })).data.error.code).toBe("already_friends");
    expect((await api("POST", "/api/users/@me/relationships", ana.token, { username: "ana5" })).status).toBe(400);
    expect((await api("POST", "/api/users/@me/relationships", ana.token, { username: "ninguem" })).status).toBe(404);

    // Duda: aceitar pelo PUT
    await api("POST", "/api/users/@me/relationships", ana.token, { username: "duda5" });
    expect((await api<Relationship>("PUT", `/api/users/@me/relationships/${ana.user.id}`, duda.token, { type: "friend" })).data.type).toBe("friend");
    expect((await api("PUT", `/api/users/@me/relationships/${caio.user.id}`, ana.token, { type: "friend" })).status).toBe(400); // não há pedido
    betoWs.close();
  });

  it("conversa a dois: aparece para o outro só com a primeira mensagem; quem está fora não vê nada", async () => {
    const { client: betoWs } = await ws(beto.token);
    dm = (await api<DmChannel>("POST", "/api/users/@me/channels", ana.token, { recipientIds: [beto.user.id] })).data;
    expect(dm).toMatchObject({ type: "dm", name: null, recipients: [expect.objectContaining({ id: beto.user.id })], lastMessageId: null });
    await betoWs.expectNoEvent("DM_CHANNEL_CREATE");
    // abrir de novo devolve a mesma conversa
    expect((await api<DmChannel>("POST", "/api/users/@me/channels", ana.token, { recipientIds: [beto.user.id] })).data.id).toBe(dm.id);

    const msg = (await api<Message>("POST", `/api/channels/${dm.id}/messages`, ana.token, { content: "oi Beto" })).data;
    expect((await eventWhere(betoWs, "DM_CHANNEL_CREATE")).d).toMatchObject({ id: dm.id, recipients: [expect.objectContaining({ id: ana.user.id })] });
    expect((await eventWhere(betoWs, "MESSAGE_CREATE")).d).toMatchObject({ id: msg.id, content: "oi Beto" });

    // reconectar: a conversa vem no READY e conta como menção
    const again = await ws(beto.token);
    expect(again.ready.privateChannels?.map((c) => c.id)).toEqual([dm.id]);
    expect(again.ready.readStates?.find((r) => r.channelId === dm.id)).toMatchObject({ mentionCount: 1, lastMessageId: msg.id });
    again.client.close();

    // Caio não participa: 404 em tudo
    expect((await api("GET", `/api/channels/${dm.id}/messages`, caio.token)).status).toBe(404);
    expect((await api("POST", `/api/channels/${dm.id}/messages`, caio.token, { content: "entrei" })).status).toBe(404);
    expect((await api("PUT", `/api/channels/${dm.id}/messages/${msg.id}/reactions/%F0%9F%91%8D`, caio.token)).status).toBe(404);
    // e as rotas de canal de servidor não servem para conversa direta
    expect((await api("PATCH", `/api/channels/${dm.id}`, ana.token, { name: "hack" })).status).toBe(404);
    expect((await api("PUT", `/api/channels/${dm.id}/messages/${msg.id}/reactions/%F0%9F%91%8D`, beto.token)).status).toBe(204);
    expect((await api("DELETE", `/api/messages/${msg.id}`, beto.token)).status).toBe(403); // só apaga a própria

    // digitando: só para quem está na conversa
    const { client: caioWs } = await ws(caio.token);
    const { client: anaWs } = await ws(ana.token);
    anaWs.send({ op: "typing", channelId: dm.id });
    await eventWhere(betoWs, "TYPING_START", (d) => d.channelId === dm.id);
    await caioWs.expectNoEvent("TYPING_START");
    betoWs.close();
    caioWs.close();
    anaWs.close();
  });

  it("fechar a conversa tira da lista; mensagem nova traz de volta", async () => {
    const { client: betoWs } = await ws(beto.token);
    expect((await api("DELETE", `/api/dms/${dm.id}`, beto.token)).status).toBe(204);
    await eventWhere(betoWs, "DM_CHANNEL_DELETE", (d) => d.id === dm.id);
    await api("POST", `/api/channels/${dm.id}/messages`, ana.token, { content: "voltou?" });
    await eventWhere(betoWs, "DM_CHANNEL_CREATE", (d) => d.id === dm.id);
    betoWs.close();
  });

  it("quem divide servidor pode mandar mensagem, a menos que a pessoa aceite só de amigos; estranho nunca", async () => {
    expect((await api("POST", "/api/users/@me/channels", ana.token, { recipientIds: [caio.user.id] })).status).toBe(200);
    expect((await api("POST", "/api/users/@me/channels", estranho.token, { recipientIds: [ana.user.id] })).status).toBe(403);
    await api("PATCH", "/api/users/@me/settings", duda.token, { dmPolicy: "friends" });
    expect((await api<{ dmPolicy: string }>("GET", "/api/users/@me/settings", duda.token)).data.dmPolicy).toBe("friends");
    expect((await api("POST", "/api/users/@me/channels", ana.token, { recipientIds: [duda.user.id] })).status).toBe(200); // amigas
    const caioToDuda = await api<{ error: { code: string } }>("POST", "/api/users/@me/channels", caio.token, { recipientIds: [duda.user.id] });
    expect(caioToDuda.data.error.code).toBe("dm_not_allowed");
  });

  it("bloquear: desfaz a amizade, impede pedido e mensagem (sem contar a quem foi bloqueado); desbloquear libera", async () => {
    const { client: anaWs } = await ws(ana.token);
    expect((await api<Relationship>("PUT", `/api/users/@me/relationships/${ana.user.id}`, beto.token, { type: "blocked" })).data.type).toBe("blocked");
    expect((await eventWhere(anaWs, "RELATIONSHIP_UPDATE", (d) => (d.user as { id: string }).id === beto.user.id)).d.type).toBeNull();
    const send = await api<{ error: { code: string } }>("POST", `/api/channels/${dm.id}/messages`, ana.token, { content: "oi?" });
    expect(send.status).toBe(403);
    expect(send.data.error.code).toBe("dm_blocked");
    const ask = await api<{ error: { code: string; message: string } }>("POST", "/api/users/@me/relationships", ana.token, { username: "beto5" });
    expect(ask.data.error.code).toBe("request_failed"); // não diz que foi bloqueio
    expect((await api("GET", `/api/channels/${dm.id}/messages`, ana.token)).status).toBe(200); // o histórico continua legível
    expect((await api("POST", "/api/users/@me/channels", ana.token, { recipientIds: [beto.user.id] })).status).toBe(403);

    expect((await api("DELETE", `/api/users/@me/relationships/${ana.user.id}`, beto.token)).status).toBe(204);
    expect((await api("POST", `/api/channels/${dm.id}/messages`, ana.token, { content: "de novo" })).status).toBe(201);
    await api("POST", "/api/users/@me/relationships", ana.token, { username: "beto5" });
    await api("PUT", `/api/users/@me/relationships/${ana.user.id}`, beto.token, { type: "friend" });
    anaWs.close();
  });

  it("grupo: só com amigos; renomear, pôr e tirar gente; quem cria sai e o grupo continua", async () => {
    expect((await api("POST", "/api/users/@me/channels", ana.token, { recipientIds: [beto.user.id, caio.user.id] })).status).toBe(403); // Caio não é amigo
    const { client: betoWs } = await ws(beto.token);
    const group = (await api<DmChannel>("POST", "/api/users/@me/channels", ana.token, { recipientIds: [beto.user.id, duda.user.id], name: "Viagem" })).data;
    expect(group).toMatchObject({ type: "group_dm", name: "Viagem", ownerId: ana.user.id });
    expect(group.recipients.map((r) => r.id).sort()).toEqual([beto.user.id, duda.user.id].sort());
    await eventWhere(betoWs, "DM_CHANNEL_CREATE", (d) => d.id === group.id);

    await api("PATCH", `/api/dms/${group.id}`, beto.token, { name: "Viagem de julho" });
    expect((await eventWhere(betoWs, "DM_CHANNEL_UPDATE", (d) => d.id === group.id)).d.name).toBe("Viagem de julho");
    expect((await api("PUT", `/api/dms/${group.id}/recipients/${caio.user.id}`, ana.token)).status).toBe(403); // não é amigo
    expect((await api("DELETE", `/api/dms/${group.id}/recipients/${duda.user.id}`, beto.token)).status).toBe(403); // não é o dono
    expect((await api("DELETE", `/api/dms/${group.id}/recipients/${duda.user.id}`, ana.token)).status).toBe(204);

    const msg = await api<Message>("POST", `/api/channels/${group.id}/messages`, beto.token, { content: "partiu" });
    expect(msg.status).toBe(201);
    expect((await api("GET", `/api/channels/${group.id}/messages`, duda.token)).status).toBe(404); // saiu

    await api("DELETE", `/api/dms/${group.id}`, ana.token); // a dona sai
    const after = await eventWhere(betoWs, "DM_CHANNEL_UPDATE", (d) => d.id === group.id && d.ownerId === beto.user.id);
    expect(after.d.recipients).toEqual([]);
    betoWs.close();
  });
});

describe("migração 1.9", () => {
  it("canais da 1.8 (servidor obrigatório) viram canais que podem ser conversa direta, sem perder nada", () => {
    const dir = mkdtempSync(join(tmpdir(), "aurora-migracao-dm-"));
    const path = join(dir, "antigo.db");
    const old = new DatabaseSync(path);
    old.exec(`PRAGMA foreign_keys = ON;
      CREATE TABLE users (id INTEGER PRIMARY KEY, username TEXT NOT NULL UNIQUE, display_name TEXT NOT NULL, password_hash TEXT NOT NULL, created_at INTEGER NOT NULL);
      CREATE TABLE guilds (id INTEGER PRIMARY KEY, name TEXT NOT NULL, owner_id INTEGER NOT NULL REFERENCES users(id), created_at INTEGER NOT NULL);
      CREATE TABLE members (guild_id INTEGER NOT NULL REFERENCES guilds(id) ON DELETE CASCADE, user_id INTEGER NOT NULL REFERENCES users(id) ON DELETE CASCADE, joined_at INTEGER NOT NULL, PRIMARY KEY (guild_id, user_id));
      CREATE TABLE channels (id INTEGER PRIMARY KEY, guild_id INTEGER NOT NULL REFERENCES guilds(id) ON DELETE CASCADE, name TEXT NOT NULL, position INTEGER NOT NULL, type TEXT NOT NULL DEFAULT 'text');
      CREATE TABLE messages (id INTEGER PRIMARY KEY, channel_id INTEGER NOT NULL REFERENCES channels(id) ON DELETE CASCADE, author_id INTEGER NOT NULL REFERENCES users(id), content TEXT NOT NULL, created_at INTEGER NOT NULL, edited_at INTEGER);
      INSERT INTO users VALUES (1, 'ana', 'Ana', 'x', 0), (2, 'beto', 'Beto', 'x', 0);
      INSERT INTO guilds VALUES (10, 'Antigo', 1, 0);
      INSERT INTO members VALUES (10, 1, 0);
      INSERT INTO channels VALUES (20, 10, 'geral', 0, 'text');
      INSERT INTO messages VALUES (30, 20, 1, 'oi', 0, NULL);`);
    old.close();
    const migrated = new Store(path);
    expect(migrated.getChannel("20")).toMatchObject({ name: "geral", guildId: "10" });
    expect(migrated.listMessages("20", null, 10).map((m) => m.content)).toEqual(["oi"]);
    const dmId = migrated.createDm("1", "2"); // canal sem servidor agora é aceito
    expect(migrated.getConversation(dmId)?.dm?.type).toBe("dm");
    expect(migrated.getChannel(dmId)).toBeUndefined(); // e não aparece como canal de servidor
    migrated.deleteGuild("10"); // a cascata continua: some o canal e as mensagens
    expect(migrated.getChannel("20")).toBeUndefined();
    expect(migrated.getMessage("30")).toBeUndefined();
    migrated.close();
    new Store(path).close(); // abrir de novo não refaz a tabela
    rmSync(dir, { recursive: true, force: true });
  });
});
