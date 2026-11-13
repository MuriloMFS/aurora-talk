import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { DatabaseSync } from "node:sqlite";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { AddressInfo } from "node:net";
import type { FastifyInstance } from "fastify";
import {
  DEFAULT_EVERYONE_PERMISSIONS,
  PERMISSIONS,
  type AuditLogEntry,
  type AuthResponse,
  type Channel,
  type Guild,
  type Invite,
  type Message,
  type Role,
  type ServerFrame,
  type VoiceToken,
} from "@aurora/schema";
import { buildApp } from "./http.ts";
import { Gateway } from "./gateway.ts";
import { Store } from "./store.ts";
import { GatewayTestClient, request } from "./test-utils.ts";

let app: FastifyInstance;
let store: Store;
let base = "";
const api = <T = unknown>(method: string, path: string, token?: string, body?: unknown) => request<T>(base, method, path, token, body);
const ws = (token: string) => GatewayTestClient.identify(base, token, 2);
const decodeJwt = (jwt: string) => JSON.parse(Buffer.from(jwt.split(".")[1]!, "base64url").toString("utf8")) as { video: Record<string, unknown> };
const { VIEW_CHANNEL, SEND_MESSAGES, CONNECT, MANAGE_MESSAGES } = PERMISSIONS;
/** Espera um evento que cumpra a condição (ignora os outros do mesmo tipo que estiverem na fila). */
const eventWhere = <T extends string>(client: GatewayTestClient, t: T, match: (d: Record<string, unknown>) => boolean) =>
  client.next((f) => f.op === "dispatch" && f.t === t && match((f as { d: Record<string, unknown> }).d)) as Promise<Extract<ServerFrame, { op: "dispatch"; t: T }>>;

beforeAll(async () => {
  store = new Store(":memory:");
  // apiUrl em porta fechada: as chamadas ao LiveKit falham rápido e são ignoradas (melhor esforço)
  app = await buildApp({ store, gateway: new Gateway(store), voice: { apiKey: "devkey", apiSecret: "secret", apiUrl: "http://127.0.0.1:9" } });
  await app.listen({ port: 0, host: "127.0.0.1" });
  base = `http://127.0.0.1:${(app.server.address() as AddressInfo).port}`;
});

afterAll(async () => {
  await app.close();
  store.close();
});

describe("permissões por canal, castigo e moderação de voz", () => {
  let ana: AuthResponse; // dona
  let beto: AuthResponse; // equipe (moderador)
  let caio: AuthResponse; // membro comum
  let duda: AuthResponse; // membro comum
  let guild: Guild;
  let geral: Channel;
  let sala: Channel;
  let staff: Channel;
  let invite: Invite;
  let equipe: Role;

  it("canal privado: quem não tem acesso não vê o canal, as mensagens, a digitação nem as menções", async () => {
    const reg = (u: string) => api<AuthResponse>("POST", "/api/auth/register", undefined, { username: u, password: "senha-forte-1" }).then((r) => r.data);
    [ana, beto, caio, duda] = await Promise.all([reg("ana2"), reg("beto2"), reg("caio2"), reg("duda2")]);
    guild = (await api<Guild>("POST", "/api/guilds", ana.token, { name: "Clube" })).data;
    geral = guild.channels.find((c) => c.type === "text")!;
    sala = guild.channels.find((c) => c.type === "voice")!;
    expect(guild.roles[0]!.permissions).toBe(DEFAULT_EVERYONE_PERMISSIONS);
    expect(DEFAULT_EVERYONE_PERMISSIONS & VIEW_CHANNEL).toBeTruthy();
    invite = (await api<Invite>("POST", `/api/guilds/${guild.id}/invites`, ana.token)).data;
    for (const u of [beto, caio, duda]) await api("POST", `/api/invites/${invite.code}`, u.token);

    const { client: caioWs } = await ws(caio.token);
    const created = await api<Channel>("POST", `/api/guilds/${guild.id}/channels`, ana.token, { name: "staff", private: true });
    expect(created.status).toBe(201);
    staff = created.data;
    expect(staff.overwrites).toEqual([{ targetType: "role", targetId: guild.id, allow: 0, deny: VIEW_CHANNEL }]); // a dona já vê tudo
    await caioWs.expectNoEvent("CHANNEL_CREATE");

    const secret = (await api<Message>("POST", `/api/channels/${staff.id}/messages`, ana.token, { content: `segredo <@${caio.user.id}>` })).data;
    expect(secret.mentions).toEqual([]); // quem não vê o canal não é mencionado
    await caioWs.expectNoEvent("MESSAGE_CREATE");
    expect((await api("GET", `/api/channels/${staff.id}/messages`, caio.token)).status).toBe(404);
    expect((await api("POST", `/api/channels/${staff.id}/messages`, caio.token, { content: "oi" })).status).toBe(404);
    expect((await api("PUT", `/api/channels/${staff.id}/messages/${secret.id}/reactions/%F0%9F%91%8D`, caio.token)).status).toBe(404);
    expect((await api("DELETE", `/api/messages/${secret.id}`, caio.token)).status).toBe(404);

    const { client: anaWs } = await ws(ana.token);
    anaWs.send({ op: "typing", channelId: staff.id });
    await caioWs.expectNoEvent("TYPING_START");

    // ao (re)conectar, o canal nem aparece (nem como "não lido")
    const again = await ws(caio.token);
    expect(again.ready.guilds[0]!.channels.map((c) => c.id)).not.toContain(staff.id);
    expect(again.ready.readStates?.map((r) => r.channelId)).not.toContain(staff.id);
    again.client.close();
    caioWs.close();
    anaWs.close();
  });

  it("liberar um cargo no canal: quem ganha o cargo recebe o canal na hora; quem perde, deixa de ver", async () => {
    equipe = (
      await api<Role>("POST", `/api/guilds/${guild.id}/roles`, ana.token, {
        name: "Equipe",
        permissions: PERMISSIONS.MANAGE_CHANNELS | PERMISSIONS.MODERATE_MEMBERS | PERMISSIONS.MUTE_MEMBERS | PERMISSIONS.MOVE_MEMBERS,
      })
    ).data;
    const put = await api<Channel>("PUT", `/api/channels/${staff.id}/overwrites/role/${equipe.id}`, ana.token, { allow: VIEW_CHANNEL, deny: 0 });
    expect(put.status).toBe(200);
    expect(put.data.overwrites).toContainEqual({ targetType: "role", targetId: equipe.id, allow: VIEW_CHANNEL, deny: 0 });

    const { client: betoWs } = await ws(beto.token);
    await api("PUT", `/api/guilds/${guild.id}/members/${beto.user.id}/roles/${equipe.id}`, ana.token);
    expect((await betoWs.event("CHANNEL_CREATE")).d).toMatchObject({ id: staff.id, name: "staff" });
    expect((await api<Message[]>("GET", `/api/channels/${staff.id}/messages`, beto.token)).data.map((m) => m.content)).toEqual([`segredo <@${caio.user.id}>`]);

    await api("DELETE", `/api/guilds/${guild.id}/members/${beto.user.id}/roles/${equipe.id}`, ana.token);
    expect((await betoWs.event("CHANNEL_DELETE")).d).toEqual({ id: staff.id, guildId: guild.id });
    expect((await api("GET", `/api/channels/${staff.id}/messages`, beto.token)).status).toBe(404);
    await api("PUT", `/api/guilds/${guild.id}/members/${beto.user.id}/roles/${equipe.id}`, ana.token);
    betoWs.close();
  });

  it("canal só de leitura: o @todos lê e reage, mas não escreve; a dona escreve", async () => {
    const res = await api<Channel>("PUT", `/api/channels/${geral.id}/overwrites/role/${guild.id}`, ana.token, { allow: 0, deny: SEND_MESSAGES });
    expect(res.data.overwrites).toEqual([{ targetType: "role", targetId: guild.id, allow: 0, deny: SEND_MESSAGES }]);
    const denied = await api<{ error: { message: string } }>("POST", `/api/channels/${geral.id}/messages`, caio.token, { content: "oi" });
    expect(denied.status).toBe(403);
    expect(denied.data.error.message).toMatch(/Enviar mensagens.*neste canal/);
    const notice = (await api<Message>("POST", `/api/channels/${geral.id}/messages`, ana.token, { content: "aviso" })).data;
    expect((await api("PUT", `/api/channels/${geral.id}/messages/${notice.id}/reactions/%F0%9F%91%8D`, caio.token)).status).toBe(204);
    // a pessoa pode ser liberada sozinha
    await api("PUT", `/api/channels/${geral.id}/overwrites/member/${duda.user.id}`, ana.token, { allow: SEND_MESSAGES, deny: 0 });
    expect((await api("POST", `/api/channels/${geral.id}/messages`, duda.token, { content: "posso" })).status).toBe(201);
    await api("DELETE", `/api/channels/${geral.id}/overwrites/member/${duda.user.id}`, ana.token);
    await api("DELETE", `/api/channels/${geral.id}/overwrites/role/${guild.id}`, ana.token);
    expect((await api("POST", `/api/channels/${geral.id}/messages`, caio.token, { content: "voltou" })).status).toBe(201);
  });

  it("quem edita as permissões do canal: não tira o próprio acesso, só mexe no que tem e em quem está abaixo", async () => {
    // o Beto (Equipe, Gerenciar canais) não pode esconder o #geral de si mesmo
    const lockOut = await api<{ error: { code: string } }>("PUT", `/api/channels/${geral.id}/overwrites/role/${guild.id}`, beto.token, { allow: 0, deny: VIEW_CHANNEL });
    expect(lockOut.status).toBe(400);
    expect(lockOut.data.error.code).toBe("lock_out");
    // liberando a Equipe antes, pode
    expect((await api("PUT", `/api/channels/${geral.id}/overwrites/role/${equipe.id}`, beto.token, { allow: VIEW_CHANNEL, deny: 0 })).status).toBe(403); // cargo do nível dele
    expect((await api("PUT", `/api/channels/${geral.id}/overwrites/member/${beto.user.id}`, beto.token, { allow: VIEW_CHANNEL, deny: 0 })).status).toBe(200);
    expect((await api("PUT", `/api/channels/${geral.id}/overwrites/role/${guild.id}`, beto.token, { allow: 0, deny: VIEW_CHANNEL })).status).toBe(200);
    // Gerenciar mensagens ele não tem: o pedido de liberar isso é ignorado
    const clamped = await api<Channel>("PUT", `/api/channels/${geral.id}/overwrites/member/${caio.user.id}`, beto.token, { allow: VIEW_CHANNEL | MANAGE_MESSAGES, deny: 0 });
    expect(clamped.data.overwrites).toContainEqual({ targetType: "member", targetId: caio.user.id, allow: VIEW_CHANNEL, deny: 0 });
    // nem na dona ele mexe
    expect((await api("PUT", `/api/channels/${geral.id}/overwrites/member/${ana.user.id}`, beto.token, { allow: 0, deny: VIEW_CHANNEL })).status).toBe(403);
    // desfaz (a dona)
    for (const [type, id] of [["role", guild.id], ["member", beto.user.id], ["member", caio.user.id]] as const) {
      await api("DELETE", `/api/channels/${geral.id}/overwrites/${type}/${id}`, ana.token);
    }
    const log = (await api<AuditLogEntry[]>("GET", `/api/guilds/${guild.id}/audit-log`, ana.token)).data;
    expect(log.find((e) => e.action === "channel_permissions" && e.detail?.startsWith("caio2: libera Ver canais"))).toBeTruthy();
  });

  it("sala de voz privada: quem não vê não entra nem fica sabendo quem está lá", async () => {
    const vip = (await api<Channel>("POST", `/api/guilds/${guild.id}/channels`, ana.token, { name: "Sala VIP", type: "voice", private: true })).data;
    expect((await api("POST", `/api/channels/${vip.id}/voice`, caio.token)).status).toBe(404);
    const { client: caioWs } = await ws(caio.token);
    const { client: anaWs } = await ws(ana.token);
    anaWs.send({ op: "voice_join", channelId: vip.id, muted: false, deafened: false });
    await eventWhere(anaWs, "VOICE_STATE_UPDATE", (d) => d.userId === ana.user.id && d.channelId === vip.id);
    await caioWs.expectNoEvent("VOICE_STATE_UPDATE");
    caioWs.send({ op: "voice_join", channelId: vip.id, muted: false, deafened: false });
    await anaWs.expectNoEvent("VOICE_STATE_UPDATE");
    anaWs.send({ op: "voice_leave" });
    await eventWhere(anaWs, "VOICE_STATE_UPDATE", (d) => d.userId === ana.user.id && d.channelId === null);
    caioWs.close();
    anaWs.close();
    await api("DELETE", `/api/channels/${vip.id}`, ana.token);
  });

  it("castigo: só ler até a hora marcada; sai da voz; não escapa saindo e voltando; tirar libera", async () => {
    const { client: caioWs } = await ws(caio.token);
    const { client: dudaWs } = await ws(duda.token);
    caioWs.send({ op: "voice_join", channelId: sala.id, muted: false, deafened: false });
    await eventWhere(dudaWs, "VOICE_STATE_UPDATE", (d) => d.userId === caio.user.id && d.channelId === sala.id);

    const before = Date.now();
    const res = await api<{ timeoutUntil: number }>("PUT", `/api/guilds/${guild.id}/members/${caio.user.id}/timeout`, beto.token, { minutes: 10 });
    expect(res.status).toBe(200);
    expect(res.data.timeoutUntil).toBeGreaterThanOrEqual(before + 10 * 60_000);
    expect((await eventWhere(dudaWs, "MEMBER_UPDATE", (d) => d.userId === caio.user.id)).d.timeoutUntil).toBe(res.data.timeoutUntil);
    await eventWhere(dudaWs, "VOICE_STATE_UPDATE", (d) => d.userId === caio.user.id && d.channelId === null); // saiu da voz

    const send = await api<{ error: { code: string } }>("POST", `/api/channels/${geral.id}/messages`, caio.token, { content: "oi" });
    expect(send.status).toBe(403);
    expect(send.data.error.code).toBe("timed_out");
    expect((await api("GET", `/api/channels/${geral.id}/messages`, caio.token)).status).toBe(200); // ler pode
    expect((await api("POST", `/api/channels/${sala.id}/voice`, caio.token)).status).toBe(403);
    expect((await api("POST", `/api/guilds/${guild.id}/invites`, caio.token)).status).toBe(403);
    caioWs.send({ op: "typing", channelId: geral.id });
    await dudaWs.expectNoEvent("TYPING_START");

    // sair e voltar não tira o castigo
    await api("DELETE", `/api/guilds/${guild.id}/members/@me`, caio.token);
    const rejoined = (await api<Guild>("POST", `/api/invites/${invite.code}`, caio.token)).data;
    expect(rejoined.members.find((m) => m.user.id === caio.user.id)?.timeoutUntil).toBe(res.data.timeoutUntil);
    expect((await api("POST", `/api/channels/${geral.id}/messages`, caio.token, { content: "oi" })).status).toBe(403);

    // a dona e o Administrador não ficam de castigo; o Beto não castiga quem está no nível dele ou acima
    expect((await api("PUT", `/api/guilds/${guild.id}/members/${ana.user.id}/timeout`, beto.token, { minutes: 5 })).status).toBe(403);
    expect((await api("PUT", `/api/guilds/${guild.id}/members/${caio.user.id}/timeout`, duda.token, { minutes: 5 })).status).toBe(403); // sem permissão

    expect((await api("PUT", `/api/guilds/${guild.id}/members/${caio.user.id}/timeout`, beto.token, { minutes: null })).data).toEqual({ timeoutUntil: null });
    expect((await api("POST", `/api/channels/${geral.id}/messages`, caio.token, { content: "voltei" })).status).toBe(201);
    const log = (await api<AuditLogEntry[]>("GET", `/api/guilds/${guild.id}/audit-log`, ana.token)).data;
    expect(log.find((e) => e.action === "member_timeout")).toMatchObject({ targetName: "caio2", detail: "10 minutos" });
    expect(log[0]!.action).toBe("member_timeout_remove");
    caioWs.close();
    dudaWs.close();
  });

  it("voz: silenciar, mover e desconectar (com hierarquia e só para salas em que a pessoa pode entrar)", async () => {
    const sala2 = (await api<Channel>("POST", `/api/guilds/${guild.id}/channels`, ana.token, { name: "Sala 2", type: "voice" })).data;
    const { client: caioWs } = await ws(caio.token);
    const { client: dudaWs } = await ws(duda.token);
    caioWs.send({ op: "voice_join", channelId: sala.id, muted: false, deafened: false });
    await eventWhere(dudaWs, "VOICE_STATE_UPDATE", (d) => d.userId === caio.user.id && d.channelId === sala.id);

    // silenciar: vale na hora, segura o microfone desligado e entra na credencial
    expect((await api("PATCH", `/api/guilds/${guild.id}/members/${caio.user.id}/voice`, beto.token, { muted: true })).status).toBe(204);
    expect((await eventWhere(dudaWs, "VOICE_STATE_UPDATE", (d) => d.userId === caio.user.id && d.serverMuted === true)).d).toMatchObject({ muted: true });
    caioWs.send({ op: "voice_state", muted: false, deafened: false, streaming: false });
    expect((await eventWhere(dudaWs, "VOICE_STATE_UPDATE", (d) => d.userId === caio.user.id)).d).toMatchObject({ muted: true, serverMuted: true });
    const token = (await api<VoiceToken>("POST", `/api/channels/${sala.id}/voice`, caio.token)).data.token;
    expect(decodeJwt(token).video.canPublishSources).toEqual(["screen_share", "screen_share_audio"]);
    await api("PATCH", `/api/guilds/${guild.id}/members/${caio.user.id}/voice`, beto.token, { muted: false });
    await eventWhere(dudaWs, "VOICE_STATE_UPDATE", (d) => d.userId === caio.user.id && d.serverMuted === false);

    // mover: o Caio recebe o VOICE_MOVE; quem está vendo vê ele na outra sala (sem "saiu e entrou")
    expect((await api("PATCH", `/api/guilds/${guild.id}/members/${caio.user.id}/voice`, beto.token, { channelId: sala2.id })).status).toBe(204);
    expect((await caioWs.event("VOICE_MOVE")).d).toEqual({ guildId: guild.id, channelId: sala2.id });
    await eventWhere(dudaWs, "VOICE_STATE_UPDATE", (d) => d.userId === caio.user.id && d.channelId === sala2.id);
    caioWs.send({ op: "voice_join", channelId: sala2.id, muted: false, deafened: false }); // o app troca de sala
    await eventWhere(dudaWs, "VOICE_STATE_UPDATE", (d) => d.userId === caio.user.id && d.channelId === sala2.id);
    await dudaWs.expectNoEvent("VOICE_STATE_UPDATE");

    // não move para uma sala em que a pessoa não pode entrar
    await api("PUT", `/api/channels/${sala.id}/overwrites/member/${caio.user.id}`, ana.token, { allow: 0, deny: CONNECT });
    const blocked = await api<{ error: { code: string } }>("PATCH", `/api/guilds/${guild.id}/members/${caio.user.id}/voice`, beto.token, { channelId: sala.id });
    expect(blocked.data.error.code).toBe("cannot_connect");
    await api("DELETE", `/api/channels/${sala.id}/overwrites/member/${caio.user.id}`, ana.token);

    // hierarquia e permissão
    expect((await api("PATCH", `/api/guilds/${guild.id}/members/${caio.user.id}/voice`, duda.token, { channelId: null })).status).toBe(403);
    expect((await api("PATCH", `/api/guilds/${guild.id}/members/${ana.user.id}/voice`, beto.token, { muted: true })).status).toBe(403);

    // desconectar
    expect((await api("PATCH", `/api/guilds/${guild.id}/members/${caio.user.id}/voice`, beto.token, { channelId: null })).status).toBe(204);
    expect((await caioWs.event("VOICE_MOVE")).d).toEqual({ guildId: guild.id, channelId: null });
    await eventWhere(dudaWs, "VOICE_STATE_UPDATE", (d) => d.userId === caio.user.id && d.channelId === null);
    const notInVoice = await api<{ error: { code: string } }>("PATCH", `/api/guilds/${guild.id}/members/${caio.user.id}/voice`, beto.token, { channelId: null });
    expect(notInVoice.data.error.code).toBe("not_in_voice");

    const actions = (await api<AuditLogEntry[]>("GET", `/api/guilds/${guild.id}/audit-log`, ana.token)).data.map((e) => e.action);
    for (const action of ["voice_mute", "voice_unmute", "voice_move", "voice_disconnect"]) expect(actions).toContain(action);
    caioWs.close();
    dudaWs.close();
  });
});

describe("migração 1.6", () => {
  it('o @todos dos servidores antigos ganha "Ver canais" uma vez só (se depois tirarem, continua tirado)', () => {
    const dir = mkdtempSync(join(tmpdir(), "aurora-migracao-canais-"));
    const path = join(dir, "antigo.db");
    const old = new DatabaseSync(path);
    const before16 = DEFAULT_EVERYONE_PERMISSIONS & ~VIEW_CHANNEL;
    old.exec(`CREATE TABLE users (id INTEGER PRIMARY KEY, username TEXT NOT NULL UNIQUE, display_name TEXT NOT NULL, password_hash TEXT NOT NULL, created_at INTEGER NOT NULL);
      CREATE TABLE guilds (id INTEGER PRIMARY KEY, name TEXT NOT NULL, owner_id INTEGER NOT NULL, created_at INTEGER NOT NULL);
      CREATE TABLE members (guild_id INTEGER NOT NULL, user_id INTEGER NOT NULL, joined_at INTEGER NOT NULL, PRIMARY KEY (guild_id, user_id));
      CREATE TABLE channels (id INTEGER PRIMARY KEY, guild_id INTEGER NOT NULL, name TEXT NOT NULL, position INTEGER NOT NULL, type TEXT NOT NULL DEFAULT 'text');
      CREATE TABLE roles (id INTEGER PRIMARY KEY, guild_id INTEGER NOT NULL, name TEXT NOT NULL, color INTEGER, position INTEGER NOT NULL, permissions INTEGER NOT NULL, hoist INTEGER NOT NULL DEFAULT 0);
      INSERT INTO users VALUES (1, 'dono', 'Dono', 'x', 0), (2, 'membro', 'Membro', 'x', 0);
      INSERT INTO guilds VALUES (10, 'Antigo', 1, 0);
      INSERT INTO members VALUES (10, 1, 0), (10, 2, 1);
      INSERT INTO channels VALUES (20, 10, 'geral', 0, 'text');
      INSERT INTO roles VALUES (10, 10, '@todos', NULL, 0, ${before16}, 0);`);
    old.close();
    const migrated = new Store(path);
    expect(migrated.permissionsOf("10", "2")).toBe(DEFAULT_EVERYONE_PERMISSIONS);
    expect(migrated.channelViewerIds(migrated.getChannel("20")!).sort()).toEqual(["1", "2"]);
    // a dona resolve esconder tudo do @todos: abrir de novo não devolve
    migrated.updateRole("10", { name: "@todos", color: null, hoist: false, permissions: before16 });
    migrated.close();
    const reopened = new Store(path);
    expect(reopened.permissionsOf("10", "2")).toBe(before16);
    expect(reopened.channelViewerIds(reopened.getChannel("20")!)).toEqual(["1"]);
    reopened.close();
    rmSync(dir, { recursive: true, force: true });
  });
});
