import { afterAll, beforeAll, describe, expect, it } from "vitest";
import type { AddressInfo } from "node:net";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { DatabaseSync } from "node:sqlite";
import type { FastifyInstance } from "fastify";
import { PERMISSIONS, type AuthResponse, type Channel, type Guild, type Invite, type Message, type MessageSearchResult, type Role } from "@aurora/schema";
import { buildApp, searchTerms } from "./http.ts";
import { Gateway } from "./gateway.ts";
import { Store } from "./store.ts";
import { request } from "./test-utils.ts";

let app: FastifyInstance;
let store: Store;
let base = "";
const api = <T = unknown>(method: string, path: string, token?: string, body?: unknown) => request<T>(base, method, path, token, body);
const reg = (u: string) => api<AuthResponse>("POST", "/api/auth/register", undefined, { username: u, password: "senha-forte-1" }).then((r) => r.data);
const search = (token: string, scope: string, params: Record<string, string>) =>
  api<MessageSearchResult>("GET", `${scope}/messages/search?${new URLSearchParams(params)}`, token);

beforeAll(async () => {
  store = new Store(":memory:");
  app = await buildApp({ store, gateway: new Gateway(store), limits: { search: 10_000, auth: 1000 } });
  await app.listen({ port: 0, host: "127.0.0.1" });
  base = `http://127.0.0.1:${(app.server.address() as AddressInfo).port}`;
});

afterAll(async () => {
  await app.close();
  store.close();
});

describe("busca de mensagens", () => {
  it("separa as palavras e ignora operadores do índice", () => {
    expect(searchTerms('Ação "rápida" OR jogo*')).toEqual(["Ação", "rápida", "OR", "jogo"]);
    expect(searchTerms("   ")).toEqual([]);
    expect(searchTerms(undefined)).toEqual([]);
  });

  it("acha sem acento e por começo de palavra; editar e apagar valem na hora", async () => {
    const ana = await reg("busca1");
    const guild = (await api<Guild>("POST", "/api/guilds", ana.token, { name: "Busca" })).data;
    const geral = guild.channels.find((c) => c.type === "text")!;
    const scope = `/api/guilds/${guild.id}`;
    const m1 = (await api<Message>("POST", `/api/channels/${geral.id}/messages`, ana.token, { content: "Ação rápida no jogo de hoje" })).data;
    await api("POST", `/api/channels/${geral.id}/messages`, ana.token, { content: "nada a ver" });

    let res = await search(ana.token, scope, { q: "acao jog" });
    expect(res.status).toBe(200);
    expect(res.data.messages.map((m) => m.id)).toEqual([m1.id]);
    expect(res.data.total).toBe(1);
    // aspas e asteriscos do texto não quebram a consulta
    expect((await search(ana.token, scope, { q: '"acao' })).data.total).toBe(1);

    await api("PATCH", `/api/messages/${m1.id}`, ana.token, { content: "mudou tudo" });
    expect((await search(ana.token, scope, { q: "acao" })).data.total).toBe(0);
    expect((await search(ana.token, scope, { q: "mudou" })).data.total).toBe(1);
    await api("DELETE", `/api/messages/${m1.id}`, ana.token);
    expect((await search(ana.token, scope, { q: "mudou" })).data.total).toBe(0);

    expect((await search(ana.token, scope, {})).status).toBe(400); // nada para procurar
  });

  it("filtros: autor, canal, link e datas; do mais novo para o mais antigo, em páginas", async () => {
    const [ana, beto] = await Promise.all([reg("busca2a"), reg("busca2b")]);
    const guild = (await api<Guild>("POST", "/api/guilds", ana.token, { name: "Filtros" })).data;
    const invite = (await api<Invite>("POST", `/api/guilds/${guild.id}/invites`, ana.token)).data;
    await api("POST", `/api/invites/${invite.code}`, beto.token);
    const geral = guild.channels.find((c) => c.type === "text")!;
    const jogos = (await api<Channel>("POST", `/api/guilds/${guild.id}/channels`, ana.token, { name: "jogos" })).data;
    const scope = `/api/guilds/${guild.id}`;
    const anaUser = store.getUser(ana.user.id)!;
    const betoUser = store.getUser(beto.user.id)!;
    const a = store.createMessage(geral.id, anaUser, "mapa novo https://exemplo.dev/mapa");
    const b = store.createMessage(jogos.id, betoUser, "mapa velho");
    const c = store.createMessage(geral.id, betoUser, "mapa sem link");

    expect((await search(ana.token, scope, { q: "mapa" })).data.messages.map((m) => m.id)).toEqual([c.id, b.id, a.id]);
    expect((await search(ana.token, scope, { q: "mapa", authorId: beto.user.id })).data.messages.map((m) => m.id)).toEqual([c.id, b.id]);
    expect((await search(ana.token, scope, { q: "mapa", channelId: jogos.id })).data.messages.map((m) => m.id)).toEqual([b.id]);
    expect((await search(ana.token, scope, { has: "link" })).data.messages.map((m) => m.id)).toEqual([a.id]);
    expect((await search(ana.token, scope, { q: "mapa", after: String(Date.now() + 60_000) })).data.total).toBe(0);
    expect((await search(ana.token, scope, { q: "mapa", before: String(Date.now() + 60_000) })).data.total).toBe(3);

    for (let i = 0; i < 30; i++) store.createMessage(geral.id, anaUser, `rodada ${i}`);
    const page1 = (await search(ana.token, scope, { q: "rodada" })).data;
    const page2 = (await search(ana.token, scope, { q: "rodada", offset: "25" })).data;
    expect(page1.total).toBe(30);
    expect(page1.messages).toHaveLength(25);
    expect(page2.messages).toHaveLength(5);
    expect(new Set([...page1.messages, ...page2.messages].map((m) => m.id)).size).toBe(30);
  });

  it("sigilo: em qualquer combinação de cargos e canais privados, só volta o que a pessoa vê agora", async () => {
    // gerador pseudoaleatório com semente fixa (o teste é reproduzível)
    let seed = 20261114;
    const rand = () => ((seed = (seed * 1103515245 + 12345) % 2 ** 31) / 2 ** 31);
    const pick = <T>(list: readonly T[]) => list[Math.floor(rand() * list.length)]!;

    const owner = await reg("sigilo0");
    const people = await Promise.all([1, 2, 3, 4].map((i) => reg(`sigilo${i}`)));
    const outsider = await reg("sigilo9");
    const guild = (await api<Guild>("POST", "/api/guilds", owner.token, { name: "Sigilo" })).data;
    const invite = (await api<Invite>("POST", `/api/guilds/${guild.id}/invites`, owner.token)).data;
    for (const p of people) await api("POST", `/api/invites/${invite.code}`, p.token);
    const roles: Role[] = [];
    for (const name of ["staff", "vip"]) roles.push((await api<Role>("POST", `/api/guilds/${guild.id}/roles`, owner.token, { name, permissions: 0 })).data);
    const channels: Channel[] = [guild.channels.find((c) => c.type === "text")!];
    for (let i = 0; i < 4; i++) {
      channels.push((await api<Channel>("POST", `/api/guilds/${guild.id}/channels`, owner.token, { name: `c${i}`, private: rand() < 0.6 })).data);
    }
    const ownerUser = store.getUser(owner.user.id)!;
    for (const channel of channels) store.createMessage(channel.id, ownerUser, `segredo do canal ${channel.name}`);

    const scope = `/api/guilds/${guild.id}`;
    for (let round = 0; round < 12; round++) {
      // muda cargos e sobrescritas ao acaso
      for (const p of people) {
        const role = pick(roles);
        await api(rand() < 0.5 ? "PUT" : "DELETE", `/api/guilds/${guild.id}/members/${p.user.id}/roles/${role.id}`, owner.token);
      }
      const channel = pick(channels);
      const target = rand() < 0.5 ? { type: "role", id: pick(roles).id } : { type: "member", id: pick(people).user.id };
      if (rand() < 0.7) {
        const allow = rand() < 0.5 ? PERMISSIONS.VIEW_CHANNEL : 0;
        await api("PUT", `/api/channels/${channel.id}/overwrites/${target.type}/${target.id}`, owner.token, { allow, deny: allow ? 0 : PERMISSIONS.VIEW_CHANNEL });
      } else {
        await api("DELETE", `/api/channels/${channel.id}/overwrites/${target.type}/${target.id}`, owner.token);
      }
      for (const p of people) {
        const visible = new Set(
          store.channelsOf(guild.id).filter((c) => (store.channelPermissionsOf(c, p.user.id) & PERMISSIONS.VIEW_CHANNEL) !== 0).map((c) => c.id),
        );
        const found = (await search(p.token, scope, { q: "segredo" })).data.messages;
        expect(found.every((m) => visible.has(m.channelId))).toBe(true); // nada de canal que ela não vê
        expect(found).toHaveLength(channels.filter((c) => visible.has(c.id)).length); // e tudo que ela vê (a sala de voz não tem a palavra)
        // pedir um canal específico que ela não vê não vaza nada
        for (const c of channels.filter((c) => !visible.has(c.id))) {
          expect((await search(p.token, scope, { q: "segredo", channelId: c.id })).data.total).toBe(0);
          expect((await search(p.token, `/api/channels/${c.id}`, { q: "segredo" })).status).toBe(404);
        }
      }
    }
    // quem não é do servidor nem sabe que ele existe
    expect((await search(outsider.token, scope, { q: "segredo" })).status).toBe(404);
  });

  it("conversa direta: só quem está nela busca", async () => {
    const [ana, beto, caio] = await Promise.all([reg("busca4a"), reg("busca4b"), reg("busca4c")]);
    const dmId = store.createDm(ana.user.id, beto.user.id);
    store.createMessage(dmId, store.getUser(ana.user.id)!, "senha do wifi é churrasco");
    expect((await search(beto.token, `/api/channels/${dmId}`, { q: "wifi" })).data.total).toBe(1);
    expect((await search(caio.token, `/api/channels/${dmId}`, { q: "wifi" })).status).toBe(404);
  });

  it("histórico em volta de uma mensagem e depois dela", async () => {
    const ana = await reg("busca5");
    const guild = (await api<Guild>("POST", "/api/guilds", ana.token, { name: "Volta" })).data;
    const geral = guild.channels.find((c) => c.type === "text")!;
    const user = store.getUser(ana.user.id)!;
    const ids = Array.from({ length: 120 }, (_, i) => store.createMessage(geral.id, user, `m${i}`).id);
    const around = (await api<Message[]>("GET", `/api/channels/${geral.id}/messages?around=${ids[60]}`, ana.token)).data;
    expect(around).toHaveLength(50);
    expect(around.map((m) => m.id)).toContain(ids[60]);
    expect(around[0]!.id).toBe(ids[36]); // 25 até ela (inclusa) e 25 depois
    expect(around.at(-1)!.id).toBe(ids[85]);
    const after = (await api<Message[]>("GET", `/api/channels/${geral.id}/messages?after=${ids[100]}`, ana.token)).data;
    expect(after.map((m) => m.id)).toEqual(ids.slice(101));
  });
});

describe("migração da busca", () => {
  it("banco de antes da 1.15: o histórico entra no índice ao abrir", () => {
    const dir = mkdtempSync(join(tmpdir(), "aurora-busca-"));
    const path = join(dir, "a.db");
    try {
      const first = new Store(path);
      const user = first.createUser("velho", "Velho", "x");
      const live = { isOnline: () => false, presenceOf: () => ({ status: "offline" as const, customStatus: null }), voiceStatesOf: () => [] };
      const guild = first.createGuild("Antigo", user.id, live);
      const channel = first.channelsOf(guild.id).find((c) => c.type === "text")!;
      first.createMessage(channel.id, user, "mensagem histórica de 2025");
      first.close();
      // volta o banco ao estado da 1.14: sem índice nem gatilhos
      const raw = new DatabaseSync(path);
      raw.exec("DROP TRIGGER messages_fts_insert; DROP TRIGGER messages_fts_delete; DROP TRIGGER messages_fts_update; DROP TABLE messages_fts; PRAGMA user_version = 1;");
      raw.close();
      const reopened = new Store(path);
      const found = reopened.searchMessages({ channelIds: [channel.id], terms: ["historica"], offset: 0, limit: 25 });
      expect(found.messages.map((m) => m.content)).toEqual(["mensagem histórica de 2025"]);
      reopened.close();
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });
});
