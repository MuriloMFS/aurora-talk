import { DatabaseSync } from "node:sqlite";
import { mkdirSync } from "node:fs";
import { dirname } from "node:path";
import {
  DEFAULT_EVERYONE_PERMISSIONS,
  EVERYONE_ROLE_NAME,
  LIMITS,
  PERMISSIONS,
  applyTimeout,
  byPositionDesc,
  computeChannelPermissions,
  computePermissions,
  type AuditAction,
  type AuditLogEntry,
  type Ban,
  type Channel,
  type ChannelType,
  type Guild,
  type Id,
  type Invite,
  type InviteDetails,
  type Member,
  type Message,
  type MessageReference,
  type Overwrite,
  type PermissionContext,
  type Reaction,
  type ReadState,
  type Role,
  type User,
  type VoiceState,
} from "@aurora/schema";
import { ID_EPOCH, ID_SEQUENCE_SIZE, nextId } from "./ids.ts";
import { newInviteCode } from "./auth.ts";

const SCHEMA = `
CREATE TABLE IF NOT EXISTS users (
  id INTEGER PRIMARY KEY, username TEXT NOT NULL UNIQUE, display_name TEXT NOT NULL,
  password_hash TEXT NOT NULL, created_at INTEGER NOT NULL);
CREATE TABLE IF NOT EXISTS sessions (
  token_hash TEXT PRIMARY KEY, user_id INTEGER NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  created_at INTEGER NOT NULL);
CREATE TABLE IF NOT EXISTS guilds (
  id INTEGER PRIMARY KEY, name TEXT NOT NULL, owner_id INTEGER NOT NULL REFERENCES users(id),
  created_at INTEGER NOT NULL);
CREATE TABLE IF NOT EXISTS members (
  guild_id INTEGER NOT NULL REFERENCES guilds(id) ON DELETE CASCADE,
  user_id INTEGER NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  joined_at INTEGER NOT NULL, PRIMARY KEY (guild_id, user_id));
CREATE INDEX IF NOT EXISTS members_by_user ON members(user_id);
CREATE TABLE IF NOT EXISTS channels (
  id INTEGER PRIMARY KEY, guild_id INTEGER NOT NULL REFERENCES guilds(id) ON DELETE CASCADE,
  name TEXT NOT NULL, position INTEGER NOT NULL, type TEXT NOT NULL DEFAULT 'text');
CREATE INDEX IF NOT EXISTS channels_by_guild ON channels(guild_id, position);
CREATE TABLE IF NOT EXISTS invites (
  code TEXT PRIMARY KEY, guild_id INTEGER NOT NULL REFERENCES guilds(id) ON DELETE CASCADE,
  created_by INTEGER NOT NULL REFERENCES users(id), created_at INTEGER NOT NULL,
  uses INTEGER NOT NULL DEFAULT 0);
CREATE TABLE IF NOT EXISTS messages (
  id INTEGER PRIMARY KEY, channel_id INTEGER NOT NULL REFERENCES channels(id) ON DELETE CASCADE,
  author_id INTEGER NOT NULL REFERENCES users(id), content TEXT NOT NULL,
  created_at INTEGER NOT NULL, edited_at INTEGER);
CREATE INDEX IF NOT EXISTS messages_by_channel ON messages(channel_id, id);
CREATE TABLE IF NOT EXISTS reactions (
  message_id INTEGER NOT NULL REFERENCES messages(id) ON DELETE CASCADE,
  user_id INTEGER NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  emoji TEXT NOT NULL, created_at INTEGER NOT NULL,
  PRIMARY KEY (message_id, emoji, user_id));
CREATE TABLE IF NOT EXISTS message_mentions (
  message_id INTEGER NOT NULL REFERENCES messages(id) ON DELETE CASCADE,
  user_id INTEGER NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  PRIMARY KEY (message_id, user_id));
CREATE INDEX IF NOT EXISTS mentions_by_user ON message_mentions(user_id, message_id);
CREATE TABLE IF NOT EXISTS read_states (
  user_id INTEGER NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  channel_id INTEGER NOT NULL REFERENCES channels(id) ON DELETE CASCADE,
  last_read_id INTEGER NOT NULL, PRIMARY KEY (user_id, channel_id));
-- 1.5: cargos (o @todos tem id = id do servidor), banimentos e registro de auditoria
CREATE TABLE IF NOT EXISTS roles (
  id INTEGER PRIMARY KEY, guild_id INTEGER NOT NULL REFERENCES guilds(id) ON DELETE CASCADE,
  name TEXT NOT NULL, color INTEGER, position INTEGER NOT NULL, permissions INTEGER NOT NULL,
  hoist INTEGER NOT NULL DEFAULT 0);
CREATE INDEX IF NOT EXISTS roles_by_guild ON roles(guild_id, position);
CREATE TABLE IF NOT EXISTS member_roles (
  guild_id INTEGER NOT NULL, user_id INTEGER NOT NULL,
  role_id INTEGER NOT NULL REFERENCES roles(id) ON DELETE CASCADE,
  PRIMARY KEY (guild_id, user_id, role_id),
  FOREIGN KEY (guild_id, user_id) REFERENCES members(guild_id, user_id) ON DELETE CASCADE);
CREATE TABLE IF NOT EXISTS bans (
  guild_id INTEGER NOT NULL REFERENCES guilds(id) ON DELETE CASCADE,
  user_id INTEGER NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  reason TEXT, banned_by INTEGER REFERENCES users(id) ON DELETE SET NULL,
  created_at INTEGER NOT NULL, PRIMARY KEY (guild_id, user_id));
CREATE TABLE IF NOT EXISTS audit_log (
  id INTEGER PRIMARY KEY, guild_id INTEGER NOT NULL REFERENCES guilds(id) ON DELETE CASCADE,
  actor_id INTEGER REFERENCES users(id) ON DELETE SET NULL, action TEXT NOT NULL,
  target_name TEXT NOT NULL, detail TEXT, created_at INTEGER NOT NULL);
CREATE INDEX IF NOT EXISTS audit_by_guild ON audit_log(guild_id, id);
-- 1.6: permissões por canal e moderação (castigo e silêncio na voz ficam mesmo se a pessoa sair e voltar)
CREATE TABLE IF NOT EXISTS channel_overwrites (
  channel_id INTEGER NOT NULL REFERENCES channels(id) ON DELETE CASCADE,
  target_type TEXT NOT NULL, target_id INTEGER NOT NULL, allow INTEGER NOT NULL, deny INTEGER NOT NULL,
  PRIMARY KEY (channel_id, target_type, target_id));
CREATE TABLE IF NOT EXISTS moderation (
  guild_id INTEGER NOT NULL REFERENCES guilds(id) ON DELETE CASCADE,
  user_id INTEGER NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  timeout_until INTEGER, server_muted INTEGER NOT NULL DEFAULT 0,
  PRIMARY KEY (guild_id, user_id));
`;

interface UserRow { id: number; username: string; display_name: string }
interface ChannelRow { id: number; guild_id: number; name: string; position: number; type: ChannelType }
interface GuildRow { id: number; name: string; owner_id: number }
interface MemberRow extends UserRow { joined_at: number }
interface RoleRow { id: number; guild_id: number; name: string; color: number | null; position: number; permissions: number; hoist: number }
interface OverwriteRow { channel_id: number; target_type: string; target_id: number; allow: number; deny: number }
interface MessageRow {
  id: number; channel_id: number; author_id: number; content: string; created_at: number; edited_at: number | null; username: string; display_name: string;
  reply_to_id: number | null; reply_author_id: number | null; reply_username: string | null; reply_display_name: string | null; reply_content: string | null;
}

const toUser = (r: UserRow): User => ({ id: String(r.id), username: r.username, displayName: r.display_name });
const toChannel = (r: ChannelRow, overwrites: Overwrite[] = []): Channel => ({
  id: String(r.id),
  guildId: String(r.guild_id),
  type: r.type === "voice" ? "voice" : "text",
  name: r.name,
  position: r.position,
  overwrites,
});
const toOverwrite = (r: OverwriteRow): Overwrite => ({
  targetType: r.target_type === "member" ? "member" : "role",
  targetId: String(r.target_id),
  allow: r.allow,
  deny: r.deny,
});
const CHANNEL_COLUMNS = "id, guild_id, name, position, type";
const toRole = (r: RoleRow): Role => ({
  id: String(r.id),
  guildId: String(r.guild_id),
  name: r.name,
  color: r.color,
  position: r.position,
  permissions: r.permissions,
  hoist: r.hoist === 1,
});
const ROLE_COLUMNS = "id, guild_id, name, color, position, permissions, hoist";
const userOrNull = (id: number | null, username: string | null, displayName: string | null): User | null =>
  id === null || username === null ? null : { id: String(id), username, displayName: displayName ?? username };

const excerpt = (content: string) => (content.length > LIMITS.replyExcerptMax ? `${content.slice(0, LIMITS.replyExcerptMax - 1)}…` : content);

const toReference = (r: MessageRow): MessageReference | null => {
  if (r.reply_to_id === null) return null;
  const alive = r.reply_author_id !== null && r.reply_content !== null;
  return {
    id: String(r.reply_to_id),
    author: alive ? { id: String(r.reply_author_id), username: r.reply_username!, displayName: r.reply_display_name! } : null,
    content: alive ? excerpt(r.reply_content!) : null,
  };
};

const MESSAGE_SELECT = `SELECT m.id, m.channel_id, m.author_id, m.content, m.created_at, m.edited_at, u.username, u.display_name,
    m.reply_to_id, r.author_id AS reply_author_id, ru.username AS reply_username, ru.display_name AS reply_display_name, r.content AS reply_content
  FROM messages m JOIN users u ON u.id = m.author_id
  LEFT JOIN messages r ON r.id = m.reply_to_id LEFT JOIN users ru ON ru.id = r.author_id`;

/** Estado em memória (do gateway) que entra nos objetos de servidor: presença e voz. */
export interface LiveState {
  isOnline(userId: Id): boolean;
  voiceStatesOf(guildId: Id): VoiceState[];
}

/** Acesso a dados da 1.0 (SQLite embutido do Node). Interface pensada para trocar por Postgres depois. */
export class Store {
  private readonly db: DatabaseSync;

  constructor(path: string) {
    if (path !== ":memory:") mkdirSync(dirname(path), { recursive: true });
    this.db = new DatabaseSync(path);
    if (path !== ":memory:") this.db.exec("PRAGMA journal_mode = WAL;");
    this.db.exec("PRAGMA foreign_keys = ON;");
    this.db.exec(SCHEMA);
    this.migrate();
  }

  /** Migrações aditivas para bancos criados por versões anteriores. */
  private migrate(): void {
    const columns = this.all<{ name: string }>("PRAGMA table_info(channels)").map((c) => c.name);
    if (!columns.includes("type")) this.db.exec("ALTER TABLE channels ADD COLUMN type TEXT NOT NULL DEFAULT 'text'");
    // 1.3: respostas. Sem chave estrangeira de propósito: apagar a original não apaga as respostas.
    const messageColumns = this.all<{ name: string }>("PRAGMA table_info(messages)").map((c) => c.name);
    if (!messageColumns.includes("reply_to_id")) this.db.exec("ALTER TABLE messages ADD COLUMN reply_to_id INTEGER");
    // 1.5: todo servidor ganha o cargo @todos com as permissões padrão
    this.run(
      `INSERT INTO roles (id, guild_id, name, color, position, permissions, hoist)
       SELECT g.id, g.id, ?, NULL, 0, ?, 0 FROM guilds g WHERE NOT EXISTS (SELECT 1 FROM roles r WHERE r.id = g.id)`,
      EVERYONE_ROLE_NAME,
      DEFAULT_EVERYONE_PERMISSIONS,
    );
    // 1.6: "Ver canais" passou a existir; quem já estava no servidor continua vendo tudo (uma vez só)
    const version = this.one<{ user_version: number }>("PRAGMA user_version")?.user_version ?? 0;
    if (version < 1) {
      this.run("UPDATE roles SET permissions = permissions | ? WHERE id = guild_id", PERMISSIONS.VIEW_CHANNEL);
      this.db.exec("PRAGMA user_version = 1");
    }
  }

  close(): void {
    this.db.close();
  }

  private one<T>(sql: string, ...params: (string | number | null)[]): T | undefined {
    return this.db.prepare(sql).get(...params) as T | undefined;
  }

  private all<T>(sql: string, ...params: (string | number | null)[]): T[] {
    return this.db.prepare(sql).all(...params) as unknown as T[];
  }

  private run(sql: string, ...params: (string | number | null)[]): void {
    this.db.prepare(sql).run(...params);
  }

  /** Executa e devolve quantas linhas mudaram. */
  private change(sql: string, ...params: (string | number | null)[]): number {
    return Number(this.db.prepare(sql).run(...params).changes);
  }

  private transaction<T>(work: () => T): T {
    this.db.exec("BEGIN");
    try {
      const result = work();
      this.db.exec("COMMIT");
      return result;
    } catch (error) {
      this.db.exec("ROLLBACK");
      throw error;
    }
  }

  /* ---------- usuários e sessões ---------- */

  usernameExists(username: string): boolean {
    return this.one("SELECT 1 FROM users WHERE username = ?", username) !== undefined;
  }

  createUser(username: string, displayName: string, passwordHash: string): User {
    const id = nextId();
    this.run("INSERT INTO users (id, username, display_name, password_hash, created_at) VALUES (?, ?, ?, ?, ?)", Number(id), username, displayName, passwordHash, Date.now());
    return { id, username, displayName };
  }

  findCredentials(username: string): { user: User; passwordHash: string } | undefined {
    const row = this.one<UserRow & { password_hash: string }>("SELECT id, username, display_name, password_hash FROM users WHERE username = ?", username);
    return row ? { user: toUser(row), passwordHash: row.password_hash } : undefined;
  }

  createSession(tokenHash: string, userId: Id): void {
    this.run("INSERT INTO sessions (token_hash, user_id, created_at) VALUES (?, ?, ?)", tokenHash, Number(userId), Date.now());
  }

  sessionUser(tokenHash: string): User | undefined {
    const row = this.one<UserRow>("SELECT u.id, u.username, u.display_name FROM sessions s JOIN users u ON u.id = s.user_id WHERE s.token_hash = ?", tokenHash);
    return row ? toUser(row) : undefined;
  }

  deleteSession(tokenHash: string): void {
    this.run("DELETE FROM sessions WHERE token_hash = ?", tokenHash);
  }

  /* ---------- conta ---------- */

  updateDisplayName(userId: Id, displayName: string): User | undefined {
    this.run("UPDATE users SET display_name = ? WHERE id = ?", displayName, Number(userId));
    const row = this.one<UserRow>("SELECT id, username, display_name FROM users WHERE id = ?", Number(userId));
    return row ? toUser(row) : undefined;
  }

  passwordHashOf(userId: Id): string | undefined {
    return this.one<{ password_hash: string }>("SELECT password_hash FROM users WHERE id = ?", Number(userId))?.password_hash;
  }

  updatePassword(userId: Id, passwordHash: string): void {
    this.run("UPDATE users SET password_hash = ? WHERE id = ?", passwordHash, Number(userId));
  }

  /** Encerra as outras sessões do usuário (troca de senha) e devolve os hashes encerrados. */
  deleteOtherSessions(userId: Id, keepTokenHash: string): string[] {
    const others = this.all<{ token_hash: string }>("SELECT token_hash FROM sessions WHERE user_id = ? AND token_hash <> ?", Number(userId), keepTokenHash).map((r) => r.token_hash);
    this.run("DELETE FROM sessions WHERE user_id = ? AND token_hash <> ?", Number(userId), keepTokenHash);
    return others;
  }

  /* ---------- servidores, membros e canais ---------- */

  createGuild(name: string, ownerId: Id, live: LiveState): Guild {
    const guildId = nextId();
    this.transaction(() => {
      const now = Date.now();
      this.run("INSERT INTO guilds (id, name, owner_id, created_at) VALUES (?, ?, ?, ?)", Number(guildId), name, Number(ownerId), now);
      this.run("INSERT INTO members (guild_id, user_id, joined_at) VALUES (?, ?, ?)", Number(guildId), Number(ownerId), now);
      this.run("INSERT INTO roles (id, guild_id, name, color, position, permissions, hoist) VALUES (?, ?, ?, NULL, 0, ?, 0)", Number(guildId), Number(guildId), EVERYONE_ROLE_NAME, DEFAULT_EVERYONE_PERMISSIONS);
      this.run("INSERT INTO channels (id, guild_id, name, position, type) VALUES (?, ?, ?, 0, 'text')", Number(nextId()), Number(guildId), "geral");
      this.run("INSERT INTO channels (id, guild_id, name, position, type) VALUES (?, ?, ?, 1, 'voice')", Number(nextId()), Number(guildId), "Sala de voz");
    });
    return this.getGuild(guildId, live)!;
  }

  /**
   * O servidor como `viewerId` o vê: só os canais que ele pode ver (e só a voz desses canais).
   * Sem `viewerId`, tudo (uso interno).
   */
  getGuild(guildId: Id, live: LiveState, viewerId?: Id): Guild | undefined {
    const row = this.one<GuildRow>("SELECT id, name, owner_id FROM guilds WHERE id = ?", Number(guildId));
    if (!row) return undefined;
    const id = String(row.id);
    const now = Date.now();
    const members = this.all<MemberRow & { timeout_until: number | null }>(
      `SELECT u.id, u.username, u.display_name, m.joined_at, mo.timeout_until FROM members m JOIN users u ON u.id = m.user_id
       LEFT JOIN moderation mo ON mo.guild_id = m.guild_id AND mo.user_id = m.user_id
       WHERE m.guild_id = ? ORDER BY m.joined_at`,
      row.id,
    ).map((r): Member => ({
      user: toUser(r),
      joinedAt: r.joined_at,
      online: live.isOnline(String(r.id)),
      roles: [],
      timeoutUntil: r.timeout_until !== null && r.timeout_until > now ? r.timeout_until : null,
    }));
    const byUser = new Map(members.map((m) => [m.user.id, m]));
    for (const r of this.all<{ user_id: number; role_id: number }>("SELECT user_id, role_id FROM member_roles WHERE guild_id = ?", row.id)) {
      byUser.get(String(r.user_id))?.roles.push(String(r.role_id));
    }
    const roles = this.rolesOf(id);
    let channels = this.channelsOf(id);
    let voiceStates = live.voiceStatesOf(id);
    if (viewerId !== undefined) {
      const ctx: PermissionContext = { guildId: id, ownerId: String(row.owner_id), roles };
      const viewerRoles = byUser.get(viewerId)?.roles ?? [];
      channels = channels.filter((c) => computeChannelPermissions(ctx, viewerId, viewerRoles, c.overwrites) & PERMISSIONS.VIEW_CHANNEL);
      const visible = new Set(channels.map((c) => c.id));
      voiceStates = voiceStates.filter((v) => visible.has(v.channelId));
    }
    return { id, name: row.name, ownerId: String(row.owner_id), channels, members, voiceStates, roles };
  }

  /** Canais do servidor com as sobrescritas (ordem de exibição). */
  channelsOf(guildId: Id): Channel[] {
    const overwrites = new Map<number, Overwrite[]>();
    for (const r of this.all<OverwriteRow>(
      "SELECT o.channel_id, o.target_type, o.target_id, o.allow, o.deny FROM channel_overwrites o JOIN channels c ON c.id = o.channel_id WHERE c.guild_id = ?",
      Number(guildId),
    )) {
      overwrites.set(r.channel_id, [...(overwrites.get(r.channel_id) ?? []), toOverwrite(r)]);
    }
    return this.all<ChannelRow>(`SELECT ${CHANNEL_COLUMNS} FROM channels WHERE guild_id = ? ORDER BY position, id`, Number(guildId)).map((r) =>
      toChannel(r, overwrites.get(r.id) ?? []),
    );
  }

  ownerOf(guildId: Id): Id | undefined {
    const row = this.one<{ owner_id: number }>("SELECT owner_id FROM guilds WHERE id = ?", Number(guildId));
    return row ? String(row.owner_id) : undefined;
  }

  guildName(guildId: Id): string | undefined {
    return this.one<{ name: string }>("SELECT name FROM guilds WHERE id = ?", Number(guildId))?.name;
  }

  renameGuild(guildId: Id, name: string): void {
    this.run("UPDATE guilds SET name = ? WHERE id = ?", name, Number(guildId));
  }

  /** Apaga o servidor e tudo dele (canais, mensagens, cargos, convites…), por cascata. Devolve quem era membro. */
  deleteGuild(guildId: Id): Id[] {
    const members = this.memberIds(guildId);
    this.run("DELETE FROM guilds WHERE id = ?", Number(guildId));
    return members;
  }

  /* ---------- cargos e permissões ---------- */

  rolesOf(guildId: Id): Role[] {
    return this.all<RoleRow>(`SELECT ${ROLE_COLUMNS} FROM roles WHERE guild_id = ?`, Number(guildId)).map(toRole).sort(byPositionDesc);
  }

  getRole(roleId: Id): Role | undefined {
    const row = this.one<RoleRow>(`SELECT ${ROLE_COLUMNS} FROM roles WHERE id = ?`, Number(roleId));
    return row ? toRole(row) : undefined;
  }

  memberRoleIds(guildId: Id, userId: Id): Id[] {
    return this.all<{ role_id: number }>("SELECT role_id FROM member_roles WHERE guild_id = ? AND user_id = ?", Number(guildId), Number(userId)).map((r) => String(r.role_id));
  }

  permissionContext(guildId: Id): PermissionContext | undefined {
    const ownerId = this.ownerOf(guildId);
    return ownerId ? { guildId, ownerId, roles: this.rolesOf(guildId) } : undefined;
  }

  /** Permissões efetivas no servidor (0 para quem não é membro; de castigo, só "Ver canais"). */
  permissionsOf(guildId: Id, userId: Id): number {
    const ctx = this.permissionContext(guildId);
    if (!ctx || !this.isMember(guildId, userId)) return 0;
    return applyTimeout(computePermissions(ctx, userId, this.memberRoleIds(guildId, userId)), this.timeoutOf(guildId, userId));
  }

  /** Permissões efetivas num canal (0 para quem não é membro ou não vê o canal). */
  channelPermissionsOf(channel: Channel, userId: Id): number {
    const ctx = this.permissionContext(channel.guildId);
    if (!ctx || !this.isMember(channel.guildId, userId)) return 0;
    return computeChannelPermissions(ctx, userId, this.memberRoleIds(channel.guildId, userId), channel.overwrites, this.timeoutOf(channel.guildId, userId));
  }

  /** Cargos de cada membro do servidor (quem não tem cargo aparece com lista vazia). */
  private memberRoleMap(guildId: Id): Map<Id, Id[]> {
    const map = new Map<Id, Id[]>(this.memberIds(guildId).map((id) => [id, []]));
    for (const r of this.all<{ user_id: number; role_id: number }>("SELECT user_id, role_id FROM member_roles WHERE guild_id = ?", Number(guildId))) {
      map.get(String(r.user_id))?.push(String(r.role_id));
    }
    return map;
  }

  /** Quem vê o canal (o castigo não esconde canais, então não entra aqui). */
  channelViewerIds(channel: Channel): Id[] {
    const ctx = this.permissionContext(channel.guildId);
    if (!ctx) return [];
    return [...this.memberRoleMap(channel.guildId)]
      .filter(([userId, roleIds]) => computeChannelPermissions(ctx, userId, roleIds, channel.overwrites) & PERMISSIONS.VIEW_CHANNEL)
      .map(([userId]) => userId);
  }

  /** Para cada membro, os canais que ele vê (antes/depois de mudar cargos ou sobrescritas). */
  visibility(guildId: Id): Map<Id, Set<Id>> {
    const ctx = this.permissionContext(guildId);
    const result = new Map<Id, Set<Id>>();
    if (!ctx) return result;
    const channels = this.channelsOf(guildId);
    for (const [userId, roleIds] of this.memberRoleMap(guildId)) {
      result.set(userId, new Set(channels.filter((c) => computeChannelPermissions(ctx, userId, roleIds, c.overwrites) & PERMISSIONS.VIEW_CHANNEL).map((c) => c.id)));
    }
    return result;
  }

  /* ---------- sobrescritas por canal ---------- */

  /** Grava (ou apaga, se não libera nem bloqueia nada) a sobrescrita. */
  setOverwrite(channelId: Id, overwrite: Overwrite): void {
    if (overwrite.allow === 0 && overwrite.deny === 0) {
      this.deleteOverwrite(channelId, overwrite.targetType, overwrite.targetId);
      return;
    }
    this.run(
      `INSERT INTO channel_overwrites (channel_id, target_type, target_id, allow, deny) VALUES (?, ?, ?, ?, ?)
       ON CONFLICT (channel_id, target_type, target_id) DO UPDATE SET allow = excluded.allow, deny = excluded.deny`,
      Number(channelId),
      overwrite.targetType,
      Number(overwrite.targetId),
      overwrite.allow,
      overwrite.deny,
    );
  }

  deleteOverwrite(channelId: Id, targetType: Overwrite["targetType"], targetId: Id): boolean {
    return this.change("DELETE FROM channel_overwrites WHERE channel_id = ? AND target_type = ? AND target_id = ?", Number(channelId), targetType, Number(targetId)) > 0;
  }

  /* ---------- castigo e silêncio na voz ---------- */

  /** Fim do castigo (ms) se ainda valer; `null` = livre. */
  timeoutOf(guildId: Id, userId: Id): number | null {
    const until = this.one<{ timeout_until: number | null }>("SELECT timeout_until FROM moderation WHERE guild_id = ? AND user_id = ?", Number(guildId), Number(userId))?.timeout_until ?? null;
    return until !== null && until > Date.now() ? until : null;
  }

  setTimeoutUntil(guildId: Id, userId: Id, until: number | null): void {
    this.run(
      `INSERT INTO moderation (guild_id, user_id, timeout_until) VALUES (?, ?, ?)
       ON CONFLICT (guild_id, user_id) DO UPDATE SET timeout_until = excluded.timeout_until`,
      Number(guildId),
      Number(userId),
      until,
    );
  }

  isServerMuted(guildId: Id, userId: Id): boolean {
    return this.one<{ server_muted: number }>("SELECT server_muted FROM moderation WHERE guild_id = ? AND user_id = ?", Number(guildId), Number(userId))?.server_muted === 1;
  }

  setServerMuted(guildId: Id, userId: Id, muted: boolean): void {
    this.run(
      `INSERT INTO moderation (guild_id, user_id, server_muted) VALUES (?, ?, ?)
       ON CONFLICT (guild_id, user_id) DO UPDATE SET server_muted = excluded.server_muted`,
      Number(guildId),
      Number(userId),
      muted ? 1 : 0,
    );
  }

  /** Cargo novo entra logo acima do @todos (posição 1); os outros sobem um. */
  createRole(guildId: Id, fields: Pick<Role, "name" | "color" | "permissions" | "hoist">): Role {
    const id = nextId();
    this.transaction(() => {
      this.run("UPDATE roles SET position = position + 1 WHERE guild_id = ? AND position >= 1", Number(guildId));
      this.run(
        "INSERT INTO roles (id, guild_id, name, color, position, permissions, hoist) VALUES (?, ?, ?, ?, 1, ?, ?)",
        Number(id),
        Number(guildId),
        fields.name,
        fields.color,
        fields.permissions,
        fields.hoist ? 1 : 0,
      );
    });
    return this.getRole(id)!;
  }

  updateRole(roleId: Id, fields: Pick<Role, "name" | "color" | "permissions" | "hoist">): void {
    this.run("UPDATE roles SET name = ?, color = ?, permissions = ?, hoist = ? WHERE id = ?", fields.name, fields.color, fields.permissions, fields.hoist ? 1 : 0, Number(roleId));
  }

  /** Troca o cargo de lugar com o vizinho de cima ou de baixo (o @todos nunca sai do 0). */
  swapRolePositions(a: Role, b: Role): void {
    this.transaction(() => {
      this.run("UPDATE roles SET position = ? WHERE id = ?", b.position, Number(a.id));
      this.run("UPDATE roles SET position = ? WHERE id = ?", a.position, Number(b.id));
    });
  }

  deleteRole(role: Role): void {
    this.transaction(() => {
      this.run("DELETE FROM channel_overwrites WHERE target_type = 'role' AND target_id = ?", Number(role.id));
      this.run("DELETE FROM roles WHERE id = ?", Number(role.id));
      this.run("UPDATE roles SET position = position - 1 WHERE guild_id = ? AND position > ?", Number(role.guildId), role.position);
    });
  }

  /** Dá (`add`) ou tira o cargo. Devolve os cargos do membro depois da mudança. */
  setMemberRole(guildId: Id, userId: Id, roleId: Id, add: boolean): Id[] {
    if (add) this.run("INSERT OR IGNORE INTO member_roles (guild_id, user_id, role_id) VALUES (?, ?, ?)", Number(guildId), Number(userId), Number(roleId));
    else this.run("DELETE FROM member_roles WHERE guild_id = ? AND user_id = ? AND role_id = ?", Number(guildId), Number(userId), Number(roleId));
    return this.memberRoleIds(guildId, userId);
  }

  getMember(guildId: Id, userId: Id): { user: User; roles: Id[] } | undefined {
    const row = this.one<UserRow>("SELECT u.id, u.username, u.display_name FROM members m JOIN users u ON u.id = m.user_id WHERE m.guild_id = ? AND m.user_id = ?", Number(guildId), Number(userId));
    return row ? { user: toUser(row), roles: this.memberRoleIds(guildId, userId) } : undefined;
  }

  getUser(userId: Id): User | undefined {
    const row = this.one<UserRow>("SELECT id, username, display_name FROM users WHERE id = ?", Number(userId));
    return row ? toUser(row) : undefined;
  }

  /** Tira a pessoa do servidor (sair, ser expulsa ou banida); os cargos e as sobrescritas dela vão junto. */
  removeMember(guildId: Id, userId: Id): void {
    this.transaction(() => {
      this.dropMemberOverwrites(guildId, userId);
      this.run("DELETE FROM members WHERE guild_id = ? AND user_id = ?", Number(guildId), Number(userId));
    });
  }

  private dropMemberOverwrites(guildId: Id, userId: Id): void {
    this.run(
      "DELETE FROM channel_overwrites WHERE target_type = 'member' AND target_id = ? AND channel_id IN (SELECT id FROM channels WHERE guild_id = ?)",
      Number(userId),
      Number(guildId),
    );
  }

  /* ---------- banimentos ---------- */

  ban(guildId: Id, userId: Id, reason: string | null, bannedBy: Id): void {
    this.transaction(() => {
      this.run(
        "INSERT INTO bans (guild_id, user_id, reason, banned_by, created_at) VALUES (?, ?, ?, ?, ?) ON CONFLICT (guild_id, user_id) DO UPDATE SET reason = excluded.reason, banned_by = excluded.banned_by",
        Number(guildId),
        Number(userId),
        reason,
        Number(bannedBy),
        Date.now(),
      );
      this.dropMemberOverwrites(guildId, userId);
      this.run("DELETE FROM members WHERE guild_id = ? AND user_id = ?", Number(guildId), Number(userId));
    });
  }

  isBanned(guildId: Id, userId: Id): boolean {
    return this.one("SELECT 1 FROM bans WHERE guild_id = ? AND user_id = ?", Number(guildId), Number(userId)) !== undefined;
  }

  unban(guildId: Id, userId: Id): boolean {
    return this.change("DELETE FROM bans WHERE guild_id = ? AND user_id = ?", Number(guildId), Number(userId)) > 0;
  }

  bansOf(guildId: Id): Ban[] {
    return this.all<{ id: number; username: string; display_name: string; reason: string | null; created_at: number; by_id: number | null; by_username: string | null; by_display_name: string | null }>(
      `SELECT u.id, u.username, u.display_name, b.reason, b.created_at, bu.id AS by_id, bu.username AS by_username, bu.display_name AS by_display_name
       FROM bans b JOIN users u ON u.id = b.user_id LEFT JOIN users bu ON bu.id = b.banned_by
       WHERE b.guild_id = ? ORDER BY b.created_at DESC`,
      Number(guildId),
    ).map((r) => ({ user: toUser(r), reason: r.reason, bannedBy: userOrNull(r.by_id, r.by_username, r.by_display_name), createdAt: r.created_at }));
  }

  /* ---------- registro de auditoria ---------- */

  audit(guildId: Id, actorId: Id, action: AuditAction, targetName: string, detail: string | null = null): void {
    this.run(
      "INSERT INTO audit_log (id, guild_id, actor_id, action, target_name, detail, created_at) VALUES (?, ?, ?, ?, ?, ?, ?)",
      Number(nextId()),
      Number(guildId),
      Number(actorId),
      action,
      targetName,
      detail,
      Date.now(),
    );
  }

  auditLog(guildId: Id, before: Id | null, limit: number): AuditLogEntry[] {
    return this.all<{ id: number; actor_id: number | null; username: string | null; display_name: string | null; action: AuditAction; target_name: string; detail: string | null; created_at: number }>(
      `SELECT a.id, a.actor_id, u.username, u.display_name, a.action, a.target_name, a.detail, a.created_at
       FROM audit_log a LEFT JOIN users u ON u.id = a.actor_id
       WHERE a.guild_id = ? AND (? IS NULL OR a.id < ?) ORDER BY a.id DESC LIMIT ?`,
      Number(guildId),
      before === null ? null : Number(before),
      before === null ? null : Number(before),
      limit,
    ).map((r) => ({
      id: String(r.id),
      guildId,
      actor: userOrNull(r.actor_id, r.username, r.display_name),
      action: r.action,
      targetName: r.target_name,
      detail: r.detail,
      createdAt: r.created_at,
    }));
  }

  guildsOf(userId: Id, live: LiveState): Guild[] {
    return this.all<{ guild_id: number }>("SELECT guild_id FROM members WHERE user_id = ? ORDER BY joined_at", Number(userId))
      .map((r) => this.getGuild(String(r.guild_id), live, userId))
      .filter((g): g is Guild => g !== undefined);
  }

  isMember(guildId: Id, userId: Id): boolean {
    return this.one("SELECT 1 FROM members WHERE guild_id = ? AND user_id = ?", Number(guildId), Number(userId)) !== undefined;
  }

  memberIds(guildId: Id): Id[] {
    return this.all<{ user_id: number }>("SELECT user_id FROM members WHERE guild_id = ?", Number(guildId)).map((r) => String(r.user_id));
  }

  /** Todos os usuários que compartilham pelo menos um servidor com `userId` (para presença). */
  peersOf(userId: Id): Id[] {
    return this.all<{ user_id: number }>(
      "SELECT DISTINCT m2.user_id FROM members m1 JOIN members m2 ON m2.guild_id = m1.guild_id WHERE m1.user_id = ? AND m2.user_id <> ?",
      Number(userId),
      Number(userId),
    ).map((r) => String(r.user_id));
  }

  addMember(guildId: Id, user: User, live: LiveState): Member {
    const joinedAt = Date.now();
    this.run("INSERT INTO members (guild_id, user_id, joined_at) VALUES (?, ?, ?)", Number(guildId), Number(user.id), joinedAt);
    return { user, joinedAt, online: live.isOnline(user.id), roles: [], timeoutUntil: this.timeoutOf(guildId, user.id) };
  }

  getChannel(channelId: Id): Channel | undefined {
    const row = this.one<ChannelRow>(`SELECT ${CHANNEL_COLUMNS} FROM channels WHERE id = ?`, Number(channelId));
    if (!row) return undefined;
    const overwrites = this.all<OverwriteRow>("SELECT channel_id, target_type, target_id, allow, deny FROM channel_overwrites WHERE channel_id = ?", row.id).map(toOverwrite);
    return toChannel(row, overwrites);
  }

  renameChannel(channelId: Id, name: string): void {
    this.run("UPDATE channels SET name = ? WHERE id = ?", name, Number(channelId));
  }

  /** Apaga o canal com as mensagens, reações e leituras dele (cascata). */
  deleteChannel(channelId: Id): void {
    this.run("DELETE FROM channels WHERE id = ?", Number(channelId));
  }

  countChannels(guildId: Id, type: ChannelType): number {
    return this.one<{ n: number }>("SELECT COUNT(*) AS n FROM channels WHERE guild_id = ? AND type = ?", Number(guildId), type)?.n ?? 0;
  }

  createChannel(guildId: Id, name: string, type: ChannelType = "text", overwrites: Overwrite[] = []): Channel {
    const id = nextId();
    this.transaction(() => {
      const max = this.one<{ p: number | null }>("SELECT MAX(position) AS p FROM channels WHERE guild_id = ?", Number(guildId));
      const position = (max?.p ?? -1) + 1;
      this.run("INSERT INTO channels (id, guild_id, name, position, type) VALUES (?, ?, ?, ?, ?)", Number(id), Number(guildId), name, position, type);
      for (const overwrite of overwrites) this.setOverwrite(id, overwrite);
    });
    return this.getChannel(id)!;
  }

  /* ---------- convites ---------- */

  createInvite(guildId: Id, createdBy: Id): Invite {
    for (let attempt = 0; attempt < 5; attempt++) {
      const code = newInviteCode();
      if (this.one("SELECT 1 FROM invites WHERE code = ?", code)) continue;
      this.run("INSERT INTO invites (code, guild_id, created_by, created_at) VALUES (?, ?, ?, ?)", code, Number(guildId), Number(createdBy), Date.now());
      return { code, guildId };
    }
    throw new Error("não foi possível gerar um código de convite único");
  }

  findInvite(code: string): Invite | undefined {
    const row = this.one<{ code: string; guild_id: number }>("SELECT code, guild_id FROM invites WHERE code = ?", code);
    return row ? { code: row.code, guildId: String(row.guild_id) } : undefined;
  }

  countInviteUse(code: string): void {
    this.run("UPDATE invites SET uses = uses + 1 WHERE code = ?", code);
  }

  invitesOf(guildId: Id): InviteDetails[] {
    return this.all<{ code: string; uses: number; created_at: number; id: number | null; username: string | null; display_name: string | null }>(
      `SELECT i.code, i.uses, i.created_at, u.id, u.username, u.display_name
       FROM invites i LEFT JOIN users u ON u.id = i.created_by WHERE i.guild_id = ? ORDER BY i.created_at DESC`,
      Number(guildId),
    ).map((r) => ({ code: r.code, guildId, uses: r.uses, createdAt: r.created_at, createdBy: userOrNull(r.id, r.username, r.display_name) }));
  }

  deleteInvite(code: string): boolean {
    return this.change("DELETE FROM invites WHERE code = ?", code) > 0;
  }

  /* ---------- mensagens ---------- */

  /** Completa as linhas com reações e menções (duas consultas para a página inteira). */
  private hydrate(rows: MessageRow[]): Message[] {
    if (rows.length === 0) return [];
    const ids = rows.map((r) => r.id);
    const marks = ids.map(() => "?").join(",");
    const reactions = new Map<number, Reaction[]>();
    // ordem: o emoji que apareceu primeiro vem primeiro
    for (const r of this.all<{ message_id: number; emoji: string; user_id: number }>(
      `SELECT message_id, emoji, user_id FROM reactions WHERE message_id IN (${marks}) ORDER BY created_at, user_id`,
      ...ids,
    )) {
      const list = reactions.get(r.message_id) ?? [];
      const entry = list.find((x) => x.emoji === r.emoji);
      if (entry) entry.userIds.push(String(r.user_id));
      else list.push({ emoji: r.emoji, userIds: [String(r.user_id)] });
      reactions.set(r.message_id, list);
    }
    const mentions = new Map<number, Id[]>();
    for (const r of this.all<{ message_id: number; user_id: number }>(`SELECT message_id, user_id FROM message_mentions WHERE message_id IN (${marks})`, ...ids)) {
      mentions.set(r.message_id, [...(mentions.get(r.message_id) ?? []), String(r.user_id)]);
    }
    return rows.map((r) => ({
      id: String(r.id),
      channelId: String(r.channel_id),
      author: { id: String(r.author_id), username: r.username, displayName: r.display_name },
      content: r.content,
      createdAt: r.created_at,
      editedAt: r.edited_at,
      replyTo: toReference(r),
      reactions: reactions.get(r.id) ?? [],
      mentions: mentions.get(r.id) ?? [],
    }));
  }

  private setMentions(messageId: Id, mentionIds: Id[]): void {
    this.run("DELETE FROM message_mentions WHERE message_id = ?", Number(messageId));
    for (const userId of mentionIds) this.run("INSERT OR IGNORE INTO message_mentions (message_id, user_id) VALUES (?, ?)", Number(messageId), Number(userId));
  }

  /** `mentionIds` já validados (membros do servidor), incluindo o autor da mensagem respondida. */
  createMessage(channelId: Id, author: User, content: string, replyToId: Id | null = null, mentionIds: Id[] = []): Message {
    const id = nextId();
    this.transaction(() => {
      this.run(
        "INSERT INTO messages (id, channel_id, author_id, content, created_at, reply_to_id) VALUES (?, ?, ?, ?, ?, ?)",
        Number(id), Number(channelId), Number(author.id), content, Date.now(), replyToId === null ? null : Number(replyToId),
      );
      this.setMentions(id, mentionIds);
    });
    return this.getMessage(id)!;
  }

  getMessage(messageId: Id): Message | undefined {
    const row = this.one<MessageRow>(`${MESSAGE_SELECT} WHERE m.id = ?`, Number(messageId));
    return row ? this.hydrate([row])[0] : undefined;
  }

  /** Página em ordem cronológica: as `limit` mensagens anteriores a `before` (ou as mais recentes). */
  listMessages(channelId: Id, before: Id | null, limit: number): Message[] {
    const rows = before
      ? this.all<MessageRow>(`${MESSAGE_SELECT} WHERE m.channel_id = ? AND m.id < ? ORDER BY m.id DESC LIMIT ?`, Number(channelId), Number(before), limit)
      : this.all<MessageRow>(`${MESSAGE_SELECT} WHERE m.channel_id = ? ORDER BY m.id DESC LIMIT ?`, Number(channelId), limit);
    return this.hydrate(rows).reverse();
  }

  updateMessage(messageId: Id, content: string, mentionIds: Id[] = []): Message | undefined {
    this.transaction(() => {
      this.run("UPDATE messages SET content = ?, edited_at = ? WHERE id = ?", content, Date.now(), Number(messageId));
      this.setMentions(messageId, mentionIds);
    });
    return this.getMessage(messageId);
  }

  deleteMessage(messageId: Id): void {
    this.run("DELETE FROM messages WHERE id = ?", Number(messageId)); // reações e menções vão junto (cascata)
  }

  /* ---------- reações ---------- */

  /** Quantos emojis diferentes a mensagem já tem. */
  reactionKinds(messageId: Id): number {
    return this.one<{ n: number }>("SELECT COUNT(DISTINCT emoji) AS n FROM reactions WHERE message_id = ?", Number(messageId))?.n ?? 0;
  }

  hasReactionEmoji(messageId: Id, emoji: string): boolean {
    return this.one("SELECT 1 FROM reactions WHERE message_id = ? AND emoji = ?", Number(messageId), emoji) !== undefined;
  }

  /** `true` se a reação é nova (reagir de novo com o mesmo emoji não faz nada). */
  addReaction(messageId: Id, userId: Id, emoji: string): boolean {
    return this.change("INSERT OR IGNORE INTO reactions (message_id, user_id, emoji, created_at) VALUES (?, ?, ?, ?)", Number(messageId), Number(userId), emoji, Date.now()) > 0;
  }

  /** `true` se havia a reação. */
  removeReaction(messageId: Id, userId: Id, emoji: string): boolean {
    return this.change("DELETE FROM reactions WHERE message_id = ? AND user_id = ? AND emoji = ?", Number(messageId), Number(userId), emoji) > 0;
  }

  /* ---------- leitura (não lidas e menções) ---------- */

  /** Marca como lido até `messageId`. Só avança (ack atrasado não desfaz leitura mais nova). `true` se mudou. */
  ack(userId: Id, channelId: Id, messageId: Id): boolean {
    return (
      this.change(
        `INSERT INTO read_states (user_id, channel_id, last_read_id) VALUES (?, ?, ?)
         ON CONFLICT (user_id, channel_id) DO UPDATE SET last_read_id = excluded.last_read_id WHERE excluded.last_read_id > read_states.last_read_id`,
        Number(userId), Number(channelId), Number(messageId),
      ) > 0
    );
  }

  /**
   * Leitura de todos os canais de texto do usuário. Quem nunca abriu um canal leu "até a entrada no
   * servidor" (histórico antigo não aparece como não lido).
   */
  readStatesOf(userId: Id): ReadState[] {
    const uid = Number(userId);
    const rows = this.all<{ channel_id: number; last_read_id: number; last_message_id: number | null; mention_count: number }>(
      `WITH base AS (
         SELECT c.id AS channel_id, COALESCE(rs.last_read_id, MAX(mb.joined_at - ?, 0) * ?) AS last_read_id
           FROM channels c
           JOIN members mb ON mb.guild_id = c.guild_id AND mb.user_id = ?
           LEFT JOIN read_states rs ON rs.channel_id = c.id AND rs.user_id = ?
          WHERE c.type = 'text')
       SELECT b.channel_id, b.last_read_id,
         (SELECT MAX(m.id) FROM messages m WHERE m.channel_id = b.channel_id) AS last_message_id,
         (SELECT COUNT(*) FROM message_mentions mm JOIN messages m ON m.id = mm.message_id
            WHERE mm.user_id = ? AND m.channel_id = b.channel_id AND m.author_id <> ? AND m.id > b.last_read_id) AS mention_count
       FROM base b`,
      ID_EPOCH, ID_SEQUENCE_SIZE, uid, uid, uid, uid,
    );
    return rows.map((r) => ({
      channelId: String(r.channel_id),
      lastReadId: String(r.last_read_id),
      lastMessageId: r.last_message_id === null ? null : String(r.last_message_id),
      mentionCount: r.mention_count,
    }));
  }
}
