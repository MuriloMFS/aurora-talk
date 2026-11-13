import { useSyncExternalStore } from "react";
import type { Channel, DispatchEvent, Guild, Id, Member, Message, ReadState, User, VoiceState } from "@aurora/schema";
import type { ConnectionStatus } from "../net/gateway";

export const TYPING_TTL_MS = 8_000;

export interface GuildEntry {
  id: Id;
  name: string;
  ownerId: Id;
  channelIds: Id[];
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
}

export type ChatAction =
  | { type: "status"; status: ConnectionStatus }
  | { type: "ready"; user: User; guilds: Guild[]; readStates?: ReadState[] }
  | { type: "dispatch"; event: DispatchEvent; now: number }
  | { type: "guildUpsert"; guild: Guild }
  | { type: "channelUpsert"; channel: Channel }
  | { type: "messageUpsert"; message: Message }
  | { type: "history"; channelId: Id; messages: Message[]; mode: "latest" | "older"; pageSize: number }
  | { type: "focusChannel"; channelId: Id | null }
  | { type: "windowFocus"; focused: boolean }
  | { type: "typingExpire"; now: number };

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
};

const byId = (a: { id: Id }, b: { id: Id }) => Number(a.id) - Number(b.id);
/** IDs são números ordenados no tempo (≤ 2^53), guardados como texto. */
const newer = (a: Id | null | undefined, b: Id | null | undefined) => Number(a ?? 0) > Number(b ?? 0);

export const isUnread = (state: ChatState, channelId: Id): boolean => {
  const read = state.reads[channelId];
  return Boolean(read && newer(read.lastMessageId, read.lastReadId));
};
export const mentionCountOf = (state: ChatState, channelId: Id): number => state.reads[channelId]?.mentionCount ?? 0;

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
  for (const channel of guild.channels) channels[channel.id] = channel;
  const members: Record<Id, Member> = {};
  for (const member of guild.members) members[member.user.id] = member;
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
  return { ...state, me: state.me?.id === user.id ? user : state.me, members, messages };
}

function withChannel(state: ChatState, channel: Channel): ChatState {
  const guild = state.guilds[channel.guildId];
  if (!guild) return state;
  const channels = { ...state.channels, [channel.id]: channel };
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
    const mentionsMe = !known && newer(message.id, read.lastReadId) && state.me !== null && message.mentions.includes(state.me.id);
    nextRead = { ...read, lastMessageId, mentionCount: read.mentionCount + (mentionsMe ? 1 : 0) };
  }

  const channelTyping = state.typing[message.channelId];
  const typing =
    channelTyping && message.author.id in channelTyping
      ? { ...state.typing, [message.channelId]: Object.fromEntries(Object.entries(channelTyping).filter(([id]) => id !== message.author.id)) }
      : state.typing;
  return { ...state, messages, reads: { ...state.reads, [message.channelId]: nextRead }, typing };
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
        if (member) members[guildId] = { ...guildMembers, [event.d.userId]: { ...member, online: event.d.online } };
      }
      return { ...state, members };
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
    case "VOICE_STATE_UPDATE": {
      const { guildId, userId, channelId, muted, deafened, streaming } = event.d;
      const guildVoice = { ...state.voice[guildId] };
      if (channelId === null) delete guildVoice[userId];
      else guildVoice[userId] = { userId, channelId, muted, deafened, streaming };
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
      let next: ChatState = { ...initialChatState, me: action.user, status: "ready", reads, activeChannelId: state.activeChannelId, focused: state.focused };
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
