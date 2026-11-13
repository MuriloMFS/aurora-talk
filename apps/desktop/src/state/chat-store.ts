import { useSyncExternalStore } from "react";
import {
  applyTimeout,
  byPositionDesc,
  computeChannelPermissions,
  computePermissions,
  type Channel,
  type DispatchEvent,
  type DmChannel,
  type Relationship,
  type UserSettings,
  type CustomStatus,
  type PresenceStatus,
  type Guild,
  type Id,
  type Member,
  type Message,
  type ReadState,
  type Role,
  type User,
  type VoiceState,
} from "@aurora/schema";
import type { ConnectionStatus } from "../net/gateway";

export const TYPING_TTL_MS = 8_000;

export interface GuildEntry {
  id: Id;
  name: string;
  ownerId: Id;
  channelIds: Id[];
  /** Do mais alto para o mais baixo; o @todos (id = id do servidor) por último. */
  roles: Role[];
}

export interface ChannelMessages {
  items: Message[];
  hasMore: boolean;
  loaded: boolean;
}

/** Leitura de um canal (vem do servidor no READY e é mantida ao vivo). */
export interface ReadInfo {
  lastReadId: Id;
  lastMessageId: Id | null;
  mentionCount: number;
}

export interface ChatState {
  me: User | null;
  status: ConnectionStatus;
  guildOrder: Id[];
  guilds: Record<Id, GuildEntry>;
  channels: Record<Id, Channel>;
  members: Record<Id, Record<Id, Member>>;
  messages: Record<Id, ChannelMessages>;
  typing: Record<Id, Record<Id, number>>;
  /** channelId → leitura. Canal sem entrada = nada não lido conhecido. */
  reads: Record<Id, ReadInfo>;
  activeChannelId: Id | null;
  /** A janela do app está em foco? Só assim o canal aberto conta como lido. */
  focused: boolean;
  /** guildId → userId → quem está em qual canal de voz. */
  voice: Record<Id, Record<Id, VoiceState>>;
  /** Conversas diretas abertas (as mensagens e a leitura ficam em `messages`/`reads`, como os canais). */
  dms: Record<Id, DmChannel>;
  /** Amigos, pedidos e bloqueios, por id da outra pessoa. */
  relationships: Record<Id, Relationship>;
  settings: UserSettings;
}

export type ChatAction =
  | { type: "status"; status: ConnectionStatus }
  | { type: "ready"; user: User; guilds: Guild[]; readStates?: ReadState[]; privateChannels?: DmChannel[]; relationships?: Relationship[]; settings?: UserSettings }
  | { type: "dispatch"; event: DispatchEvent; now: number }
  | { type: "guildUpsert"; guild: Guild }
  | { type: "channelUpsert"; channel: Channel }
  | { type: "messageUpsert"; message: Message }
  | { type: "history"; channelId: Id; messages: Message[]; mode: "latest" | "older"; pageSize: number }
  | { type: "focusChannel"; channelId: Id | null }
  | { type: "windowFocus"; focused: boolean }
  | { type: "typingExpire"; now: number }
  | { type: "settings"; settings: UserSettings };

export const initialChatState: ChatState = {
  me: null,
  status: "connecting",
  guildOrder: [],
  guilds: {},
  channels: {},
  members: {},
  messages: {},
  typing: {},
  reads: {},
  activeChannelId: null,
  focused: true,
  voice: {},
  dms: {},
  relationships: {},
  settings: { dmPolicy: "servers" },
};

const byId = (a: { id: Id }, b: { id: Id }) => Number(a.id) - Number(b.id);
/** IDs são números ordenados no tempo (≤ 2^53), guardados como texto. */
const newer = (a: Id | null | undefined, b: Id | null | undefined) => Number(a ?? 0) > Number(b ?? 0);

export const isUnread = (state: ChatState, channelId: Id): boolean => {
  const read = state.reads[channelId];
  return Boolean(read && newer(read.lastMessageId, read.lastReadId));
};
export const mentionCountOf = (state: ChatState, channelId: Id): number => state.reads[channelId]?.mentionCount ?? 0;

/** Conversas diretas, da mais recente para a mais antiga. */
export const dmList = (state: ChatState): DmChannel[] =>
  Object.values(state.dms).sort((a, b) => Number(b.lastMessageId ?? b.id) - Number(a.lastMessageId ?? a.id));

/** Nome da conversa: o do grupo, ou o nome das pessoas. */
export const dmName = (dm: DmChannel): string =>
  dm.name ?? (dm.recipients.length > 0 ? dm.recipients.map((u) => u.displayName).join(", ") : "Grupo vazio");

/** Mensagens diretas não lidas (todas contam como menção): selo do botão Início. */
export const dmMentionTotal = (state: ChatState): number => Object.keys(state.dms).reduce((sum, id) => sum + mentionCountOf(state, id), 0);

export const isBlocked = (state: ChatState, userId: Id): boolean => state.relationships[userId]?.type === "blocked";

/** Presença vinda do servidor (servidor antigo só manda `online`). */
function presenceFields(d: { online: boolean; status?: PresenceStatus; customStatus?: CustomStatus | null }) {
  return { online: d.online, status: d.status ?? (d.online ? "online" : "offline"), customStatus: d.customStatus ?? null } as const;
}

/** Como uma pessoa aparece: membro de algum servidor ou amigo (o primeiro que souber). */
export function presenceOf(state: ChatState, userId: Id): { status: PresenceStatus; customStatus: CustomStatus | null } {
  const rel = state.relationships[userId];
  if (rel && rel.type !== "blocked") return { status: rel.status ?? (rel.online ? "online" : "offline"), customStatus: rel.customStatus ?? null };
  for (const members of Object.values(state.members)) {
    const m = members[userId];
    if (m) return { status: m.status ?? (m.online ? "online" : "offline"), customStatus: m.customStatus ?? null };
  }
  return { status: "offline", customStatus: null };
}

/** Minhas permissões neste servidor (o servidor confere de novo; aqui só serve para esconder o que não posso). */
export function myPermissions(state: ChatState, guildId: Id, now: number = Date.now()): number {
  const guild = state.guilds[guildId];
  const me = state.me;
  if (!guild || !me) return 0;
  const member = state.members[guildId]?.[me.id];
  return applyTimeout(computePermissions({ guildId, ownerId: guild.ownerId, roles: guild.roles }, me.id, member?.roles ?? []), member?.timeoutUntil, now);
}

/** Minhas permissões neste canal (sobrescritas e castigo incluídos). */
export function myChannelPermissions(state: ChatState, channelId: Id, now: number = Date.now()): number {
  const channel = state.channels[channelId];
  const guild = channel ? state.guilds[channel.guildId] : undefined;
  const me = state.me;
  if (!channel || !guild || !me) return 0;
  const member = state.members[guild.id]?.[me.id];
  return computeChannelPermissions({ guildId: guild.id, ownerId: guild.ownerId, roles: guild.roles }, me.id, member?.roles ?? [], channel.overwrites ?? [], member?.timeoutUntil ?? null, now);
}

/** Fim do meu castigo neste servidor (ou `null`). */
export function myTimeout(state: ChatState, guildId: Id, now: number = Date.now()): number | null {
  const until = state.me ? state.members[guildId]?.[state.me.id]?.timeoutUntil : null;
  return until != null && until > now ? until : null;
}

function mergeMessages(current: Message[], incoming: Message[]): Message[] {
  const map = new Map(current.map((m) => [m.id, m]));
  for (const m of incoming) map.set(m.id, m);
  return [...map.values()].sort(byId);
}

/** O canal está sendo visto agora (aberto e com a janela em foco)? */
const isWatching = (state: ChatState, channelId: Id) => state.focused && state.activeChannelId === channelId;

/** Marca como lido até a última mensagem conhecida (só no app; quem avisa o servidor é o ChatApp). */
function markRead(state: ChatState, channelId: Id | null): ChatState {
  if (!channelId) return state;
  const read = state.reads[channelId];
  if (!read || (!newer(read.lastMessageId, read.lastReadId) && read.mentionCount === 0)) return state;
  return { ...state, reads: { ...state.reads, [channelId]: { ...read, lastReadId: read.lastMessageId ?? read.lastReadId, mentionCount: 0 } } };
}

function withGuild(state: ChatState, guild: Guild): ChatState {
  const channels = { ...state.channels };
  for (const channel of guild.channels) channels[channel.id] = { ...channel, overwrites: channel.overwrites ?? [] };
  const members: Record<Id, Member> = {};
  for (const member of guild.members) members[member.user.id] = { ...member, roles: member.roles ?? [] };
  const voice: Record<Id, VoiceState> = {};
  for (const state of guild.voiceStates ?? []) voice[state.userId] = state;
  return {
    ...state,
    guildOrder: state.guildOrder.includes(guild.id) ? state.guildOrder : [...state.guildOrder, guild.id],
    guilds: {
      ...state.guilds,
      [guild.id]: {
        id: guild.id,
        name: guild.name,
        ownerId: guild.ownerId,
        channelIds: [...guild.channels].sort((a, b) => a.position - b.position || byId(a, b)).map((c) => c.id),
        roles: [...(guild.roles ?? [])].sort(byPositionDesc),
      },
    },
    channels,
    members: { ...state.members, [guild.id]: members },
    voice: { ...state.voice, [guild.id]: voice },
  };
}

/** Nome de exibição novo: vale para mim, para a lista de membros e para as mensagens já carregadas. */
function withUser(state: ChatState, user: User): ChatState {
  const members: ChatState["members"] = {};
  for (const [guildId, byUser] of Object.entries(state.members)) {
    const member = byUser[user.id];
    members[guildId] = member ? { ...byUser, [user.id]: { ...member, user } } : byUser;
  }
  const messages: ChatState["messages"] = {};
  for (const [channelId, bucket] of Object.entries(state.messages)) {
    let changed = false;
    const items = bucket.items.map((message) => {
      const author = message.author.id === user.id ? user : message.author;
      const replyTo = message.replyTo?.author?.id === user.id ? { ...message.replyTo, author: user } : message.replyTo;
      if (author === message.author && replyTo === message.replyTo) return message;
      changed = true;
      return { ...message, author, replyTo };
    });
    messages[channelId] = changed ? { ...bucket, items } : bucket;
  }
  const rel = state.relationships[user.id];
  const relationships = rel ? { ...state.relationships, [user.id]: { ...rel, user } } : state.relationships;
  const dms = Object.fromEntries(
    Object.entries(state.dms).map(([id, dm]) => [id, dm.recipients.some((r) => r.id === user.id) ? { ...dm, recipients: dm.recipients.map((r) => (r.id === user.id ? user : r)) } : dm]),
  );
  return { ...state, me: state.me?.id === user.id ? user : state.me, members, messages, relationships, dms };
}

/** Tira canais do estado (canal apagado ou servidor que saiu da minha lista), com mensagens e leituras. */
function withoutChannels(state: ChatState, channelIds: readonly Id[]): ChatState {
  if (channelIds.length === 0) return state;
  const drop = new Set(channelIds);
  const keep = <T,>(record: Record<Id, T>) => Object.fromEntries(Object.entries(record).filter(([id]) => !drop.has(id)));
  return { ...state, channels: keep(state.channels), messages: keep(state.messages), reads: keep(state.reads), typing: keep(state.typing) };
}

/** Servidor apagado, ou eu saí/fui expulso/banido: some tudo dele. */
function withoutGuild(state: ChatState, guildId: Id): ChatState {
  const guild = state.guilds[guildId];
  if (!guild) return state;
  const next = withoutChannels(state, guild.channelIds);
  const { [guildId]: _guild, ...guilds } = next.guilds;
  const { [guildId]: _members, ...members } = next.members;
  const { [guildId]: _voice, ...voice } = next.voice;
  return { ...next, guilds, members, voice, guildOrder: next.guildOrder.filter((id) => id !== guildId) };
}

function withChannel(state: ChatState, channel: Channel): ChatState {
  const guild = state.guilds[channel.guildId];
  if (!guild) return state;
  const channels = { ...state.channels, [channel.id]: { ...channel, overwrites: channel.overwrites ?? [] } };
  const channelIds = guild.channelIds.includes(channel.id)
    ? guild.channelIds
    : [...guild.channelIds, channel.id].sort((a, b) => (channels[a]?.position ?? 0) - (channels[b]?.position ?? 0));
  return { ...state, channels, guilds: { ...state.guilds, [guild.id]: { ...guild, channelIds } } };
}

function withMessage(state: ChatState, message: Message): ChatState {
  const bucket = state.messages[message.channelId];
  const known = bucket?.items.some((m) => m.id === message.id) ?? false;
  const messages = bucket?.loaded
    ? { ...state.messages, [message.channelId]: { ...bucket, items: mergeMessages(bucket.items, [message]) } }
    : state.messages;

  // Leitura: o que eu escrevo e o que chega no canal que estou vendo já está lido.
  const read = state.reads[message.channelId] ?? { lastReadId: "0", lastMessageId: null, mentionCount: 0 };
  const lastMessageId = newer(message.id, read.lastMessageId) ? message.id : read.lastMessageId;
  const mine = message.author.id === state.me?.id;
  let nextRead: ReadInfo;
  if (mine || isWatching(state, message.channelId)) {
    nextRead = { lastReadId: newer(lastMessageId, read.lastReadId) ? lastMessageId! : read.lastReadId, lastMessageId, mentionCount: mine ? 0 : read.mentionCount };
  } else {
    const isDm = message.channelId in state.dms;
    const mentionsMe = !known && newer(message.id, read.lastReadId) && state.me !== null && (isDm || message.mentions.includes(state.me.id));
    nextRead = { ...read, lastMessageId, mentionCount: read.mentionCount + (mentionsMe ? 1 : 0) };
  }

  const channelTyping = state.typing[message.channelId];
  const typing =
    channelTyping && message.author.id in channelTyping
      ? { ...state.typing, [message.channelId]: Object.fromEntries(Object.entries(channelTyping).filter(([id]) => id !== message.author.id)) }
      : state.typing;
  const dm = state.dms[message.channelId];
  const dms = dm && newer(message.id, dm.lastMessageId) ? { ...state.dms, [dm.id]: { ...dm, lastMessageId: message.id } } : state.dms;
  return { ...state, messages, reads: { ...state.reads, [message.channelId]: nextRead }, typing, dms };
}

/** Aplica uma mudança a uma mensagem já carregada (reações etc.). */
function updateMessage(state: ChatState, channelId: Id, messageId: Id, change: (message: Message) => Message): ChatState {
  const bucket = state.messages[channelId];
  if (!bucket?.items.some((m) => m.id === messageId)) return state;
  return { ...state, messages: { ...state.messages, [channelId]: { ...bucket, items: bucket.items.map((m) => (m.id === messageId ? change(m) : m)) } } };
}

function withReaction(message: Message, emoji: string, userId: Id, add: boolean): Message {
  const existing = message.reactions.find((r) => r.emoji === emoji);
  if (add) {
    if (existing?.userIds.includes(userId)) return message;
    const reactions = existing
      ? message.reactions.map((r) => (r.emoji === emoji ? { ...r, userIds: [...r.userIds, userId] } : r))
      : [...message.reactions, { emoji, userIds: [userId] }];
    return { ...message, reactions };
  }
  if (!existing?.userIds.includes(userId)) return message;
  const reactions = message.reactions
    .map((r) => (r.emoji === emoji ? { ...r, userIds: r.userIds.filter((id) => id !== userId) } : r))
    .filter((r) => r.userIds.length > 0);
  return { ...message, reactions };
}

function applyDispatch(state: ChatState, event: DispatchEvent, now: number): ChatState {
  switch (event.t) {
    case "GUILD_CREATE":
      return withGuild(state, event.d);
    case "CHANNEL_CREATE":
      return withChannel(state, event.d);
    case "MEMBER_ADD": {
      const members = state.members[event.d.guildId];
      if (!members) return state;
      return { ...state, members: { ...state.members, [event.d.guildId]: { ...members, [event.d.member.user.id]: event.d.member } } };
    }
    case "PRESENCE_UPDATE": {
      const members = { ...state.members };
      for (const [guildId, guildMembers] of Object.entries(members)) {
        const member = guildMembers[event.d.userId];
        if (member) members[guildId] = { ...guildMembers, [event.d.userId]: { ...member, ...presenceFields(event.d) } };
      }
      const rel = state.relationships[event.d.userId];
      const relationships = rel && rel.type !== "blocked" ? { ...state.relationships, [rel.user.id]: { ...rel, ...presenceFields(event.d) } } : state.relationships;
      return { ...state, members, relationships };
    }
    case "MESSAGE_CREATE":
      return withMessage(state, event.d);
    case "MESSAGE_UPDATE":
      return updateMessage(state, event.d.channelId, event.d.id, () => event.d);
    case "MESSAGE_DELETE": {
      const bucket = state.messages[event.d.channelId];
      if (!bucket) return state;
      return { ...state, messages: { ...state.messages, [event.d.channelId]: { ...bucket, items: bucket.items.filter((m) => m.id !== event.d.id) } } };
    }
    case "MESSAGE_REACTION_ADD":
    case "MESSAGE_REACTION_REMOVE": {
      const { channelId, messageId, userId, emoji } = event.d;
      return updateMessage(state, channelId, messageId, (m) => withReaction(m, emoji, userId, event.t === "MESSAGE_REACTION_ADD"));
    }
    case "READ_STATE_UPDATE": {
      // Li em outro aparelho/aba.
      const read = state.reads[event.d.channelId];
      if (!read || !newer(event.d.lastReadId, read.lastReadId)) return state;
      const caughtUp = !newer(read.lastMessageId, event.d.lastReadId);
      return { ...state, reads: { ...state.reads, [event.d.channelId]: { ...read, lastReadId: event.d.lastReadId, mentionCount: caughtUp ? 0 : read.mentionCount } } };
    }
    case "TYPING_START": {
      if (event.d.userId === state.me?.id) return state;
      const channelTyping = { ...state.typing[event.d.channelId], [event.d.userId]: now + TYPING_TTL_MS };
      return { ...state, typing: { ...state.typing, [event.d.channelId]: channelTyping } };
    }
    case "USER_UPDATE":
      return withUser(state, event.d);
    case "USER_SETTINGS_UPDATE":
      return { ...state, settings: { ...state.settings, ...event.d } };
    case "RELATIONSHIP_UPDATE": {
      const { [event.d.user.id]: _old, ...rest } = state.relationships;
      const relationships = event.d.type === null ? rest : { ...rest, [event.d.user.id]: { user: event.d.user, type: event.d.type, since: event.d.since, online: event.d.online } };
      return { ...state, relationships };
    }
    case "DM_CHANNEL_CREATE":
    case "DM_CHANNEL_UPDATE":
      return { ...state, dms: { ...state.dms, [event.d.id]: event.d } };
    case "DM_CHANNEL_DELETE": {
      if (!state.dms[event.d.id]) return state;
      const { [event.d.id]: _gone, ...dms } = state.dms;
      return { ...withoutChannels(state, [event.d.id]), dms };
    }
    case "GUILD_UPDATE": {
      const guild = state.guilds[event.d.id];
      return guild ? { ...state, guilds: { ...state.guilds, [guild.id]: { ...guild, name: event.d.name } } } : state;
    }
    case "GUILD_DELETE":
      return withoutGuild(state, event.d.id);
    case "GUILD_ROLES_UPDATE": {
      const guild = state.guilds[event.d.guildId];
      if (!guild) return state;
      const roles = [...event.d.roles].sort(byPositionDesc);
      const alive = new Set(roles.map((r) => r.id));
      // cargo excluído: sai também de quem o tinha
      const members = Object.fromEntries(
        Object.entries(state.members[guild.id] ?? {}).map(([id, m]) => [id, m.roles.every((r) => alive.has(r)) ? m : { ...m, roles: m.roles.filter((r) => alive.has(r)) }]),
      );
      return { ...state, guilds: { ...state.guilds, [guild.id]: { ...guild, roles } }, members: { ...state.members, [guild.id]: members } };
    }
    case "MEMBER_UPDATE": {
      const member = state.members[event.d.guildId]?.[event.d.userId];
      if (!member) return state;
      const timeoutUntil = event.d.timeoutUntil === undefined ? member.timeoutUntil : event.d.timeoutUntil;
      return { ...state, members: { ...state.members, [event.d.guildId]: { ...state.members[event.d.guildId], [event.d.userId]: { ...member, roles: event.d.roles, timeoutUntil } } } };
    }
    case "MEMBER_REMOVE": {
      if (event.d.userId === state.me?.id) return withoutGuild(state, event.d.guildId);
      const guildMembers = state.members[event.d.guildId];
      if (!guildMembers?.[event.d.userId]) return state;
      const { [event.d.userId]: _removed, ...rest } = guildMembers;
      const { [event.d.userId]: _voice, ...voice } = state.voice[event.d.guildId] ?? {};
      return { ...state, members: { ...state.members, [event.d.guildId]: rest }, voice: { ...state.voice, [event.d.guildId]: voice } };
    }
    case "CHANNEL_UPDATE":
      return state.channels[event.d.id] ? withChannel(state, event.d) : state;
    case "CHANNEL_DELETE": {
      // canal apagado, ou deixei de ver (canal privado): some com quem estava na voz dele
      const guild = state.guilds[event.d.guildId];
      if (!guild) return state;
      const next = withoutChannels(state, [event.d.id]);
      const voice = Object.fromEntries(Object.entries(state.voice[guild.id] ?? {}).filter(([, v]) => v.channelId !== event.d.id));
      return {
        ...next,
        guilds: { ...next.guilds, [guild.id]: { ...guild, channelIds: guild.channelIds.filter((id) => id !== event.d.id) } },
        voice: { ...next.voice, [guild.id]: voice },
      };
    }
    case "VOICE_STATE_UPDATE": {
      const { guildId, userId, channelId, muted, deafened, streaming, serverMuted } = event.d;
      const guildVoice = { ...state.voice[guildId] };
      if (channelId === null) delete guildVoice[userId];
      else guildVoice[userId] = { userId, channelId, muted, deafened, streaming, serverMuted: serverMuted ?? false };
      return { ...state, voice: { ...state.voice, [guildId]: guildVoice } };
    }
    default:
      return state; // evento de uma versão mais nova do servidor: ignorar, nunca quebrar
  }
}

export function chatReducer(state: ChatState, action: ChatAction): ChatState {
  switch (action.type) {
    case "status":
      return action.status === state.status ? state : { ...state, status: action.status };
    case "ready": {
      // Reconexão: refaz servidores/canais/membros e descarta o cache de mensagens (pode ter perdido eventos).
      const reads = action.readStates
        ? Object.fromEntries(action.readStates.map((r) => [r.channelId, { lastReadId: r.lastReadId, lastMessageId: r.lastMessageId, mentionCount: r.mentionCount }]))
        : state.reads;
      let next: ChatState = {
        ...initialChatState,
        me: action.user,
        status: "ready",
        reads,
        activeChannelId: state.activeChannelId,
        focused: state.focused,
        dms: Object.fromEntries((action.privateChannels ?? []).map((dm) => [dm.id, dm])),
        relationships: Object.fromEntries((action.relationships ?? []).map((r) => [r.user.id, r])),
        settings: action.settings ?? initialChatState.settings,
      };
      for (const guild of action.guilds) next = withGuild(next, guild);
      return state.focused ? markRead(next, state.activeChannelId) : next;
    }
    case "dispatch":
      return applyDispatch(state, action.event, action.now);
    case "guildUpsert":
      return withGuild(state, action.guild);
    case "channelUpsert":
      return withChannel(state, action.channel);
    case "messageUpsert":
      return withMessage(state, action.message);
    case "history": {
      const bucket = state.messages[action.channelId];
      const items = mergeMessages(action.mode === "older" ? (bucket?.items ?? []) : (bucket?.loaded ? bucket.items : []), action.messages);
      const hasMore = action.messages.length >= action.pageSize;
      return { ...state, messages: { ...state.messages, [action.channelId]: { items, loaded: true, hasMore } } };
    }
    case "focusChannel": {
      const next = action.channelId === state.activeChannelId ? state : { ...state, activeChannelId: action.channelId };
      return next.focused ? markRead(next, action.channelId) : next;
    }
    case "windowFocus": {
      if (action.focused === state.focused) return state;
      const next = { ...state, focused: action.focused };
      return action.focused ? markRead(next, state.activeChannelId) : next;
    }
    case "settings":
      return { ...state, settings: action.settings };
    case "typingExpire": {
      let changed = false;
      const typing: ChatState["typing"] = {};
      for (const [channelId, users] of Object.entries(state.typing)) {
        const alive = Object.fromEntries(Object.entries(users).filter(([, until]) => until > action.now));
        if (Object.keys(alive).length !== Object.keys(users).length) changed = true;
        if (Object.keys(alive).length > 0) typing[channelId] = alive;
      }
      return changed ? { ...state, typing } : state;
    }
  }
}

export interface ChatStore {
  getState(): ChatState;
  dispatch(action: ChatAction): void;
  subscribe(listener: () => void): () => void;
}

export function createChatStore(): ChatStore {
  let state = initialChatState;
  const listeners = new Set<() => void>();
  return {
    getState: () => state,
    dispatch(action) {
      const next = chatReducer(state, action);
      if (next === state) return;
      state = next;
      for (const listener of listeners) listener();
    },
    subscribe(listener) {
      listeners.add(listener);
      return () => listeners.delete(listener);
    },
  };
}

export function useChatState(store: ChatStore): ChatState {
  return useSyncExternalStore(store.subscribe, store.getState);
}
