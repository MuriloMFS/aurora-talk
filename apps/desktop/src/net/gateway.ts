import { GATEWAY_PATH, GATEWAY_VERSION, type ClientFrame, type DispatchEvent, type Guild, type Id, type ReadState, type ServerFrame, type User, type DmChannel, type Relationship, type UserSettings } from "@aurora/schema";

export type ConnectionStatus = "connecting" | "ready" | "reconnecting";
/** O que veio no READY além de servidores e leitura (1.9: conversas diretas, amigos, preferências). */
export interface ReadyExtra {
  privateChannels?: DmChannel[];
  relationships?: Relationship[];
  settings?: UserSettings;
}

export interface GatewayHandlers {
  onStatus(status: ConnectionStatus): void;
  onReady(user: User, guilds: Guild[], readStates: ReadState[] | undefined, extra: ReadyExtra): void;
  onDispatch(event: DispatchEvent): void;
  onInvalidSession(reason: string): void;
}

const MAX_BACKOFF_MS = 15_000;

/** WebSocket com heartbeat e reconexão automática (backoff exponencial com jitter). */
export class GatewayClient {
  private readonly url: string;
  private readonly token: string;
  private readonly handlers: GatewayHandlers;
  private socket: WebSocket | null = null;
  private heartbeatTimer: ReturnType<typeof setInterval> | undefined;
  private reconnectTimer: ReturnType<typeof setTimeout> | undefined;
  private attempt = 0;
  private stopped = true;
  private awaitingAck = false;

  constructor(serverUrl: string, token: string, handlers: GatewayHandlers) {
    this.url = `${serverUrl.replace(/^http/i, "ws")}${GATEWAY_PATH}`;
    this.token = token;
    this.handlers = handlers;
  }

  start(): void {
    this.stopped = false;
    this.open();
  }

  stop(): void {
    this.stopped = true;
    clearInterval(this.heartbeatTimer);
    clearTimeout(this.reconnectTimer);
    this.socket?.close(1000);
    this.socket = null;
  }

  sendTyping(channelId: Id): void {
    this.send({ op: "typing", channelId });
  }

  sendVoiceJoin(channelId: Id, muted: boolean, deafened: boolean): void {
    this.send({ op: "voice_join", channelId, muted, deafened });
  }

  sendVoiceState(muted: boolean, deafened: boolean, streaming: boolean): void {
    this.send({ op: "voice_state", muted, deafened, streaming });
  }

  sendVoiceLeave(): void {
    this.send({ op: "voice_leave" });
  }

  private send(frame: ClientFrame): void {
    if (this.socket?.readyState === WebSocket.OPEN) this.socket.send(JSON.stringify(frame));
  }

  private open(): void {
    this.handlers.onStatus(this.attempt === 0 ? "connecting" : "reconnecting");
    const socket = new WebSocket(this.url);
    this.socket = socket;

    socket.onmessage = (event) => {
      let frame: ServerFrame;
      try {
        frame = JSON.parse(String(event.data)) as ServerFrame;
      } catch {
        return;
      }
      switch (frame.op) {
        case "hello":
          this.startHeartbeat(frame.heartbeatIntervalMs);
          this.send({ op: "identify", token: this.token, v: GATEWAY_VERSION });
          break;
        case "ready":
          this.attempt = 0;
          this.handlers.onStatus("ready");
          this.handlers.onReady(frame.user, frame.guilds, frame.readStates, {
            privateChannels: frame.privateChannels,
            relationships: frame.relationships,
            settings: frame.settings,
          });
          break;
        case "heartbeat_ack":
          this.awaitingAck = false;
          break;
        case "dispatch": {
          const { op: _op, ...event } = frame;
          this.handlers.onDispatch(event as DispatchEvent);
          break;
        }
        case "invalid_session":
          this.stopped = true;
          this.handlers.onInvalidSession(frame.reason);
          break;
      }
    };

    socket.onclose = () => {
      clearInterval(this.heartbeatTimer);
      if (this.socket !== socket || this.stopped) return;
      const delay = Math.min(MAX_BACKOFF_MS, 1000 * 2 ** this.attempt) * (0.5 + Math.random() / 2);
      this.attempt += 1;
      this.handlers.onStatus("reconnecting");
      this.reconnectTimer = setTimeout(() => this.open(), delay);
    };
  }

  private startHeartbeat(intervalMs: number): void {
    clearInterval(this.heartbeatTimer);
    this.awaitingAck = false;
    this.heartbeatTimer = setInterval(() => {
      if (this.awaitingAck) {
        this.socket?.close(); // servidor não respondeu: força reconexão
        return;
      }
      this.awaitingAck = true;
      this.send({ op: "heartbeat" });
    }, intervalMs);
  }
}
