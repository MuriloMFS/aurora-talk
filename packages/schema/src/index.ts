/**
 * Contrato compartilhado entre o app (apps/desktop) e o servidor (apps/server).
 * IDs são strings (ordenadas no tempo) para permitir migrar para 64 bits sem mudar o cliente.
 */
export type Id = string;

export * from "./permissions.ts";
import type { Overwrite, Role } from "./permissions.ts";

export interface User {
  id: Id;
  username: string;
  displayName: string;
}

export type ChannelType = "text" | "voice";

export interface Channel {
  id: Id;
  guildId: Id;
  type: ChannelType;
  name: string;
  position: number;
  /** Permissões deste canal para cargos/pessoas (vazio = vale o do servidor). */
  overwrites: Overwrite[];
}

/** Quem está em qual canal de voz (some quando a pessoa sai ou a conexão cai). */
export interface VoiceState {
  userId: Id;
  channelId: Id;
  muted: boolean;
  deafened: boolean;
  /** Compartilhando a tela ("AO VIVO"). */
  streaming: boolean;
  /** Silenciado por um moderador (não liga o microfone até tirarem). */
  serverMuted?: boolean;
}

/** Servidor STUN/TURN no formato do `RTCIceServer` do WebRTC. */
export interface IceServer {
  urls: string[];
  username?: string;
  credential?: string;
}

/** Credenciais para entrar na sala de mídia (LiveKit) de um canal de voz. */
export interface VoiceToken {
  url: string;
  token: string;
  room: string;
  /**
   * Retransmissor (TURN) com credenciais temporárias, para quem está fora da rede do servidor
   * chegar à mídia sem portas abertas no roteador. Ausente = conexão direta ao LiveKit.
   */
  iceServers?: IceServer[];
}

export interface Member {
  user: User;
  joinedAt: number;
  online: boolean;
  /** Cargos do membro, sem o @todos (que todo mundo tem). */
  roles: Id[];
  /** De castigo até este instante (ms); `null` = livre. */
  timeoutUntil?: number | null;
}

export interface Guild {
  id: Id;
  name: string;
  ownerId: Id;
  channels: Channel[];
  members: Member[];
  voiceStates: VoiceState[];
  /** Inclui o @todos (id = id do servidor, posição 0). */
  roles: Role[];
}

/** Trecho da mensagem respondida (resolvido pelo servidor). `author`/`content` nulos = a original foi apagada. */
export interface MessageReference {
  id: Id;
  author: User | null;
  content: string | null;
}

/** Uma reação: o emoji e quem reagiu (a contagem é `userIds.length`). */
export interface Reaction {
  emoji: string;
  userIds: Id[];
}

export interface Message {
  id: Id;
  channelId: Id;
  author: User;
  /** Texto com Markdown; menções vêm como `<@idDoUsuário>`. */
  content: string;
  createdAt: number;
  editedAt: number | null;
  replyTo: MessageReference | null;
  reactions: Reaction[];
  /** Quem foi mencionado (inclui o autor da mensagem respondida). Só membros do servidor. */
  mentions: Id[];
  /** Eco do nonce enviado pelo cliente (de-duplicação do envio). */
  nonce?: string;
}

/** Leitura de um canal de texto, guardada no servidor (vale em todos os aparelhos). */
export interface ReadState {
  channelId: Id;
  /** Última mensagem lida (quem nunca abriu o canal: tudo antes da entrada no servidor conta como lido). */
  lastReadId: Id;
  lastMessageId: Id | null;
  /** Menções a você depois da última leitura. */
  mentionCount: number;
}

export interface AuthResponse {
  token: string;
  user: User;
}

export interface Invite {
  code: string;
  guildId: Id;
}

/** Convite na tela de configurações do servidor. */
export interface InviteDetails extends Invite {
  createdBy: User | null;
  createdAt: number;
  uses: number;
}

export interface Ban {
  user: User;
  reason: string | null;
  bannedBy: User | null;
  createdAt: number;
}

export type AuditAction =
  | "guild_update"
  | "channel_create"
  | "channel_update"
  | "channel_delete"
  | "role_create"
  | "role_update"
  | "role_delete"
  | "member_role_add"
  | "member_role_remove"
  | "member_kick"
  | "member_ban"
  | "member_unban"
  | "invite_delete"
  | "channel_permissions"
  | "member_timeout"
  | "member_timeout_remove"
  | "voice_mute"
  | "voice_unmute"
  | "voice_move"
  | "voice_disconnect";

/** Uma linha do registro de auditoria: quem fez, o quê, em quem/onde e quando. */
export interface AuditLogEntry {
  id: Id;
  guildId: Id;
  actor: User | null;
  action: AuditAction;
  /** Nome do alvo no momento da ação (o alvo pode ter sido apagado depois). */
  targetName: string;
  /** Detalhe curto (ex.: nome antigo → novo, motivo do banimento, cargo dado). */
  detail: string | null;
  createdAt: number;
}

export interface ApiErrorBody {
  error: { code: string; message: string };
}

export const LIMITS = {
  usernameMin: 2,
  usernameMax: 32,
  displayNameMax: 32,
  passwordMin: 8,
  passwordMax: 128,
  guildNameMin: 2,
  guildNameMax: 100,
  channelNameMin: 1,
  channelNameMax: 100,
  messageMax: 2000,
  pageSize: 50,
  /** Tamanho do trecho da mensagem respondida. */
  replyExcerptMax: 200,
  /** Emojis diferentes por mensagem. */
  reactionsPerMessage: 20,
  mentionsPerMessage: 20,
  banReasonMax: 200,
  auditPageSize: 50,
} as const;

/** `<@id>`: como uma menção fica guardada no texto da mensagem. */
export const mentionToken = (userId: Id): string => `<@${userId}>`;

/** IDs mencionados no texto (sem repetir, na ordem em que aparecem). */
export function extractMentionIds(content: string): Id[] {
  const ids: Id[] = [];
  for (const match of content.matchAll(/<@(\d{1,20})>/g)) {
    const id = match[1]!;
    if (!ids.includes(id)) ids.push(id);
  }
  return ids;
}

const EMOJI_CHARS = /^(?:\p{Extended_Pictographic}|\p{Emoji_Modifier}|\p{Regional_Indicator}|[‍️⃣#*0-9])+$/u;
const EMOJI_BASE = /\p{Extended_Pictographic}|\p{Regional_Indicator}/u;

/** Reação válida: um emoji Unicode (com tons de pele, bandeiras e combinações), sem texto solto. */
export function isValidEmoji(value: string): boolean {
  return value.length > 0 && value.length <= 32 && EMOJI_CHARS.test(value) && EMOJI_BASE.test(value);
}

/** Usuário: letras minúsculas, números, ponto e sublinhado. */
export const USERNAME_PATTERN = /^[a-z0-9_.]+$/;

/** Nome de canal de voz: livre (com espaços e maiúsculas), só aparado e sem espaços repetidos. */
export function normalizeVoiceChannelName(raw: string): string {
  return raw.trim().replace(/\s+/g, " ").slice(0, LIMITS.channelNameMax);
}

/** Nome de canal de texto no estilo `minusculas-com-hifen`, preservando acentos. */
export function normalizeChannelName(raw: string): string {
  return raw
    .trim()
    .toLowerCase()
    .replace(/\s+/g, "-")
    .replace(/[^\p{L}\p{N}_-]/gu, "")
    .replace(/-+/g, "-")
    .replace(/^-|-$/g, "")
    .slice(0, LIMITS.channelNameMax);
}

/* ---------------- gateway (WebSocket em /gateway) ---------------- */

export const GATEWAY_PATH = "/gateway";
export const HEARTBEAT_INTERVAL_MS = 30_000;
/**
 * Versão do protocolo do gateway que este cliente entende.
 * 2 = reações, leitura e perfil (MESSAGE_REACTION_*, READ_STATE_UPDATE, USER_UPDATE). Clientes sem
 * `v` (1.2.x) não recebem esses eventos — o reducer antigo não os conhece. Do 1.3.0 em diante, o
 * reducer ignora eventos que não conhece, então eventos novos podem entrar nesta mesma versão.
 */
export const GATEWAY_VERSION = 2;

export type ClientFrame =
  | { op: "identify"; token: string; v?: number }
  | { op: "heartbeat" }
  | { op: "typing"; channelId: Id }
  | { op: "voice_join"; channelId: Id; muted: boolean; deafened: boolean }
  | { op: "voice_state"; muted: boolean; deafened: boolean; streaming: boolean }
  | { op: "voice_leave" };

export type DispatchEvent =
  | { t: "MESSAGE_CREATE"; d: Message }
  | { t: "MESSAGE_UPDATE"; d: Message }
  | { t: "MESSAGE_DELETE"; d: { id: Id; channelId: Id } }
  | { t: "GUILD_CREATE"; d: Guild }
  | { t: "CHANNEL_CREATE"; d: Channel }
  | { t: "MEMBER_ADD"; d: { guildId: Id; member: Member } }
  | { t: "PRESENCE_UPDATE"; d: { userId: Id; online: boolean } }
  | { t: "TYPING_START"; d: { channelId: Id; userId: Id } }
  /** `channelId: null` = saiu da voz. */
  | { t: "VOICE_STATE_UPDATE"; d: { guildId: Id; userId: Id; channelId: Id | null; muted: boolean; deafened: boolean; streaming: boolean; serverMuted?: boolean } }
  | { t: "MESSAGE_REACTION_ADD"; d: ReactionEvent }
  | { t: "MESSAGE_REACTION_REMOVE"; d: ReactionEvent }
  /** Só para o próprio usuário: leu um canal em outro aparelho/aba. */
  | { t: "READ_STATE_UPDATE"; d: { channelId: Id; lastReadId: Id } }
  /** Alguém (inclusive eu, em outro aparelho) mudou o nome de exibição. */
  | { t: "USER_UPDATE"; d: User }
  | { t: "GUILD_UPDATE"; d: { id: Id; name: string } }
  /** O servidor foi excluído, ou eu saí, fui expulso ou banido: some da minha lista. */
  | { t: "GUILD_DELETE"; d: { id: Id } }
  /** Lista completa de cargos depois de criar, editar, ordenar ou excluir. */
  | { t: "GUILD_ROLES_UPDATE"; d: { guildId: Id; roles: Role[] } }
  | { t: "MEMBER_UPDATE"; d: { guildId: Id; userId: Id; roles: Id[]; timeoutUntil?: number | null } }
  | { t: "MEMBER_REMOVE"; d: { guildId: Id; userId: Id } }
  | { t: "CHANNEL_UPDATE"; d: Channel }
  | { t: "CHANNEL_DELETE"; d: { id: Id; guildId: Id } }
  /**
   * Só para quem foi movido: um moderador levou você para outra sala (`channelId`) ou tirou você da
   * voz (`null`). O estado de voz no servidor já mudou; o app troca de sala sem avisar "saí".
   */
  | { t: "VOICE_MOVE"; d: { guildId: Id; channelId: Id | null } };

export interface ReactionEvent {
  channelId: Id;
  messageId: Id;
  userId: Id;
  emoji: string;
}

/** Eventos que só vão para clientes com `identify.v >= 2`. */
export const V2_EVENTS: ReadonlySet<DispatchEvent["t"]> = new Set([
  "MESSAGE_REACTION_ADD",
  "MESSAGE_REACTION_REMOVE",
  "READ_STATE_UPDATE",
  "USER_UPDATE",
  "GUILD_UPDATE",
  "GUILD_DELETE",
  "GUILD_ROLES_UPDATE",
  "MEMBER_UPDATE",
  "MEMBER_REMOVE",
  "CHANNEL_UPDATE",
  "CHANNEL_DELETE",
  "VOICE_MOVE",
]);

export type ServerFrame =
  | { op: "hello"; heartbeatIntervalMs: number }
  /** `readStates` só para `v >= 2`. */
  | { op: "ready"; user: User; guilds: Guild[]; readStates?: ReadState[] }
  | { op: "heartbeat_ack" }
  | ({ op: "dispatch" } & DispatchEvent)
  | { op: "invalid_session"; reason: string };

/** Códigos de fechamento do WebSocket usados pelo servidor. */
export const CLOSE_CODES = {
  identifyTimeout: 4001,
  invalidFrame: 4002,
  heartbeatTimeout: 4003,
  invalidSession: 4004,
} as const;
