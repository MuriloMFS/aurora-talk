import { afterAll, beforeAll, describe, expect, it } from "vitest";
import type { AddressInfo } from "node:net";
import type { FastifyInstance } from "fastify";
import type { AuthResponse, Guild, Invite, Message, User } from "@aurora/schema";
import { buildApp } from "./http.ts";
import { Gateway } from "./gateway.ts";
import { Store } from "./store.ts";
import { GatewayTestClient, request } from "./test-utils.ts";

let app: FastifyInstance;
let store: Store;
let base = "";
const api = <T = unknown>(method: string, path: string, token?: string, body?: unknown) => request<T>(base, method, path, token, body);

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

describe("minha conta", () => {
  let ana: AuthResponse;
  let beto: AuthResponse;
  let estranho: AuthResponse;
  let guild: Guild;

  it("prepara: Ana e Beto no mesmo servidor, Estranho fora", async () => {
    ana = (await api<AuthResponse>("POST", "/api/auth/register", undefined, { username: "ana", password: "senha-forte-1" })).data;
    beto = (await api<AuthResponse>("POST", "/api/auth/register", undefined, { username: "beto", password: "senha-forte-2" })).data;
    estranho = (await api<AuthResponse>("POST", "/api/auth/register", undefined, { username: "estranho", password: "senha-forte-3" })).data;
    guild = (await api<Guild>("POST", "/api/guilds", ana.token, { name: "Turma" })).data;
    const invite = (await api<Invite>("POST", `/api/guilds/${guild.id}/invites`, ana.token)).data;
    await api("POST", `/api/invites/${invite.code}`, beto.token);
  });

  it("mudar o nome de exibição avisa quem divide servidor (e as minhas outras abas), não estranhos", async () => {
    const text = guild.channels.find((c) => c.type === "text")!;
    await api<Message>("POST", `/api/channels/${text.id}/messages`, ana.token, { content: "oi" });
    const { client: betoWs } = await GatewayTestClient.identify(base, beto.token, 2);
    const { client: anaOutraAba } = await GatewayTestClient.identify(base, ana.token, 2);
    const { client: estranhoWs } = await GatewayTestClient.identify(base, estranho.token, 2);
    const { client: betoAntigo } = await GatewayTestClient.identify(base, beto.token); // app 1.2.x (sem versão)

    const res = await api<User>("PATCH", "/api/users/@me", ana.token, { displayName: "  Ana Clara  " });
    expect(res.status).toBe(200);
    expect(res.data).toEqual({ id: ana.user.id, username: "ana", displayName: "Ana Clara" });
    expect((await betoWs.event("USER_UPDATE")).d).toEqual(res.data);
    expect((await anaOutraAba.event("USER_UPDATE")).d).toEqual(res.data);
    await estranhoWs.expectNoEvent("USER_UPDATE");
    await betoAntigo.expectNoEvent("USER_UPDATE"); // o reducer do 1.2.x não conhece o evento

    // o histórico já vem com o nome novo
    const history = (await api<Message[]>("GET", `/api/channels/${text.id}/messages`, beto.token)).data;
    expect(history.at(-1)?.author.displayName).toBe("Ana Clara");
    expect((await api<User>("GET", "/api/users/@me", ana.token)).data.displayName).toBe("Ana Clara");
    for (const ws of [betoWs, anaOutraAba, estranhoWs, betoAntigo]) ws.close();
  });

  it("nome vazio ou longo demais é recusado com a explicação", async () => {
    const empty = await api<{ error: { message: string } }>("PATCH", "/api/users/@me", ana.token, { displayName: "   " });
    expect(empty.status).toBe(400);
    expect(empty.data.error.message).toMatch(/Informe um nome/);
    expect((await api("PATCH", "/api/users/@me", ana.token, { displayName: "x".repeat(33) })).status).toBe(400);
    expect((await api("PATCH", "/api/users/@me", undefined, { displayName: "Sem login" })).status).toBe(401);
  });

  it("trocar a senha confere a atual, mantém esta sessão e encerra as outras", async () => {
    const outroAparelho = (await api<AuthResponse>("POST", "/api/auth/login", undefined, { username: "beto", password: "senha-forte-2" })).data;
    const { client: outroWs } = await GatewayTestClient.identify(base, outroAparelho.token, 2);

    const wrong = await api<{ error: { message: string } }>("POST", "/api/users/@me/password", beto.token, { currentPassword: "errada", newPassword: "nova-senha-123" });
    expect(wrong.status).toBe(400);
    expect(wrong.data.error.message).toMatch(/senha atual está errada/);
    expect((await api("POST", "/api/users/@me/password", beto.token, { currentPassword: "senha-forte-2", newPassword: "curta" })).status).toBe(400);

    expect((await api("POST", "/api/users/@me/password", beto.token, { currentPassword: "senha-forte-2", newPassword: "nova-senha-123" })).status).toBe(204);
    expect((await api("GET", "/api/users/@me", beto.token)).status).toBe(200); // esta sessão continua
    expect((await api("GET", "/api/users/@me", outroAparelho.token)).status).toBe(401); // a outra caiu
    await outroWs.closed;
    expect((await api("POST", "/api/auth/login", undefined, { username: "beto", password: "senha-forte-2" })).status).toBe(401);
    expect((await api("POST", "/api/auth/login", undefined, { username: "beto", password: "nova-senha-123" })).status).toBe(200);
  });
});
