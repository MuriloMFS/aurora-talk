import type { ApiErrorBody, AuditLogEntry, AuthResponse, Ban, Channel, ChannelType, Guild, Id, Invite, InviteDetails, Message, Overwrite, Role, User, VoiceToken } from "@aurora/schema";

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
  createChannel(guildId: Id, name: string, type: ChannelType = "text", isPrivate = false) {
    return this.request<Channel>("POST", `/api/guilds/${guildId}/channels`, { name, type, ...(isPrivate ? { private: true } : {}) });
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
  updateProfile(displayName: string) {
    return this.request<User>("PATCH", "/api/users/@me", { displayName });
  }
  /* ---------- configurações do servidor (o servidor confere permissão e hierarquia) ---------- */
  updateGuild(guildId: Id, name: string) {
    return this.request<{ id: Id; name: string }>("PATCH", `/api/guilds/${guildId}`, { name });
  }
  deleteGuild(guildId: Id) {
    return this.request<void>("DELETE", `/api/guilds/${guildId}`);
  }
  leaveGuild(guildId: Id) {
    return this.request<void>("DELETE", `/api/guilds/${guildId}/members/@me`);
  }
  createRole(guildId: Id, fields: Partial<Pick<Role, "name" | "color" | "permissions" | "hoist">> = {}) {
    return this.request<Role>("POST", `/api/guilds/${guildId}/roles`, fields);
  }
  updateRole(guildId: Id, roleId: Id, fields: Partial<Pick<Role, "name" | "color" | "permissions" | "hoist">>) {
    return this.request<Role>("PATCH", `/api/guilds/${guildId}/roles/${roleId}`, fields);
  }
  moveRole(guildId: Id, roleId: Id, direction: "up" | "down") {
    return this.request<Role[]>("POST", `/api/guilds/${guildId}/roles/${roleId}/move`, { direction });
  }
  deleteRole(guildId: Id, roleId: Id) {
    return this.request<void>("DELETE", `/api/guilds/${guildId}/roles/${roleId}`);
  }
  setMemberRole(guildId: Id, userId: Id, roleId: Id, add: boolean) {
    return this.request<{ roles: Id[] }>(add ? "PUT" : "DELETE", `/api/guilds/${guildId}/members/${userId}/roles/${roleId}`);
  }
  kickMember(guildId: Id, userId: Id) {
    return this.request<void>("DELETE", `/api/guilds/${guildId}/members/${userId}`);
  }
  banMember(guildId: Id, userId: Id, reason?: string) {
    return this.request<void>("PUT", `/api/guilds/${guildId}/bans/${userId}`, reason ? { reason } : {});
  }
  listBans(guildId: Id) {
    return this.request<Ban[]>("GET", `/api/guilds/${guildId}/bans`);
  }
  unbanMember(guildId: Id, userId: Id) {
    return this.request<void>("DELETE", `/api/guilds/${guildId}/bans/${userId}`);
  }
  listInvites(guildId: Id) {
    return this.request<InviteDetails[]>("GET", `/api/guilds/${guildId}/invites`);
  }
  deleteInvite(code: string) {
    return this.request<void>("DELETE", `/api/invites/${encodeURIComponent(code)}`);
  }
  updateChannel(channelId: Id, name: string) {
    return this.request<Channel>("PATCH", `/api/channels/${channelId}`, { name });
  }
  deleteChannel(channelId: Id) {
    return this.request<void>("DELETE", `/api/channels/${channelId}`);
  }
  /** Permissões do canal para um cargo ou pessoa (`allow` e `deny` zerados = volta a seguir o servidor). */
  setOverwrite(channelId: Id, overwrite: Overwrite) {
    return this.request<Channel>("PUT", `/api/channels/${channelId}/overwrites/${overwrite.targetType}/${overwrite.targetId}`, { allow: overwrite.allow, deny: overwrite.deny });
  }
  deleteOverwrite(channelId: Id, targetType: Overwrite["targetType"], targetId: Id) {
    return this.request<Channel>("DELETE", `/api/channels/${channelId}/overwrites/${targetType}/${targetId}`);
  }
  /** Castigo por `minutes` (ou `null` para tirar). */
  timeoutMember(guildId: Id, userId: Id, minutes: number | null) {
    return this.request<{ timeoutUntil: number | null }>("PUT", `/api/guilds/${guildId}/members/${userId}/timeout`, { minutes });
  }
  /** Silenciar (`muted`), mover (`channelId`) ou desconectar (`channelId: null`) alguém na voz. */
  moderateVoice(guildId: Id, userId: Id, action: { muted?: boolean; channelId?: Id | null }) {
    return this.request<void>("PATCH", `/api/guilds/${guildId}/members/${userId}/voice`, action);
  }
  auditLog(guildId: Id, before?: Id) {
    return this.request<AuditLogEntry[]>("GET", `/api/guilds/${guildId}/audit-log${before ? `?before=${before}` : ""}`);
  }
  /** Troca a senha; as sessões dos outros aparelhos são encerradas (esta continua). */
  changePassword(currentPassword: string, newPassword: string) {
    return this.request<void>("POST", "/api/users/@me/password", { currentPassword, newPassword });
  }
}
