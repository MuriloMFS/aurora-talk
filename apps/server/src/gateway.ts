import type { WebSocket } from "ws";
import { hasPermission, CLOSE_CODES, HEARTBEAT_INTERVAL_MS, V2_EVENTS, type Channel, type ClientFrame, type DispatchEvent, type Id, type ServerFrame, type VoiceState } from "@aurora/schema";
import { hashToken } from "./auth.ts";
import { RateLimiter } from "./rate-limit.ts";
import type { LiveState, Store } from "./store.ts";

const IDENTIFY_TIMEOUT_MS = 10_000;
const OPEN = 1;

interface Connection {
  socket: WebSocket;
  userId: Id;
  tokenHash: string;
  /** Versão do protocolo do cliente (`identify.v`); 1 = app 1.2.x. */
  version: number;
}

/** Sessão de voz de um usuário (uma por vez), presa à conexão que entrou. */
interface VoiceSession {
  guildId: Id;
  state: VoiceState;
  connection: Connection;
}

function parseFrame(raw: string): ClientFrame | null {
  try {
    const value: unknown = JSON.parse(raw);
    if (typeof value !== "object" || value === null || !("op" in value)) return null;
    const f = value as { op: unknown; token?: unknown; v?: unknown; channelId?: unknown; muted?: unknown; deafened?: unknown; streaming?: unknown };
    const flags = typeof f.muted === "boolean" && typeof f.deafened === "boolean";
    switch (f.op) {
      case "heartbeat":
        return { op: "heartbeat" };
      case "identify":
        if (typeof f.token !== "string") return null;
        return Number.isInteger(f.v) ? { op: "identify", token: f.token, v: f.v as number } : { op: "identify", token: f.token };
      case "typing":
        return typeof f.channelId === "string" ? { op: "typing", channelId: f.channelId } : null;
      case "voice_join":
        return typeof f.channelId === "string" && flags ? { op: "voice_join", channelId: f.channelId, muted: f.muted as boolean, deafened: f.deafened as boolean } : null;
      case "voice_state":
        return flags && typeof f.streaming === "boolean"
          ? { op: "voice_state", muted: f.muted as boolean, deafened: f.deafened as boolean, streaming: f.streaming }
          : null;
      case "voice_leave":
        return { op: "voice_leave" };
      default:
        return null;
    }
  } catch {
    return null;
  }
}

/** Conexões WebSocket, presença, voz e fan-out de eventos (em memória, 1 processo). */
export class Gateway implements LiveState {
  private readonly connections = new Map<Id, Set<Connection>>();
  private readonly voice = new Map<Id, VoiceSession>();
  private readonly typingLimiter = new RateLimiter(1, 3_000);
  private readonly store: Store;
  /** Durante o desligamento as conexões fecham depois do banco: não consultar mais nada. */
  private closing = false;

  constructor(store: Store) {
    this.store = store;
  }

  readonly isOnline = (userId: Id): boolean => (this.connections.get(userId)?.size ?? 0) > 0;

  voiceStatesOf(guildId: Id): VoiceState[] {
    return [...this.voice.values()].filter((v) => v.guildId === guildId).map((v) => v.state);
  }

  handle(socket: WebSocket): void {
    let connection: Connection | null = null;
    let lastHeartbeat = Date.now();
    const send = (frame: ServerFrame) => {
      if (socket.readyState === OPEN) socket.send(JSON.stringify(frame));
    };

    send({ op: "hello", heartbeatIntervalMs: HEARTBEAT_INTERVAL_MS });
    const identifyTimer = setTimeout(() => {
      if (!connection) socket.close(CLOSE_CODES.identifyTimeout, "identify timeout");
    }, IDENTIFY_TIMEOUT_MS);
    const heartbeatTimer = setInterval(() => {
      if (Date.now() - lastHeartbeat > HEARTBEAT_INTERVAL_MS * 2) socket.close(CLOSE_CODES.heartbeatTimeout, "heartbeat timeout");
    }, HEARTBEAT_INTERVAL_MS);

    socket.on("message", (data, isBinary) => {
      if (this.closing) return;
      const frame = isBinary ? null : parseFrame(data.toString());
      if (!frame) {
        socket.close(CLOSE_CODES.invalidFrame, "invalid frame");
        return;
      }
      if (frame.op === "heartbeat") {
        lastHeartbeat = Date.now();
        send({ op: "heartbeat_ack" });
        return;
      }
      if (frame.op === "identify") {
        if (connection) return;
        const tokenHash = hashToken(frame.token);
        const user = this.store.sessionUser(tokenHash);
        if (!user) {
          send({ op: "invalid_session", reason: "Sessão inválida ou expirada." });
          socket.close(CLOSE_CODES.invalidSession, "invalid session");
          return;
        }
        connection = { socket, userId: user.id, tokenHash, version: frame.v ?? 1 };
        const first = this.register(connection);
        lastHeartbeat = Date.now();
        const guilds = this.store.guildsOf(user.id, this);
        // leitura só dos canais que a pessoa vê (canal privado não aparece nem como "não lido")
        const visible = new Set(guilds.flatMap((g) => g.channels.map((c) => c.id)));
        const readStates = this.store.readStatesOf(user.id).filter((r) => visible.has(r.channelId));
        send(connection.version >= 2 ? { op: "ready", user, guilds, readStates } : { op: "ready", user, guilds });
        if (first) this.broadcastPresence(user.id, true);
        return;
      }
      if (!connection) return; // demais operações exigem identify
      switch (frame.op) {
        case "typing": {
          const channel = this.store.getChannel(frame.channelId);
          if (!channel || channel.type !== "text") return;
          if (!hasPermission(this.store.channelPermissionsOf(channel, connection.userId), "SEND_MESSAGES")) return;
          if (!this.typingLimiter.allow(`${connection.userId}:${channel.id}`)) return;
          this.dispatchToChannel(channel, { t: "TYPING_START", d: { channelId: channel.id, userId: connection.userId } }, connection.userId);
          return;
        }
        case "voice_join":
          this.joinVoice(connection, frame.channelId, frame.muted, frame.deafened);
          return;
        case "voice_state": {
          const session = this.voice.get(connection.userId);
          if (!session || session.connection !== connection) return;
          // "AO VIVO" só para quem pode transmitir neste canal (a credencial do LiveKit também barra o vídeo)
          const channel = this.store.getChannel(session.state.channelId);
          const streaming = frame.streaming && channel !== undefined && hasPermission(this.store.channelPermissionsOf(channel, connection.userId), "STREAM");
          session.state = { ...session.state, muted: frame.muted || frame.deafened || Boolean(session.state.serverMuted), deafened: frame.deafened, streaming };
          this.dispatchVoice(session.guildId, session.state);
          return;
        }
        case "voice_leave":
          this.leaveVoice(connection.userId);
          return;
      }
    });

    socket.on("close", () => {
      clearTimeout(identifyTimer);
      clearInterval(heartbeatTimer);
      if (!connection || this.closing) {
        if (connection) this.unregister(connection);
        return;
      }
      if (this.voice.get(connection.userId)?.connection === connection) this.leaveVoice(connection.userId);
      if (this.unregister(connection)) this.broadcastPresence(connection.userId, false);
    });
    socket.on("error", () => socket.terminate());
  }

  /** Chamado antes de o servidor fechar (hook preClose). */
  shutdown(): void {
    this.closing = true;
  }

  /** Encerra as conexões abertas com uma sessão (logout). */
  closeSession(tokenHash: string): void {
    for (const set of this.connections.values()) {
      for (const conn of set) if (conn.tokenHash === tokenHash) conn.socket.close(CLOSE_CODES.invalidSession, "logout");
    }
  }

  dispatchToUsers(userIds: Iterable<Id>, event: DispatchEvent, exceptUserId?: Id): void {
    const payload = JSON.stringify({ op: "dispatch", ...event } satisfies ServerFrame);
    // Eventos novos só para quem os entende (o reducer do app 1.2.x quebraria com um evento desconhecido).
    const minVersion = V2_EVENTS.has(event.t) ? 2 : 1;
    for (const userId of userIds) {
      if (userId === exceptUserId) continue;
      for (const conn of this.connections.get(userId) ?? []) {
        if (conn.version >= minVersion && conn.socket.readyState === OPEN) conn.socket.send(payload);
      }
    }
  }

  dispatchToUser(userId: Id, event: DispatchEvent): void {
    this.dispatchToUsers([userId], event);
  }

  dispatchToGuild(guildId: Id, event: DispatchEvent, exceptUserId?: Id): void {
    this.dispatchToUsers(this.store.memberIds(guildId), event, exceptUserId);
  }

  /** Só para quem vê o canal (mensagens, reações, digitação e voz de canal privado não vazam). */
  dispatchToChannel(channel: Channel, event: DispatchEvent, exceptUserId?: Id): void {
    this.dispatchToUsers(this.store.channelViewerIds(channel), event, exceptUserId);
  }

  /* ---------- voz ---------- */

  /* ---------- voz: usado pela API (moderação, canais e servidores apagados) ---------- */

  /** Canal de voz em que a pessoa está agora (ou null). */
  voiceChannelOf(userId: Id): Id | null {
    return this.voice.get(userId)?.state.channelId ?? null;
  }

  /** Quem está na voz deste servidor. */
  voiceMembersOf(guildId: Id): { userId: Id; channelId: Id }[] {
    return [...this.voice.values()].filter((s) => s.guildId === guildId).map((s) => ({ userId: s.state.userId, channelId: s.state.channelId }));
  }

  /** Tira a pessoa da voz deste servidor (expulsa, banida, saiu ou perdeu "Conectar"). */
  leaveVoiceIn(guildId: Id, userId: Id): void {
    if (this.voice.get(userId)?.guildId === guildId) this.leaveVoice(userId);
  }

  /** Canal de voz apagado: todo mundo que estava nele sai. */
  leaveVoiceChannel(channelId: Id): void {
    for (const [userId, session] of [...this.voice]) if (session.state.channelId === channelId) this.leaveVoice(userId);
  }

  /** Servidor apagado: esquece a voz dele sem avisar ninguém (o GUILD_DELETE já avisa). */
  forgetGuild(guildId: Id): void {
    for (const [userId, session] of [...this.voice]) if (session.guildId === guildId) this.voice.delete(userId);
  }

  /**
   * Um moderador levou a pessoa para outra sala: o estado muda aqui na hora (sem "saiu e entrou") e
   * o app dela troca de sala ao receber o VOICE_MOVE. Devolve a sala de onde ela saiu.
   */
  moveVoice(userId: Id, to: Channel): Id | null {
    const session = this.voice.get(userId);
    if (!session || session.guildId !== to.guildId || session.state.channelId === to.id) return null;
    const from = this.store.getChannel(session.state.channelId);
    session.state = { ...session.state, channelId: to.id, streaming: false };
    const toViewers = new Set(this.store.channelViewerIds(to));
    const left = from ? this.store.channelViewerIds(from).filter((id) => !toViewers.has(id)) : [];
    this.dispatchToUsers(left, { t: "VOICE_STATE_UPDATE", d: { guildId: to.guildId, userId, channelId: null, muted: false, deafened: false, streaming: false } });
    this.dispatchToUsers(toViewers, { t: "VOICE_STATE_UPDATE", d: { guildId: to.guildId, ...session.state } });
    this.dispatchToUser(userId, { t: "VOICE_MOVE", d: { guildId: to.guildId, channelId: to.id } });
    return from?.id ?? null;
  }

  /** Silêncio de moderador: vale na hora para quem está na voz deste servidor (o banco guarda para as próximas vezes). */
  setServerMuted(guildId: Id, userId: Id, serverMuted: boolean): void {
    const session = this.voice.get(userId);
    if (!session || session.guildId !== guildId || Boolean(session.state.serverMuted) === serverMuted) return;
    session.state = { ...session.state, serverMuted, muted: serverMuted || session.state.muted };
    this.dispatchVoice(guildId, session.state);
  }

  private joinVoice(connection: Connection, channelId: Id, muted: boolean, deafened: boolean): void {
    const channel = this.store.getChannel(channelId);
    if (!channel || channel.type !== "voice") return;
    if (!hasPermission(this.store.channelPermissionsOf(channel, connection.userId), "CONNECT")) return;
    const previous = this.voice.get(connection.userId);
    if (previous && previous.state.channelId !== channel.id) this.leaveVoice(connection.userId);
    const serverMuted = this.store.isServerMuted(channel.guildId, connection.userId);
    const state: VoiceState = { userId: connection.userId, channelId: channel.id, muted: muted || deafened || serverMuted, deafened, streaming: false, serverMuted };
    this.voice.set(connection.userId, { guildId: channel.guildId, state, connection });
    this.dispatchVoice(channel.guildId, state);
  }

  private leaveVoice(userId: Id): void {
    const session = this.voice.get(userId);
    if (!session) return;
    this.voice.delete(userId);
    const event: DispatchEvent = {
      t: "VOICE_STATE_UPDATE",
      d: { guildId: session.guildId, userId, channelId: null, muted: false, deafened: false, streaming: false },
    };
    const channel = this.store.getChannel(session.state.channelId);
    // a pessoa sempre fica sabendo (outro aparelho dela pode estar sem ver o canal)
    if (channel) this.dispatchToUsers(new Set([...this.store.channelViewerIds(channel), userId]), event);
    else this.dispatchToGuild(session.guildId, event);
  }

  private dispatchVoice(guildId: Id, state: VoiceState): void {
    const channel = this.store.getChannel(state.channelId);
    const event: DispatchEvent = { t: "VOICE_STATE_UPDATE", d: { guildId, ...state } };
    if (channel) this.dispatchToUsers(new Set([...this.store.channelViewerIds(channel), state.userId]), event);
  }

  /* ---------- presença ---------- */

  /** Retorna true se esta é a primeira conexão do usuário (ficou online). */
  private register(conn: Connection): boolean {
    const set = this.connections.get(conn.userId) ?? new Set<Connection>();
    set.add(conn);
    this.connections.set(conn.userId, set);
    return set.size === 1;
  }

  /** Retorna true se era a última conexão do usuário (ficou offline). */
  private unregister(conn: Connection): boolean {
    const set = this.connections.get(conn.userId);
    if (!set) return false;
    set.delete(conn);
    if (set.size > 0) return false;
    this.connections.delete(conn.userId);
    return true;
  }

  private broadcastPresence(userId: Id, online: boolean): void {
    this.dispatchToUsers(this.store.peersOf(userId), { t: "PRESENCE_UPDATE", d: { userId, online } });
  }
}
