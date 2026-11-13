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

describe("chat da sala de voz", () => {
  it("dá para conversar no chat de uma sala de voz; sala privada não vaza", async () => {
    const reg = (u: string) => api<AuthResponse>("POST", "/api/auth/register", undefined, { username: u, password: "senha-forte-1" }).then((r) => r.data);
    const [ana, beto] = await Promise.all([reg("ana9"), reg("beto9")]);
    const guild = (await api<Guild>("POST", "/api/guilds", ana.token, { name: "Voz" })).data;
    const invite = (await api<Invite>("POST", `/api/guilds/${guild.id}/invites`, ana.token)).data;
    await api("POST", `/api/invites/${invite.code}`, beto.token);
    const sala = guild.channels.find((c) => c.type === "voice")!;

    const { client: betoWs, ready } = await GatewayTestClient.identify(base, beto.token, 2);
    expect(ready.readStates?.map((r) => r.channelId)).toContain(sala.id); // não lidas também no chat da voz
    const sent = await api<Message>("POST", `/api/channels/${sala.id}/messages`, ana.token, { content: "link do jogo: https://exemplo.dev" });
    expect(sent.status).toBe(201);
    expect((await betoWs.event("MESSAGE_CREATE")).d).toMatchObject({ channelId: sala.id, content: "link do jogo: https://exemplo.dev" });
    expect((await api<Message[]>("GET", `/api/channels/${sala.id}/messages`, beto.token)).data).toHaveLength(1);

    const privada = (await api<Channel>("POST", `/api/guilds/${guild.id}/channels`, ana.token, { name: "Reunião", type: "voice", private: true })).data;
    await api("POST", `/api/channels/${privada.id}/messages`, ana.token, { content: "segredo" });
    await betoWs.expectNoEvent("MESSAGE_CREATE");
    expect((await api("GET", `/api/channels/${privada.id}/messages`, beto.token)).status).toBe(404);
    expect((await api("POST", `/api/channels/${privada.id}/messages`, beto.token, { content: "oi" })).status).toBe(404);
    betoWs.close();
  });
});
