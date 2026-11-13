import Fastify, { type FastifyInstance, type FastifyRequest } from "fastify";
import cors from "@fastify/cors";
import websocket from "@fastify/websocket";
import { z } from "zod";
import { AccessToken } from "livekit-server-sdk";
import {
  GATEWAY_PATH,
  LIMITS,
  USERNAME_PATTERN,
  extractMentionIds,
  isValidEmoji,
  normalizeChannelName,
  normalizeVoiceChannelName,
  type AuthResponse,
  type Channel,
  type Guild,
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
import type { Store } from "./store.ts";
import { registerSiteRoutes } from "./site.ts";
import type { IceServerSource } from "./turn.ts";
import { registerUpdateRoutes } from "./updates.ts";

export const SERVER_VERSION = "1.4.1";

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
const loginBody = z.object({
  username: z.string().trim().toLowerCase().min(1, "Informe o usuário."),
  password: z.string().min(1, "Informe a senha."),
});
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
});
const messageBody = z.object({ content: contentField, nonce: z.string().max(64).optional(), replyToId: z.string().max(20).optional() });
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
  /** Servidor de mídia LiveKit. `url` vazio = mesmo host pelo qual o cliente chegou, porta 7880. */
  voice?: { apiKey: string; apiSecret: string; url?: string };
  /** Retransmissor TURN (credenciais temporárias por entrada na voz). Sem ele, só conexão direta à mídia. */
  turn?: IceServerSource;
  /** Pasta do site de download (apps/site/dist). Sem ela, "/" responde 404. */
  siteDir?: string;
  /**
   * Atrás do Cloudflare Tunnel todo acesso chega de 127.0.0.1: o IP real vem em `CF-Connecting-IP`.
   * Só ligue com o servidor escutando em 127.0.0.1 (senão qualquer um na rede forja o cabeçalho).
   */
  trustCloudflare?: boolean;
}

const VOICE_TOKEN_TTL = "6h";

export async function buildApp({ store, gateway, logger = false, releasesDir, voice, turn, siteDir, trustCloudflare = false }: Deps): Promise<FastifyInstance> {
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

  const authLimiter = new RateLimiter(10, 60_000);
  const messageLimiter = new RateLimiter(10, 10_000);
  const actionLimiter = new RateLimiter(30, 60_000);
  const reactionLimiter = new RateLimiter(20, 10_000);
  const ackLimiter = new RateLimiter(60, 10_000);

  app.setErrorHandler((error, request, reply) => {
    if (error instanceof HttpError) {
      return reply.status(error.status).send({ error: { code: error.code, message: error.message } });
    }
    if (error instanceof z.ZodError) {
      return reply.status(400).send({ error: { code: "invalid_request", message: error.issues[0]?.message ?? "Requisição inválida." } });
    }
    const status = (error as { statusCode?: number }).statusCode;
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
  const memberChannel = (channelId: string, userId: Id): Channel => {
    const channel = isValidId(channelId) ? store.getChannel(channelId) : undefined;
    if (!channel || !store.isMember(channel.guildId, userId)) throw new HttpError(404, "not_found", "Canal não encontrado.");
    return channel;
  };
  /** Menções válidas: só membros do servidor, mais o autor da mensagem respondida (como no Discord). */
  const mentionsFor = (guildId: Id, content: string, replyAuthorId: Id | null | undefined, authorId: Id): Id[] => {
    const members = new Set(store.memberIds(guildId));
    const ids = extractMentionIds(content).filter((id) => members.has(id));
    if (replyAuthorId && replyAuthorId !== authorId && members.has(replyAuthorId) && !ids.includes(replyAuthorId)) ids.push(replyAuthorId);
    return ids.slice(0, LIMITS.mentionsPerMessage);
  };
  /** Mensagem de um canal de texto do qual o usuário é membro (404 se não for). */
  const channelMessage = (channelId: string, messageId: string, userId: Id): { channel: Channel; message: Message } => {
    const channel = memberChannel(channelId, userId);
    const message = isValidId(messageId) ? store.getMessage(messageId) : undefined;
    if (!message || message.channelId !== channel.id) throw new HttpError(404, "not_found", "Mensagem não encontrada.");
    return { channel, message };
  };
  const startSession = (user: User): AuthResponse => {
    const token = newSessionToken();
    store.createSession(hashToken(token), user.id);
    return { token, user };
  };

  /* ---------- rotas ---------- */
  app.get("/api/health", async () => ({ ok: true, version: SERVER_VERSION, voiceRelay: Boolean(turn) }));

  app.post("/api/auth/register", async (request, reply) => {
    limit(authLimiter, `auth:${clientIp(request)}`);
    const body = registerBody.parse(request.body);
    if (store.usernameExists(body.username)) throw new HttpError(409, "username_taken", "Esse nome de usuário já está em uso.");
    const user = store.createUser(body.username, body.displayName ?? body.username, await hashPassword(body.password));
    return reply.status(201).send(startSession(user));
  });

  app.post("/api/auth/login", async (request) => {
    limit(authLimiter, `auth:${clientIp(request)}`);
    const body = loginBody.parse(request.body);
    const credentials = store.findCredentials(body.username);
    const ok = credentials ? await verifyPassword(body.password, credentials.passwordHash) : await verifyAgainstDummy(body.password);
    if (!credentials || !ok) throw new HttpError(401, "invalid_credentials", "Usuário ou senha incorretos.");
    return startSession(credentials.user);
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
    gateway.dispatchToUser(user.id, { t: "GUILD_CREATE", d: guild });
    return reply.status(201).send(guild);
  });

  app.post<{ Params: { guildId: string } }>("/api/guilds/:guildId/invites", async (request, reply) => {
    const { user } = authenticate(request);
    limit(actionLimiter, `action:${user.id}`);
    const guild = memberGuild(request.params.guildId, user.id);
    return reply.status(201).send(store.createInvite(guild.id, user.id));
  });

  app.post<{ Params: { code: string } }>("/api/invites/:code", async (request) => {
    const { user } = authenticate(request);
    limit(actionLimiter, `action:${user.id}`);
    const invite = /^[A-Za-z0-9]{4,32}$/.test(request.params.code) ? store.findInvite(request.params.code) : undefined;
    if (!invite) throw new HttpError(404, "invite_not_found", "Convite inválido ou expirado. Confira o código.");
    if (!store.isMember(invite.guildId, user.id)) {
      const member = store.addMember(invite.guildId, user, gateway);
      store.countInviteUse(invite.code);
      gateway.dispatchToGuild(invite.guildId, { t: "MEMBER_ADD", d: { guildId: invite.guildId, member } }, user.id);
      gateway.dispatchToUser(user.id, { t: "GUILD_CREATE", d: store.getGuild(invite.guildId, gateway)! });
    }
    return store.getGuild(invite.guildId, gateway);
  });

  app.post<{ Params: { guildId: string } }>("/api/guilds/:guildId/channels", async (request, reply) => {
    const { user } = authenticate(request);
    limit(actionLimiter, `action:${user.id}`);
    const guild = memberGuild(request.params.guildId, user.id);
    if (guild.ownerId !== user.id) throw new HttpError(403, "forbidden", "Só o dono do servidor pode criar canais.");
    const body = channelBody.parse(request.body);
    const type = body.type ?? "text";
    const name = type === "voice" ? normalizeVoiceChannelName(body.name) : normalizeChannelName(body.name);
    if (!name) throw new HttpError(400, "invalid_request", "Escolha um nome de canal com letras ou números.");
    const channel = store.createChannel(guild.id, name, type);
    gateway.dispatchToGuild(guild.id, { t: "CHANNEL_CREATE", d: channel });
    return reply.status(201).send(channel);
  });

  // Credencial para a sala de mídia do canal de voz (o áudio vai direto ao LiveKit, não passa por aqui).
  app.post<{ Params: { channelId: string } }>("/api/channels/:channelId/voice", async (request): Promise<VoiceToken> => {
    const { user } = authenticate(request);
    const channel = memberChannel(request.params.channelId, user.id);
    if (channel.type !== "voice") throw new HttpError(400, "invalid_request", "Este não é um canal de voz.");
    if (!voice) throw new HttpError(503, "voice_unavailable", "A voz não está configurada neste servidor.");
    const room = `aurora-voice-${channel.id}`;
    const token = new AccessToken(voice.apiKey, voice.apiSecret, { identity: user.id, name: user.displayName, ttl: VOICE_TOKEN_TTL });
    token.addGrant({ room, roomJoin: true, canPublish: true, canSubscribe: true, canPublishData: false });
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
    const channel = memberChannel(request.params.channelId, user.id);
    if (channel.type !== "text") throw new HttpError(400, "invalid_request", "Canais de voz não têm mensagens.");
    const query = pageQuery.parse(request.query);
    const before = query.before && isValidId(query.before) ? query.before : null;
    return store.listMessages(channel.id, before, query.limit ?? LIMITS.pageSize);
  });

  app.post<{ Params: { channelId: string } }>("/api/channels/:channelId/messages", async (request, reply) => {
    const { user } = authenticate(request);
    const channel = memberChannel(request.params.channelId, user.id);
    if (channel.type !== "text") throw new HttpError(400, "invalid_request", "Canais de voz não têm mensagens.");
    limit(messageLimiter, `msg:${user.id}`);
    const body = messageBody.parse(request.body);
    let replyAuthorId: Id | null = null;
    if (body.replyToId !== undefined) {
      const original = isValidId(body.replyToId) ? store.getMessage(body.replyToId) : undefined;
      if (!original || original.channelId !== channel.id) throw new HttpError(400, "reply_not_found", "A mensagem que você quer responder foi apagada.");
      replyAuthorId = original.author.id;
    }
    const mentions = mentionsFor(channel.guildId, body.content, replyAuthorId, user.id);
    const created = store.createMessage(channel.id, user, body.content, body.replyToId ?? null, mentions);
    store.ack(user.id, channel.id, created.id); // o que eu escrevi já está lido
    const message = { ...created, ...(body.nonce ? { nonce: body.nonce } : {}) };
    gateway.dispatchToGuild(channel.guildId, { t: "MESSAGE_CREATE", d: message });
    return reply.status(201).send(message);
  });

  app.patch<{ Params: { messageId: string } }>("/api/messages/:messageId", async (request) => {
    const { user } = authenticate(request);
    const message = isValidId(request.params.messageId) ? store.getMessage(request.params.messageId) : undefined;
    if (!message) throw new HttpError(404, "not_found", "Mensagem não encontrada.");
    const channel = memberChannel(message.channelId, user.id);
    if (message.author.id !== user.id) throw new HttpError(403, "forbidden", "Você só pode editar as suas mensagens.");
    const { content } = editBody.parse(request.body);
    const updated = store.updateMessage(message.id, content, mentionsFor(channel.guildId, content, message.replyTo?.author?.id, user.id))!;
    gateway.dispatchToGuild(channel.guildId, { t: "MESSAGE_UPDATE", d: updated });
    return updated;
  });

  app.delete<{ Params: { messageId: string } }>("/api/messages/:messageId", async (request, reply) => {
    const { user } = authenticate(request);
    const message = isValidId(request.params.messageId) ? store.getMessage(request.params.messageId) : undefined;
    if (!message) throw new HttpError(404, "not_found", "Mensagem não encontrada.");
    const channel = memberChannel(message.channelId, user.id);
    const guild = memberGuild(channel.guildId, user.id);
    if (message.author.id !== user.id && guild.ownerId !== user.id) {
      throw new HttpError(403, "forbidden", "Você só pode apagar as suas mensagens.");
    }
    store.deleteMessage(message.id);
    gateway.dispatchToGuild(channel.guildId, { t: "MESSAGE_DELETE", d: { id: message.id, channelId: channel.id } });
    return reply.status(204).send();
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
    if (!store.hasReactionEmoji(message.id, emoji) && store.reactionKinds(message.id) >= LIMITS.reactionsPerMessage) {
      throw new HttpError(400, "too_many_reactions", "Esta mensagem já tem reações demais. Use um dos emojis que já estão nela.");
    }
    if (store.addReaction(message.id, user.id, emoji)) {
      gateway.dispatchToGuild(channel.guildId, { t: "MESSAGE_REACTION_ADD", d: { channelId: channel.id, messageId: message.id, userId: user.id, emoji } });
    }
    return reply.status(204).send();
  });

  app.delete<ReactionParams>("/api/channels/:channelId/messages/:messageId/reactions/:emoji", async (request, reply) => {
    const { user } = authenticate(request);
    limit(reactionLimiter, `react:${user.id}`);
    const { channel, message, emoji } = reactionTarget(request, user.id);
    if (store.removeReaction(message.id, user.id, emoji)) {
      gateway.dispatchToGuild(channel.guildId, { t: "MESSAGE_REACTION_REMOVE", d: { channelId: channel.id, messageId: message.id, userId: user.id, emoji } });
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
