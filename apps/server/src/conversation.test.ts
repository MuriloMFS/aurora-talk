import { afterAll, beforeAll, describe, expect, it } from "vitest";
import type { AddressInfo } from "node:net";
import type { FastifyInstance } from "fastify";
import { mentionToken, type AuthResponse, type Channel, type Guild, type Invite, type Message, type ReadState } from "@aurora/schema";
import { buildApp } from "./http.ts";
import { Gateway } from "./gateway.ts";
import { Store } from "./store.ts";
import { GatewayTestClient, request } from "./test-utils.ts";

let app: FastifyInstance;
let store: Store;
let base = "";
const api = <T = unknown>(method: string, path: string, token?: string, body?: unknown) => request<T>(base, method, path, token, body);
const reactionPath = (channelId: string, messageId: string, emoji: string) => `/api/channels/${channelId}/messages/${messageId}/reactions/${encodeURIComponent(emoji)}`;

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

describe("conversa completa: respostas, menções, reações e leitura", () => {
  let ana: AuthResponse;
  let beto: AuthResponse;
  let caio: AuthResponse;
  let guild: Guild;
  let geral: Channel;
  let outro: Channel;
  let pergunta: Message;

  it("prepara: Ana cria o servidor; Beto entra; Caio não é membro", async () => {
    ana = (await api<AuthResponse>("POST", "/api/auth/register", undefined, { username: "ana.c", displayName: "Ana", password: "senha-forte-1" })).data;
    beto = (await api<AuthResponse>("POST", "/api/auth/register", undefined, { username: "beto.c", displayName: "Beto", password: "senha-forte-2" })).data;
    caio = (await api<AuthResponse>("POST", "/api/auth/register", undefined, { username: "caio.c", password: "senha-forte-3" })).data;
    guild = (await api<Guild>("POST", "/api/guilds", ana.token, { name: "Conversa" })).data;
    geral = guild.channels.find((c) => c.type === "text")!;
    outro = (await api<Channel>("POST", `/api/guilds/${guild.id}/channels`, ana.token, { name: "outro" })).data;
    const invite = (await api<Invite>("POST", `/api/guilds/${guild.id}/invites`, ana.token)).data;
    expect((await api("POST", `/api/invites/${invite.code}`, beto.token)).status).toBe(200);
  });

  it("menções: só membros entram em `mentions`; quem não é membro é ignorado", async () => {
    const content = `oi ${mentionToken(beto.user.id)} e ${mentionToken(caio.user.id)} ${mentionToken(beto.user.id)}`;
    const sent = await api<Message>("POST", `/api/channels/${geral.id}/messages`, ana.token, { content });
    expect(sent.status).toBe(201);
    expect(sent.data.mentions).toEqual([beto.user.id]);
    expect(sent.data.replyTo).toBeNull();
    expect(sent.data.reactions).toEqual([]);
    pergunta = sent.data;
  });

  it("resposta: traz o trecho da original e menciona o autor dela", async () => {
    const res = await api<Message>("POST", `/api/channels/${geral.id}/messages`, beto.token, { content: "respondendo", replyToId: pergunta.id });
    expect(res.status).toBe(201);
    expect(res.data.replyTo).toMatchObject({ id: pergunta.id, author: { id: ana.user.id }, content: pergunta.content });
    expect(res.data.mentions).toEqual([ana.user.id]);
  });

  it("resposta a mensagem de outro canal ou inexistente: erro claro", async () => {
    const other = (await api<Message>("POST", `/api/channels/${outro.id}/messages`, ana.token, { content: "lá" })).data;
    const wrong = await api<{ error: { message: string } }>("POST", `/api/channels/${geral.id}/messages`, beto.token, { content: "x", replyToId: other.id });
    expect(wrong.status).toBe(400);
    expect(wrong.data.error.message).toContain("foi apagada");
    expect((await api("POST", `/api/channels/${geral.id}/messages`, beto.token, { content: "x", replyToId: "123" })).status).toBe(400);
  });

  it("original apagada: a resposta continua, marcada como apagada", async () => {
    const original = (await api<Message>("POST", `/api/channels/${geral.id}/messages`, ana.token, { content: "vou apagar" })).data;
    const answer = (await api<Message>("POST", `/api/channels/${geral.id}/messages`, beto.token, { content: "ok", replyToId: original.id })).data;
    expect((await api("DELETE", `/api/messages/${original.id}`, ana.token)).status).toBe(204);
    const list = (await api<Message[]>("GET", `/api/channels/${geral.id}/messages`, beto.token)).data;
    expect(list.find((m) => m.id === answer.id)?.replyTo).toEqual({ id: original.id, author: null, content: null });
  });

  it("reações: adicionar é idempotente, chega ao vivo para clientes v2 e não para clientes antigos", async () => {
    const v2 = await GatewayTestClient.identify(base, ana.token, 2);
    const old = await GatewayTestClient.identify(base, beto.token);
    expect(old.ready.readStates).toBeUndefined();

    expect((await api("PUT", reactionPath(geral.id, pergunta.id, "👍"), beto.token)).status).toBe(204);
    const added = await v2.client.event("MESSAGE_REACTION_ADD");
    expect(added.d).toEqual({ channelId: geral.id, messageId: pergunta.id, userId: beto.user.id, emoji: "👍" });
    expect((await api("PUT", reactionPath(geral.id, pergunta.id, "👍"), beto.token)).status).toBe(204);
    await v2.client.expectNoEvent("MESSAGE_REACTION_ADD");
    await old.client.expectNoEvent("MESSAGE_REACTION_ADD");

    await api("PUT", reactionPath(geral.id, pergunta.id, "👍"), ana.token);
    await api("PUT", reactionPath(geral.id, pergunta.id, "🏳️‍🌈"), ana.token);
    const list = (await api<Message[]>("GET", `/api/channels/${geral.id}/messages`, ana.token)).data;
    expect(list.find((m) => m.id === pergunta.id)?.reactions).toEqual([
      { emoji: "👍", userIds: [beto.user.id, ana.user.id] },
      { emoji: "🏳️‍🌈", userIds: [ana.user.id] },
    ]);

    expect((await api("DELETE", reactionPath(geral.id, pergunta.id, "👍"), beto.token)).status).toBe(204);
    expect((await v2.client.event("MESSAGE_REACTION_REMOVE")).d.userId).toBe(beto.user.id);
    v2.client.close();
    old.client.close();
  });

  it("reações: texto não é emoji, não-membro não reage, há limite de emojis por mensagem", async () => {
    expect((await api("PUT", reactionPath(geral.id, pergunta.id, "oi"), beto.token)).status).toBe(400);
    expect((await api("PUT", reactionPath(geral.id, pergunta.id, "👍"), caio.token)).status).toBe(404);
    expect((await api("PUT", reactionPath(outro.id, pergunta.id, "👍"), beto.token)).status).toBe(404);
    const target = (await api<Message>("POST", `/api/channels/${outro.id}/messages`, ana.token, { content: "limite" })).data;
    const emojis = [..."😀😃😄😁😆😅😂🤣😊😇🙂🙃😉😌😍🥰😘😗😙😚"];
    expect(emojis).toHaveLength(20);
    for (const emoji of emojis) store.addReaction(target.id, ana.user.id, emoji);
    const res = await api<{ error: { message: string } }>("PUT", reactionPath(outro.id, target.id, "🤖"), beto.token);
    expect(res.status).toBe(400);
    expect(res.data.error.message).toContain("reações demais");
    expect((await api("PUT", reactionPath(outro.id, target.id, "😀"), beto.token)).status).toBe(204); // emoji que já está nela pode
  });

  it("leitura: READY traz não lidas e menções; ack zera e avisa as outras abas", async () => {
    // Beto escreveu em #geral nos testes acima: enviar marca como lido. Agora a Ana o menciona de novo.
    await api("POST", `/api/channels/${geral.id}/messages`, ana.token, { content: `ei ${mentionToken(beto.user.id)}` });
    await api("POST", `/api/channels/${geral.id}/messages`, ana.token, { content: "e mais uma, sem menção" });
    const before = await GatewayTestClient.identify(base, beto.token, 2);
    const geralState = before.ready.readStates!.find((r) => r.channelId === geral.id)!;
    expect(geralState.mentionCount).toBe(1);
    expect(BigInt(geralState.lastMessageId!) > BigInt(geralState.lastReadId)).toBe(true);
    const otherTab = await GatewayTestClient.identify(base, beto.token, 2);

    const res = await api("POST", `/api/channels/${geral.id}/ack`, beto.token, { messageId: geralState.lastMessageId });
    expect(res.status).toBe(204);
    expect((await otherTab.client.event("READ_STATE_UPDATE")).d).toEqual({ channelId: geral.id, lastReadId: geralState.lastMessageId });
    // ack mais antigo não volta a leitura
    expect((await api("POST", `/api/channels/${geral.id}/ack`, beto.token, { messageId: pergunta.id })).status).toBe(204);
    await otherTab.client.expectNoEvent("READ_STATE_UPDATE");

    const after = await GatewayTestClient.identify(base, beto.token, 2);
    const read: ReadState = after.ready.readStates!.find((r) => r.channelId === geral.id)!;
    expect(read).toEqual({ channelId: geral.id, lastReadId: geralState.lastMessageId, lastMessageId: geralState.lastMessageId, mentionCount: 0 });
    for (const c of [before, otherTab, after]) c.client.close();
  });

  it("leitura: quem entra depois não vê o histórico antigo como não lido; ack de canal alheio é 404", async () => {
    const dani = (await api<AuthResponse>("POST", "/api/auth/register", undefined, { username: "dani.c", password: "senha-forte-4" })).data;
    const invite = (await api<Invite>("POST", `/api/guilds/${guild.id}/invites`, ana.token)).data;
    await api("POST", `/api/invites/${invite.code}`, dani.token);
    const { client, ready } = await GatewayTestClient.identify(base, dani.token, 2);
    const state = ready.readStates!.find((r) => r.channelId === geral.id)!;
    expect(BigInt(state.lastReadId) >= BigInt(state.lastMessageId!)).toBe(true);
    expect(state.mentionCount).toBe(0);
    client.close();
    expect((await api("POST", `/api/channels/${geral.id}/ack`, caio.token, { messageId: pergunta.id })).status).toBe(404);
  });

  it("editar: menções são recalculadas", async () => {
    const msg = (await api<Message>("POST", `/api/channels/${geral.id}/messages`, ana.token, { content: "sem menção" })).data;
    const edited = await api<Message>("PATCH", `/api/messages/${msg.id}`, ana.token, { content: `agora ${mentionToken(beto.user.id)}` });
    expect(edited.data.mentions).toEqual([beto.user.id]);
  });
});
