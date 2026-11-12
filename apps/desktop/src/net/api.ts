import type { ApiErrorBody, AuthResponse, Channel, ChannelType, Guild, Id, Invite, Message, User, VoiceToken } from "@aurora/schema";

export class ApiError extends Error {
  readonly status: number;
  readonly code: string;
  constructor(status: number, code: string, message: string) {
    super(message);
    this.status = status;
    this.code = code;
  }
}

/** Cliente REST do servidor Aurora. Mensagens de erro já vêm prontas para mostrar ao usuário. */
export class ApiClient {
  readonly baseUrl: string;
  private readonly token: string | null;

  constructor(baseUrl: string, token: string | null = null) {
    this.baseUrl = baseUrl;
    this.token = token;
  }

  private async request<T>(method: string, path: string, body?: unknown): Promise<T> {
    const headers: Record<string, string> = {};
    if (this.token) headers.Authorization = `Bearer ${this.token}`;
    if (body !== undefined) headers["Content-Type"] = "application/json";
    let response: Response;
    try {
      response = await fetch(`${this.baseUrl}${path}`, {
        method,
        headers,
        body: body === undefined ? undefined : JSON.stringify(body),
      });
    } catch {
      throw new ApiError(0, "network", "Não foi possível falar com o servidor. Confira o endereço e se ele está ligado.");
    }
    if (response.status === 204) return undefined as T;
    const data = (await response.json().catch(() => null)) as T | ApiErrorBody | null;
    if (!response.ok) {
      const error = (data as ApiErrorBody | null)?.error;
      throw new ApiError(response.status, error?.code ?? "http_error", error?.message ?? `O servidor respondeu com erro ${response.status}.`);
    }
    return data as T;
  }

  register(username: string, password: string, displayName?: string) {
    return this.request<AuthResponse>("POST", "/api/auth/register", { username, password, ...(displayName ? { displayName } : {}) });
  }
  login(username: string, password: string) {
    return this.request<AuthResponse>("POST", "/api/auth/login", { username, password });
  }
  logout() {
    return this.request<void>("POST", "/api/auth/logout");
  }
  me() {
    return this.request<User>("GET", "/api/users/@me");
  }
  createGuild(name: string) {
    return this.request<Guild>("POST", "/api/guilds", { name });
  }
  createInvite(guildId: Id) {
    return this.request<Invite>("POST", `/api/guilds/${guildId}/invites`);
  }
  joinInvite(code: string) {
    return this.request<Guild>("POST", `/api/invites/${encodeURIComponent(code)}`);
  }
  createChannel(guildId: Id, name: string, type: ChannelType = "text") {
    return this.request<Channel>("POST", `/api/guilds/${guildId}/channels`, { name, type });
  }
  voiceToken(channelId: Id) {
    return this.request<VoiceToken>("POST", `/api/channels/${channelId}/voice`);
  }
  listMessages(channelId: Id, before?: Id) {
    const query = before ? `?before=${before}` : "";
    return this.request<Message[]>("GET", `/api/channels/${channelId}/messages${query}`);
  }
  sendMessage(channelId: Id, content: string, nonce: string, replyToId?: Id) {
    return this.request<Message>("POST", `/api/channels/${channelId}/messages`, { content, nonce, ...(replyToId ? { replyToId } : {}) });
  }
  addReaction(channelId: Id, messageId: Id, emoji: string) {
    return this.request<void>("PUT", `/api/channels/${channelId}/messages/${messageId}/reactions/${encodeURIComponent(emoji)}`);
  }
  removeReaction(channelId: Id, messageId: Id, emoji: string) {
    return this.request<void>("DELETE", `/api/channels/${channelId}/messages/${messageId}/reactions/${encodeURIComponent(emoji)}`);
  }
  /** Marca o canal como lido até `messageId` (vale em todos os aparelhos). */
  ack(channelId: Id, messageId: Id) {
    return this.request<void>("POST", `/api/channels/${channelId}/ack`, { messageId });
  }
  editMessage(messageId: Id, content: string) {
    return this.request<Message>("PATCH", `/api/messages/${messageId}`, { content });
  }
  deleteMessage(messageId: Id) {
    return this.request<void>("DELETE", `/api/messages/${messageId}`);
  }
}
