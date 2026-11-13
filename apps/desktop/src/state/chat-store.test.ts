import { describe, expect, it } from "vitest";
import { DEFAULT_EVERYONE_PERMISSIONS, PERMISSIONS, hasPermission, type Guild, type Message, type User } from "@aurora/schema";
import { TYPING_TTL_MS, chatReducer, dmList, dmMentionTotal, dmName, initialChatState, isBlocked, isUnread, mentionCountOf, myChannelPermissions, myPermissions, myTimeout, presenceOf, type ChatState } from "./chat-store";

const ana: User = { id: "1", username: "ana", displayName: "Ana" };
const bia: User = { id: "2", username: "bia", displayName: "Bia" };
const guild: Guild = {
  id: "10",
  name: "Aurora",
  ownerId: "1",
  channels: [
    { id: "21", guildId: "10", type: "text", name: "design", position: 1, overwrites: [] },
    { id: "20", guildId: "10", type: "text", name: "geral", position: 0, overwrites: [] },
    { id: "30", guildId: "10", type: "voice", name: "Sala de voz", position: 2, overwrites: [] },
  ],
  members: [
    { user: ana, joinedAt: 1, online: true, roles: [] },
    { user: bia, joinedAt: 2, online: false, roles: ["50"] },
  ],
  voiceStates: [{ userId: "2", channelId: "30", muted: false, deafened: false, streaming: false }],
  roles: [
    { id: "10", guildId: "10", name: "@todos", color: null, position: 0, permissions: DEFAULT_EVERYONE_PERMISSIONS, hoist: false },
    { id: "50", guildId: "10", name: "Moderação", color: 2, position: 1, permissions: PERMISSIONS.KICK_MEMBERS, hoist: true },
  ],
};
const msg = (id: string, author: User, channelId = "20", content = id, mentions: string[] = []): Message => ({
  id,
  channelId,
  author,
  content,
  createdAt: Number(id),
  editedAt: null,
  replyTo: null,
  reactions: [],
  mentions,
});
const create = (state: ChatState, message: Message) => chatReducer(state, { type: "dispatch", event: { t: "MESSAGE_CREATE", d: message }, now: 0 });

function ready(): ChatState {
  return chatReducer(initialChatState, { type: "ready", user: ana, guilds: [guild] });
}

describe("chatReducer", () => {
  it("READY monta servidores com canais ordenados por posição", () => {
    const state = ready();
    expect(state.status).toBe("ready");
    expect(state.guildOrder).toEqual(["10"]);
    expect(state.guilds["10"]?.channelIds).toEqual(["20", "21", "30"]);
    expect(state.members["10"]?.["2"]?.online).toBe(false);
    expect(state.voice["10"]?.["2"]?.channelId).toBe("30");
  });

  it("voz: entrar, mutar e sair atualizam quem está na sala", () => {
    let state = chatReducer(ready(), {
      type: "dispatch",
      event: { t: "VOICE_STATE_UPDATE", d: { guildId: "10", userId: "1", channelId: "30", muted: false, deafened: false, streaming: false } },
      now: 0,
    });
    expect(Object.keys(state.voice["10"] ?? {}).sort()).toEqual(["1", "2"]);
    state = chatReducer(state, {
      type: "dispatch",
      event: { t: "VOICE_STATE_UPDATE", d: { guildId: "10", userId: "1", channelId: "30", muted: true, deafened: true, streaming: true } },
      now: 0,
    });
    expect(state.voice["10"]?.["1"]).toMatchObject({ muted: true, deafened: true, streaming: true });
    state = chatReducer(state, {
      type: "dispatch",
      event: { t: "VOICE_STATE_UPDATE", d: { guildId: "10", userId: "2", channelId: null, muted: false, deafened: false, streaming: false } },
      now: 0,
    });
    expect(state.voice["10"]?.["2"]).toBeUndefined();
  });

  it("mensagens de outros em canal não ativo marcam não lido; focar limpa", () => {
    let state = chatReducer(ready(), { type: "focusChannel", channelId: "21" });
    state = create(state, msg("100", bia));
    expect(isUnread(state, "20")).toBe(true);
    state = chatReducer(state, { type: "focusChannel", channelId: "20" });
    expect(isUnread(state, "20")).toBe(false);
  });

  it("a minha própria mensagem nunca deixa o canal não lido", () => {
    let state = chatReducer(ready(), { type: "focusChannel", channelId: "21" });
    state = create(state, msg("100", bia));
    state = create(state, msg("101", ana));
    expect(isUnread(state, "20")).toBe(false);
  });

  it("menções a mim contam; mensagem repetida (eco + evento) não conta duas vezes", () => {
    let state = chatReducer(ready(), { type: "focusChannel", channelId: "21" });
    state = chatReducer(state, { type: "history", channelId: "20", messages: [], mode: "latest", pageSize: 50 });
    state = create(state, msg("100", bia, "20", "<@1>", ["1"]));
    state = create(state, msg("100", bia, "20", "<@1>", ["1"]));
    state = create(state, msg("101", bia, "20", "sem menção"));
    state = create(state, msg("102", bia, "20", "<@2>", ["2"]));
    expect(mentionCountOf(state, "20")).toBe(1);
    state = chatReducer(state, { type: "focusChannel", channelId: "20" });
    expect(mentionCountOf(state, "20")).toBe(0);
  });

  it("janela sem foco: o canal aberto também acumula; voltar o foco lê", () => {
    let state = chatReducer(ready(), { type: "focusChannel", channelId: "20" });
    state = chatReducer(state, { type: "windowFocus", focused: false });
    state = create(state, msg("100", bia, "20", "<@1>", ["1"]));
    expect(isUnread(state, "20")).toBe(true);
    expect(mentionCountOf(state, "20")).toBe(1);
    state = chatReducer(state, { type: "windowFocus", focused: true });
    expect(isUnread(state, "20")).toBe(false);
    expect(state.reads["20"]?.lastReadId).toBe("100");
  });

  it("READY traz a leitura do servidor; READ_STATE_UPDATE (outro aparelho) avança e nunca volta", () => {
    let state = chatReducer(chatReducer(initialChatState, { type: "focusChannel", channelId: "21" }), {
      type: "ready",
      user: ana,
      guilds: [guild],
      readStates: [
        { channelId: "20", lastReadId: "100", lastMessageId: "105", mentionCount: 2 },
        { channelId: "21", lastReadId: "1", lastMessageId: "1", mentionCount: 0 },
      ],
    });
    expect(isUnread(state, "20")).toBe(true);
    expect(mentionCountOf(state, "20")).toBe(2);
    const readUpTo = (lastReadId: string) =>
      (state = chatReducer(state, { type: "dispatch", event: { t: "READ_STATE_UPDATE", d: { channelId: "20", lastReadId } }, now: 0 }));
    readUpTo("103");
    expect(mentionCountOf(state, "20")).toBe(2); // ainda faltam mensagens
    readUpTo("105");
    expect(isUnread(state, "20")).toBe(false);
    expect(mentionCountOf(state, "20")).toBe(0);
    readUpTo("101");
    expect(state.reads["20"]?.lastReadId).toBe("105");
  });

  it("reações ao vivo: somar, não duplicar, tirar e sumir com o emoji vazio", () => {
    let state = chatReducer(ready(), { type: "history", channelId: "20", messages: [msg("5", ana)], mode: "latest", pageSize: 50 });
    const react = (t: "MESSAGE_REACTION_ADD" | "MESSAGE_REACTION_REMOVE", userId: string, emoji = "👍") =>
      (state = chatReducer(state, { type: "dispatch", event: { t, d: { channelId: "20", messageId: "5", userId, emoji } }, now: 0 }));
    react("MESSAGE_REACTION_ADD", "1");
    react("MESSAGE_REACTION_ADD", "2");
    react("MESSAGE_REACTION_ADD", "2");
    react("MESSAGE_REACTION_ADD", "2", "🎉");
    expect(state.messages["20"]!.items[0]!.reactions).toEqual([
      { emoji: "👍", userIds: ["1", "2"] },
      { emoji: "🎉", userIds: ["2"] },
    ]);
    react("MESSAGE_REACTION_REMOVE", "2", "🎉");
    expect(state.messages["20"]!.items[0]!.reactions).toEqual([{ emoji: "👍", userIds: ["1", "2"] }]);
  });

  it("nome de exibição novo vale na hora: membros, mensagens, respostas e eu mesmo", () => {
    const reply: Message = { ...msg("101", ana), replyTo: { id: "100", author: bia, content: "100" } };
    let state = chatReducer(ready(), { type: "history", channelId: "20", messages: [msg("100", bia), reply], mode: "latest", pageSize: 50 });
    const renamed: User = { ...bia, displayName: "Bia Souza" };
    state = chatReducer(state, { type: "dispatch", event: { t: "USER_UPDATE", d: renamed }, now: 0 });
    expect(state.members["10"]?.["2"]?.user.displayName).toBe("Bia Souza");
    expect(state.messages["20"]?.items[0]?.author.displayName).toBe("Bia Souza");
    expect(state.messages["20"]?.items[1]?.replyTo?.author?.displayName).toBe("Bia Souza");
    expect(state.messages["20"]?.items[1]?.author).toBe(ana); // mensagem de outra pessoa intacta

    state = chatReducer(state, { type: "dispatch", event: { t: "USER_UPDATE", d: { ...ana, displayName: "Ana Clara" } }, now: 0 });
    expect(state.me?.displayName).toBe("Ana Clara");
  });

  it("cargos: minhas permissões mudam ao vivo; cargo excluído sai de quem tinha", () => {
    let state = chatReducer(initialChatState, { type: "ready", user: bia, guilds: [guild] });
    expect(hasPermission(myPermissions(state, "10"), "KICK_MEMBERS")).toBe(true);
    const dispatch = (s: ChatState, event: Extract<Parameters<typeof chatReducer>[1], { type: "dispatch" }>["event"]) => chatReducer(s, { type: "dispatch", event, now: 0 });
    state = dispatch(state, { t: "MEMBER_UPDATE", d: { guildId: "10", userId: "2", roles: [] } });
    expect(hasPermission(myPermissions(state, "10"), "KICK_MEMBERS")).toBe(false);
    state = dispatch(state, { t: "MEMBER_UPDATE", d: { guildId: "10", userId: "2", roles: ["50"] } });
    state = dispatch(state, { t: "GUILD_ROLES_UPDATE", d: { guildId: "10", roles: [guild.roles[0]!] } });
    expect(state.members["10"]?.["2"]?.roles).toEqual([]);
    expect(state.guilds["10"]?.roles.map((r) => r.name)).toEqual(["@todos"]);
    expect(myPermissions(state, "10")).toBe(DEFAULT_EVERYONE_PERMISSIONS);
  });

  it("permissões por canal: canal só de leitura, liberado só para mim; castigo vale até a hora marcada", () => {
    let state = chatReducer(initialChatState, { type: "ready", user: bia, guilds: [guild] });
    const dispatch = (s: ChatState, event: Extract<Parameters<typeof chatReducer>[1], { type: "dispatch" }>["event"]) => chatReducer(s, { type: "dispatch", event, now: 0 });
    const readOnly = { id: "20", guildId: "10", type: "text" as const, name: "geral", position: 0, overwrites: [{ targetType: "role" as const, targetId: "10", allow: 0, deny: PERMISSIONS.SEND_MESSAGES }] };
    state = dispatch(state, { t: "CHANNEL_UPDATE", d: readOnly });
    expect(hasPermission(myChannelPermissions(state, "20"), "SEND_MESSAGES")).toBe(false);
    expect(hasPermission(myChannelPermissions(state, "21"), "SEND_MESSAGES")).toBe(true);
    state = dispatch(state, { t: "CHANNEL_UPDATE", d: { ...readOnly, overwrites: [...readOnly.overwrites, { targetType: "member", targetId: "2", allow: PERMISSIONS.SEND_MESSAGES, deny: 0 }] } });
    expect(hasPermission(myChannelPermissions(state, "20"), "SEND_MESSAGES")).toBe(true);

    state = dispatch(state, { t: "MEMBER_UPDATE", d: { guildId: "10", userId: "2", roles: ["50"], timeoutUntil: 5_000 } });
    expect(myTimeout(state, "10", 1_000)).toBe(5_000);
    expect(myChannelPermissions(state, "21", 1_000)).toBe(PERMISSIONS.VIEW_CHANNEL);
    expect(hasPermission(myPermissions(state, "10", 1_000), "CREATE_INVITE")).toBe(false);
    expect(hasPermission(myChannelPermissions(state, "21", 5_000), "SEND_MESSAGES")).toBe(true); // acabou
    // MEMBER_UPDATE de cargo (servidor antigo, sem o campo) não apaga o castigo
    state = dispatch(state, { t: "MEMBER_UPDATE", d: { guildId: "10", userId: "2", roles: [] } });
    expect(myTimeout(state, "10", 1_000)).toBe(5_000);
  });

  it("voz: silêncio de moderador chega no estado; deixar de ver a sala some com quem está nela", () => {
    let state = ready();
    const dispatch = (s: ChatState, event: Extract<Parameters<typeof chatReducer>[1], { type: "dispatch" }>["event"]) => chatReducer(s, { type: "dispatch", event, now: 0 });
    state = dispatch(state, { t: "VOICE_STATE_UPDATE", d: { guildId: "10", userId: "2", channelId: "30", muted: true, deafened: false, streaming: false, serverMuted: true } });
    expect(state.voice["10"]?.["2"]?.serverMuted).toBe(true);
    state = dispatch(state, { t: "CHANNEL_DELETE", d: { id: "30", guildId: "10" } });
    expect(state.voice["10"]?.["2"]).toBeUndefined();
    expect(chatReducer(state, { type: "dispatch", event: { t: "VOICE_MOVE", d: { guildId: "10", channelId: null } }, now: 0 })).toBe(state); // o ChatApp é quem age
  });

  it("conversas diretas: toda mensagem conta como menção, a lista anda para a mais recente; sair some com tudo", () => {
    const dm = { id: "70", type: "dm" as const, name: null, ownerId: null, recipients: [bia], lastMessageId: null };
    const group = { id: "71", type: "group_dm" as const, name: null, ownerId: "1", recipients: [bia, { id: "3", username: "caio", displayName: "Caio" }], lastMessageId: null };
    let state = chatReducer(initialChatState, { type: "ready", user: ana, guilds: [guild], privateChannels: [dm, group], relationships: [{ user: bia, type: "friend", since: 0, online: false }] });
    expect(dmName(group)).toBe("Bia, Caio");
    state = create(state, msg("500", bia, "70", "oi"));
    expect(mentionCountOf(state, "70")).toBe(1); // sem @, mas é conversa direta
    expect(dmMentionTotal(state)).toBe(1);
    state = create(state, msg("501", bia, "71", "grupo"));
    expect(dmList(state).map((d) => d.id)).toEqual(["71", "70"]);
    const dispatch = (s: ChatState, event: Extract<Parameters<typeof chatReducer>[1], { type: "dispatch" }>["event"]) => chatReducer(s, { type: "dispatch", event, now: 0 });
    state = dispatch(state, { t: "PRESENCE_UPDATE", d: { userId: "2", online: true } });
    expect(state.relationships["2"]?.online).toBe(true);
    state = dispatch(state, { t: "USER_UPDATE", d: { ...bia, displayName: "Bia Souza" } });
    expect(state.dms["70"]?.recipients[0]?.displayName).toBe("Bia Souza");
    expect(state.relationships["2"]?.user.displayName).toBe("Bia Souza");
    state = dispatch(state, { t: "RELATIONSHIP_UPDATE", d: { user: bia, type: "blocked", since: 1, online: false } });
    expect(isBlocked(state, "2")).toBe(true);
    state = dispatch(state, { t: "DM_CHANNEL_DELETE", d: { id: "71" } });
    expect(state.dms["71"]).toBeUndefined();
    expect(state.reads["71"]).toBeUndefined();
    state = dispatch(state, { t: "RELATIONSHIP_UPDATE", d: { user: bia, type: null, since: 2, online: false } });
    expect(state.relationships["2"]).toBeUndefined();
  });

  it("status: ausente, não perturbe e personalizado chegam ao vivo; servidor antigo (só online) continua funcionando", () => {
    let state = ready();
    const dispatch = (s: ChatState, event: Extract<Parameters<typeof chatReducer>[1], { type: "dispatch" }>["event"]) => chatReducer(s, { type: "dispatch", event, now: 0 });
    const custom = { text: "Estudando", emoji: "📚", expiresAt: null };
    state = dispatch(state, { t: "PRESENCE_UPDATE", d: { userId: "2", online: true, status: "dnd", customStatus: custom } });
    expect(presenceOf(state, "2")).toEqual({ status: "dnd", customStatus: custom });
    expect(state.members["10"]?.["2"]?.online).toBe(true);
    state = dispatch(state, { t: "PRESENCE_UPDATE", d: { userId: "2", online: false } }); // servidor antigo
    expect(presenceOf(state, "2")).toEqual({ status: "offline", customStatus: null });
    state = dispatch(state, { t: "USER_SETTINGS_UPDATE", d: { dmPolicy: "friends", status: "invisible", customStatus: null } });
    expect(state.settings).toEqual({ dmPolicy: "friends", status: "invisible", customStatus: null });
    expect(presenceOf(state, "999")).toEqual({ status: "offline", customStatus: null });
  });

  it("canal renomeado e apagado; servidor renomeado; expulsão de outra pessoa e a minha", () => {
    let state = create(ready(), msg("100", bia));
    const dispatch = (s: ChatState, event: Extract<Parameters<typeof chatReducer>[1], { type: "dispatch" }>["event"]) => chatReducer(s, { type: "dispatch", event, now: 0 });
    state = dispatch(state, { t: "CHANNEL_UPDATE", d: { id: "21", guildId: "10", type: "text", name: "arte", position: 1, overwrites: [] } });
    expect(state.channels["21"]?.name).toBe("arte");
    state = dispatch(state, { t: "CHANNEL_DELETE", d: { id: "21", guildId: "10" } });
    expect(state.channels["21"]).toBeUndefined();
    expect(state.guilds["10"]?.channelIds).not.toContain("21");
    state = dispatch(state, { t: "GUILD_UPDATE", d: { id: "10", name: "Aurora Turma" } });
    expect(state.guilds["10"]?.name).toBe("Aurora Turma");
    state = dispatch(state, { t: "MEMBER_REMOVE", d: { guildId: "10", userId: "2" } });
    expect(state.members["10"]?.["2"]).toBeUndefined();
    expect(state.voice["10"]?.["2"]).toBeUndefined(); // saiu da voz junto
    state = dispatch(state, { t: "GUILD_DELETE", d: { id: "10" } });
    expect(state.guilds["10"]).toBeUndefined();
    expect(state.guildOrder).toEqual([]);
    expect(state.channels["20"]).toBeUndefined();
    expect(state.reads["20"]).toBeUndefined();
  });

  it("evento desconhecido (servidor mais novo) não quebra o estado", () => {
    const state = ready();
    expect(chatReducer(state, { type: "dispatch", event: { t: "ALGO_NOVO", d: {} } as never, now: 0 })).toBe(state);
  });

  it("histórico + eventos não duplicam e ficam em ordem", () => {
    let state = chatReducer(ready(), { type: "history", channelId: "20", messages: [msg("5", ana), msg("6", bia)], mode: "latest", pageSize: 50 });
    state = chatReducer(state, { type: "messageUpsert", message: msg("7", ana) });
    state = chatReducer(state, { type: "dispatch", event: { t: "MESSAGE_CREATE", d: msg("7", ana) }, now: 0 });
    state = chatReducer(state, { type: "history", channelId: "20", messages: [msg("3", bia), msg("4", ana)], mode: "older", pageSize: 2 });
    const bucket = state.messages["20"]!;
    expect(bucket.items.map((m) => m.id)).toEqual(["3", "4", "5", "6", "7"]);
    expect(bucket.hasMore).toBe(true);
  });

  it("edita e apaga mensagens carregadas", () => {
    let state = chatReducer(ready(), { type: "history", channelId: "20", messages: [msg("5", ana)], mode: "latest", pageSize: 50 });
    state = chatReducer(state, { type: "dispatch", event: { t: "MESSAGE_UPDATE", d: { ...msg("5", ana), content: "novo", editedAt: 9 } }, now: 0 });
    expect(state.messages["20"]!.items[0]!.content).toBe("novo");
    state = chatReducer(state, { type: "dispatch", event: { t: "MESSAGE_DELETE", d: { id: "5", channelId: "20" } }, now: 0 });
    expect(state.messages["20"]!.items).toHaveLength(0);
  });

  it("digitando expira e some quando a pessoa envia", () => {
    let state = chatReducer(ready(), { type: "dispatch", event: { t: "TYPING_START", d: { channelId: "20", userId: "2" } }, now: 1000 });
    expect(state.typing["20"]?.["2"]).toBe(1000 + TYPING_TTL_MS);
    state = chatReducer(state, { type: "typingExpire", now: 1000 + TYPING_TTL_MS + 1 });
    expect(state.typing["20"]).toBeUndefined();

    state = chatReducer(state, { type: "dispatch", event: { t: "TYPING_START", d: { channelId: "20", userId: "2" } }, now: 0 });
    state = chatReducer(state, { type: "dispatch", event: { t: "MESSAGE_CREATE", d: msg("8", bia) }, now: 0 });
    expect(state.typing["20"]?.["2"]).toBeUndefined();
  });

  it("ignora o próprio 'digitando' e atualiza presença e canais novos", () => {
    let state = chatReducer(ready(), { type: "dispatch", event: { t: "TYPING_START", d: { channelId: "20", userId: "1" } }, now: 0 });
    expect(state.typing["20"]).toBeUndefined();
    state = chatReducer(state, { type: "dispatch", event: { t: "PRESENCE_UPDATE", d: { userId: "2", online: true } }, now: 0 });
    expect(state.members["10"]?.["2"]?.online).toBe(true);
    state = chatReducer(state, { type: "dispatch", event: { t: "CHANNEL_CREATE", d: { id: "22", guildId: "10", type: "text", name: "off", position: 3, overwrites: [] } }, now: 0 });
    expect(state.guilds["10"]?.channelIds).toEqual(["20", "21", "30", "22"]);
  });

  it("reconexão (READY sem leitura, servidor antigo) descarta o cache de mensagens mas mantém não lidas", () => {
    let state = chatReducer(ready(), { type: "history", channelId: "20", messages: [msg("5", ana)], mode: "latest", pageSize: 50 });
    state = create(state, msg("6", bia, "21"));
    state = chatReducer(state, { type: "ready", user: ana, guilds: [guild] });
    expect(state.messages["20"]).toBeUndefined();
    expect(isUnread(state, "21")).toBe(true);
  });
});
