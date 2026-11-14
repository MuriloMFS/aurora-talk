import { afterAll, beforeAll, describe, expect, it } from "vitest";
import type { AddressInfo } from "node:net";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { DatabaseSync } from "node:sqlite";
import type { FastifyInstance } from "fastify";
import { PERMISSIONS, type AuthResponse, type Channel, type Guild, type Invite, type Message } from "@aurora/schema";
import { buildApp } from "./http.ts";
import { Gateway } from "./gateway.ts";
import { Store } from "./store.ts";
import { GatewayTestClient, request } from "./test-utils.ts";

let app: FastifyInstance;
let store: Store;
let base = "";
const api = <T = unknown>(method: string, path: string, token?: string, body?: unknown) => request<T>(base, method, path, token, body);
const reg = (u: string) => api<AuthResponse>("POST", "/api/auth/register", undefined, { username: u, password: "senha-forte-1" }).then((r) => r.data);
const poll = (answers = ["Pizza", "Hambúrguer", "Sushi"], extra: Record<string, unknown> = {}) => ({
  question: "O que pedimos hoje?",
  answers: answers.map((text) => ({ text })),
  durationHours: 24,
  allowMultiselect: false,
  ...extra,
});
const votePath = (channelId: string, messageId: string, answerId: number) => `/api/channels/${channelId}/polls/${messageId}/answers/${answerId}/votes/@me`;

/** Servidor com dona + 3 membros e o canal geral. */
async function setup(prefix: string) {
  const [ana, beto, caio, duda] = await Promise.all([1, 2, 3, 4].map((i) => reg(`${prefix}${i}`)));
  const guild = (await api<Guild>("POST", "/api/guilds", ana!.token, { name: "Enquetes" })).data;
  const invite = (await api<Invite>("POST", `/api/guilds/${guild.id}/invites`, ana!.token)).data;
  for (const u of [beto, caio, duda]) await api("POST", `/api/invites/${invite.code}`, u!.token);
  const geral = guild.channels.find((c) => c.type === "text")!;
  return { ana: ana!, beto: beto!, caio: caio!, duda: duda!, guild, geral };
}

beforeAll(async () => {
  store = new Store(":memory:");
  app = await buildApp({ store, gateway: new Gateway(store), limits: { auth: 1000 } });
  await app.listen({ port: 0, host: "127.0.0.1" });
  base = `http://127.0.0.1:${(app.server.address() as AddressInfo).port}`;
});

afterAll(async () => {
  await app.close();
  store.close();
});

describe("enquetes", () => {
  it("cria com as respostas na ordem; recusa enquete malformada com mensagem clara", async () => {
    const { ana, geral } = await setup("enq1x");
    const res = await api<Message>("POST", `/api/channels/${geral.id}/messages`, ana.token, { content: "", poll: poll() });
    expect(res.status).toBe(201);
    expect(res.data.poll).toMatchObject({ question: "O que pedimos hoje?", allowMultiselect: false, endedAt: null });
    expect(res.data.poll!.answers.map((a) => [a.id, a.text, a.voterIds])).toEqual([[1, "Pizza", []], [2, "Hambúrguer", []], [3, "Sushi", []]]);
    expect(res.data.poll!.expiresAt - Date.now()).toBeGreaterThan(23.9 * 3_600_000);
    // mensagem comum continua sem o campo
    const plain = await api<Message>("POST", `/api/channels/${geral.id}/messages`, ana.token, { content: "oi" });
    expect("poll" in plain.data).toBe(false);

    const bad = async (body: unknown) => (await api<{ error: { message: string } }>("POST", `/api/channels/${geral.id}/messages`, ana.token, body)).data.error.message;
    expect(await bad({ poll: poll(["só uma"]) })).toBe("A enquete precisa de pelo menos 2 respostas.");
    expect(await bad({ poll: poll(Array.from({ length: 11 }, (_, i) => `r${i}`)) })).toBe("A enquete pode ter no máximo 10 respostas.");
    expect(await bad({ poll: poll(undefined, { durationHours: 5 }) })).toBe("Escolha uma das durações da lista.");
    expect(await bad({ poll: poll(undefined, { question: "  " }) })).toBe("Escreva a pergunta da enquete.");
    expect(await bad({ poll: poll(["a", " "]) })).toBe("Toda resposta precisa de um texto.");
  });

  it("sem a permissão Criar enquetes no canal, não cria", async () => {
    const { ana, beto, guild, geral } = await setup("enq2x");
    await api("PUT", `/api/channels/${geral.id}/overwrites/role/${guild.id}`, ana.token, { allow: 0, deny: PERMISSIONS.SEND_POLLS });
    expect((await api("POST", `/api/channels/${geral.id}/messages`, beto.token, { poll: poll() })).status).toBe(403);
    expect((await api("POST", `/api/channels/${geral.id}/messages`, beto.token, { content: "texto pode" })).status).toBe(201);
  });

  it("resposta única troca o voto; múltipla soma; eventos ao vivo para o canal", async () => {
    const { ana, beto, geral } = await setup("enq3x");
    const single = (await api<Message>("POST", `/api/channels/${geral.id}/messages`, ana.token, { poll: poll() })).data;
    const multi = (await api<Message>("POST", `/api/channels/${geral.id}/messages`, ana.token, { poll: poll(undefined, { allowMultiselect: true }) })).data;
    const { client: anaWs } = await GatewayTestClient.identify(base, ana.token, 2);

    expect((await api("PUT", votePath(geral.id, single.id, 1), beto.token)).status).toBe(204);
    expect((await anaWs.event("MESSAGE_POLL_VOTE_ADD")).d).toEqual({ channelId: geral.id, messageId: single.id, answerId: 1, userId: beto.user.id });
    await api("PUT", votePath(geral.id, single.id, 3), beto.token); // troca: sai do 1, entra no 3
    expect((await anaWs.event("MESSAGE_POLL_VOTE_REMOVE")).d).toMatchObject({ answerId: 1, userId: beto.user.id });
    expect((await anaWs.event("MESSAGE_POLL_VOTE_ADD")).d).toMatchObject({ answerId: 3 });
    await api("PUT", votePath(geral.id, multi.id, 1), beto.token);
    await api("PUT", votePath(geral.id, multi.id, 2), beto.token);
    anaWs.close();

    const page = (await api<Message[]>("GET", `/api/channels/${geral.id}/messages`, ana.token)).data;
    const voters = (id: string) => page.find((m) => m.id === id)!.poll!.answers.map((a) => a.voterIds.length);
    expect(voters(single.id)).toEqual([0, 0, 1]);
    expect(voters(multi.id)).toEqual([1, 1, 0]);
    expect((await api("PUT", votePath(geral.id, single.id, 9), beto.token)).status).toBe(404); // resposta que não existe
    expect((await api("PUT", votePath(geral.id, page.find((m) => !m.poll)?.id ?? single.id, 1), beto.token)).status).toBeLessThan(500);
  });

  it("propriedade: em qualquer sequência de votos e retiradas, o que fica guardado bate com o modelo", async () => {
    const { ana, beto, caio, duda, geral } = await setup("enq4x");
    let seed = 1114;
    const rand = () => ((seed = (seed * 1103515245 + 12345) % 2 ** 31) / 2 ** 31);
    const people = [ana, beto, caio, duda];
    for (const allowMultiselect of [false, true]) {
      const msg = (await api<Message>("POST", `/api/channels/${geral.id}/messages`, ana.token, { poll: poll(["a", "b", "c", "d"], { allowMultiselect }) })).data;
      const model = new Map<string, Set<number>>(people.map((p) => [p.user.id, new Set()]));
      for (let step = 0; step < 60; step++) {
        const who = people[Math.floor(rand() * people.length)]!;
        const answer = 1 + Math.floor(rand() * 4);
        const mine = model.get(who.user.id)!;
        // só conta o que o servidor aceitou (204); recusa só pode ser o limite anti-spam (429)
        if (rand() < 0.65) {
          const { status } = await api("PUT", votePath(geral.id, msg.id, answer), who.token);
          expect([204, 429]).toContain(status);
          if (status === 204) {
            if (!allowMultiselect) mine.clear();
            mine.add(answer);
          }
        } else {
          const { status } = await api("DELETE", votePath(geral.id, msg.id, answer), who.token);
          expect([204, 429]).toContain(status);
          if (status === 204) mine.delete(answer);
        }
      }
      const stored = (await api<Message[]>("GET", `/api/channels/${geral.id}/messages`, ana.token)).data.find((m) => m.id === msg.id)!.poll!;
      for (const answer of stored.answers) {
        const expected = people.filter((p) => model.get(p.user.id)!.has(answer.id)).map((p) => p.user.id).sort();
        expect([...answer.voterIds].sort()).toEqual(expected);
      }
      if (!allowMultiselect) for (const p of people) expect(stored.answers.filter((a) => a.voterIds.includes(p.user.id)).length).toBeLessThanOrEqual(1);
    }
  });

  it("sigilo: quem não vê o canal não vota nem descobre a enquete", async () => {
    const { ana, beto, guild } = await setup("enq5x");
    const outsider = await reg("enq5fora");
    const privado = (await api<Channel>("POST", `/api/guilds/${guild.id}/channels`, ana.token, { name: "staff", private: true })).data;
    const msg = (await api<Message>("POST", `/api/channels/${privado.id}/messages`, ana.token, { poll: poll() })).data;
    expect((await api("PUT", votePath(privado.id, msg.id, 1), beto.token)).status).toBe(404);
    expect((await api("PUT", votePath(privado.id, msg.id, 1), outsider.token)).status).toBe(404);
    expect((await api("POST", `/api/channels/${privado.id}/polls/${msg.id}/expire`, beto.token)).status).toBe(404);
  });

  it("prazo e encerramento: depois do fim não vota; só quem criou ou modera encerra antes", async () => {
    const { ana, beto, caio, geral } = await setup("enq6x");
    const a = (await api<Message>("POST", `/api/channels/${geral.id}/messages`, beto.token, { poll: poll() })).data;
    await api("PUT", votePath(geral.id, a.id, 2), caio.token);
    expect((await api("POST", `/api/channels/${geral.id}/polls/${a.id}/expire`, caio.token)).status).toBe(403); // não é dela
    const ended = await api<Message>("POST", `/api/channels/${geral.id}/polls/${a.id}/expire`, beto.token);
    expect(ended.status).toBe(200);
    expect(ended.data.poll!.endedAt).not.toBeNull();
    expect(ended.data.poll!.answers[1]!.voterIds).toEqual([caio.user.id]); // os votos ficam
    expect((await api<{ error: { code: string } }>("PUT", votePath(geral.id, a.id, 1), caio.token)).data.error.code).toBe("poll_ended");
    expect((await api("DELETE", votePath(geral.id, a.id, 2), caio.token)).status).toBe(400);
    expect((await api("POST", `/api/channels/${geral.id}/polls/${a.id}/expire`, beto.token)).status).toBe(400); // já acabou

    // dona do servidor (gerencia mensagens) encerra a enquete de outra pessoa
    const b = (await api<Message>("POST", `/api/channels/${geral.id}/messages`, beto.token, { poll: poll() })).data;
    expect((await api("POST", `/api/channels/${geral.id}/polls/${b.id}/expire`, ana.token)).status).toBe(200);

    // passou do prazo: encerrada sem ninguém mexer
    const c = (await api<Message>("POST", `/api/channels/${geral.id}/messages`, beto.token, { poll: poll(undefined, { durationHours: 1 }) })).data;
    (store as unknown as { db: DatabaseSync }).db.prepare("UPDATE polls SET expires_at = ? WHERE message_id = ?").run(Date.now() - 1000, Number(c.id));
    expect((await api("PUT", votePath(geral.id, c.id, 1), caio.token)).status).toBe(400);
    const page = (await api<Message[]>("GET", `/api/channels/${geral.id}/messages`, ana.token)).data;
    expect(page.find((m) => m.id === c.id)!.poll!.endedAt).not.toBeNull();
  });

  it("apagar a mensagem leva a enquete e os votos junto", async () => {
    const { ana, beto, geral } = await setup("enq7x");
    const msg = (await api<Message>("POST", `/api/channels/${geral.id}/messages`, ana.token, { poll: poll() })).data;
    await api("PUT", votePath(geral.id, msg.id, 1), beto.token);
    expect((await api("DELETE", `/api/messages/${msg.id}`, ana.token)).status).toBe(204);
    const db = (store as unknown as { db: DatabaseSync }).db;
    expect(db.prepare("SELECT COUNT(*) AS n FROM poll_votes WHERE message_id = ?").get(Number(msg.id))).toEqual({ n: 0 });
    expect(db.prepare("SELECT COUNT(*) AS n FROM polls WHERE message_id = ?").get(Number(msg.id))).toEqual({ n: 0 });
  });
});

describe("migração das enquetes", () => {
  it("servidores de antes da 1.17 ganham Criar enquetes no @todos, uma vez", () => {
    const dir = mkdtempSync(join(tmpdir(), "aurora-enquete-"));
    const path = join(dir, "a.db");
    try {
      const first = new Store(path);
      const user = first.createUser("velha", "Velha", "x");
      const live = { isOnline: () => false, presenceOf: () => ({ status: "offline" as const, customStatus: null }), voiceStatesOf: () => [] };
      const guild = first.createGuild("Antigo", user.id, live);
      first.close();
      const raw = new DatabaseSync(path);
      raw.prepare("UPDATE roles SET permissions = permissions & ? WHERE id = guild_id").run(~PERMISSIONS.SEND_POLLS);
      raw.exec("PRAGMA user_version = 2");
      raw.close();
      const reopened = new Store(path);
      const row = (reopened as unknown as { db: DatabaseSync }).db.prepare("SELECT permissions FROM roles WHERE id = ?").get(Number(guild.id)) as { permissions: number };
      expect(row.permissions & PERMISSIONS.SEND_POLLS).toBe(PERMISSIONS.SEND_POLLS);
      reopened.close();
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });
});
