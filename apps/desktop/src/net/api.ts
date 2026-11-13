import type { ApiErrorBody, Attachment, DmChannel, Relationship, UserSettings, AuditLogEntry, AuthResponse, Ban, Channel, ChannelType, Guild, Id, Invite, InviteDetails, Message, Overwrite, Role, User, VoiceToken } from "@aurora/schema";

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
  sendMessage(channelId: Id, content: string, nonce: string, replyToId?: Id, attachmentIds: Id[] = []) {
    return this.request<Message>("POST", `/api/channels/${channelId}/messages`, {
      content,
      nonce,
      ...(replyToId ? { replyToId } : {}),
      ...(attachmentIds.length > 0 ? { attachmentIds } : {}),
    });
  }
  /** Envia um arquivo para o canal (com progresso); depois a mensagem cita o id. */
  uploadAttachment(channelId: Id, file: Blob, meta: { filename: string; width?: number; height?: number }, onProgress?: (fraction: number) => void): Promise<Attachment> {
    const query = new URLSearchParams({ filename: meta.filename });
    if (meta.width && meta.height) {
      query.set("width", String(meta.width));
      query.set("height", String(meta.height));
    }
    return new Promise((resolve, reject) => {
      const xhr = new XMLHttpRequest();
      xhr.open("POST", `${this.baseUrl}/api/channels/${channelId}/attachments?${query}`);
      if (this.token) xhr.setRequestHeader("Authorization", `Bearer ${this.token}`);
      xhr.setRequestHeader("Content-Type", "application/octet-stream");
      xhr.upload.onprogress = (event) => event.lengthComputable && onProgress?.(event.loaded / event.total);
      xhr.onerror = () => reject(new ApiError(0, "network", "O envio falhou. Confira a conexão e tente de novo."));
      xhr.onload = () => {
        let data: unknown = null;
        try {
          data = JSON.parse(xhr.responseText);
        } catch {
          // resposta sem JSON (ex.: recusado pelo tamanho no meio do caminho)
        }
        if (xhr.status >= 200 && xhr.status < 300) return resolve(data as Attachment);
        const error = (data as ApiErrorBody | null)?.error;
        reject(new ApiError(xhr.status, error?.code ?? "http_error", error?.message ?? (xhr.status === 413 ? "O arquivo é grande demais." : `O servidor respondeu com erro ${xhr.status}.`)));
      };
      xhr.send(file);
    });
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
  /** Envia a foto de perfil (já recortada e reduzida pelo app). */
  async uploadAvatar(image: Blob) {
    let response: Response;
    try {
      response = await fetch(`${this.baseUrl}/api/users/@me/avatar`, {
        method: "PUT",
        headers: { ...(this.token ? { Authorization: `Bearer ${this.token}` } : {}), "Content-Type": image.type || "application/octet-stream" },
        body: image,
      });
    } catch {
      throw new ApiError(0, "network", "Não foi possível falar com o servidor. Confira a conexão e tente de novo.");
    }
    const data = (await response.json().catch(() => null)) as User | ApiErrorBody | null;
    if (!response.ok) {
      const error = (data as ApiErrorBody | null)?.error;
      throw new ApiError(response.status, error?.code ?? "http_error", error?.message ?? `O servidor respondeu com erro ${response.status}.`);
    }
    return data as User;
  }
  removeAvatar() {
    return this.request<User>("DELETE", "/api/users/@me/avatar");
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
  /* ---------- amigos e conversas diretas ---------- */
  requestFriend(username: string) {
    return this.request<Relationship>("POST", "/api/users/@me/relationships", { username });
  }
  requestFriendById(userId: Id) {
    return this.request<Relationship>("POST", "/api/users/@me/relationships", { userId });
  }
  acceptFriend(userId: Id) {
    return this.request<Relationship>("PUT", `/api/users/@me/relationships/${userId}`, { type: "friend" });
  }
  blockUser(userId: Id) {
    return this.request<Relationship>("PUT", `/api/users/@me/relationships/${userId}`, { type: "blocked" });
  }
  /** Cancelar ou recusar pedido, desfazer amizade, desbloquear. */
  removeRelationship(userId: Id) {
    return this.request<void>("DELETE", `/api/users/@me/relationships/${userId}`);
  }
  /** Mensagens diretas, status e status personalizado (só o que vier é mudado). */
  updateUserSettings(changes: Partial<UserSettings>) {
    return this.request<UserSettings>("PATCH", "/api/users/@me/settings", changes);
  }
  /** 1 pessoa = conversa a dois; mais = grupo novo. */
  openDm(recipientIds: Id[], name?: string) {
    return this.request<DmChannel>("POST", "/api/users/@me/channels", { recipientIds, ...(name ? { name } : {}) });
  }
  renameGroupDm(channelId: Id, name: string) {
    return this.request<DmChannel>("PATCH", `/api/dms/${channelId}`, { name });
  }
  /** Fecha a conversa a dois ou sai do grupo. */
  closeDm(channelId: Id) {
    return this.request<void>("DELETE", `/api/dms/${channelId}`);
  }
  addToGroupDm(channelId: Id, userId: Id) {
    return this.request<DmChannel>("PUT", `/api/dms/${channelId}/recipients/${userId}`);
  }
  auditLog(guildId: Id, before?: Id) {
    return this.request<AuditLogEntry[]>("GET", `/api/guilds/${guildId}/audit-log${before ? `?before=${before}` : ""}`);
  }
  /** Troca a senha; as sessões dos outros aparelhos são encerradas (esta continua). */
  changePassword(currentPassword: string, newPassword: string) {
    return this.request<void>("POST", "/api/users/@me/password", { currentPassword, newPassword });
  }
}
