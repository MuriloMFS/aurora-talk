import Fastify, { type FastifyInstance, type FastifyRequest } from "fastify";
import cors from "@fastify/cors";
import websocket from "@fastify/websocket";
import { z } from "zod";
import { AccessToken, RoomServiceClient, TrackSource } from "livekit-server-sdk";
import {
  GATEWAY_PATH,
  LIMITS,
  USERNAME_PATTERN,
  extractMentionIds,
  isValidEmoji,
  activeCustomStatus,
  normalizeChannelName,
  normalizeVoiceChannelName,
  ALL_PERMISSIONS,
  CHANNEL_PERMISSIONS,
  EVERYONE_ROLE_NAME,
  PERMISSIONS,
  PERMISSION_INFO,
  ROLE_COLORS,
  ROLE_NAME_MAX,
  ROLES_PER_GUILD,
  TIMEOUT_MAX_MINUTES,
  canManageRole,
  canModerate,
  clampGrantedPermissions,
  computeChannelPermissions,
  computePermissions,
  formatDuration,
  hasPermission,
  highestPosition,
  outranks,
  type Actor,
  type ModerationPermission,
  type Overwrite,
  type PermissionName,
  type Role,
  type AuthResponse,
  type Channel,
  type DmChannel,
  type Guild,
  type Relationship,
  type RelationshipType,
  type SecurityInfo,
  type Id,
  type Message,
  type IceServer,
  type User,
  type VoiceToken,
} from "@aurora/schema";
import { hashPassword, hashToken, newSessionToken, verifyAgainstDummy, verifyPassword } from "./auth.ts";
import type { Gateway } from "./gateway.ts";
import { isValidId } from "./ids.ts";
import { RateLimiter } from "./rate-limit.ts";
import type { ServerChannel, Store } from "./store.ts";
import { registerSiteRoutes } from "./site.ts";
import { FileStore, cleanFilename, detectImageType, verifyAttachment } from "./files.ts";
import { deviceName, hashRecoveryCode, looksLikeRecoveryCode, newRecoveryCodes, newTotpSecret, otpauthUri, verifyTotp } from "./security.ts";
import { createHash } from "node:crypto";
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { nextId } from "./ids.ts";
import type { IceServerSource } from "./turn.ts";
import { registerUpdateRoutes } from "./updates.ts";

export const SERVER_VERSION = "1.13.0";

export class HttpError extends Error {
  readonly status: number;
  readonly code: string;
  constructor(status: number, code: string, message: string) {
    super(message);
    this.status = status;
    this.code = code;
  }
}

/* ---------- validação (mensagens em pt-BR, mostradas ao usuário) ---------- */
const usernameField = z
  .string()
  .trim()
  .toLowerCase()
  .min(LIMITS.usernameMin, `O usuário precisa ter pelo menos ${LIMITS.usernameMin} caracteres.`)
  .max(LIMITS.usernameMax, `O usuário pode ter no máximo ${LIMITS.usernameMax} caracteres.`)
  .regex(USERNAME_PATTERN, "Use só letras minúsculas, números, ponto e sublinhado no usuário.");
const passwordField = z
  .string()
  .min(LIMITS.passwordMin, `A senha precisa ter pelo menos ${LIMITS.passwordMin} caracteres.`)
  .max(LIMITS.passwordMax, `A senha pode ter no máximo ${LIMITS.passwordMax} caracteres.`);
const contentField = z
  .string()
  .trim()
  .min(1, "A mensagem está vazia.")
  .max(LIMITS.messageMax, `A mensagem pode ter no máximo ${LIMITS.messageMax} caracteres.`);

const registerBody = z.object({
  device: z.string().max(80).optional(),
  username: usernameField,
  displayName: z.string().trim().min(1).max(LIMITS.displayNameMax, `O nome de exibição pode ter no máximo ${LIMITS.displayNameMax} caracteres.`).optional(),
  password: passwordField,
});
const displayNameField = z
  .string()
  .trim()
  .min(1, "Informe um nome de exibição.")
  .max(LIMITS.displayNameMax, `O nome de exibição pode ter no máximo ${LIMITS.displayNameMax} caracteres.`);
const profileBody = z.object({ displayName: displayNameField });
const passwordBody = z.object({ currentPassword: z.string().min(1, "Informe a senha atual."), newPassword: passwordField });
const roleFields = {
  name: z.string().trim().min(1, "Dê um nome ao cargo.").max(ROLE_NAME_MAX, `O nome do cargo pode ter no máximo ${ROLE_NAME_MAX} caracteres.`),
  color: z.number().int().min(0).max(ROLE_COLORS - 1).nullable(),
  permissions: z.number().int().min(0).max(ALL_PERMISSIONS),
  hoist: z.boolean(),
};
const roleCreateBody = z.object(roleFields).partial();
const roleUpdateBody = z.object(roleFields).partial();
const roleMoveBody = z.object({ direction: z.enum(["up", "down"]) });
const banBody = z.object({ reason: z.string().trim().max(LIMITS.banReasonMax, `O motivo pode ter no máximo ${LIMITS.banReasonMax} caracteres.`).optional() });
const guildUpdateBody = z.object({
  name: z
    .string()
    .trim()
    .min(LIMITS.guildNameMin, `O nome do servidor precisa ter pelo menos ${LIMITS.guildNameMin} caracteres.`)
    .max(LIMITS.guildNameMax, `O nome do servidor pode ter no máximo ${LIMITS.guildNameMax} caracteres.`),
});
const channelUpdateBody = z.object({ name: z.string().max(LIMITS.channelNameMax * 2) });
const overwriteBody = z.object({
  allow: z.number().int().min(0).max(ALL_PERMISSIONS),
  deny: z.number().int().min(0).max(ALL_PERMISSIONS),
});
const timeoutBody = z.object({
  minutes: z.number().int().min(1, "Escolha por quanto tempo.").max(TIMEOUT_MAX_MINUTES, "O castigo pode durar no máximo 28 dias.").nullable(),
});
const voiceModerationBody = z.object({ muted: z.boolean().optional(), channelId: z.string().max(20).nullable().optional() });
const auditQuery = z.object({ before: z.string().optional() });
const friendRequestBody = z.union([
  z.object({ username: z.string().trim().toLowerCase().min(1, "Informe o @usuário da pessoa.").max(LIMITS.usernameMax + 1).transform((u) => u.replace(/^@/, "")) }),
  z.object({ userId: z.string().max(20) }),
]);
const relationshipBody = z.object({ type: z.enum(["friend", "blocked"]) });
const settingsBody = z.object({
  dmPolicy: z.enum(["servers", "friends"]).optional(),
  status: z.enum(["online", "idle", "dnd", "invisible"]).optional(),
  customStatus: z
    .object({
      text: z.string().trim().max(LIMITS.customStatusMax, `O status pode ter no máximo ${LIMITS.customStatusMax} caracteres.`),
      emoji: z.string().max(32).nullable(),
      expiresAt: z.number().int().nullable(),
    })
    .nullable()
    .optional(),
});
const dmCreateBody = z.object({
  recipientIds: z
    .array(z.string().max(20))
    .min(1, "Escolha com quem conversar.")
    .max(LIMITS.groupDmMax - 1, `Um grupo pode ter até ${LIMITS.groupDmMax} pessoas, contando você.`),
  name: z.string().trim().max(LIMITS.groupNameMax).optional(),
});
const groupNameBody = z.object({ name: z.string().trim().max(LIMITS.groupNameMax, `O nome do grupo pode ter no máximo ${LIMITS.groupNameMax} caracteres.`) });
const deviceField = z.string().max(80).optional();
const mfaCodeField = z.string().trim().max(20).optional();
const loginBody = z.object({
  username: z.string().trim().toLowerCase().min(1, "Informe o usuário."),
  password: z.string().min(1, "Informe a senha."),
  /** Código do app autenticador (ou de recuperação), quando a conta tem verificação em duas etapas. */
  code: mfaCodeField,
  device: deviceField,
});
const recoverBody = z.object({
  username: z.string().trim().toLowerCase().min(1, "Informe o usuário."),
  code: z.string().trim().min(1, "Informe um código de recuperação."),
  newPassword: passwordField,
  device: deviceField,
});
const passwordOnlyBody = z.object({ password: z.string().min(1, "Informe a sua senha.") });
const totpEnableBody = z.object({ code: z.string().trim().min(1, "Digite o código do app autenticador.") });
const totpDisableBody = z.object({ password: z.string().min(1, "Informe a sua senha."), code: z.string().trim().min(1, "Digite o código do app autenticador ou um código de recuperação.") });
const guildBody = z.object({
  name: z
    .string()
    .trim()
    .min(LIMITS.guildNameMin, `O nome do servidor precisa ter pelo menos ${LIMITS.guildNameMin} caracteres.`)
    .max(LIMITS.guildNameMax, `O nome do servidor pode ter no máximo ${LIMITS.guildNameMax} caracteres.`),
});
const channelBody = z.object({
  name: z.string().max(200, "Nome de canal longo demais."),
  type: z.enum(["text", "voice"]).optional(),
  /** Só quem você liberar vê (você continua vendo). */
  private: z.boolean().optional(),
});
const messageBody = z.object({
  // com anexo, o texto pode ficar vazio
  content: z.string().trim().max(LIMITS.messageMax, `A mensagem pode ter no máximo ${LIMITS.messageMax} caracteres.`).default(""),
  nonce: z.string().max(64).optional(),
  replyToId: z.string().max(20).optional(),
  attachmentIds: z
    .array(z.string().max(20))
    .max(LIMITS.attachmentsPerMessage, `Dá para enviar até ${LIMITS.attachmentsPerMessage} arquivos por mensagem.`)
    .optional(),
});
const uploadQuery = z.object({
  filename: z.string().max(400).optional(),
  width: z.coerce.number().int().min(1).max(20_000).optional(),
  height: z.coerce.number().int().min(1).max(20_000).optional(),
});
/** Anexo enviado e ainda não usado numa mensagem há mais que isso: apagado. */
const PENDING_ATTACHMENT_MS = 60 * 60_000;
const SWEEP_EVERY_MS = 10 * 60_000;
const ackBody = z.object({ messageId: z.string().max(20) });
const editBody = z.object({ content: contentField });
const pageQuery = z.object({
  before: z.string().optional(),
  limit: z.coerce.number().int().min(1).max(100).optional(),
});

interface Deps {
  store: Store;
  gateway: Gateway;
  logger?: boolean;
  /** Pasta com as versões publicadas do app (latest.json + instaladores). Sem ela, não há atualizações. */
  releasesDir?: string;
  /**
   * Servidor de mídia LiveKit. `url` vazio = mesmo host pelo qual o cliente chegou, porta 7880.
   * `apiUrl` = onde ESTE servidor fala com o LiveKit para tirar alguém da sala (padrão: 127.0.0.1:7880).
   */
  voice?: { apiKey: string; apiSecret: string; url?: string; apiUrl?: string };
  /** Retransmissor TURN (credenciais temporárias por entrada na voz). Sem ele, só conexão direta à mídia. */
  turn?: IceServerSource;
  /** Pasta dos arquivos enviados (fotos de perfil). Sem ela, uma pasta temporária (testes). */
  filesDir?: string;
  /** Pasta do site de download (apps/site/dist). Sem ela, "/" responde 404. */
  siteDir?: string;
  /**
   * Atrás do Cloudflare Tunnel todo acesso chega de 127.0.0.1: o IP real vem em `CF-Connecting-IP`.
   * Só ligue com o servidor escutando em 127.0.0.1 (senão qualquer um na rede forja o cabeçalho).
   */
  trustCloudflare?: boolean;
  /** Só para testes: tentativas por minuto de login (padrão 10 por IP) e de código (padrão 6 a cada 5 min por conta). */
  limits?: { auth?: number; mfa?: number };
}

const VOICE_TOKEN_TTL = "6h";
/** Quem foi movido e não trocou de sala (app antigo) sai da sala de mídia antiga depois disso. */
const MOVE_GRACE_MS = 15_000;

export async function buildApp({ store, gateway, logger = false, releasesDir, voice, turn, siteDir, filesDir, trustCloudflare = false, limits }: Deps): Promise<FastifyInstance> {
  const files = new FileStore(filesDir ?? join(mkdtempSync(join(tmpdir(), "aurora-files-")), "files"));
  /** Apaga anexos abandonados e os de mensagens/canais apagados (banco e disco). */
  const sweepFiles = async (now = Date.now()) => {
    for (const id of store.orphanAttachments(now - PENDING_ATTACHMENT_MS)) {
      store.deleteFile(id);
      await files.remove(id);
    }
  };
  // Nível "warn": logs de cada requisição (nível info) ficam de fora.
  const app = Fastify({
    logger: logger ? { level: "warn" } : false,
    bodyLimit: 64 * 1024,
    // Atrás do Cloudflare Tunnel: só o cloudflared (mesma máquina) é proxy confiável, para que
    // protocolo (https) e host públicos venham de X-Forwarded-Proto/Host (links de atualização certos).
    trustProxy: trustCloudflare ? "127.0.0.1" : false,
  });

  // Público só por https: quem chegar por http (pela Cloudflare) é levado para o mesmo endereço em https.
  if (trustCloudflare) {
    app.addHook("onRequest", async (request, reply) => {
      if (request.headers["x-forwarded-proto"] !== "http") return;
      if (request.method !== "GET" && request.method !== "HEAD") {
        return reply.status(403).send({ error: { code: "https_required", message: "Use o endereço com https://." } });
      }
      return reply.redirect(`https://${request.host}${request.url}`, 301);
    });
  }

  // Autenticação por token Bearer (sem cookies), então qualquer origem pode chamar.
  await app.register(cors, {
    origin: true,
    methods: ["GET", "POST", "PUT", "PATCH", "DELETE"],
    allowedHeaders: ["Authorization", "Content-Type"],
  });
  await app.register(websocket, { options: { maxPayload: 16 * 1024 } });
  // Desligamento: o gateway para de consultar o banco antes de as conexões fecharem.
  app.addHook("preClose", async () => gateway.shutdown());
  const sweepTimer = setInterval(() => void sweepFiles().catch(() => undefined), SWEEP_EVERY_MS);
  sweepTimer.unref();
  app.addHook("onClose", async () => clearInterval(sweepTimer));
  app.decorate("sweepFiles", sweepFiles);

  const authLimiter = new RateLimiter(limits?.auth ?? 10, 60_000);
  const messageLimiter = new RateLimiter(10, 10_000);
  const actionLimiter = new RateLimiter(30, 60_000);
  const reactionLimiter = new RateLimiter(20, 10_000);
  const ackLimiter = new RateLimiter(60, 10_000);
  const uploadLimiter = new RateLimiter(30, 60_000);

  app.setErrorHandler((error, request, reply) => {
    if (error instanceof HttpError) {
      return reply.status(error.status).send({ error: { code: error.code, message: error.message } });
    }
    if (error instanceof z.ZodError) {
      return reply.status(400).send({ error: { code: "invalid_request", message: error.issues[0]?.message ?? "Requisição inválida." } });
    }
    const status = (error as { statusCode?: number }).statusCode;
    if (status === 413) {
      return reply.status(413).send({ error: { code: "too_large", message: "O arquivo é grande demais. Escolha um menor." } });
    }
    if (status === 415) {
      return reply.status(415).send({ error: { code: "unsupported_type", message: "Formato não aceito. Use uma imagem PNG, JPEG, WebP ou GIF." } });
    }
    if (status && status >= 400 && status < 500) {
      return reply.status(status).send({ error: { code: "bad_request", message: "Requisição inválida." } });
    }
    request.log.error(error);
    return reply.status(500).send({ error: { code: "internal", message: "Erro interno do servidor. Tente de novo." } });
  });
  app.setNotFoundHandler((_request, reply) => reply.status(404).send({ error: { code: "not_found", message: "Rota não encontrada." } }));

  /* ---------- helpers de acesso ---------- */
  const authenticate = (request: FastifyRequest): { user: User; tokenHash: string } => {
    const match = /^Bearer (\S+)$/.exec(request.headers.authorization ?? "");
    if (!match?.[1]) throw new HttpError(401, "unauthorized", "Faça login para continuar.");
    const tokenHash = hashToken(match[1]);
    const user = store.sessionUser(tokenHash);
    if (!user) throw new HttpError(401, "unauthorized", "Sessão inválida ou expirada. Entre novamente.");
    store.touchSession(tokenHash);
    return { user, tokenHash };
  };
  /** IP de quem fez a requisição (o real, quando atrás do Cloudflare). */
  const clientIp = (request: FastifyRequest): string => {
    const forwarded = trustCloudflare ? request.headers["cf-connecting-ip"] : undefined;
    return typeof forwarded === "string" && forwarded.length <= 64 ? forwarded : request.ip;
  };
  const limit = (limiter: RateLimiter, key: string) => {
    if (!limiter.allow(key)) throw new HttpError(429, "rate_limited", "Muitas ações seguidas. Espere alguns segundos e tente de novo.");
  };
  // 404 (e não 403) para não revelar a existência de servidores/canais alheios.
  const memberGuild = (guildId: string, userId: Id): Guild => {
    const guild = isValidId(guildId) && store.isMember(guildId, userId) ? store.getGuild(guildId, gateway) : undefined;
    if (!guild) throw new HttpError(404, "not_found", "Servidor não encontrado.");
    return guild;
  };
  /** Canal que o usuário vê (canal privado de quem não tem acesso também dá 404: não revela que existe). */
  const memberChannel = (channelId: string, userId: Id): Channel => {
    const channel = isValidId(channelId) ? store.getChannel(channelId) : undefined;
    if (!channel || !hasPermission(store.channelPermissionsOf(channel, userId), "VIEW_CHANNEL")) throw new HttpError(404, "not_found", "Canal não encontrado.");
    return channel;
  };
  /** Canal de servidor que o usuário vê, ou conversa direta da qual participa (rotas de mensagem). */
  const chatChannel = (channelId: string, userId: Id): ServerChannel => {
    const channel = isValidId(channelId) ? store.getConversation(channelId) : undefined;
    if (!channel || !hasPermission(store.channelPermissionsOf(channel, userId), "VIEW_CHANNEL")) throw new HttpError(404, "not_found", "Canal não encontrado.");
    return channel;
  };
  /** Menções válidas: só quem vê o canal, mais o autor da mensagem respondida (como no Discord). */
  const mentionsFor = (channel: Channel, content: string, replyAuthorId: Id | null | undefined, authorId: Id): Id[] => {
    const members = new Set(store.channelViewerIds(channel));
    const ids = extractMentionIds(content).filter((id) => members.has(id));
    if (replyAuthorId && replyAuthorId !== authorId && members.has(replyAuthorId) && !ids.includes(replyAuthorId)) ids.push(replyAuthorId);
    return ids.slice(0, LIMITS.mentionsPerMessage);
  };
  /** Mensagem de um canal de texto do qual o usuário é membro (404 se não for). */
  const channelMessage = (channelId: string, messageId: string, userId: Id): { channel: Channel; message: Message } => {
    const channel = chatChannel(channelId, userId);
    const message = isValidId(messageId) ? store.getMessage(messageId) : undefined;
    if (!message || message.channelId !== channel.id) throw new HttpError(404, "not_found", "Mensagem não encontrada.");
    return { channel, message };
  };
  /* ---------- permissões (conferidas aqui; o app só esconde o que não pode) ---------- */
  const PERMISSION_LABEL = Object.fromEntries(PERMISSION_INFO.flatMap((g) => g.items.map((i) => [i.name, i.label]))) as Record<PermissionName, string>;
  const TIMED_OUT = "Você está de castigo neste servidor. Até acabar, dá para ler, mas não escrever, reagir nem usar a voz.";
  const requirePermission = (guildId: Id, userId: Id, name: PermissionName) => {
    if (!hasPermission(store.permissionsOf(guildId, userId), name)) {
      if (store.timeoutOf(guildId, userId) !== null) throw new HttpError(403, "timed_out", TIMED_OUT);
      throw new HttpError(403, "missing_permission", `Você não tem a permissão "${PERMISSION_LABEL[name]}" neste servidor. Peça a quem administra.`);
    }
  };
  const requireChannelPermission = (channel: ServerChannel, userId: Id, name: PermissionName) => {
    if (!hasPermission(store.channelPermissionsOf(channel, userId), name)) {
      if (channel.dm) throw new HttpError(403, "dm_blocked", "Sua mensagem não pôde ser entregue: uma das pessoas bloqueou a outra.");
      if (store.timeoutOf(channel.guildId, userId) !== null) throw new HttpError(403, "timed_out", TIMED_OUT);
      throw new HttpError(403, "missing_permission", `Você não tem a permissão "${PERMISSION_LABEL[name]}" neste canal. Peça a quem administra.`);
    }
  };
  const channelLabel = (channel: Pick<Channel, "type" | "name">) => (channel.type === "text" ? `#${channel.name}` : channel.name);
  /** "libera Ver canais, Conectar · bloqueia Enviar mensagens" (para o registro de auditoria). */
  const describeOverwrite = (allow: number, deny: number): string => {
    const names = (bits: number) => (Object.keys(PERMISSIONS) as PermissionName[]).filter((n) => bits & PERMISSIONS[n]).map((n) => PERMISSION_LABEL[n]);
    const parts = [allow && `libera ${names(allow).join(", ")}`, deny && `bloqueia ${names(deny).join(", ")}`].filter(Boolean);
    return parts.length > 0 ? parts.join(" · ") : "volta a seguir o servidor";
  };
  const actorOf = (guildId: Id, userId: Id): Actor => ({ userId, roleIds: store.memberRoleIds(guildId, userId) });
  const contextOf = (guildId: Id) => store.permissionContext(guildId)!;
  /** Cargo do servidor (404 se for de outro). */
  const guildRole = (guildId: Id, roleId: string): Role => {
    const role = isValidId(roleId) ? store.getRole(roleId) : undefined;
    if (!role || role.guildId !== guildId) throw new HttpError(404, "not_found", "Cargo não encontrado.");
    return role;
  };
  const requireRoleControl = (guildId: Id, userId: Id, role: Role) => {
    requirePermission(guildId, userId, "MANAGE_ROLES");
    if (!canManageRole(contextOf(guildId), actorOf(guildId, userId), role)) {
      throw new HttpError(403, "role_hierarchy", "Esse cargo está no mesmo nível ou acima do seu. Só dá para mexer em cargos abaixo do seu cargo mais alto.");
    }
  };
  const broadcastRoles = (guildId: Id) => gateway.dispatchToGuild(guildId, { t: "GUILD_ROLES_UPDATE", d: { guildId, roles: store.rolesOf(guildId) } });

  /* ---------- voz: tirar da sala do LiveKit e atualizar o que cada um pode publicar ---------- */
  let roomService: RoomServiceClient | null = null;
  const rooms = () => {
    if (!voice) return null;
    roomService ??= new RoomServiceClient(voice.apiUrl ?? "http://127.0.0.1:7880", voice.apiKey, voice.apiSecret);
    return roomService;
  };
  const voiceRoom = (channelId: Id) => `aurora-voice-${channelId}`;
  /** O que a credencial do LiveKit libera: microfone com "Falar" (e sem silêncio de moderador), tela com "Transmitir". */
  const publishSources = (permissions: number, serverMuted = false): TrackSource[] => [
    ...(hasPermission(permissions, "SPEAK") && !serverMuted ? [TrackSource.MICROPHONE] : []),
    ...(hasPermission(permissions, "STREAM") ? [TrackSource.SCREEN_SHARE, TrackSource.SCREEN_SHARE_AUDIO] : []),
  ];
  /** Melhor esforço: se o LiveKit não responder, a pessoa cai sozinha quando a credencial expirar. */
  const evictFromVoice = (guildId: Id, userId: Id) => {
    const channelId = gateway.voiceChannelOf(userId);
    gateway.leaveVoiceIn(guildId, userId);
    if (channelId) rooms()?.removeParticipant(voiceRoom(channelId), userId).catch(() => undefined);
  };
  /** Depois de mudar cargos, sobrescritas, castigo ou silêncio: quem está na voz passa a poder (ou não) falar e transmitir na hora. */
  const refreshVoiceGrants = (guildId: Id, onlyUserId?: Id) => {
    for (const { userId, channelId } of gateway.voiceMembersOf(guildId)) {
      if (onlyUserId !== undefined && userId !== onlyUserId) continue;
      const channel = store.getChannel(channelId);
      const permissions = channel ? store.channelPermissionsOf(channel, userId) : 0;
      if (!hasPermission(permissions, "CONNECT")) {
        evictFromVoice(guildId, userId);
        continue;
      }
      const sources = publishSources(permissions, store.isServerMuted(guildId, userId));
      rooms()
        ?.updateParticipant(voiceRoom(channelId), userId, undefined, { canPublish: sources.length > 0, canSubscribe: true, canPublishData: false, canPublishSources: sources })
        .catch(() => undefined);
    }
  };
  /** Silêncio de moderador: além de tirar a permissão, desliga o microfone que já está no ar (melhor esforço). */
  const silenceMicrophone = (channelId: Id, userId: Id) => {
    const service = rooms();
    if (!service) return;
    service
      .getParticipant(voiceRoom(channelId), userId)
      .then((participant) =>
        Promise.all(
          participant.tracks
            .filter((track) => track.source === TrackSource.MICROPHONE && !track.muted)
            .map((track) => service.mutePublishedTrack(voiceRoom(channelId), userId, track.sid, true)),
        ),
      )
      .catch(() => undefined);
  };
  /**
   * Depois de mudar quem vê o quê (cargos, permissões ou sobrescritas): cada pessoa ganha ou perde os
   * canais na hora (com quem está na voz deles), e a voz se ajusta.
   */
  const syncAccess = (guildId: Id, before: Map<Id, Set<Id>>) => {
    const after = store.visibility(guildId);
    const channels = new Map(store.channelsOf(guildId).map((c) => [c.id, c]));
    const voiceStates = gateway.voiceStatesOf(guildId);
    for (const [userId, visible] of after) {
      const previous = before.get(userId) ?? new Set<Id>();
      for (const channelId of visible) {
        const channel = channels.get(channelId);
        if (previous.has(channelId) || !channel) continue;
        gateway.dispatchToUser(userId, { t: "CHANNEL_CREATE", d: channel });
        for (const state of voiceStates) if (state.channelId === channelId) gateway.dispatchToUser(userId, { t: "VOICE_STATE_UPDATE", d: { guildId, ...state } });
      }
      for (const channelId of previous) if (!visible.has(channelId)) gateway.dispatchToUser(userId, { t: "CHANNEL_DELETE", d: { id: channelId, guildId } });
    }
    refreshVoiceGrants(guildId);
  };
  /** Tira a pessoa do servidor (expulsa, banida ou saiu) e avisa todo mundo. */
  const dropMember = (guildId: Id, userId: Id) => {
    evictFromVoice(guildId, userId);
    gateway.dispatchToGuild(guildId, { t: "MEMBER_REMOVE", d: { guildId, userId } });
    gateway.dispatchToUser(userId, { t: "GUILD_DELETE", d: { id: guildId } });
  };

  const startSession = (user: User, request: FastifyRequest, device?: string): AuthResponse => {
    const token = newSessionToken();
    store.createSession(hashToken(token), user.id, deviceName(device, request.headers["user-agent"]));
    return { token, user };
  };
  const mfaLimiter = new RateLimiter(limits?.mfa ?? 6, 5 * 60_000);
  const recoverLimiter = new RateLimiter(5, 15 * 60_000);
  /**
   * Segundo fator: código de 6 dígitos do app autenticador, ou um código de recuperação (gasto na hora).
   * `true` se valeu.
   */
  const checkSecondFactor = (userId: Id, code: string): boolean => {
    const totp = store.totpOf(userId);
    if (totp.secret && /^\d{6}$/.test(code.replace(/\s/g, ""))) {
      const step = verifyTotp(totp.secret, code.replace(/\s/g, ""), totp.lastStep);
      return step !== null && store.useTotpStep(userId, step);
    }
    return looksLikeRecoveryCode(code) && store.useRecoveryCode(userId, hashRecoveryCode(code));
  };
  const requirePassword = async (userId: Id, password: string) => {
    const hash = store.passwordHashOf(userId);
    if (!hash || !(await verifyPassword(password, hash))) throw new HttpError(400, "invalid_password", "A senha está errada. Confira e tente de novo.");
  };
  const issueRecoveryCodes = (userId: Id): string[] => {
    const codes = newRecoveryCodes();
    store.replaceRecoveryCodes(userId, codes.map(hashRecoveryCode));
    return codes;
  };

  /* ---------- rotas ---------- */
  app.get("/api/health", async () => ({ ok: true, version: SERVER_VERSION, voiceRelay: Boolean(turn) }));

  app.post("/api/auth/register", async (request, reply) => {
    limit(authLimiter, `auth:${clientIp(request)}`);
    const body = registerBody.parse(request.body);
    if (store.usernameExists(body.username)) throw new HttpError(409, "username_taken", "Esse nome de usuário já está em uso.");
    const user = store.createUser(body.username, body.displayName ?? body.username, await hashPassword(body.password));
    return reply.status(201).send(startSession(user, request, body.device));
  });

  app.post("/api/auth/login", async (request) => {
    limit(authLimiter, `auth:${clientIp(request)}`);
    const body = loginBody.parse(request.body);
    const credentials = store.findCredentials(body.username);
    const ok = credentials ? await verifyPassword(body.password, credentials.passwordHash) : await verifyAgainstDummy(body.password);
    if (!credentials || !ok) throw new HttpError(401, "invalid_credentials", "Usuário ou senha incorretos.");
    if (store.totpOf(credentials.user.id).secret) {
      if (!body.code) throw new HttpError(401, "mfa_required", "Digite o código de 6 dígitos do seu app autenticador (ou um código de recuperação).");
      limit(mfaLimiter, `mfa:${credentials.user.id}`);
      if (!checkSecondFactor(credentials.user.id, body.code)) {
        throw new HttpError(401, "mfa_invalid", "Código errado ou já usado. Confira o horário do celular e digite o código que está aparecendo agora.");
      }
    }
    return startSession(credentials.user, request, body.device);
  });

  // Esqueci a senha: com um código de recuperação, troca a senha e desconecta todos os aparelhos.
  app.post("/api/auth/recover", async (request) => {
    limit(recoverLimiter, `recover:${clientIp(request)}`);
    const body = recoverBody.parse(request.body ?? {});
    limit(recoverLimiter, `recover-user:${body.username}`);
    const credentials = store.findCredentials(body.username);
    const fail = () => new HttpError(400, "recover_failed", "Usuário ou código de recuperação incorretos (ou o código já foi usado).");
    if (!credentials || !looksLikeRecoveryCode(body.code)) throw fail();
    if (!store.useRecoveryCode(credentials.user.id, hashRecoveryCode(body.code))) throw fail();
    store.updatePassword(credentials.user.id, await hashPassword(body.newPassword));
    for (const hash of store.deleteAllSessions(credentials.user.id)) gateway.closeSession(hash);
    return startSession(credentials.user, request, body.device);
  });

  /* ---------- Minha conta → Segurança ---------- */
  const securityOf = (userId: Id, currentHash: string): SecurityInfo => ({
    totpEnabled: store.totpOf(userId).secret !== null,
    recoveryCodesLeft: store.recoveryCodesLeft(userId),
    sessions: store.sessionsOf(userId).map(({ tokenHash, ...s }) => ({ ...s, current: tokenHash === currentHash })),
  });

  app.get("/api/users/@me/security", async (request) => {
    const { user, tokenHash } = authenticate(request);
    return securityOf(user.id, tokenHash);
  });

  // Códigos novos (os antigos deixam de valer). Pede a senha: quem pegou o computador aberto não gera.
  app.post("/api/users/@me/recovery-codes", async (request) => {
    const { user } = authenticate(request);
    limit(authLimiter, `security:${user.id}`);
    await requirePassword(user.id, passwordOnlyBody.parse(request.body ?? {}).password);
    return { recoveryCodes: issueRecoveryCodes(user.id) };
  });

  // Passo 1: segredo novo (fica pendente até confirmar com um código do app).
  app.post("/api/users/@me/totp/setup", async (request) => {
    const { user } = authenticate(request);
    limit(authLimiter, `security:${user.id}`);
    await requirePassword(user.id, passwordOnlyBody.parse(request.body ?? {}).password);
    if (store.totpOf(user.id).secret) throw new HttpError(400, "already_enabled", "A verificação em duas etapas já está ligada.");
    const secret = newTotpSecret();
    store.setTotpPending(user.id, secret);
    return { secret, uri: otpauthUri("Aurora", user.username, secret) };
  });

  // Passo 2: o código do app confirma que ficou certo; liga e entrega os códigos de recuperação.
  app.post("/api/users/@me/totp/enable", async (request) => {
    const { user } = authenticate(request);
    limit(mfaLimiter, `mfa:${user.id}`);
    const { code } = totpEnableBody.parse(request.body ?? {});
    const { pending } = store.totpOf(user.id);
    if (!pending) throw new HttpError(400, "no_setup", "Comece de novo: clique em ligar a verificação em duas etapas.");
    const step = verifyTotp(pending, code.replace(/\s/g, ""), null);
    if (step === null) throw new HttpError(400, "mfa_invalid", "Código errado. Confira se o horário do celular está certo e digite o código que está aparecendo agora.");
    store.setTotpSecret(user.id, pending, step);
    return { recoveryCodes: issueRecoveryCodes(user.id) };
  });

  app.post("/api/users/@me/totp/disable", async (request) => {
    const { user } = authenticate(request);
    limit(mfaLimiter, `mfa:${user.id}`);
    const body = totpDisableBody.parse(request.body ?? {});
    await requirePassword(user.id, body.password);
    if (!store.totpOf(user.id).secret) return { ok: true };
    if (!checkSecondFactor(user.id, body.code)) throw new HttpError(400, "mfa_invalid", "Código errado ou já usado.");
    store.setTotpSecret(user.id, null);
    return { ok: true };
  });

  // Desconectar um aparelho (o atual também vale: é como sair).
  app.delete<{ Params: { sessionId: string } }>("/api/users/@me/sessions/:sessionId", async (request, reply) => {
    const { user } = authenticate(request);
    const session = store.sessionsOf(user.id).find((s) => s.id === request.params.sessionId);
    if (!session) throw new HttpError(404, "not_found", "Esse aparelho já foi desconectado.");
    store.deleteSession(session.tokenHash);
    gateway.closeSession(session.tokenHash);
    return reply.status(204).send();
  });

  // Desconectar todos os outros aparelhos.
  app.delete("/api/users/@me/sessions", async (request, reply) => {
    const { user, tokenHash } = authenticate(request);
    for (const other of store.deleteOtherSessions(user.id, tokenHash)) gateway.closeSession(other);
    return reply.status(204).send();
  });

  app.post("/api/auth/logout", async (request, reply) => {
    const { tokenHash } = authenticate(request);
    store.deleteSession(tokenHash);
    gateway.closeSession(tokenHash);
    return reply.status(204).send();
  });

  app.get("/api/users/@me", async (request) => authenticate(request).user);

  // Nome de exibição: vale na hora para quem divide servidor comigo e para as minhas outras abas/aparelhos.
  app.patch("/api/users/@me", async (request) => {
    const { user } = authenticate(request);
    const body = profileBody.parse(request.body);
    const updated = store.updateDisplayName(user.id, body.displayName);
    if (!updated) throw new HttpError(404, "not_found", "Conta não encontrada.");
    if (updated.displayName !== user.displayName) gateway.dispatchToUsers([user.id, ...store.peersOf(user.id)], { t: "USER_UPDATE", d: updated });
    return updated;
  });

  /* ---------- foto de perfil ---------- */
  // O app manda a imagem já recortada e reduzida (256 px), como corpo bruto da requisição.
  app.addContentTypeParser(["image/png", "image/jpeg", "image/gif", "image/webp", "application/octet-stream"], { parseAs: "buffer" }, (_request, body, done) =>
    done(null, body),
  );
  const announceUser = (user: User) => gateway.dispatchToUsers([user.id, ...store.peersOf(user.id)], { t: "USER_UPDATE", d: user });

  app.put("/api/users/@me/avatar", { bodyLimit: LIMITS.avatarMaxBytes }, async (request) => {
    const { user } = authenticate(request);
    limit(actionLimiter, `action:${user.id}`);
    const bytes = request.body;
    if (!Buffer.isBuffer(bytes) || bytes.length === 0) throw new HttpError(400, "invalid_request", "Envie a imagem da foto.");
    const contentType = detectImageType(bytes);
    if (!contentType) throw new HttpError(415, "unsupported_type", "Esse arquivo não é uma imagem PNG, JPEG, WebP ou GIF.");
    const id = nextId();
    await files.write(id, bytes);
    store.createFile({ id, ownerId: user.id, kind: "avatar", contentType, size: bytes.length, sha256: createHash("sha256").update(bytes).digest("hex"), createdAt: Date.now() });
    const previous = store.setAvatar(user.id, id);
    if (previous) {
      store.deleteFile(previous);
      await files.remove(previous);
    }
    const updated = store.getUser(user.id)!;
    announceUser(updated);
    return updated;
  });

  app.delete("/api/users/@me/avatar", async (request) => {
    const { user } = authenticate(request);
    limit(actionLimiter, `action:${user.id}`);
    const previous = store.setAvatar(user.id, null);
    if (previous) {
      store.deleteFile(previous);
      await files.remove(previous);
    }
    const updated = store.getUser(user.id)!;
    if (previous) announceUser(updated);
    return updated;
  });

  // Fotos de perfil são públicas (como em qualquer app de chat). O id nunca muda de conteúdo: cache longo.
  app.get<{ Params: { fileId: string } }>("/api/files/:fileId", async (request, reply) => {
    const file = isValidId(request.params.fileId) ? store.getFile(request.params.fileId) : undefined;
    if (!file || file.kind === "attachment") throw new HttpError(404, "not_found", "Arquivo não encontrado.");
    const bytes = await files.read(file.id).catch(() => null);
    if (!bytes) throw new HttpError(404, "not_found", "Arquivo não encontrado.");
    return reply
      .header("Content-Type", file.contentType)
      .header("X-Content-Type-Options", "nosniff")
      .header("Content-Security-Policy", "default-src 'none'; sandbox")
      .header("Cross-Origin-Resource-Policy", "cross-origin")
      .header("Cache-Control", "public, max-age=31536000, immutable")
      .header("Content-Disposition", "inline")
      .send(bytes);
  });

  /* ---------- amigos, pedidos e bloqueios ---------- */
  const friendLimiter = new RateLimiter(20, 60_000);
  /** Avisa os dois lados (cada um vê a sua relação). */
  const announceRelationship = (userId: Id, target: User, type: RelationshipType | null, since = Date.now()) =>
    gateway.dispatchToUser(userId, { t: "RELATIONSHIP_UPDATE", d: { user: target, type, since, online: type !== null && type !== "blocked" && gateway.isOnline(target.id) } });
  const setBoth = (me: User, other: User, mine: RelationshipType | null, theirs: RelationshipType | null) => {
    const since = Date.now();
    store.setRelationship(me.id, other.id, mine, since);
    store.setRelationship(other.id, me.id, theirs, since);
    announceRelationship(me.id, other, mine, since);
    announceRelationship(other.id, me, theirs, since);
  };
  const relationshipOf = (me: User, other: User): Relationship => ({
    user: other,
    type: store.relationshipOf(me.id, other.id)!,
    since: Date.now(),
    online: gateway.isOnline(other.id),
  });

  app.get("/api/users/@me/relationships", async (request) => {
    const { user } = authenticate(request);
    return store.relationshipsOf(user.id, gateway);
  });

  // Pedido de amizade por @usuário (ou id). Se a outra pessoa já tinha pedido, vira amizade.
  app.post("/api/users/@me/relationships", async (request, reply) => {
    const { user } = authenticate(request);
    limit(friendLimiter, `friend:${user.id}`);
    const body = friendRequestBody.parse(request.body ?? {});
    const target = "username" in body ? store.findUserByUsername(body.username) : isValidId(body.userId) ? store.getUser(body.userId) : undefined;
    if (!target) throw new HttpError(404, "user_not_found", "Não achamos ninguém com esse usuário. Confira o @ (letras minúsculas, sem espaços).");
    if (target.id === user.id) throw new HttpError(400, "invalid_request", "Esse é você.");
    const mine = store.relationshipOf(user.id, target.id);
    if (mine === "blocked") throw new HttpError(400, "blocked", "Você bloqueou essa pessoa. Desbloqueie antes de pedir amizade.");
    // quem me bloqueou não fica sabendo do pedido; a resposta é genérica para não revelar o bloqueio
    if (store.relationshipOf(target.id, user.id) === "blocked") throw new HttpError(400, "request_failed", "Não foi possível enviar o pedido de amizade.");
    if (mine === "friend") throw new HttpError(400, "already_friends", `Você e ${target.displayName} já são amigos.`);
    if (mine === "incoming") setBoth(user, target, "friend", "friend");
    else if (mine !== "outgoing") setBoth(user, target, "outgoing", "incoming");
    return reply.status(200).send(relationshipOf(user, target));
  });

  // Aceitar pedido ("friend") ou bloquear ("blocked").
  app.put<{ Params: { userId: string } }>("/api/users/@me/relationships/:userId", async (request) => {
    const { user } = authenticate(request);
    limit(friendLimiter, `friend:${user.id}`);
    const target = isValidId(request.params.userId) ? store.getUser(request.params.userId) : undefined;
    if (!target || target.id === user.id) throw new HttpError(404, "user_not_found", "Pessoa não encontrada.");
    const { type } = relationshipBody.parse(request.body ?? {});
    const mine = store.relationshipOf(user.id, target.id);
    const theirs = store.relationshipOf(target.id, user.id);
    if (type === "friend") {
      if (mine === "friend") return relationshipOf(user, target);
      if (mine !== "incoming") throw new HttpError(400, "no_request", "Não há pedido de amizade dessa pessoa para aceitar.");
      setBoth(user, target, "friend", "friend");
    } else if (mine !== "blocked") {
      // bloquear desfaz amizade e pedidos; se a outra pessoa também me bloqueou, o bloqueio dela fica
      setBoth(user, target, "blocked", theirs === "blocked" ? "blocked" : null);
    }
    return relationshipOf(user, target);
  });

  // Desfazer: cancelar ou recusar pedido, desfazer amizade, desbloquear.
  app.delete<{ Params: { userId: string } }>("/api/users/@me/relationships/:userId", async (request, reply) => {
    const { user } = authenticate(request);
    limit(friendLimiter, `friend:${user.id}`);
    const target = isValidId(request.params.userId) ? store.getUser(request.params.userId) : undefined;
    if (!target) throw new HttpError(404, "user_not_found", "Pessoa não encontrada.");
    const mine = store.relationshipOf(user.id, target.id);
    if (mine === null) return reply.status(204).send();
    if (mine === "blocked") {
      store.setRelationship(user.id, target.id, null);
      announceRelationship(user.id, target, null);
    } else {
      const theirs = store.relationshipOf(target.id, user.id);
      setBoth(user, target, null, theirs === "blocked" ? "blocked" : null);
    }
    return reply.status(204).send();
  });

  const settingsOf = (userId: Id) => ({ dmPolicy: store.dmPolicyOf(userId), status: store.statusOf(userId), customStatus: store.customStatusOf(userId) });

  app.get("/api/users/@me/settings", async (request) => {
    const { user } = authenticate(request);
    return settingsOf(user.id);
  });

  // Preferência de mensagens diretas, status e status personalizado (vale em todos os aparelhos na hora).
  app.patch("/api/users/@me/settings", async (request) => {
    const { user } = authenticate(request);
    limit(actionLimiter, `action:${user.id}`);
    const body = settingsBody.parse(request.body ?? {});
    if (body.customStatus) {
      const { text, emoji, expiresAt } = body.customStatus;
      if (emoji !== null && !isValidEmoji(emoji)) throw new HttpError(400, "invalid_emoji", "Escolha um emoji para o status (ou nenhum).");
      if (!text && emoji === null) throw new HttpError(400, "invalid_request", "Escreva algo ou escolha um emoji para o status.");
      if (expiresAt !== null && !activeCustomStatus(body.customStatus)) throw new HttpError(400, "invalid_request", "Esse horário para limpar o status já passou.");
    }
    if (body.dmPolicy) store.setDmPolicy(user.id, body.dmPolicy);
    if (body.status) store.setStatus(user.id, body.status);
    if (body.customStatus !== undefined) store.setCustomStatus(user.id, body.customStatus);
    const settings = settingsOf(user.id);
    gateway.dispatchToUser(user.id, { t: "USER_SETTINGS_UPDATE", d: settings });
    gateway.refreshPresence(user.id);
    return settings;
  });

  /* ---------- conversas diretas ---------- */
  const dmFor = (channelId: Id, viewerId: Id): DmChannel => store.dmChannelFor(channelId, viewerId)!;
  /** Conversa a dois que alguém fechou volta a aparecer quando chega mensagem nova. */
  const reopenDm = (channelId: Id) => {
    for (const userId of store.hiddenRecipientsOf(channelId)) {
      store.setDmOpen(channelId, userId, true);
      gateway.dispatchToUser(userId, { t: "DM_CHANNEL_CREATE", d: dmFor(channelId, userId) });
    }
  };
  /** Todo mundo do grupo recebe a conversa como ela é para si. */
  const announceDm = (channelId: Id, t: "DM_CHANNEL_CREATE" | "DM_CHANNEL_UPDATE") => {
    for (const userId of store.recipientIdsOf(channelId)) gateway.dispatchToUser(userId, { t, d: dmFor(channelId, userId) });
  };
  /** Conversa direta da qual o usuário participa (404 se não). */
  const myDm = (channelId: string, userId: Id) => {
    const channel = isValidId(channelId) ? store.getConversation(channelId) : undefined;
    if (!channel?.dm || !channel.dm.recipientIds.includes(userId)) throw new HttpError(404, "not_found", "Conversa não encontrada.");
    return channel as ServerChannel & { dm: NonNullable<ServerChannel["dm"]> };
  };

  // Abrir conversa: com 1 pessoa é a conversa a dois (a mesma sempre); com mais, um grupo novo.
  app.post("/api/users/@me/channels", async (request, reply) => {
    const { user } = authenticate(request);
    limit(actionLimiter, `action:${user.id}`);
    const body = dmCreateBody.parse(request.body ?? {});
    const ids = [...new Set(body.recipientIds)].filter((id) => id !== user.id);
    const people = ids.map((id) => (isValidId(id) ? store.getUser(id) : undefined));
    if (ids.length === 0 || people.some((p) => !p)) throw new HttpError(404, "user_not_found", "Pessoa não encontrada.");
    if (ids.length === 1) {
      const other = people[0]!;
      if (store.isBlockedEither(user.id, other.id)) throw new HttpError(403, "dm_blocked", "Não dá para conversar com essa pessoa: uma de vocês bloqueou a outra.");
      const friends = store.relationshipOf(user.id, other.id) === "friend";
      const allowed = friends || (store.dmPolicyOf(other.id) === "servers" && store.sharesGuild(user.id, other.id));
      if (!allowed) {
        throw new HttpError(403, "dm_not_allowed", `${other.displayName} só recebe mensagens diretas de amigos (ou de quem divide servidor). Mande um pedido de amizade.`);
      }
      const id = store.findDm(user.id, other.id) ?? store.createDm(user.id, other.id);
      store.setDmOpen(id, user.id, true);
      const dm = dmFor(id, user.id);
      gateway.dispatchToUser(user.id, { t: "DM_CHANNEL_CREATE", d: dm });
      return reply.status(200).send(dm);
    }
    for (const p of people) {
      if (store.relationshipOf(user.id, p!.id) !== "friend") throw new HttpError(403, "not_friends", `Só dá para pôr amigos num grupo. Você e ${p!.displayName} ainda não são amigos.`);
    }
    const id = store.createGroupDm(user.id, ids, body.name || null);
    announceDm(id, "DM_CHANNEL_CREATE");
    return reply.status(201).send(dmFor(id, user.id));
  });

  // Renomear o grupo (qualquer pessoa do grupo; vazio = nomes das pessoas).
  app.patch<{ Params: { channelId: string } }>("/api/dms/:channelId", async (request) => {
    const { user } = authenticate(request);
    limit(actionLimiter, `action:${user.id}`);
    const dm = myDm(request.params.channelId, user.id);
    if (dm.dm.type !== "group_dm") throw new HttpError(400, "invalid_request", "Só grupos têm nome.");
    const { name } = groupNameBody.parse(request.body ?? {});
    store.renameGroupDm(dm.id, name || null);
    announceDm(dm.id, "DM_CHANNEL_UPDATE");
    return dmFor(dm.id, user.id);
  });

  // Fechar a conversa a dois (some da minha lista até chegar mensagem nova) ou sair do grupo.
  app.delete<{ Params: { channelId: string } }>("/api/dms/:channelId", async (request, reply) => {
    const { user } = authenticate(request);
    const dm = myDm(request.params.channelId, user.id);
    if (dm.dm.type === "dm") store.setDmOpen(dm.id, user.id, false);
    else if (!store.removeRecipient(dm.id, user.id).deleted) announceDm(dm.id, "DM_CHANNEL_UPDATE");
    gateway.dispatchToUser(user.id, { t: "DM_CHANNEL_DELETE", d: { id: dm.id } });
    return reply.status(204).send();
  });

  // Pôr alguém no grupo (amigo de quem põe; até 10 pessoas).
  app.put<{ Params: { channelId: string; userId: string } }>("/api/dms/:channelId/recipients/:userId", async (request) => {
    const { user } = authenticate(request);
    limit(actionLimiter, `action:${user.id}`);
    const dm = myDm(request.params.channelId, user.id);
    if (dm.dm.type !== "group_dm") throw new HttpError(400, "invalid_request", "Para conversar com mais gente, crie um grupo.");
    const target = isValidId(request.params.userId) ? store.getUser(request.params.userId) : undefined;
    if (!target) throw new HttpError(404, "user_not_found", "Pessoa não encontrada.");
    if (dm.dm.recipientIds.includes(target.id)) return dmFor(dm.id, user.id);
    if (store.relationshipOf(user.id, target.id) !== "friend") throw new HttpError(403, "not_friends", `Só dá para pôr amigos no grupo. Você e ${target.displayName} ainda não são amigos.`);
    if (dm.dm.recipientIds.length >= LIMITS.groupDmMax) throw new HttpError(400, "group_full", `O grupo já tem ${LIMITS.groupDmMax} pessoas.`);
    store.addRecipient(dm.id, target.id);
    announceDm(dm.id, "DM_CHANNEL_UPDATE");
    gateway.dispatchToUser(target.id, { t: "DM_CHANNEL_CREATE", d: dmFor(dm.id, target.id) });
    return dmFor(dm.id, user.id);
  });

  // Tirar do grupo: o dono tira qualquer um; cada um pode sair (é o DELETE /api/dms/:id).
  app.delete<{ Params: { channelId: string; userId: string } }>("/api/dms/:channelId/recipients/:userId", async (request, reply) => {
    const { user } = authenticate(request);
    limit(actionLimiter, `action:${user.id}`);
    const dm = myDm(request.params.channelId, user.id);
    const targetId = request.params.userId;
    if (dm.dm.type !== "group_dm" || !dm.dm.recipientIds.includes(targetId)) throw new HttpError(404, "not_found", "Essa pessoa não está no grupo.");
    if (targetId !== user.id && dm.dm.ownerId !== user.id) throw new HttpError(403, "owner_only", "Só quem criou o grupo pode tirar pessoas.");
    const { deleted } = store.removeRecipient(dm.id, targetId);
    gateway.dispatchToUser(targetId, { t: "DM_CHANNEL_DELETE", d: { id: dm.id } });
    if (!deleted) announceDm(dm.id, "DM_CHANNEL_UPDATE");
    return reply.status(204).send();
  });

  // Troca de senha: confere a atual e encerra as sessões dos outros aparelhos (esta continua).
  app.post("/api/users/@me/password", async (request, reply) => {
    const { user, tokenHash } = authenticate(request);
    limit(authLimiter, `password:${user.id}`);
    const body = passwordBody.parse(request.body);
    const currentHash = store.passwordHashOf(user.id);
    if (!currentHash || !(await verifyPassword(body.currentPassword, currentHash))) {
      throw new HttpError(400, "invalid_password", "A senha atual está errada. Confira e tente de novo.");
    }
    store.updatePassword(user.id, await hashPassword(body.newPassword));
    for (const other of store.deleteOtherSessions(user.id, tokenHash)) gateway.closeSession(other);
    return reply.status(204).send();
  });

  app.post("/api/guilds", async (request, reply) => {
    const { user } = authenticate(request);
    limit(actionLimiter, `action:${user.id}`);
    const { name } = guildBody.parse(request.body);
    const guild = store.createGuild(name, user.id, gateway);
    gateway.dispatchToUser(user.id, { t: "GUILD_CREATE", d: guild }); // o dono vê tudo
    return reply.status(201).send(guild);
  });

  app.post<{ Params: { guildId: string } }>("/api/guilds/:guildId/invites", async (request, reply) => {
    const { user } = authenticate(request);
    limit(actionLimiter, `action:${user.id}`);
    const guild = memberGuild(request.params.guildId, user.id);
    requirePermission(guild.id, user.id, "CREATE_INVITE");
    return reply.status(201).send(store.createInvite(guild.id, user.id));
  });

  /* ---------- configurações do servidor ---------- */
  type GuildParams = { Params: { guildId: string } };
  /** Servidor do qual o usuário é membro: só o id, sem montar o objeto inteiro. */
  const memberGuildId = (guildId: string, userId: Id): Id => {
    if (!isValidId(guildId) || !store.isMember(guildId, userId)) throw new HttpError(404, "not_found", "Servidor não encontrado.");
    return guildId;
  };

  app.patch<GuildParams>("/api/guilds/:guildId", async (request) => {
    const { user } = authenticate(request);
    limit(actionLimiter, `action:${user.id}`);
    const guildId = memberGuildId(request.params.guildId, user.id);
    requirePermission(guildId, user.id, "MANAGE_GUILD");
    const { name } = guildUpdateBody.parse(request.body);
    const before = store.guildName(guildId)!;
    if (name !== before) {
      store.renameGuild(guildId, name);
      store.audit(guildId, user.id, "guild_update", name, `nome: ${before} → ${name}`);
      gateway.dispatchToGuild(guildId, { t: "GUILD_UPDATE", d: { id: guildId, name, ...store.guildImages(guildId) } });
    }
    return { id: guildId, name, ...store.guildImages(guildId) };
  });

  // Imagem e capa do servidor: o app manda já recortadas e reduzidas (como a foto de perfil).
  const GUILD_IMAGE = {
    icon: { kind: "guild_icon", added: "imagem nova", removed: "imagem removida" },
    banner: { kind: "guild_banner", added: "capa nova", removed: "capa removida" },
  } as const;
  const replaceGuildImage = async (guildId: Id, userId: Id, which: "icon" | "banner", fileId: Id | null) => {
    const previous = store.setGuildImage(guildId, which, fileId);
    if (previous) {
      store.deleteFile(previous);
      await files.remove(previous);
    }
    const name = store.guildName(guildId)!;
    store.audit(guildId, userId, "guild_update", name, fileId ? GUILD_IMAGE[which].added : GUILD_IMAGE[which].removed);
    const result = { id: guildId, name, ...store.guildImages(guildId) };
    gateway.dispatchToGuild(guildId, { t: "GUILD_UPDATE", d: result });
    return result;
  };
  for (const which of ["icon", "banner"] as const) {
    app.put<GuildParams>(`/api/guilds/:guildId/${which}`, { bodyLimit: LIMITS.avatarMaxBytes }, async (request) => {
      const { user } = authenticate(request);
      limit(actionLimiter, `action:${user.id}`);
      const guildId = memberGuildId(request.params.guildId, user.id);
      requirePermission(guildId, user.id, "MANAGE_GUILD");
      const bytes = request.body;
      if (!Buffer.isBuffer(bytes) || bytes.length === 0) throw new HttpError(400, "invalid_request", "Envie a imagem.");
      const contentType = detectImageType(bytes);
      if (!contentType) throw new HttpError(415, "unsupported_type", "Esse arquivo não é uma imagem PNG, JPEG, WebP ou GIF.");
      const id = nextId();
      await files.write(id, bytes);
      store.createFile({ id, ownerId: user.id, kind: GUILD_IMAGE[which].kind, contentType, size: bytes.length, sha256: createHash("sha256").update(bytes).digest("hex"), createdAt: Date.now() });
      return replaceGuildImage(guildId, user.id, which, id);
    });
    app.delete<GuildParams>(`/api/guilds/:guildId/${which}`, async (request) => {
      const { user } = authenticate(request);
      limit(actionLimiter, `action:${user.id}`);
      const guildId = memberGuildId(request.params.guildId, user.id);
      requirePermission(guildId, user.id, "MANAGE_GUILD");
      return replaceGuildImage(guildId, user.id, which, null);
    });
  }

  app.delete<GuildParams>("/api/guilds/:guildId", async (request, reply) => {
    const { user } = authenticate(request);
    const guildId = memberGuildId(request.params.guildId, user.id);
    if (store.ownerOf(guildId) !== user.id) throw new HttpError(403, "owner_only", "Só o dono pode excluir o servidor.");
    for (const { userId, channelId } of gateway.voiceMembersOf(guildId)) rooms()?.removeParticipant(voiceRoom(channelId), userId).catch(() => undefined);
    gateway.forgetGuild(guildId);
    for (const image of Object.values(store.guildImages(guildId))) {
      if (!image) continue;
      store.deleteFile(image);
      await files.remove(image);
    }
    const members = store.deleteGuild(guildId);
    gateway.dispatchToUsers(members, { t: "GUILD_DELETE", d: { id: guildId } });
    return reply.status(204).send();
  });

  // Sair do servidor (o dono não sai: exclui ou, no futuro, transfere).
  app.delete<GuildParams>("/api/guilds/:guildId/members/@me", async (request, reply) => {
    const { user } = authenticate(request);
    const guildId = memberGuildId(request.params.guildId, user.id);
    if (store.ownerOf(guildId) === user.id) throw new HttpError(400, "owner_cannot_leave", "Você é o dono: para sair, exclua o servidor.");
    store.removeMember(guildId, user.id);
    dropMember(guildId, user.id);
    return reply.status(204).send();
  });

  /* cargos */
  app.post<GuildParams>("/api/guilds/:guildId/roles", async (request, reply) => {
    const { user } = authenticate(request);
    limit(actionLimiter, `action:${user.id}`);
    const guildId = memberGuildId(request.params.guildId, user.id);
    requirePermission(guildId, user.id, "MANAGE_ROLES");
    if (store.rolesOf(guildId).length >= ROLES_PER_GUILD) throw new HttpError(400, "too_many_roles", `O servidor já tem ${ROLES_PER_GUILD} cargos. Exclua algum para criar outro.`);
    const body = roleCreateBody.parse(request.body ?? {});
    const permissions = clampGrantedPermissions(store.permissionsOf(guildId, user.id), 0, body.permissions ?? 0);
    const role = store.createRole(guildId, { name: body.name ?? "novo cargo", color: body.color ?? null, permissions, hoist: body.hoist ?? false });
    store.audit(guildId, user.id, "role_create", role.name);
    broadcastRoles(guildId);
    return reply.status(201).send(role);
  });

  app.patch<{ Params: { guildId: string; roleId: string } }>("/api/guilds/:guildId/roles/:roleId", async (request) => {
    const { user } = authenticate(request);
    limit(actionLimiter, `action:${user.id}`);
    const guildId = memberGuildId(request.params.guildId, user.id);
    const role = guildRole(guildId, request.params.roleId);
    requireRoleControl(guildId, user.id, role);
    const body = roleUpdateBody.parse(request.body ?? {});
    const everyone = role.id === guildId;
    const before = store.visibility(guildId);
    const next = {
      name: everyone ? EVERYONE_ROLE_NAME : (body.name ?? role.name),
      color: everyone ? null : body.color === undefined ? role.color : body.color,
      hoist: everyone ? false : (body.hoist ?? role.hoist),
      permissions: body.permissions === undefined ? role.permissions : clampGrantedPermissions(store.permissionsOf(guildId, user.id), role.permissions, body.permissions),
    };
    store.updateRole(role.id, next);
    const changes = [
      next.name !== role.name && `nome: ${role.name} → ${next.name}`,
      next.permissions !== role.permissions && "permissões",
      next.color !== role.color && "cor",
      next.hoist !== role.hoist && (next.hoist ? "mostrar separado" : "não mostrar separado"),
    ].filter(Boolean);
    if (changes.length > 0) {
      store.audit(guildId, user.id, "role_update", next.name, changes.join(", "));
      broadcastRoles(guildId);
      if (next.permissions !== role.permissions) syncAccess(guildId, before);
    }
    return store.getRole(role.id);
  });

  // Subir/descer um cargo uma posição (troca com o vizinho; os dois precisam estar abaixo do seu).
  app.post<{ Params: { guildId: string; roleId: string } }>("/api/guilds/:guildId/roles/:roleId/move", async (request) => {
    const { user } = authenticate(request);
    limit(actionLimiter, `action:${user.id}`);
    const guildId = memberGuildId(request.params.guildId, user.id);
    const role = guildRole(guildId, request.params.roleId);
    if (role.id === guildId) throw new HttpError(400, "invalid_request", "O @todos fica sempre por último.");
    requireRoleControl(guildId, user.id, role);
    const { direction } = roleMoveBody.parse(request.body);
    const neighbor = store.rolesOf(guildId).find((r) => r.position === role.position + (direction === "up" ? 1 : -1));
    if (!neighbor || neighbor.id === guildId) return store.rolesOf(guildId); // já está no limite
    requireRoleControl(guildId, user.id, neighbor);
    store.swapRolePositions(role, neighbor);
    broadcastRoles(guildId);
    return store.rolesOf(guildId);
  });

  app.delete<{ Params: { guildId: string; roleId: string } }>("/api/guilds/:guildId/roles/:roleId", async (request, reply) => {
    const { user } = authenticate(request);
    limit(actionLimiter, `action:${user.id}`);
    const guildId = memberGuildId(request.params.guildId, user.id);
    const role = guildRole(guildId, request.params.roleId);
    if (role.id === guildId) throw new HttpError(400, "invalid_request", "O @todos não pode ser excluído.");
    requireRoleControl(guildId, user.id, role);
    const before = store.visibility(guildId);
    const touched = store.channelsOf(guildId).filter((c) => c.overwrites.some((o) => o.targetType === "role" && o.targetId === role.id));
    store.deleteRole(role); // as sobrescritas do cargo vão junto
    store.audit(guildId, user.id, "role_delete", role.name);
    broadcastRoles(guildId);
    for (const channel of touched) {
      const updated = store.getChannel(channel.id);
      if (updated) gateway.dispatchToChannel(updated, { t: "CHANNEL_UPDATE", d: updated });
    }
    syncAccess(guildId, before);
    return reply.status(204).send();
  });

  /* membros: dar/tirar cargo, expulsar, banir */
  type MemberRoleParams = { Params: { guildId: string; userId: string; roleId: string } };
  const setMemberRole = (request: FastifyRequest<MemberRoleParams>, add: boolean) => {
    const { user } = authenticate(request);
    limit(actionLimiter, `action:${user.id}`);
    const guildId = memberGuildId(request.params.guildId, user.id);
    const target = isValidId(request.params.userId) ? store.getMember(guildId, request.params.userId) : undefined;
    if (!target) throw new HttpError(404, "not_found", "Essa pessoa não está no servidor.");
    const role = guildRole(guildId, request.params.roleId);
    if (role.id === guildId) throw new HttpError(400, "invalid_request", "Todo mundo já tem o @todos.");
    requireRoleControl(guildId, user.id, role);
    const had = target.roles.includes(role.id);
    const before = store.visibility(guildId);
    const roles = store.setMemberRole(guildId, target.user.id, role.id, add);
    if (had !== add) {
      store.audit(guildId, user.id, add ? "member_role_add" : "member_role_remove", target.user.displayName, role.name);
      gateway.dispatchToGuild(guildId, { t: "MEMBER_UPDATE", d: { guildId, userId: target.user.id, roles, timeoutUntil: store.timeoutOf(guildId, target.user.id) } });
      syncAccess(guildId, before);
    }
    return { roles };
  };
  app.put<MemberRoleParams>("/api/guilds/:guildId/members/:userId/roles/:roleId", async (request) => setMemberRole(request, true));
  app.delete<MemberRoleParams>("/api/guilds/:guildId/members/:userId/roles/:roleId", async (request) => setMemberRole(request, false));

  type MemberParams = { Params: { guildId: string; userId: string } };
  const moderationTarget = (request: FastifyRequest<MemberParams>, userId: Id, permission: ModerationPermission) => {
    const guildId = memberGuildId(request.params.guildId, userId);
    requirePermission(guildId, userId, permission);
    const target = isValidId(request.params.userId) ? store.getMember(guildId, request.params.userId) : undefined;
    return { guildId, target };
  };
  const hierarchyError = (self: boolean) =>
    new HttpError(403, "member_hierarchy", self ? "Você não pode fazer isso consigo mesmo." : "Essa pessoa está no mesmo nível ou acima de você. Só dá para moderar quem está abaixo do seu cargo mais alto.");
  const requireOutranks = (guildId: Id, userId: Id, target: { user: User; roles: Id[] }, permission: ModerationPermission) => {
    if (!canModerate(contextOf(guildId), actorOf(guildId, userId), { userId: target.user.id, roleIds: target.roles }, permission)) {
      throw hierarchyError(target.user.id === userId);
    }
  };

  app.delete<MemberParams>("/api/guilds/:guildId/members/:userId", async (request, reply) => {
    const { user } = authenticate(request);
    limit(actionLimiter, `action:${user.id}`);
    const { guildId, target } = moderationTarget(request, user.id, "KICK_MEMBERS");
    if (!target) throw new HttpError(404, "not_found", "Essa pessoa não está no servidor.");
    requireOutranks(guildId, user.id, target, "KICK_MEMBERS");
    store.removeMember(guildId, target.user.id);
    store.audit(guildId, user.id, "member_kick", target.user.displayName);
    dropMember(guildId, target.user.id);
    return reply.status(204).send();
  });

  app.put<MemberParams>("/api/guilds/:guildId/bans/:userId", async (request, reply) => {
    const { user } = authenticate(request);
    limit(actionLimiter, `action:${user.id}`);
    const { guildId, target } = moderationTarget(request, user.id, "BAN_MEMBERS");
    const { reason } = banBody.parse(request.body ?? {});
    // dá para banir quem já saiu (para não voltar); quem ainda está precisa estar abaixo de você
    const banned = target?.user ?? (isValidId(request.params.userId) ? store.getUser(request.params.userId) : undefined);
    if (!banned) throw new HttpError(404, "not_found", "Conta não encontrada.");
    if (target) requireOutranks(guildId, user.id, target, "BAN_MEMBERS");
    else if (banned.id === user.id || banned.id === store.ownerOf(guildId)) throw new HttpError(403, "member_hierarchy", "Essa conta não pode ser banida.");
    store.ban(guildId, banned.id, reason || null, user.id);
    store.audit(guildId, user.id, "member_ban", banned.displayName, reason || null);
    if (target) dropMember(guildId, banned.id);
    return reply.status(204).send();
  });

  app.get<GuildParams>("/api/guilds/:guildId/bans", async (request) => {
    const { user } = authenticate(request);
    const guildId = memberGuildId(request.params.guildId, user.id);
    requirePermission(guildId, user.id, "BAN_MEMBERS");
    return store.bansOf(guildId);
  });

  app.delete<MemberParams>("/api/guilds/:guildId/bans/:userId", async (request, reply) => {
    const { user } = authenticate(request);
    limit(actionLimiter, `action:${user.id}`);
    const guildId = memberGuildId(request.params.guildId, user.id);
    requirePermission(guildId, user.id, "BAN_MEMBERS");
    const banned = isValidId(request.params.userId) ? store.getUser(request.params.userId) : undefined;
    if (!banned || !store.unban(guildId, banned.id)) throw new HttpError(404, "not_found", "Essa conta não está banida.");
    store.audit(guildId, user.id, "member_unban", banned.displayName);
    return reply.status(204).send();
  });

  /* castigo: só ver (sem escrever, reagir nem usar a voz) até a hora marcada */
  app.put<MemberParams>("/api/guilds/:guildId/members/:userId/timeout", async (request) => {
    const { user } = authenticate(request);
    limit(actionLimiter, `action:${user.id}`);
    const { guildId, target } = moderationTarget(request, user.id, "MODERATE_MEMBERS");
    if (!target) throw new HttpError(404, "not_found", "Essa pessoa não está no servidor.");
    requireOutranks(guildId, user.id, target, "MODERATE_MEMBERS");
    const { minutes } = timeoutBody.parse(request.body ?? {});
    if (minutes !== null && computePermissions(contextOf(guildId), target.user.id, target.roles) & PERMISSIONS.ADMINISTRATOR) {
      throw new HttpError(400, "cannot_timeout_admin", "Quem tem Administrador não fica de castigo. Tire o cargo com Administrador antes.");
    }
    const had = store.timeoutOf(guildId, target.user.id);
    const until = minutes === null ? null : Date.now() + minutes * 60_000;
    store.setTimeoutUntil(guildId, target.user.id, until);
    if (until !== null || had !== null) {
      store.audit(guildId, user.id, until === null ? "member_timeout_remove" : "member_timeout", target.user.displayName, minutes === null ? null : formatDuration(minutes));
      gateway.dispatchToGuild(guildId, { t: "MEMBER_UPDATE", d: { guildId, userId: target.user.id, roles: target.roles, timeoutUntil: until } });
      if (until !== null) refreshVoiceGrants(guildId, target.user.id); // de castigo, sai da voz
    }
    return { timeoutUntil: until };
  });

  /* voz: silenciar, mover para outra sala ou desconectar */
  app.patch<MemberParams>("/api/guilds/:guildId/members/:userId/voice", async (request, reply) => {
    const { user } = authenticate(request);
    limit(actionLimiter, `action:${user.id}`);
    const guildId = memberGuildId(request.params.guildId, user.id);
    const target = isValidId(request.params.userId) ? store.getMember(guildId, request.params.userId) : undefined;
    if (!target) throw new HttpError(404, "not_found", "Essa pessoa não está no servidor.");
    const body = voiceModerationBody.parse(request.body ?? {});
    if (body.muted === undefined && body.channelId === undefined) throw new HttpError(400, "invalid_request", "Escolha o que fazer: silenciar, mover ou desconectar.");
    if (!outranks(contextOf(guildId), actorOf(guildId, user.id), { userId: target.user.id, roleIds: target.roles })) throw hierarchyError(target.user.id === user.id);
    const currentId = gateway.voiceChannelOf(target.user.id);
    const current = currentId ? store.getChannel(currentId) : undefined;
    const here = current?.guildId === guildId ? current : undefined;

    if (body.muted !== undefined) {
      if (here) requireChannelPermission(here, user.id, "MUTE_MEMBERS");
      else requirePermission(guildId, user.id, "MUTE_MEMBERS");
      if (store.isServerMuted(guildId, target.user.id) !== body.muted) {
        store.setServerMuted(guildId, target.user.id, body.muted);
        gateway.setServerMuted(guildId, target.user.id, body.muted);
        if (here) {
          refreshVoiceGrants(guildId, target.user.id);
          if (body.muted) silenceMicrophone(here.id, target.user.id);
        }
        store.audit(guildId, user.id, body.muted ? "voice_mute" : "voice_unmute", target.user.displayName);
      }
    }

    if (body.channelId !== undefined) {
      if (!here) throw new HttpError(400, "not_in_voice", "Essa pessoa não está na voz deste servidor.");
      requireChannelPermission(here, user.id, "MOVE_MEMBERS");
      if (body.channelId === null) {
        gateway.dispatchToUser(target.user.id, { t: "VOICE_MOVE", d: { guildId, channelId: null } });
        evictFromVoice(guildId, target.user.id);
        store.audit(guildId, user.id, "voice_disconnect", target.user.displayName, here.name);
      } else {
        const to = isValidId(body.channelId) ? store.getChannel(body.channelId) : undefined;
        if (!to || to.guildId !== guildId || to.type !== "voice" || !hasPermission(store.channelPermissionsOf(to, user.id), "VIEW_CHANNEL")) {
          throw new HttpError(404, "not_found", "Sala de voz não encontrada.");
        }
        requireChannelPermission(to, user.id, "MOVE_MEMBERS");
        if (!hasPermission(store.channelPermissionsOf(to, target.user.id), "CONNECT")) {
          throw new HttpError(400, "cannot_connect", `${target.user.displayName} não pode entrar em ${to.name}. Libere "Conectar" nessa sala para a pessoa antes de mover.`);
        }
        if (gateway.moveVoice(target.user.id, to) !== null) {
          const from = here.id;
          // app que não trocar de sala sozinho (versão antiga) sai da sala de mídia antiga
          setTimeout(() => {
            if (gateway.voiceChannelOf(target.user.id) !== from) rooms()?.removeParticipant(voiceRoom(from), target.user.id).catch(() => undefined);
          }, MOVE_GRACE_MS).unref();
          store.audit(guildId, user.id, "voice_move", target.user.displayName, `${here.name} → ${to.name}`);
        }
      }
    }
    return reply.status(204).send();
  });

  /* convites e registro de auditoria */
  app.get<GuildParams>("/api/guilds/:guildId/invites", async (request) => {
    const { user } = authenticate(request);
    const guildId = memberGuildId(request.params.guildId, user.id);
    requirePermission(guildId, user.id, "MANAGE_GUILD");
    return store.invitesOf(guildId);
  });

  app.delete<{ Params: { code: string } }>("/api/invites/:code", async (request, reply) => {
    const { user } = authenticate(request);
    limit(actionLimiter, `action:${user.id}`);
    const invite = /^[A-Za-z0-9]{4,32}$/.test(request.params.code) ? store.findInvite(request.params.code) : undefined;
    if (!invite || !store.isMember(invite.guildId, user.id)) throw new HttpError(404, "invite_not_found", "Convite não encontrado.");
    requirePermission(invite.guildId, user.id, "MANAGE_GUILD");
    store.deleteInvite(invite.code);
    store.audit(invite.guildId, user.id, "invite_delete", invite.code);
    return reply.status(204).send();
  });

  app.get<GuildParams>("/api/guilds/:guildId/audit-log", async (request) => {
    const { user } = authenticate(request);
    const guildId = memberGuildId(request.params.guildId, user.id);
    requirePermission(guildId, user.id, "VIEW_AUDIT_LOG");
    const { before } = auditQuery.parse(request.query);
    return store.auditLog(guildId, before && isValidId(before) ? before : null, LIMITS.auditPageSize);
  });

  app.post<{ Params: { code: string } }>("/api/invites/:code", async (request) => {
    const { user } = authenticate(request);
    limit(actionLimiter, `action:${user.id}`);
    const invite = /^[A-Za-z0-9]{4,32}$/.test(request.params.code) ? store.findInvite(request.params.code) : undefined;
    if (!invite) throw new HttpError(404, "invite_not_found", "Convite inválido ou expirado. Confira o código.");
    if (store.isBanned(invite.guildId, user.id)) throw new HttpError(403, "banned", "Você foi banido deste servidor e não pode entrar de novo.");
    if (!store.isMember(invite.guildId, user.id)) {
      const member = store.addMember(invite.guildId, user, gateway);
      store.countInviteUse(invite.code);
      gateway.dispatchToGuild(invite.guildId, { t: "MEMBER_ADD", d: { guildId: invite.guildId, member } }, user.id);
      gateway.dispatchToUser(user.id, { t: "GUILD_CREATE", d: store.getGuild(invite.guildId, gateway, user.id)! });
    }
    return store.getGuild(invite.guildId, gateway, user.id);
  });

  app.post<{ Params: { guildId: string } }>("/api/guilds/:guildId/channels", async (request, reply) => {
    const { user } = authenticate(request);
    limit(actionLimiter, `action:${user.id}`);
    const guild = memberGuild(request.params.guildId, user.id);
    requirePermission(guild.id, user.id, "MANAGE_CHANNELS");
    const body = channelBody.parse(request.body);
    const type = body.type ?? "text";
    const name = type === "voice" ? normalizeVoiceChannelName(body.name) : normalizeChannelName(body.name);
    if (!name) throw new HttpError(400, "invalid_request", "Escolha um nome de canal com letras ou números.");
    const overwrites: Overwrite[] = [];
    if (body.private) {
      overwrites.push({ targetType: "role", targetId: guild.id, allow: 0, deny: PERMISSIONS.VIEW_CHANNEL });
      // quem cria continua vendo (dono e Administrador já veem tudo)
      if (!(store.permissionsOf(guild.id, user.id) & PERMISSIONS.ADMINISTRATOR)) overwrites.push({ targetType: "member", targetId: user.id, allow: PERMISSIONS.VIEW_CHANNEL, deny: 0 });
    }
    const channel = store.createChannel(guild.id, name, type, overwrites);
    store.audit(guild.id, user.id, "channel_create", channelLabel(channel), body.private ? "privado" : null);
    gateway.dispatchToChannel(channel, { t: "CHANNEL_CREATE", d: channel });
    return reply.status(201).send(channel);
  });

  app.patch<{ Params: { channelId: string } }>("/api/channels/:channelId", async (request) => {
    const { user } = authenticate(request);
    limit(actionLimiter, `action:${user.id}`);
    const channel = memberChannel(request.params.channelId, user.id);
    requirePermission(channel.guildId, user.id, "MANAGE_CHANNELS");
    const body = channelUpdateBody.parse(request.body);
    const name = channel.type === "voice" ? normalizeVoiceChannelName(body.name) : normalizeChannelName(body.name);
    if (!name) throw new HttpError(400, "invalid_request", "Escolha um nome de canal com letras ou números.");
    if (name !== channel.name) {
      store.renameChannel(channel.id, name);
      store.audit(channel.guildId, user.id, "channel_update", channelLabel({ ...channel, name }), `nome: ${channelLabel(channel)} → ${channelLabel({ ...channel, name })}`);
      gateway.dispatchToChannel(channel, { t: "CHANNEL_UPDATE", d: { ...channel, name } });
    }
    return { ...channel, name };
  });

  /* permissões do canal (sobrescritas para um cargo ou uma pessoa) */
  type OverwriteParams = { Params: { channelId: string; targetType: string; targetId: string } };
  const applyOverwrite = (request: FastifyRequest<OverwriteParams>, userId: Id, requested: { allow: number; deny: number }): Channel => {
    const channel = memberChannel(request.params.channelId, userId);
    requirePermission(channel.guildId, userId, "MANAGE_CHANNELS");
    const { targetType, targetId } = request.params;
    if ((targetType !== "role" && targetType !== "member") || !isValidId(targetId)) throw new HttpError(404, "not_found", "Cargo ou pessoa não encontrado.");
    const guildId = channel.guildId;
    const ctx = contextOf(guildId);
    const actor = actorOf(guildId, userId);
    let targetName: string;
    if (targetType === "role") {
      const role = guildRole(guildId, targetId);
      // @todos: quem gerencia canais pode; outro cargo: só os abaixo do seu
      if (role.id !== guildId && userId !== ctx.ownerId && role.position >= highestPosition(ctx, userId, actor.roleIds)) {
        throw new HttpError(403, "role_hierarchy", "Esse cargo está no mesmo nível ou acima do seu. Só dá para mudar as permissões de cargos abaixo do seu cargo mais alto.");
      }
      targetName = role.id === guildId ? EVERYONE_ROLE_NAME : role.name;
    } else {
      const member = store.getMember(guildId, targetId);
      if (!member) throw new HttpError(404, "not_found", "Essa pessoa não está no servidor.");
      if (member.user.id !== userId && !outranks(ctx, actor, { userId: member.user.id, roleIds: member.roles })) throw hierarchyError(false);
      targetName = member.user.displayName;
    }
    // só se libera ou bloqueia o que você mesmo tem neste canal; o resto fica como estava
    const mine = store.channelPermissionsOf(channel, userId);
    const previous = channel.overwrites.find((o) => o.targetType === targetType && o.targetId === targetId) ?? { allow: 0, deny: 0 };
    const allow = clampGrantedPermissions(mine, previous.allow, requested.allow & CHANNEL_PERMISSIONS) & CHANNEL_PERMISSIONS;
    const deny = clampGrantedPermissions(mine, previous.deny, requested.deny & CHANNEL_PERMISSIONS) & CHANNEL_PERMISSIONS & ~allow;
    if (allow === previous.allow && deny === previous.deny) return channel;
    const next: Overwrite[] = [
      ...channel.overwrites.filter((o) => !(o.targetType === targetType && o.targetId === targetId)),
      ...(allow || deny ? [{ targetType, targetId, allow, deny } as Overwrite] : []),
    ];
    if (!(computeChannelPermissions(ctx, userId, actor.roleIds, next) & PERMISSIONS.VIEW_CHANNEL)) {
      throw new HttpError(400, "lock_out", "Assim você perderia o acesso a este canal. Libere antes um cargo seu (ou você mesmo) e depois esconda o canal.");
    }
    const before = store.visibility(guildId);
    store.setOverwrite(channel.id, { targetType, targetId, allow, deny });
    const updated = store.getChannel(channel.id)!;
    store.audit(guildId, userId, "channel_permissions", channelLabel(channel), `${targetName}: ${describeOverwrite(allow, deny)}`);
    syncAccess(guildId, before);
    // quem já via recebe as regras novas (quem passou a ver já recebeu o canal inteiro)
    const kept = store.channelViewerIds(updated).filter((id) => before.get(id)?.has(channel.id));
    gateway.dispatchToUsers(kept, { t: "CHANNEL_UPDATE", d: updated });
    return updated;
  };
  app.put<OverwriteParams>("/api/channels/:channelId/overwrites/:targetType/:targetId", async (request) => {
    const { user } = authenticate(request);
    limit(actionLimiter, `action:${user.id}`);
    return applyOverwrite(request, user.id, overwriteBody.parse(request.body));
  });
  app.delete<OverwriteParams>("/api/channels/:channelId/overwrites/:targetType/:targetId", async (request) => {
    const { user } = authenticate(request);
    limit(actionLimiter, `action:${user.id}`);
    return applyOverwrite(request, user.id, { allow: 0, deny: 0 });
  });

  app.delete<{ Params: { channelId: string } }>("/api/channels/:channelId", async (request, reply) => {
    const { user } = authenticate(request);
    limit(actionLimiter, `action:${user.id}`);
    const channel = memberChannel(request.params.channelId, user.id);
    requirePermission(channel.guildId, user.id, "MANAGE_CHANNELS");
    if (channel.type === "text" && store.countChannels(channel.guildId, "text") <= 1) {
      throw new HttpError(400, "last_text_channel", "O servidor precisa de pelo menos um canal de texto. Crie outro antes de excluir este.");
    }
    if (channel.type === "voice") {
      for (const { userId, channelId } of gateway.voiceMembersOf(channel.guildId)) if (channelId === channel.id) rooms()?.removeParticipant(voiceRoom(channelId), userId).catch(() => undefined);
      gateway.leaveVoiceChannel(channel.id);
    }
    const viewers = store.channelViewerIds(channel);
    store.deleteChannel(channel.id);
    store.audit(channel.guildId, user.id, "channel_delete", channelLabel(channel));
    gateway.dispatchToUsers(viewers, { t: "CHANNEL_DELETE", d: { id: channel.id, guildId: channel.guildId } });
    return reply.status(204).send();
  });

  // Credencial para a sala de mídia do canal de voz (o áudio vai direto ao LiveKit, não passa por aqui).
  app.post<{ Params: { channelId: string } }>("/api/channels/:channelId/voice", async (request): Promise<VoiceToken> => {
    const { user } = authenticate(request);
    const channel = memberChannel(request.params.channelId, user.id);
    if (channel.type !== "voice") throw new HttpError(400, "invalid_request", "Este não é um canal de voz.");
    if (!voice) throw new HttpError(503, "voice_unavailable", "A voz não está configurada neste servidor.");
    requireChannelPermission(channel, user.id, "CONNECT");
    const room = voiceRoom(channel.id);
    const token = new AccessToken(voice.apiKey, voice.apiSecret, { identity: user.id, name: user.displayName, ttl: VOICE_TOKEN_TTL });
    const sources = publishSources(store.channelPermissionsOf(channel, user.id), store.isServerMuted(channel.guildId, user.id));
    token.addGrant({ room, roomJoin: true, canPublish: sources.length > 0, canPublishSources: sources, canSubscribe: true, canPublishData: false });
    const url = voice.url || `${request.protocol === "https" ? "wss" : "ws"}://${request.hostname}:7880`;
    // Sem o retransmissor, a voz ainda funciona para quem alcança o LiveKit direto (rede local).
    let iceServers: IceServer[] | undefined;
    if (turn) {
      try {
        iceServers = await turn();
      } catch (error) {
        request.log.warn({ err: error }, "retransmissor TURN indisponível: esta entrada na voz segue só com conexão direta");
      }
    }
    return { url, token: await token.toJwt(), room, ...(iceServers && { iceServers }) };
  });

  app.get<{ Params: { channelId: string } }>("/api/channels/:channelId/messages", async (request) => {
    const { user } = authenticate(request);
    const channel = chatChannel(request.params.channelId, user.id);
    const query = pageQuery.parse(request.query);
    const before = query.before && isValidId(query.before) ? query.before : null;
    return store.listMessages(channel.id, before, query.limit ?? LIMITS.pageSize);
  });

  app.post<{ Params: { channelId: string } }>("/api/channels/:channelId/messages", async (request, reply) => {
    const { user } = authenticate(request);
    const channel = chatChannel(request.params.channelId, user.id);
    requireChannelPermission(channel, user.id, "SEND_MESSAGES");
    limit(messageLimiter, `msg:${user.id}`);
    const body = messageBody.parse(request.body);
    const attachmentIds = [...new Set(body.attachmentIds ?? [])];
    if (!body.content && attachmentIds.length === 0) throw new HttpError(400, "invalid_request", "A mensagem está vazia.");
    if (attachmentIds.length > 0 && store.pendingAttachments(attachmentIds.filter(isValidId), user.id, channel.id).length !== attachmentIds.length) {
      throw new HttpError(400, "attachment_not_found", "Um dos arquivos não foi encontrado (pode ter expirado). Envie de novo.");
    }
    let replyAuthorId: Id | null = null;
    if (body.replyToId !== undefined) {
      const original = isValidId(body.replyToId) ? store.getMessage(body.replyToId) : undefined;
      if (!original || original.channelId !== channel.id) throw new HttpError(400, "reply_not_found", "A mensagem que você quer responder foi apagada.");
      replyAuthorId = original.author.id;
    }
    const mentions = mentionsFor(channel, body.content, replyAuthorId, user.id);
    const created = store.createMessage(channel.id, user, body.content, body.replyToId ?? null, mentions, attachmentIds);
    store.ack(user.id, channel.id, created.id); // o que eu escrevi já está lido
    const message = { ...created, ...(body.nonce ? { nonce: body.nonce } : {}) };
    if (channel.dm) reopenDm(channel.id);
    gateway.dispatchToChannel(channel, { t: "MESSAGE_CREATE", d: message });
    return reply.status(201).send(message);
  });

  app.patch<{ Params: { messageId: string } }>("/api/messages/:messageId", async (request) => {
    const { user } = authenticate(request);
    const message = isValidId(request.params.messageId) ? store.getMessage(request.params.messageId) : undefined;
    if (!message) throw new HttpError(404, "not_found", "Mensagem não encontrada.");
    const channel = chatChannel(message.channelId, user.id);
    if (message.author.id !== user.id) throw new HttpError(403, "forbidden", "Você só pode editar as suas mensagens.");
    const { content } = editBody.parse(request.body);
    const updated = store.updateMessage(message.id, content, mentionsFor(channel, content, message.replyTo?.author?.id, user.id))!;
    gateway.dispatchToChannel(channel, { t: "MESSAGE_UPDATE", d: updated });
    return updated;
  });

  app.delete<{ Params: { messageId: string } }>("/api/messages/:messageId", async (request, reply) => {
    const { user } = authenticate(request);
    const message = isValidId(request.params.messageId) ? store.getMessage(request.params.messageId) : undefined;
    if (!message) throw new HttpError(404, "not_found", "Mensagem não encontrada.");
    const channel = chatChannel(message.channelId, user.id);
    if (message.author.id !== user.id && !hasPermission(store.channelPermissionsOf(channel, user.id), "MANAGE_MESSAGES")) {
      throw new HttpError(403, "forbidden", "Você só pode apagar as suas mensagens.");
    }
    const attached = store.attachmentIdsOf(message.id);
    store.deleteMessage(message.id);
    for (const fileId of attached) {
      store.deleteFile(fileId);
      await files.remove(fileId);
    }
    gateway.dispatchToChannel(channel, { t: "MESSAGE_DELETE", d: { id: message.id, channelId: channel.id } });
    return reply.status(204).send();
  });

  /* ---------- anexos ---------- */
  // O app envia cada arquivo assim que é escolhido (com progresso); a mensagem depois só cita os ids.
  app.post<{ Params: { channelId: string } }>("/api/channels/:channelId/attachments", { bodyLimit: LIMITS.attachmentMaxBytes }, async (request, reply) => {
    const { user } = authenticate(request);
    const channel = chatChannel(request.params.channelId, user.id);
    requireChannelPermission(channel, user.id, "SEND_MESSAGES");
    limit(uploadLimiter, `upload:${user.id}`);
    const bytes = request.body;
    if (!Buffer.isBuffer(bytes) || bytes.length === 0) throw new HttpError(400, "invalid_request", "O arquivo está vazio.");
    const query = uploadQuery.parse(request.query);
    const image = detectImageType(bytes);
    const file = {
      id: nextId(),
      ownerId: user.id,
      kind: "attachment" as const,
      // imagem só com o tipo conferido pelos bytes; o resto sempre como download
      contentType: image ?? "application/octet-stream",
      size: bytes.length,
      sha256: createHash("sha256").update(bytes).digest("hex"),
      createdAt: Date.now(),
      filename: cleanFilename(query.filename, LIMITS.filenameMax),
      channelId: channel.id,
      messageId: null,
      width: image ? (query.width ?? null) : null,
      height: image ? (query.height ?? null) : null,
    };
    await files.write(file.id, bytes);
    store.createFile(file);
    return reply.status(201).send({ id: file.id, filename: file.filename, size: file.size, contentType: file.contentType, width: file.width, height: file.height, url: "" });
  });

  // Link assinado (vem junto da mensagem, só para quem vê o canal). Sem login: <img> não manda o token.
  app.get<{ Params: { fileId: string; filename: string }; Querystring: { ex?: string; sig?: string } }>("/api/attachments/:fileId/:filename", async (request, reply) => {
    const { fileId } = request.params;
    const valid = isValidId(fileId) && verifyAttachment(store.attachmentSecret, fileId, request.query.ex, request.query.sig);
    const file = valid ? store.getFile(fileId) : undefined;
    if (!file || file.kind !== "attachment" || file.messageId == null) throw new HttpError(404, "not_found", "Arquivo não encontrado ou link vencido. Abra a mensagem de novo para ter um link novo.");
    const bytes = await files.read(file.id).catch(() => null);
    if (!bytes) throw new HttpError(404, "not_found", "Arquivo não encontrado.");
    const inline = file.contentType.startsWith("image/");
    const name = file.filename ?? "arquivo";
    const ascii = name.replace(/[^\x20-\x7e]/g, "_").replace(/["\\]/g, "_");
    return reply
      .header("Content-Type", file.contentType)
      .header("X-Content-Type-Options", "nosniff")
      .header("Content-Security-Policy", "default-src 'none'; sandbox")
      .header("Cross-Origin-Resource-Policy", "cross-origin")
      .header("Cache-Control", "private, max-age=3600")
      .header("Content-Disposition", `${inline ? "inline" : "attachment"}; filename="${ascii}"; filename*=UTF-8''${encodeURIComponent(name)}`)
      .send(bytes);
  });

  /* ---------- reações ---------- */
  type ReactionParams = { Params: { channelId: string; messageId: string; emoji: string } };
  const reactionTarget = (request: FastifyRequest<ReactionParams>, userId: Id) => {
    const { channel, message } = channelMessage(request.params.channelId, request.params.messageId, userId);
    const emoji = request.params.emoji;
    if (!isValidEmoji(emoji)) throw new HttpError(400, "invalid_emoji", "Reação inválida. Escolha um emoji.");
    return { channel, message, emoji };
  };

  app.put<ReactionParams>("/api/channels/:channelId/messages/:messageId/reactions/:emoji", async (request, reply) => {
    const { user } = authenticate(request);
    limit(reactionLimiter, `react:${user.id}`);
    const { channel, message, emoji } = reactionTarget(request, user.id);
    requireChannelPermission(channel, user.id, "ADD_REACTIONS");
    if (!store.hasReactionEmoji(message.id, emoji) && store.reactionKinds(message.id) >= LIMITS.reactionsPerMessage) {
      throw new HttpError(400, "too_many_reactions", "Esta mensagem já tem reações demais. Use um dos emojis que já estão nela.");
    }
    if (store.addReaction(message.id, user.id, emoji)) {
      gateway.dispatchToChannel(channel, { t: "MESSAGE_REACTION_ADD", d: { channelId: channel.id, messageId: message.id, userId: user.id, emoji } });
    }
    return reply.status(204).send();
  });

  app.delete<ReactionParams>("/api/channels/:channelId/messages/:messageId/reactions/:emoji", async (request, reply) => {
    const { user } = authenticate(request);
    limit(reactionLimiter, `react:${user.id}`);
    const { channel, message, emoji } = reactionTarget(request, user.id);
    if (store.removeReaction(message.id, user.id, emoji)) {
      gateway.dispatchToChannel(channel, { t: "MESSAGE_REACTION_REMOVE", d: { channelId: channel.id, messageId: message.id, userId: user.id, emoji } });
    }
    return reply.status(204).send();
  });

  /* ---------- leitura ---------- */
  app.post<{ Params: { channelId: string } }>("/api/channels/:channelId/ack", async (request, reply) => {
    const { user } = authenticate(request);
    limit(ackLimiter, `ack:${user.id}`);
    const { messageId } = ackBody.parse(request.body);
    const { channel, message } = channelMessage(request.params.channelId, messageId, user.id);
    if (store.ack(user.id, channel.id, message.id)) {
      gateway.dispatchToUser(user.id, { t: "READ_STATE_UPDATE", d: { channelId: channel.id, lastReadId: message.id } });
    }
    return reply.status(204).send();
  });

  app.get(GATEWAY_PATH, { websocket: true }, (socket) => gateway.handle(socket));

  if (releasesDir) registerUpdateRoutes(app, releasesDir);
  if (siteDir) registerSiteRoutes(app, siteDir);

  return app;
}
