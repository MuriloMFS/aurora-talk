import { afterAll, beforeAll, describe, expect, it } from "vitest";
import type { AddressInfo } from "node:net";
import type { FastifyInstance } from "fastify";
import type { AuthResponse, Guild, Invite, ServerFrame, UserSettings } from "@aurora/schema";
import { buildApp } from "./http.ts";
import { Gateway } from "./gateway.ts";
import { Store } from "./store.ts";
import { GatewayTestClient, request } from "./test-utils.ts";

let app: FastifyInstance;
let store: Store;
let base = "";
const api = <T = unknown>(method: string, path: string, token?: string, body?: unknown) => request<T>(base, method, path, token, body);
const ws = (token: string) => GatewayTestClient.identify(base, token, 2);
type Presence = Extract<ServerFrame, { op: "dispatch"; t: "PRESENCE_UPDATE" }>;
/** Próximo aviso de presença de `userId` que cumpra a condição. */
const noPresenceOf = (client: GatewayTestClient, userId: string) =>
  client.expectNoMatch((f) => f.op === "dispatch" && f.t === "PRESENCE_UPDATE" && f.d.userId === userId);
const presenceOf = (client: GatewayTestClient, userId: string, match: (d: Presence["d"]) => boolean = () => true) =>
  client.next((f) => f.op === "dispatch" && f.t === "PRESENCE_UPDATE" && f.d.userId === userId && match(f.d)) as Promise<Presence>;

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

describe("status", () => {
  let ana: AuthResponse;
  let beto: AuthResponse;
  let guild: Guild;
  let betoWs: GatewayTestClient;

  it("ausente sozinho: só quando todos os aparelhos da pessoa estão parados", async () => {
    const reg = (u: string) => api<AuthResponse>("POST", "/api/auth/register", undefined, { username: u, password: "senha-forte-1" }).then((r) => r.data);
    [ana, beto] = await Promise.all([reg("ana6"), reg("beto6")]);
    guild = (await api<Guild>("POST", "/api/guilds", ana.token, { name: "Status" })).data;
    const invite = (await api<Invite>("POST", `/api/guilds/${guild.id}/invites`, ana.token)).data;
    await api("POST", `/api/invites/${invite.code}`, beto.token);
    betoWs = (await ws(beto.token)).client;

    const { client: pc } = await ws(ana.token);
    expect((await presenceOf(betoWs, ana.user.id)).d).toEqual({ userId: ana.user.id, online: true, status: "online", customStatus: null });
    const { client: celular } = await ws(ana.token);
    betoWs.drain();
    pc.send({ op: "idle", idle: true });
    await noPresenceOf(betoWs, ana.user.id); // o celular ainda está em uso
    celular.send({ op: "idle", idle: true });
    expect((await presenceOf(betoWs, ana.user.id)).d.status).toBe("idle");
    pc.send({ op: "idle", idle: false });
    expect((await presenceOf(betoWs, ana.user.id)).d.status).toBe("online");
    celular.close();
    pc.close();
    expect((await presenceOf(betoWs, ana.user.id, (d) => !d.online)).d).toMatchObject({ status: "offline", customStatus: null });
  });

  it("não perturbe e status personalizado: valem na hora, para os outros e para os meus outros aparelhos", async () => {
    const { client: pc } = await ws(ana.token);
    await presenceOf(betoWs, ana.user.id, (d) => d.online);
    const { client: celular } = await ws(ana.token);
    const res = await api<UserSettings>("PATCH", "/api/users/@me/settings", ana.token, { status: "dnd", customStatus: { text: "Estudando", emoji: "📚", expiresAt: null } });
    expect(res.data).toMatchObject({ status: "dnd", customStatus: { text: "Estudando", emoji: "📚", expiresAt: null } });
    expect((await presenceOf(betoWs, ana.user.id, (d) => d.status === "dnd")).d.customStatus).toEqual({ text: "Estudando", emoji: "📚", expiresAt: null });
    const sync = await celular.next((f) => f.op === "dispatch" && f.t === "USER_SETTINGS_UPDATE");
    expect(sync).toMatchObject({ d: { status: "dnd" } });
    // quem entra depois vê no servidor e no READY
    const members = (await api<Guild>("POST", `/api/invites/${(await api<Invite>("POST", `/api/guilds/${guild.id}/invites`, ana.token)).data.code}`, beto.token)).data.members;
    expect(members.find((m) => m.user.id === ana.user.id)).toMatchObject({ online: true, status: "dnd", customStatus: { text: "Estudando" } });
    const again = await ws(ana.token);
    expect(again.ready.settings).toMatchObject({ status: "dnd", customStatus: { text: "Estudando" } });
    again.client.close();
    // ausente automático não passa por cima do não perturbe
    betoWs.drain();
    pc.send({ op: "idle", idle: true });
    celular.send({ op: "idle", idle: true });
    await noPresenceOf(betoWs, ana.user.id);
    pc.close();
    celular.close();
    await presenceOf(betoWs, ana.user.id, (d) => !d.online);
  });

  it("invisível: aparece offline (sem status personalizado), mas continua usando tudo", async () => {
    await api("PATCH", "/api/users/@me/settings", ana.token, { status: "invisible" });
    betoWs.drain();
    const { client: pc } = await ws(ana.token);
    await noPresenceOf(betoWs, ana.user.id);
    const view = (await ws(beto.token)).ready.guilds.find((g) => g.id === guild.id)!;
    expect(view.members.find((m) => m.user.id === ana.user.id)).toMatchObject({ online: false, status: "offline", customStatus: null });
    // amizade: também offline para o amigo
    await api("POST", "/api/users/@me/relationships", ana.token, { username: "beto6" });
    const rel = (await api<{ user: { id: string }; online: boolean; status: string }[]>("GET", "/api/users/@me/relationships", beto.token)).data;
    expect(rel.find((r) => r.user.id === ana.user.id)).toMatchObject({ online: false, status: "offline" });
    await api("PATCH", "/api/users/@me/settings", ana.token, { status: "online" });
    expect((await presenceOf(betoWs, ana.user.id, (d) => d.online)).d).toMatchObject({ status: "online", customStatus: { text: "Estudando" } });
    pc.close();
  });

  it("status personalizado vence sozinho; emoji inválido, vazio ou horário passado são recusados", async () => {
    await api("PATCH", "/api/users/@me/settings", ana.token, { customStatus: { text: "Já volto", emoji: null, expiresAt: Date.now() + 150 } });
    expect((await api<UserSettings>("GET", "/api/users/@me/settings", ana.token)).data.customStatus?.text).toBe("Já volto");
    await new Promise((r) => setTimeout(r, 250));
    expect((await api<UserSettings>("GET", "/api/users/@me/settings", ana.token)).data.customStatus).toBeNull();
    expect((await api("PATCH", "/api/users/@me/settings", ana.token, { customStatus: { text: "x", emoji: "abc", expiresAt: null } })).status).toBe(400);
    expect((await api("PATCH", "/api/users/@me/settings", ana.token, { customStatus: { text: "", emoji: null, expiresAt: null } })).status).toBe(400);
    expect((await api("PATCH", "/api/users/@me/settings", ana.token, { customStatus: { text: "x", emoji: null, expiresAt: Date.now() - 1000 } })).status).toBe(400);
    expect((await api("PATCH", "/api/users/@me/settings", ana.token, { customStatus: { text: "x".repeat(129), emoji: null, expiresAt: null } })).status).toBe(400);
    expect((await api<UserSettings>("PATCH", "/api/users/@me/settings", ana.token, { customStatus: null })).data.customStatus).toBeNull();
    betoWs.close();
  });
});
