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
  type Ban,
  type Channel,
  type Guild,
  type Invite,
  type InviteDetails,
  type Message,
  type Role,
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

beforeAll(async () => {
  store = new Store(":memory:");
  // apiUrl em porta fechada: tirar alguém da sala do LiveKit falha rápido e é ignorado (melhor esforço)
  app = await buildApp({ store, gateway: new Gateway(store), voice: { apiKey: "devkey", apiSecret: "secret", apiUrl: "http://127.0.0.1:9" } });
  await app.listen({ port: 0, host: "127.0.0.1" });
  base = `http://127.0.0.1:${(app.server.address() as AddressInfo).port}`;
});

afterAll(async () => {
  await app.close();
  store.close();
});

describe("configurações do servidor", () => {
  let ana: AuthResponse; // dona
  let beto: AuthResponse; // vai virar moderador
  let caio: AuthResponse; // membro comum
  let duda: AuthResponse; // outra moderadora (mesmo nível do Beto)
  let guild: Guild;
  let geral: Channel;
  let sala: Channel;
  let invite: Invite;
  let mod: Role;

  it("servidor novo nasce com o @todos e as permissões padrão; quem entra não tem cargo", async () => {
    const reg = (u: string) => api<AuthResponse>("POST", "/api/auth/register", undefined, { username: u, password: "senha-forte-1" }).then((r) => r.data);
    [ana, beto, caio, duda] = await Promise.all([reg("ana"), reg("beto"), reg("caio"), reg("duda")]);
    guild = (await api<Guild>("POST", "/api/guilds", ana.token, { name: "Turma" })).data;
    geral = guild.channels.find((c) => c.type === "text")!;
    sala = guild.channels.find((c) => c.type === "voice")!;
    expect(guild.roles).toEqual([{ id: guild.id, guildId: guild.id, name: "@todos", color: null, position: 0, permissions: DEFAULT_EVERYONE_PERMISSIONS, hoist: false }]);
    invite = (await api<Invite>("POST", `/api/guilds/${guild.id}/invites`, ana.token)).data;
    for (const u of [beto, caio, duda]) {
      const joined = await api<Guild>("POST", `/api/invites/${invite.code}`, u.token);
      expect(joined.data.members.find((m) => m.user.id === u.user.id)?.roles).toEqual([]);
    }
  });

  it("sem a permissão, nada feito (e a mensagem diz qual falta)", async () => {
    const res = await api<{ error: { message: string } }>("POST", `/api/guilds/${guild.id}/channels`, caio.token, { name: "novo" });
    expect(res.status).toBe(403);
    expect(res.data.error.message).toMatch(/Gerenciar canais/);
    expect((await api("PATCH", `/api/guilds/${guild.id}`, caio.token, { name: "Hack" })).status).toBe(403);
    expect((await api("POST", `/api/guilds/${guild.id}/roles`, caio.token, {})).status).toBe(403);
    expect((await api("GET", `/api/guilds/${guild.id}/bans`, caio.token)).status).toBe(403);
    expect((await api("GET", `/api/guilds/${guild.id}/audit-log`, caio.token)).status).toBe(403);
    expect((await api("POST", `/api/guilds/${guild.id}/invites`, caio.token)).status).toBe(201); // @todos pode convidar
  });

  it("dona cria o cargo Moderação e dá ao Beto e à Duda; todos ficam sabendo na hora", async () => {
    const { client: caioWs } = await ws(caio.token);
    const created = await api<Role>("POST", `/api/guilds/${guild.id}/roles`, ana.token, {
      name: "Moderação",
      color: 2,
      hoist: true,
      permissions: PERMISSIONS.KICK_MEMBERS | PERMISSIONS.MANAGE_MESSAGES | PERMISSIONS.MANAGE_ROLES | PERMISSIONS.VIEW_AUDIT_LOG,
    });
    expect(created.status).toBe(201);
    mod = created.data;
    expect(mod.position).toBe(1);
    const rolesEvent = await caioWs.event("GUILD_ROLES_UPDATE");
    expect(rolesEvent.d.roles.map((r) => r.name)).toEqual(["Moderação", "@todos"]);
    for (const u of [beto, duda]) {
      const res = await api<{ roles: string[] }>("PUT", `/api/guilds/${guild.id}/members/${u.user.id}/roles/${mod.id}`, ana.token);
      expect(res.data.roles).toEqual([mod.id]);
      expect((await caioWs.event("MEMBER_UPDATE")).d).toEqual({ guildId: guild.id, userId: u.user.id, roles: [mod.id], timeoutUntil: null });
    }
    caioWs.close();
  });

  it("hierarquia: o Beto modera e dá cargos abaixo dele, mas não a Duda (mesmo nível), nem a dona, nem o próprio cargo", async () => {
    // cargo novo nasce abaixo da Moderação: o Beto pode criar e editar, mas só concede o que tem
    const vip = (await api<Role>("POST", `/api/guilds/${guild.id}/roles`, beto.token, { name: "VIP", permissions: PERMISSIONS.STREAM | PERMISSIONS.BAN_MEMBERS | PERMISSIONS.ADMINISTRATOR })).data;
    expect(vip.permissions).toBe(PERMISSIONS.STREAM); // Banir e Administrador ele não tem; Transmitir ele tem (pelo @todos)
    const edited = await api<Role>("PATCH", `/api/guilds/${guild.id}/roles/${vip.id}`, beto.token, { permissions: PERMISSIONS.STREAM | PERMISSIONS.BAN_MEMBERS });
    expect(edited.data.permissions).toBe(PERMISSIONS.STREAM);
    expect((await api("PATCH", `/api/guilds/${guild.id}/roles/${mod.id}`, beto.token, { name: "Chefia" })).status).toBe(403);
    expect((await api("PUT", `/api/guilds/${guild.id}/members/${caio.user.id}/roles/${vip.id}`, beto.token)).status).toBe(200);
    expect((await api("PUT", `/api/guilds/${guild.id}/members/${caio.user.id}/roles/${mod.id}`, beto.token)).status).toBe(403);
    expect((await api("DELETE", `/api/guilds/${guild.id}/members/${duda.user.id}`, beto.token)).status).toBe(403);
    expect((await api("DELETE", `/api/guilds/${guild.id}/members/${ana.user.id}`, beto.token)).status).toBe(403);
    // ordem: o VIP sobe? não passa da Moderação (que é do nível do Beto)
    const moved = await api<Role[]>("POST", `/api/guilds/${guild.id}/roles/${vip.id}/move`, beto.token, { direction: "up" });
    expect(moved.status).toBe(403);
    const byAna = await api<Role[]>("POST", `/api/guilds/${guild.id}/roles/${vip.id}/move`, ana.token, { direction: "up" });
    expect(byAna.data.map((r) => r.name)).toEqual(["VIP", "Moderação", "@todos"]);
    await api("POST", `/api/guilds/${guild.id}/roles/${vip.id}/move`, ana.token, { direction: "down" });
  });

  it("Gerenciar mensagens: o Beto apaga a mensagem do Caio; o Caio não apaga a do Beto", async () => {
    const fromCaio = (await api<Message>("POST", `/api/channels/${geral.id}/messages`, caio.token, { content: "spam" })).data;
    const fromBeto = (await api<Message>("POST", `/api/channels/${geral.id}/messages`, beto.token, { content: "regras" })).data;
    expect((await api("DELETE", `/api/messages/${fromBeto.id}`, caio.token)).status).toBe(403);
    expect((await api("DELETE", `/api/messages/${fromCaio.id}`, beto.token)).status).toBe(204);
  });

  it("tirar Enviar mensagens do @todos cala o Caio, mas não a dona", async () => {
    const res = await api<Role>("PATCH", `/api/guilds/${guild.id}/roles/${guild.id}`, ana.token, { permissions: DEFAULT_EVERYONE_PERMISSIONS & ~PERMISSIONS.SEND_MESSAGES, name: "tentou renomear" });
    expect(res.data.name).toBe("@todos"); // o nome do @todos não muda
    expect((await api("POST", `/api/channels/${geral.id}/messages`, caio.token, { content: "oi" })).status).toBe(403);
    expect((await api("POST", `/api/channels/${geral.id}/messages`, ana.token, { content: "oi" })).status).toBe(201);
    await api("PATCH", `/api/guilds/${guild.id}/roles/${guild.id}`, ana.token, { permissions: DEFAULT_EVERYONE_PERMISSIONS });
  });

  it("voz: sem Conectar não entra; sem Falar a credencial não libera o microfone", async () => {
    const token = (await api<VoiceToken>("POST", `/api/channels/${sala.id}/voice`, caio.token)).data.token;
    expect(decodeJwt(token).video).toMatchObject({ canPublish: true, canPublishSources: ["microphone", "screen_share", "screen_share_audio"] });
    await api("PATCH", `/api/guilds/${guild.id}/roles/${guild.id}`, ana.token, { permissions: DEFAULT_EVERYONE_PERMISSIONS & ~PERMISSIONS.SPEAK });
    const mute = decodeJwt((await api<VoiceToken>("POST", `/api/channels/${sala.id}/voice`, caio.token)).data.token).video;
    expect(mute.canPublishSources).toEqual(["screen_share", "screen_share_audio"]);
    await api("PATCH", `/api/guilds/${guild.id}/roles/${guild.id}`, ana.token, { permissions: DEFAULT_EVERYONE_PERMISSIONS & ~PERMISSIONS.CONNECT });
    expect((await api("POST", `/api/channels/${sala.id}/voice`, caio.token)).status).toBe(403);
    const { client: caioWs } = await ws(caio.token);
    const { client: anaWs } = await ws(ana.token);
    caioWs.send({ op: "voice_join", channelId: sala.id, muted: false, deafened: false });
    await anaWs.expectNoEvent("VOICE_STATE_UPDATE"); // o gateway também barra
    await api("PATCH", `/api/guilds/${guild.id}/roles/${guild.id}`, ana.token, { permissions: DEFAULT_EVERYONE_PERMISSIONS });
    caioWs.close();
    anaWs.close();
  });

  it("expulsar: some para quem saiu, os outros ficam sabendo, e dá para voltar com convite", async () => {
    const { client: caioWs } = await ws(caio.token);
    const { client: anaWs } = await ws(ana.token);
    caioWs.send({ op: "voice_join", channelId: sala.id, muted: false, deafened: false });
    await anaWs.event("VOICE_STATE_UPDATE");
    expect((await api("DELETE", `/api/guilds/${guild.id}/members/${caio.user.id}`, beto.token)).status).toBe(204);
    expect((await caioWs.event("GUILD_DELETE")).d).toEqual({ id: guild.id });
    expect((await anaWs.event("VOICE_STATE_UPDATE")).d).toMatchObject({ userId: caio.user.id, channelId: null }); // saiu da voz junto
    expect((await anaWs.event("MEMBER_REMOVE")).d).toEqual({ guildId: guild.id, userId: caio.user.id });
    expect((await api("GET", `/api/channels/${geral.id}/messages`, caio.token)).status).toBe(404);
    expect((await api("POST", `/api/invites/${invite.code}`, caio.token)).status).toBe(200); // pode voltar
    caioWs.close();
    anaWs.close();
  });

  it("banir: com motivo, sem volta pelo convite; lista de banidos; desbanir libera", async () => {
    // o Beto não tem Banir: a dona dá a permissão à Moderação
    await api("PATCH", `/api/guilds/${guild.id}/roles/${mod.id}`, ana.token, { permissions: mod.permissions | PERMISSIONS.BAN_MEMBERS });
    expect((await api("PUT", `/api/guilds/${guild.id}/bans/${caio.user.id}`, beto.token, { reason: "flood no #geral" })).status).toBe(204);
    const joinAgain = await api<{ error: { message: string } }>("POST", `/api/invites/${invite.code}`, caio.token);
    expect(joinAgain.status).toBe(403);
    expect(joinAgain.data.error.message).toMatch(/banido/);
    const bans = (await api<Ban[]>("GET", `/api/guilds/${guild.id}/bans`, beto.token)).data;
    expect(bans).toEqual([expect.objectContaining({ user: expect.objectContaining({ id: caio.user.id }), reason: "flood no #geral", bannedBy: expect.objectContaining({ id: beto.user.id }) })]);
    expect((await api("DELETE", `/api/guilds/${guild.id}/bans/${caio.user.id}`, beto.token)).status).toBe(204);
    expect((await api("POST", `/api/invites/${invite.code}`, caio.token)).status).toBe(200);
  });

  it("convites: lista com quem criou e quantos usos; revogar invalida o código", async () => {
    expect((await api("GET", `/api/guilds/${guild.id}/invites`, beto.token)).status).toBe(403); // falta Gerenciar servidor
    const list = (await api<InviteDetails[]>("GET", `/api/guilds/${guild.id}/invites`, ana.token)).data;
    const mine = list.find((i) => i.code === invite.code)!;
    expect(mine.createdBy?.id).toBe(ana.user.id);
    expect(mine.uses).toBeGreaterThanOrEqual(5);
    expect((await api("DELETE", `/api/invites/${invite.code}`, ana.token)).status).toBe(204);
    expect((await api("POST", `/api/invites/${invite.code}`, duda.token)).status).toBe(404);
  });

  it("canais e servidor: renomear avisa todo mundo; não dá para apagar o último canal de texto", async () => {
    const { client: dudaWs } = await ws(duda.token);
    const renamed = await api<Channel>("PATCH", `/api/channels/${geral.id}`, ana.token, { name: "Bate Papo" });
    expect(renamed.data.name).toBe("bate-papo");
    expect((await dudaWs.event("CHANNEL_UPDATE")).d).toMatchObject({ id: geral.id, name: "bate-papo" });
    const last = await api<{ error: { message: string } }>("DELETE", `/api/channels/${geral.id}`, ana.token);
    expect(last.status).toBe(400);
    expect(last.data.error.message).toMatch(/pelo menos um canal de texto/);
    expect((await api("DELETE", `/api/channels/${sala.id}`, ana.token)).status).toBe(204);
    expect((await dudaWs.event("CHANNEL_DELETE")).d).toEqual({ id: sala.id, guildId: guild.id });
    expect((await api<{ name: string }>("PATCH", `/api/guilds/${guild.id}`, ana.token, { name: "Turma do sábado" })).data.name).toBe("Turma do sábado");
    expect((await dudaWs.event("GUILD_UPDATE")).d).toEqual({ id: guild.id, name: "Turma do sábado", icon: null, banner: null });
    dudaWs.close();
  });

  it("registro de auditoria: o mais novo primeiro, com quem fez e o detalhe", async () => {
    const log = (await api<AuditLogEntry[]>("GET", `/api/guilds/${guild.id}/audit-log`, beto.token)).data;
    expect(log[0]).toMatchObject({ action: "guild_update", actor: expect.objectContaining({ id: ana.user.id }), detail: "nome: Turma → Turma do sábado" });
    const actions = log.map((e) => e.action);
    for (const action of ["channel_delete", "channel_update", "invite_delete", "member_unban", "member_ban", "member_kick", "member_role_add", "role_create"]) expect(actions).toContain(action);
    const ban = log.find((e) => e.action === "member_ban")!;
    expect(ban).toMatchObject({ targetName: "caio", detail: "flood no #geral" });
    const page2 = (await api<AuditLogEntry[]>("GET", `/api/guilds/${guild.id}/audit-log?before=${log[2]!.id}`, beto.token)).data;
    expect(page2[0]!.id).toBe(log[3]!.id);
  });

  it("sair e excluir: a dona não sai, só exclui; só ela exclui; todos recebem GUILD_DELETE", async () => {
    expect((await api("DELETE", `/api/guilds/${guild.id}/members/@me`, ana.token)).status).toBe(400);
    expect((await api("DELETE", `/api/guilds/${guild.id}/members/@me`, caio.token)).status).toBe(204);
    expect((await api("DELETE", `/api/guilds/${guild.id}`, beto.token)).status).toBe(403);
    const { client: dudaWs } = await ws(duda.token);
    expect((await api("DELETE", `/api/guilds/${guild.id}`, ana.token)).status).toBe(204);
    expect((await dudaWs.event("GUILD_DELETE")).d).toEqual({ id: guild.id });
    expect((await api("GET", `/api/channels/${geral.id}/messages`, ana.token)).status).toBe(404);
    expect(store.rolesOf(guild.id)).toEqual([]);
    dudaWs.close();
  });
});

describe("migração 1.5", () => {
  it("servidores antigos ganham o @todos com as permissões padrão; o dono continua podendo tudo", () => {
    const dir = mkdtempSync(join(tmpdir(), "aurora-migracao-cargos-"));
    const path = join(dir, "antigo.db");
    const old = new DatabaseSync(path);
    old.exec(`CREATE TABLE users (id INTEGER PRIMARY KEY, username TEXT NOT NULL UNIQUE, display_name TEXT NOT NULL, password_hash TEXT NOT NULL, created_at INTEGER NOT NULL);
      CREATE TABLE guilds (id INTEGER PRIMARY KEY, name TEXT NOT NULL, owner_id INTEGER NOT NULL, created_at INTEGER NOT NULL);
      CREATE TABLE members (guild_id INTEGER NOT NULL, user_id INTEGER NOT NULL, joined_at INTEGER NOT NULL, PRIMARY KEY (guild_id, user_id));
      INSERT INTO users VALUES (1, 'dono', 'Dono', 'x', 0), (2, 'membro', 'Membro', 'x', 0);
      INSERT INTO guilds VALUES (10, 'Antigo', 1, 0);
      INSERT INTO members VALUES (10, 1, 0), (10, 2, 1);`);
    old.close();
    const migrated = new Store(path);
    expect(migrated.rolesOf("10")).toEqual([{ id: "10", guildId: "10", name: "@todos", color: null, position: 0, permissions: DEFAULT_EVERYONE_PERMISSIONS, hoist: false }]);
    expect(migrated.permissionsOf("10", "2")).toBe(DEFAULT_EVERYONE_PERMISSIONS);
    expect(migrated.permissionsOf("10", "1") & PERMISSIONS.ADMINISTRATOR).toBeTruthy();
    migrated.close();
    new Store(path).close(); // abrir de novo não duplica
    rmSync(dir, { recursive: true, force: true });
  });
});
