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
  type Attachment,
  type AuditAction,
  type AuditLogEntry,
  type Ban,
  type Channel,
  type ChannelType,
  type CustomStatus,
  type PresenceStatus,
  type UserStatus,
  type DmChannel,
  type DmPolicy,
  type Relationship,
  type RelationshipType,
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
import { randomBytes } from "node:crypto";
import { signAttachment } from "./files.ts";

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
  id INTEGER PRIMARY KEY, guild_id INTEGER REFERENCES guilds(id) ON DELETE CASCADE,
  name TEXT NOT NULL, position INTEGER NOT NULL, type TEXT NOT NULL DEFAULT 'text',
  owner_id INTEGER REFERENCES users(id) ON DELETE SET NULL, dm_key TEXT UNIQUE);
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
-- 1.7: arquivos enviados (o conteúdo fica em disco, em data/files/<id>)
CREATE TABLE IF NOT EXISTS files (
  id INTEGER PRIMARY KEY, owner_id INTEGER REFERENCES users(id) ON DELETE SET NULL,
  kind TEXT NOT NULL, content_type TEXT NOT NULL, size INTEGER NOT NULL, sha256 TEXT NOT NULL,
  created_at INTEGER NOT NULL);
-- 1.8: segredos do servidor (assinatura dos links de anexo); colunas de anexo em files (migração)
CREATE TABLE IF NOT EXISTS secrets (name TEXT PRIMARY KEY, value TEXT NOT NULL);
-- 1.9: amigos/pedidos/bloqueios (cada lado tem a sua linha) e conversas diretas (canais sem servidor)
CREATE TABLE IF NOT EXISTS relationships (
  user_id INTEGER NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  target_id INTEGER NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  type TEXT NOT NULL, since INTEGER NOT NULL, PRIMARY KEY (user_id, target_id));
-- 1.11: códigos de recuperação (só o hash; cada um vale uma vez)
CREATE TABLE IF NOT EXISTS recovery_codes (
  user_id INTEGER NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  code_hash TEXT NOT NULL, used_at INTEGER, PRIMARY KEY (user_id, code_hash));
CREATE TABLE IF NOT EXISTS channel_recipients (
  channel_id INTEGER NOT NULL REFERENCES channels(id) ON DELETE CASCADE,
  user_id INTEGER NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  joined_at INTEGER NOT NULL, open INTEGER NOT NULL DEFAULT 1, PRIMARY KEY (channel_id, user_id));
CREATE INDEX IF NOT EXISTS recipients_by_user ON channel_recipients(user_id);
`;

interface UserRow { id: number; username: string; display_name: string; avatar_id: number | null }
/** Canal visto pelo servidor: os de servidor (`Channel`) e as conversas diretas (`dm` preenchido, `guildId` vazio). */
export type ServerChannel = Channel & { dm?: { type: "dm" | "group_dm"; recipientIds: Id[]; ownerId: Id | null } };
const dmKeyOf = (a: Id, b: Id) => [a, b].sort((x, y) => Number(x) - Number(y)).join(":");

export interface StoredFile {
  id: Id;
  ownerId: Id | null;
  kind: "avatar" | "attachment" | "guild_icon" | "guild_banner";
  contentType: string;
  size: number;
  sha256: string;
  createdAt: number;
  /** Só anexos: nome mostrado, canal onde foi enviado, mensagem (nula até enviar) e tamanho da imagem. */
  filename?: string | null;
  channelId?: Id | null;
  messageId?: Id | null;
  width?: number | null;
  height?: number | null;
}
interface FileRow {
  id: number; owner_id: number | null; kind: "avatar" | "attachment" | "guild_icon" | "guild_banner"; content_type: string; size: number; sha256: string; created_at: number;
  filename: string | null; channel_id: number | null; message_id: number | null; width: number | null; height: number | null;
}
const FILE_COLUMNS = "id, owner_id, kind, content_type, size, sha256, created_at, filename, channel_id, message_id, width, height";
const idOrNull = (n: number | null) => (n === null ? null : String(n));
const toFile = (r: FileRow): StoredFile => ({
  id: String(r.id),
  ownerId: idOrNull(r.owner_id),
  kind: r.kind,
  contentType: r.content_type,
  size: r.size,
  sha256: r.sha256,
  createdAt: r.created_at,
  filename: r.filename,
  channelId: idOrNull(r.channel_id),
  messageId: idOrNull(r.message_id),
  width: r.width,
  height: r.height,
});
interface ChannelRow { id: number; guild_id: number; name: string; position: number; type: ChannelType }
interface GuildRow { id: number; name: string; owner_id: number; icon_id: number | null; banner_id: number | null; created_at: number }
interface MemberRow extends UserRow { joined_at: number }
interface RoleRow { id: number; guild_id: number; name: string; color: number | null; position: number; permissions: number; hoist: number }
interface OverwriteRow { channel_id: number; target_type: string; target_id: number; allow: number; deny: number }
interface MessageRow {
  id: number; channel_id: number; author_id: number; content: string; created_at: number; edited_at: number | null; username: string; display_name: string; avatar_id: number | null;
  reply_to_id: number | null; reply_author_id: number | null; reply_username: string | null; reply_display_name: string | null; reply_avatar_id: number | null; reply_content: string | null;
}

const avatarOf = (id: number | null | undefined): string | null => (id == null ? null : String(id));
const toUser = (r: UserRow): User => ({ id: String(r.id), username: r.username, displayName: r.display_name, avatar: avatarOf(r.avatar_id) });
/** Colunas de usuário (com o apelido `u`) usadas nas consultas que montam `User`. */
const USER_COLUMNS = "u.id, u.username, u.display_name, u.avatar_id";
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
const userOrNull = (id: number | null, username: string | null, displayName: string | null, avatarId: number | null = null): User | null =>
  id === null || username === null ? null : { id: String(id), username, displayName: displayName ?? username, avatar: avatarOf(avatarId) };

const excerpt = (content: string) => (content.length > LIMITS.replyExcerptMax ? `${content.slice(0, LIMITS.replyExcerptMax - 1)}…` : content);

const toReference = (r: MessageRow): MessageReference | null => {
  if (r.reply_to_id === null) return null;
  const alive = r.reply_author_id !== null && r.reply_content !== null;
  return {
    id: String(r.reply_to_id),
    author: alive ? { id: String(r.reply_author_id), username: r.reply_username!, displayName: r.reply_display_name!, avatar: avatarOf(r.reply_avatar_id) } : null,
    content: alive ? excerpt(r.reply_content!) : null,
  };
};

const MESSAGE_SELECT = `SELECT m.id, m.channel_id, m.author_id, m.content, m.created_at, m.edited_at, u.username, u.display_name, u.avatar_id,
    m.reply_to_id, r.author_id AS reply_author_id, ru.username AS reply_username, ru.display_name AS reply_display_name, ru.avatar_id AS reply_avatar_id, r.content AS reply_content
  FROM messages m JOIN users u ON u.id = m.author_id
  LEFT JOIN messages r ON r.id = m.reply_to_id LEFT JOIN users ru ON ru.id = r.author_id`;

/** Estado em memória (do gateway) que entra nos objetos de servidor: presença e voz. */
export interface LiveState {
  /** Aparece online (conectado e não invisível). */
  isOnline(userId: Id): boolean;
  /** Como os outros veem a pessoa agora (invisível = offline; o personalizado só para quem aparece). */
  presenceOf(userId: Id): { status: PresenceStatus; customStatus: CustomStatus | null };
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
    this.allowChannelsWithoutGuild();
    // 1.3: respostas. Sem chave estrangeira de propósito: apagar a original não apaga as respostas.
    // 1.8: anexos usam a mesma tabela de arquivos da 1.7
    const fileColumns = this.all<{ name: string }>("PRAGMA table_info(files)").map((c) => c.name);
    for (const [column, type] of [
      ["filename", "TEXT"],
      ["channel_id", "INTEGER"],
      ["message_id", "INTEGER REFERENCES messages(id) ON DELETE SET NULL"],
      ["width", "INTEGER"],
      ["height", "INTEGER"],
      ["position", "INTEGER"],
    ] as const) {
      if (!fileColumns.includes(column)) this.db.exec(`ALTER TABLE files ADD COLUMN ${column} ${type}`);
    }
    this.db.exec("CREATE INDEX IF NOT EXISTS files_by_message ON files(message_id)");
    // 1.13: imagem do servidor
    const guildColumns = this.all<{ name: string }>("PRAGMA table_info(guilds)").map((c) => c.name);
    if (!guildColumns.includes("icon_id")) this.db.exec("ALTER TABLE guilds ADD COLUMN icon_id INTEGER");
    if (!guildColumns.includes("banner_id")) this.db.exec("ALTER TABLE guilds ADD COLUMN banner_id INTEGER");
    const userColumns = this.all<{ name: string }>("PRAGMA table_info(users)").map((c) => c.name);
    if (!userColumns.includes("avatar_id")) this.db.exec("ALTER TABLE users ADD COLUMN avatar_id INTEGER");
    if (!userColumns.includes("dm_policy")) this.db.exec("ALTER TABLE users ADD COLUMN dm_policy TEXT NOT NULL DEFAULT 'servers'");
    // 1.10: status escolhido e status personalizado
    if (!userColumns.includes("status")) this.db.exec("ALTER TABLE users ADD COLUMN status TEXT NOT NULL DEFAULT 'online'");
    // 1.11: verificação em duas etapas (segredo ativo, segredo esperando confirmação, último passo usado)
    for (const column of ["totp_secret TEXT", "totp_pending TEXT", "totp_last_step INTEGER"]) {
      if (!userColumns.includes(column.split(" ")[0]!)) this.db.exec(`ALTER TABLE users ADD COLUMN ${column}`);
    }
    // 1.11: aparelho e último uso de cada sessão
    const sessionColumns = this.all<{ name: string }>("PRAGMA table_info(sessions)").map((c) => c.name);
    if (!sessionColumns.includes("device")) this.db.exec("ALTER TABLE sessions ADD COLUMN device TEXT");
    if (!sessionColumns.includes("last_seen")) this.db.exec("ALTER TABLE sessions ADD COLUMN last_seen INTEGER");
    for (const column of ["custom_text TEXT", "custom_emoji TEXT", "custom_expires INTEGER"]) {
      if (!userColumns.includes(column.split(" ")[0]!)) this.db.exec(`ALTER TABLE users ADD COLUMN ${column}`);
    }
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

  /**
   * 1.9: conversas diretas são canais sem servidor. O SQLite não deixa tirar o NOT NULL de uma coluna,
   * então a tabela é refeita (procedimento oficial: sem chaves estrangeiras durante a troca, conferindo
   * no fim). Mensagens, leituras, sobrescritas e anexos continuam apontando para os mesmos ids.
   */
  private allowChannelsWithoutGuild(): void {
    const guildColumn = this.all<{ name: string; notnull: number }>("PRAGMA table_info(channels)").find((c) => c.name === "guild_id");
    if (!guildColumn || guildColumn.notnull === 0) return;
    this.db.exec("PRAGMA foreign_keys = OFF");
    try {
      this.transaction(() => {
        this.db.exec(`CREATE TABLE channels_new (
          id INTEGER PRIMARY KEY, guild_id INTEGER REFERENCES guilds(id) ON DELETE CASCADE,
          name TEXT NOT NULL, position INTEGER NOT NULL, type TEXT NOT NULL DEFAULT 'text',
          owner_id INTEGER REFERENCES users(id) ON DELETE SET NULL, dm_key TEXT UNIQUE);
          INSERT INTO channels_new (id, guild_id, name, position, type) SELECT id, guild_id, name, position, type FROM channels;
          DROP TABLE channels;
          ALTER TABLE channels_new RENAME TO channels;
          CREATE INDEX IF NOT EXISTS channels_by_guild ON channels(guild_id, position);`);
        const broken = this.all("PRAGMA foreign_key_check");
        if (broken.length > 0) throw new Error(`migração dos canais deixou ${broken.length} referências quebradas`);
      });
    } finally {
      this.db.exec("PRAGMA foreign_keys = ON");
    }
  }

  /** Segredo aleatório do servidor (criado na primeira vez e guardado no banco). */
  secret(name: string): string {
    const existing = this.one<{ value: string }>("SELECT value FROM secrets WHERE name = ?", name)?.value;
    if (existing) return existing;
    const value = randomBytes(32).toString("base64url");
    this.run("INSERT OR IGNORE INTO secrets (name, value) VALUES (?, ?)", name, value);
    return this.one<{ value: string }>("SELECT value FROM secrets WHERE name = ?", name)!.value;
  }

  private attachmentSecretCache: string | null = null;
  get attachmentSecret(): string {
    this.attachmentSecretCache ??= this.secret("attachments");
    return this.attachmentSecretCache;
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
    return { id, username, displayName, avatar: null };
  }

  findCredentials(username: string): { user: User; passwordHash: string } | undefined {
    const row = this.one<UserRow & { password_hash: string }>("SELECT id, username, display_name, avatar_id, password_hash FROM users WHERE username = ?", username);
    return row ? { user: toUser(row), passwordHash: row.password_hash } : undefined;
  }

  createSession(tokenHash: string, userId: Id, device: string | null = null): void {
    const now = Date.now();
    this.run("INSERT INTO sessions (token_hash, user_id, created_at, device, last_seen) VALUES (?, ?, ?, ?, ?)", tokenHash, Number(userId), now, device, now);
  }

  /** Último uso da sessão (gravado no máximo uma vez por minuto). */
  touchSession(tokenHash: string, now = Date.now()): void {
    this.run("UPDATE sessions SET last_seen = ? WHERE token_hash = ? AND (last_seen IS NULL OR last_seen < ?)", now, tokenHash, now - 60_000);
  }

  /** Aparelhos conectados, do uso mais recente para o mais antigo. O id é o começo do hash (não revela o token). */
  sessionsOf(userId: Id): { id: string; tokenHash: string; device: string; createdAt: number; lastSeen: number | null }[] {
    return this.all<{ token_hash: string; device: string | null; created_at: number; last_seen: number | null }>(
      "SELECT token_hash, device, created_at, last_seen FROM sessions WHERE user_id = ? ORDER BY COALESCE(last_seen, created_at) DESC",
      Number(userId),
    ).map((r) => ({ id: r.token_hash.slice(0, 16), tokenHash: r.token_hash, device: r.device ?? "Aparelho conectado antes da 1.11", createdAt: r.created_at, lastSeen: r.last_seen }));
  }

  /** Encerra todas as sessões (senha recuperada). Devolve os hashes encerrados. */
  deleteAllSessions(userId: Id): string[] {
    const all = this.all<{ token_hash: string }>("SELECT token_hash FROM sessions WHERE user_id = ?", Number(userId)).map((r) => r.token_hash);
    this.run("DELETE FROM sessions WHERE user_id = ?", Number(userId));
    return all;
  }

  /* ---------- verificação em duas etapas e recuperação ---------- */

  totpOf(userId: Id): { secret: string | null; pending: string | null; lastStep: number | null } {
    const r = this.one<{ totp_secret: string | null; totp_pending: string | null; totp_last_step: number | null }>(
      "SELECT totp_secret, totp_pending, totp_last_step FROM users WHERE id = ?",
      Number(userId),
    );
    return { secret: r?.totp_secret ?? null, pending: r?.totp_pending ?? null, lastStep: r?.totp_last_step ?? null };
  }

  setTotpPending(userId: Id, secret: string | null): void {
    this.run("UPDATE users SET totp_pending = ? WHERE id = ?", secret, Number(userId));
  }

  /** Liga (com o segredo confirmado) ou desliga (`null`). */
  setTotpSecret(userId: Id, secret: string | null, lastStep: number | null = null): void {
    this.run("UPDATE users SET totp_secret = ?, totp_pending = NULL, totp_last_step = ? WHERE id = ?", secret, lastStep, Number(userId));
  }

  /** Grava o passo usado só se for mais novo (evita aceitar o mesmo código em duas requisições ao mesmo tempo). */
  useTotpStep(userId: Id, step: number): boolean {
    return this.change("UPDATE users SET totp_last_step = ? WHERE id = ? AND (totp_last_step IS NULL OR totp_last_step < ?)", step, Number(userId), step) > 0;
  }

  replaceRecoveryCodes(userId: Id, hashes: readonly string[]): void {
    this.transaction(() => {
      this.run("DELETE FROM recovery_codes WHERE user_id = ?", Number(userId));
      for (const hash of hashes) this.run("INSERT INTO recovery_codes (user_id, code_hash) VALUES (?, ?)", Number(userId), hash);
    });
  }

  /** Gasta o código (se existir e ainda não tiver sido usado). */
  useRecoveryCode(userId: Id, hash: string): boolean {
    return this.change("UPDATE recovery_codes SET used_at = ? WHERE user_id = ? AND code_hash = ? AND used_at IS NULL", Date.now(), Number(userId), hash) > 0;
  }

  recoveryCodesLeft(userId: Id): number {
    return this.one<{ n: number }>("SELECT COUNT(*) AS n FROM recovery_codes WHERE user_id = ? AND used_at IS NULL", Number(userId))?.n ?? 0;
  }

  sessionUser(tokenHash: string): User | undefined {
    const row = this.one<UserRow>(`SELECT ${USER_COLUMNS} FROM sessions s JOIN users u ON u.id = s.user_id WHERE s.token_hash = ?`, tokenHash);
    return row ? toUser(row) : undefined;
  }

  deleteSession(tokenHash: string): void {
    this.run("DELETE FROM sessions WHERE token_hash = ?", tokenHash);
  }

  /* ---------- conta ---------- */

  updateDisplayName(userId: Id, displayName: string): User | undefined {
    this.run("UPDATE users SET display_name = ? WHERE id = ?", displayName, Number(userId));
    return this.getUser(userId);
  }

  /* ---------- arquivos e foto de perfil ---------- */

  createFile(file: StoredFile): void {
    const n = (v: Id | null | undefined) => (v == null ? null : Number(v));
    this.run(
      `INSERT INTO files (${FILE_COLUMNS}) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
      Number(file.id),
      n(file.ownerId),
      file.kind,
      file.contentType,
      file.size,
      file.sha256,
      file.createdAt,
      file.filename ?? null,
      n(file.channelId),
      n(file.messageId),
      file.width ?? null,
      file.height ?? null,
    );
  }

  getFile(fileId: Id): StoredFile | undefined {
    const r = this.one<FileRow>(`SELECT ${FILE_COLUMNS} FROM files WHERE id = ?`, Number(fileId));
    return r ? toFile(r) : undefined;
  }

  /** Anexos ainda não enviados, deste dono e deste canal, entre os pedidos (para conferir antes de enviar). */
  pendingAttachments(fileIds: readonly Id[], ownerId: Id, channelId: Id): StoredFile[] {
    if (fileIds.length === 0) return [];
    const marks = fileIds.map(() => "?").join(",");
    return this.all<FileRow>(
      `SELECT ${FILE_COLUMNS} FROM files WHERE id IN (${marks}) AND kind = 'attachment' AND message_id IS NULL AND owner_id = ? AND channel_id = ?`,
      ...fileIds.map(Number),
      Number(ownerId),
      Number(channelId),
    ).map(toFile);
  }

  /** Anexos de uma mensagem (para apagar os arquivos junto). */
  attachmentIdsOf(messageId: Id): Id[] {
    return this.all<{ id: number }>("SELECT id FROM files WHERE message_id = ? AND kind = 'attachment'", Number(messageId)).map((r) => String(r.id));
  }

  /** Anexos sem mensagem há mais de `olderThan` (enviados e abandonados, ou de mensagem/canal apagado). */
  orphanAttachments(olderThan: number): Id[] {
    return this.all<{ id: number }>("SELECT id FROM files WHERE kind = 'attachment' AND message_id IS NULL AND created_at < ?", olderThan).map((r) => String(r.id));
  }

  deleteFile(fileId: Id): void {
    this.run("DELETE FROM files WHERE id = ?", Number(fileId));
  }

  /** Troca a foto (ou tira, com `null`). Devolve o id da foto anterior, para apagar o arquivo. */
  setAvatar(userId: Id, fileId: Id | null): Id | null {
    const previous = this.one<{ avatar_id: number | null }>("SELECT avatar_id FROM users WHERE id = ?", Number(userId))?.avatar_id ?? null;
    this.run("UPDATE users SET avatar_id = ? WHERE id = ?", fileId === null ? null : Number(fileId), Number(userId));
    return avatarOf(previous);
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
    const row = this.one<GuildRow>("SELECT id, name, owner_id, icon_id, banner_id, created_at FROM guilds WHERE id = ?", Number(guildId));
    if (!row) return undefined;
    const id = String(row.id);
    const now = Date.now();
    const members = this.all<MemberRow & { timeout_until: number | null }>(
      `SELECT ${USER_COLUMNS}, m.joined_at, mo.timeout_until FROM members m JOIN users u ON u.id = m.user_id
       LEFT JOIN moderation mo ON mo.guild_id = m.guild_id AND mo.user_id = m.user_id
       WHERE m.guild_id = ? ORDER BY m.joined_at`,
      row.id,
    ).map((r): Member => {
      const presence = live.presenceOf(String(r.id));
      return {
        user: toUser(r),
        joinedAt: r.joined_at,
        online: presence.status !== "offline",
        roles: [],
        timeoutUntil: r.timeout_until !== null && r.timeout_until > now ? r.timeout_until : null,
        status: presence.status,
        customStatus: presence.customStatus,
      };
    });
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
    return { id, name: row.name, icon: avatarOf(row.icon_id), banner: avatarOf(row.banner_id), createdAt: row.created_at, ownerId: String(row.owner_id), channels, members, voiceStates, roles };
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
  /** Troca a imagem ou a capa do servidor (ou tira, com `null`). Devolve a anterior, para apagar o arquivo. */
  setGuildImage(guildId: Id, which: "icon" | "banner", fileId: Id | null): Id | null {
    const column = which === "icon" ? "icon_id" : "banner_id";
    const previous = this.one<Record<string, number | null>>(`SELECT ${column} AS v FROM guilds WHERE id = ?`, Number(guildId))?.v ?? null;
    this.run(`UPDATE guilds SET ${column} = ? WHERE id = ?`, fileId === null ? null : Number(fileId), Number(guildId));
    return avatarOf(previous);
  }

  guildImages(guildId: Id): { icon: Id | null; banner: Id | null } {
    const r = this.one<{ icon_id: number | null; banner_id: number | null }>("SELECT icon_id, banner_id FROM guilds WHERE id = ?", Number(guildId));
    return { icon: avatarOf(r?.icon_id ?? null), banner: avatarOf(r?.banner_id ?? null) };
  }

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
  channelPermissionsOf(channel: ServerChannel, userId: Id): number {
    if (channel.dm) return this.dmPermissionsOf(channel.dm, userId);
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
  channelViewerIds(channel: ServerChannel): Id[] {
    if (channel.dm) return [...channel.dm.recipientIds];
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
    const row = this.one<UserRow>(`SELECT ${USER_COLUMNS} FROM members m JOIN users u ON u.id = m.user_id WHERE m.guild_id = ? AND m.user_id = ?`, Number(guildId), Number(userId));
    return row ? { user: toUser(row), roles: this.memberRoleIds(guildId, userId) } : undefined;
  }

  getUser(userId: Id): User | undefined {
    const row = this.one<UserRow>(`SELECT ${USER_COLUMNS} FROM users u WHERE u.id = ?`, Number(userId));
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
    return this.all<UserRow & { reason: string | null; created_at: number; by_id: number | null; by_username: string | null; by_display_name: string | null; by_avatar_id: number | null }>(
      `SELECT ${USER_COLUMNS}, b.reason, b.created_at, bu.id AS by_id, bu.username AS by_username, bu.display_name AS by_display_name, bu.avatar_id AS by_avatar_id
       FROM bans b JOIN users u ON u.id = b.user_id LEFT JOIN users bu ON bu.id = b.banned_by
       WHERE b.guild_id = ? ORDER BY b.created_at DESC`,
      Number(guildId),
    ).map((r) => ({ user: toUser(r), reason: r.reason, bannedBy: userOrNull(r.by_id, r.by_username, r.by_display_name, r.by_avatar_id), createdAt: r.created_at }));
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
    return this.all<{ id: number; actor_id: number | null; username: string | null; display_name: string | null; avatar_id: number | null; action: AuditAction; target_name: string; detail: string | null; created_at: number }>(
      `SELECT a.id, a.actor_id, u.username, u.display_name, u.avatar_id, a.action, a.target_name, a.detail, a.created_at
       FROM audit_log a LEFT JOIN users u ON u.id = a.actor_id
       WHERE a.guild_id = ? AND (? IS NULL OR a.id < ?) ORDER BY a.id DESC LIMIT ?`,
      Number(guildId),
      before === null ? null : Number(before),
      before === null ? null : Number(before),
      limit,
    ).map((r) => ({
      id: String(r.id),
      guildId,
      actor: userOrNull(r.actor_id, r.username, r.display_name, r.avatar_id),
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

  /**
   * Quem recebe minha presença e meu perfil ao vivo: quem divide servidor comigo, amigos e pedidos, e
   * quem está nas minhas conversas diretas. (Quem eu bloqueei e quem me bloqueou ficam de fora da parte
   * de amizade, mas continuam vendo o que um servidor em comum mostra.)
   */
  peersOf(userId: Id): Id[] {
    const uid = Number(userId);
    return this.all<{ user_id: number }>(
      `SELECT m2.user_id FROM members m1 JOIN members m2 ON m2.guild_id = m1.guild_id WHERE m1.user_id = ? AND m2.user_id <> ?
       UNION SELECT target_id FROM relationships WHERE user_id = ? AND type <> 'blocked'
       UNION SELECT r2.user_id FROM channel_recipients r1 JOIN channel_recipients r2 ON r2.channel_id = r1.channel_id WHERE r1.user_id = ? AND r2.user_id <> ?`,
      uid,
      uid,
      uid,
      uid,
      uid,
    ).map((r) => String(r.user_id));
  }

  /* ---------- amigos, pedidos e bloqueios ---------- */

  relationshipOf(userId: Id, targetId: Id): RelationshipType | null {
    return (this.one<{ type: RelationshipType }>("SELECT type FROM relationships WHERE user_id = ? AND target_id = ?", Number(userId), Number(targetId))?.type ?? null);
  }

  relationshipsOf(userId: Id, live: Pick<LiveState, "isOnline" | "presenceOf">): Relationship[] {
    return this.all<UserRow & { type: RelationshipType; since: number }>(
      `SELECT ${USER_COLUMNS}, r.type, r.since FROM relationships r JOIN users u ON u.id = r.target_id WHERE r.user_id = ? ORDER BY u.display_name`,
      Number(userId),
    ).map((r) => {
      const presence = r.type === "blocked" ? { status: "offline" as const, customStatus: null } : live.presenceOf(String(r.id));
      return { user: toUser(r), type: r.type, since: r.since, online: presence.status !== "offline", status: presence.status, customStatus: presence.customStatus };
    });
  }

  /** Grava (ou apaga, com `null`) a minha relação com `targetId`. */
  setRelationship(userId: Id, targetId: Id, type: RelationshipType | null, since = Date.now()): void {
    if (type === null) this.run("DELETE FROM relationships WHERE user_id = ? AND target_id = ?", Number(userId), Number(targetId));
    else
      this.run(
        "INSERT INTO relationships (user_id, target_id, type, since) VALUES (?, ?, ?, ?) ON CONFLICT (user_id, target_id) DO UPDATE SET type = excluded.type, since = excluded.since",
        Number(userId),
        Number(targetId),
        type,
        since,
      );
  }

  /** Um dos dois bloqueou o outro? */
  isBlockedEither(a: Id, b: Id): boolean {
    return this.relationshipOf(a, b) === "blocked" || this.relationshipOf(b, a) === "blocked";
  }

  sharesGuild(a: Id, b: Id): boolean {
    return this.one("SELECT 1 FROM members m1 JOIN members m2 ON m2.guild_id = m1.guild_id WHERE m1.user_id = ? AND m2.user_id = ?", Number(a), Number(b)) !== undefined;
  }

  findUserByUsername(username: string): User | undefined {
    const row = this.one<UserRow>(`SELECT ${USER_COLUMNS} FROM users u WHERE u.username = ?`, username);
    return row ? toUser(row) : undefined;
  }

  dmPolicyOf(userId: Id): DmPolicy {
    return this.one<{ dm_policy: string }>("SELECT dm_policy FROM users WHERE id = ?", Number(userId))?.dm_policy === "friends" ? "friends" : "servers";
  }

  setDmPolicy(userId: Id, policy: DmPolicy): void {
    this.run("UPDATE users SET dm_policy = ? WHERE id = ?", policy, Number(userId));
  }

  /* ---------- status ---------- */

  statusOf(userId: Id): UserStatus {
    const status = this.one<{ status: string }>("SELECT status FROM users WHERE id = ?", Number(userId))?.status;
    return status === "idle" || status === "dnd" || status === "invisible" ? status : "online";
  }

  setStatus(userId: Id, status: UserStatus): void {
    this.run("UPDATE users SET status = ? WHERE id = ?", status, Number(userId));
  }

  /** Status personalizado que ainda vale (o vencido conta como nenhum). */
  customStatusOf(userId: Id, now = Date.now()): CustomStatus | null {
    const r = this.one<{ custom_text: string | null; custom_emoji: string | null; custom_expires: number | null }>(
      "SELECT custom_text, custom_emoji, custom_expires FROM users WHERE id = ?",
      Number(userId),
    );
    if (!r || (!r.custom_text && !r.custom_emoji)) return null;
    if (r.custom_expires !== null && r.custom_expires <= now) return null;
    return { text: r.custom_text ?? "", emoji: r.custom_emoji, expiresAt: r.custom_expires };
  }

  setCustomStatus(userId: Id, custom: CustomStatus | null): void {
    this.run(
      "UPDATE users SET custom_text = ?, custom_emoji = ?, custom_expires = ? WHERE id = ?",
      custom?.text || null,
      custom?.emoji ?? null,
      custom?.expiresAt ?? null,
      Number(userId),
    );
  }

  /* ---------- conversas diretas ---------- */

  private dmPermissionsOf(dm: NonNullable<ServerChannel["dm"]>, userId: Id): number {
    if (!dm.recipientIds.includes(userId)) return 0;
    const all = PERMISSIONS.VIEW_CHANNEL | PERMISSIONS.SEND_MESSAGES | PERMISSIONS.ADD_REACTIONS;
    if (dm.type === "dm") {
      const other = dm.recipientIds.find((id) => id !== userId);
      if (other && this.isBlockedEither(userId, other)) return PERMISSIONS.VIEW_CHANNEL; // lê o histórico, não escreve
    }
    return all;
  }

  /** Canal de servidor ou conversa direta (para as rotas de mensagem, que servem aos dois). */
  getConversation(channelId: Id): ServerChannel | undefined {
    const channel = this.getChannel(channelId);
    if (channel) return channel;
    const row = this.one<{ id: number; type: string; name: string; owner_id: number | null }>(
      "SELECT id, type, name, owner_id FROM channels WHERE id = ? AND guild_id IS NULL",
      Number(channelId),
    );
    if (!row) return undefined;
    const type = row.type === "group_dm" ? "group_dm" : "dm";
    return {
      id: String(row.id),
      guildId: "",
      type: "text",
      name: row.name,
      position: 0,
      overwrites: [],
      dm: { type, recipientIds: this.recipientIdsOf(String(row.id)), ownerId: idOrNull(row.owner_id) },
    };
  }

  recipientIdsOf(channelId: Id): Id[] {
    return this.all<{ user_id: number }>("SELECT user_id FROM channel_recipients WHERE channel_id = ? ORDER BY joined_at, user_id", Number(channelId)).map((r) => String(r.user_id));
  }

  /** A conversa como `viewerId` a vê (sem ele na lista de pessoas). */
  dmChannelFor(channelId: Id, viewerId: Id): DmChannel | undefined {
    const row = this.one<{ id: number; type: string; name: string; owner_id: number | null }>(
      "SELECT id, type, name, owner_id FROM channels WHERE id = ? AND guild_id IS NULL",
      Number(channelId),
    );
    if (!row) return undefined;
    const recipients = this.all<UserRow>(
      `SELECT ${USER_COLUMNS} FROM channel_recipients r JOIN users u ON u.id = r.user_id WHERE r.channel_id = ? AND r.user_id <> ? ORDER BY r.joined_at, u.id`,
      row.id,
      Number(viewerId),
    ).map(toUser);
    const last = this.one<{ id: number | null }>("SELECT MAX(id) AS id FROM messages WHERE channel_id = ?", row.id)?.id ?? null;
    return {
      id: String(row.id),
      type: row.type === "group_dm" ? "group_dm" : "dm",
      name: row.type === "group_dm" && row.name ? row.name : null,
      ownerId: idOrNull(row.owner_id),
      recipients,
      lastMessageId: idOrNull(last),
    };
  }

  /** Conversas que a pessoa deixou abertas (a dois que ela fechou só voltam com mensagem nova). */
  privateChannelsOf(userId: Id): DmChannel[] {
    return this.all<{ channel_id: number }>("SELECT channel_id FROM channel_recipients WHERE user_id = ? AND open = 1", Number(userId))
      .map((r) => this.dmChannelFor(String(r.channel_id), userId))
      .filter((c): c is DmChannel => c !== undefined)
      .sort((a, b) => Number(b.lastMessageId ?? b.id) - Number(a.lastMessageId ?? a.id));
  }

  findDm(a: Id, b: Id): Id | null {
    return idOrNull(this.one<{ id: number }>("SELECT id FROM channels WHERE dm_key = ?", dmKeyOf(a, b))?.id ?? null);
  }

  /** Conversa a dois: aberta para quem criou; para o outro, aparece quando chegar a primeira mensagem. */
  createDm(from: Id, to: Id): Id {
    const id = nextId();
    const now = Date.now();
    this.transaction(() => {
      this.run("INSERT INTO channels (id, guild_id, name, position, type, dm_key) VALUES (?, NULL, '', 0, 'dm', ?)", Number(id), dmKeyOf(from, to));
      this.run("INSERT INTO channel_recipients (channel_id, user_id, joined_at, open) VALUES (?, ?, ?, 1), (?, ?, ?, 0)", Number(id), Number(from), now, Number(id), Number(to), now);
    });
    return id;
  }

  createGroupDm(ownerId: Id, memberIds: readonly Id[], name: string | null): Id {
    const id = nextId();
    const now = Date.now();
    this.transaction(() => {
      this.run("INSERT INTO channels (id, guild_id, name, position, type, owner_id) VALUES (?, NULL, ?, 0, 'group_dm', ?)", Number(id), name ?? "", Number(ownerId));
      for (const userId of [ownerId, ...memberIds]) this.run("INSERT OR IGNORE INTO channel_recipients (channel_id, user_id, joined_at, open) VALUES (?, ?, ?, 1)", Number(id), Number(userId), now);
    });
    return id;
  }

  setDmOpen(channelId: Id, userId: Id, open: boolean): void {
    this.run("UPDATE channel_recipients SET open = ? WHERE channel_id = ? AND user_id = ?", open ? 1 : 0, Number(channelId), Number(userId));
  }

  hiddenRecipientsOf(channelId: Id): Id[] {
    return this.all<{ user_id: number }>("SELECT user_id FROM channel_recipients WHERE channel_id = ? AND open = 0", Number(channelId)).map((r) => String(r.user_id));
  }

  addRecipient(channelId: Id, userId: Id): void {
    this.run("INSERT OR IGNORE INTO channel_recipients (channel_id, user_id, joined_at, open) VALUES (?, ?, ?, 1)", Number(channelId), Number(userId), Date.now());
  }

  /** Tira do grupo. Se era o dono, o dono passa a ser quem entrou primeiro; sem ninguém, o grupo some. */
  removeRecipient(channelId: Id, userId: Id): { deleted: boolean } {
    return this.transaction(() => {
      this.run("DELETE FROM channel_recipients WHERE channel_id = ? AND user_id = ?", Number(channelId), Number(userId));
      const left = this.recipientIdsOf(channelId);
      if (left.length === 0) {
        this.run("DELETE FROM channels WHERE id = ? AND guild_id IS NULL", Number(channelId));
        return { deleted: true };
      }
      this.run("UPDATE channels SET owner_id = ? WHERE id = ? AND (owner_id IS NULL OR owner_id = ?)", Number(left[0]), Number(channelId), Number(userId));
      return { deleted: false };
    });
  }

  renameGroupDm(channelId: Id, name: string | null): void {
    this.run("UPDATE channels SET name = ? WHERE id = ? AND type = 'group_dm'", name ?? "", Number(channelId));
  }

  addMember(guildId: Id, user: User, live: LiveState): Member {
    const joinedAt = Date.now();
    this.run("INSERT INTO members (guild_id, user_id, joined_at) VALUES (?, ?, ?)", Number(guildId), Number(user.id), joinedAt);
    const presence = live.presenceOf(user.id);
    return { user, joinedAt, online: presence.status !== "offline", roles: [], timeoutUntil: this.timeoutOf(guildId, user.id), status: presence.status, customStatus: presence.customStatus };
  }

  getChannel(channelId: Id): Channel | undefined {
    const row = this.one<ChannelRow>(`SELECT ${CHANNEL_COLUMNS} FROM channels WHERE id = ? AND guild_id IS NOT NULL`, Number(channelId));
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
    return this.all<{ code: string; uses: number; created_at: number; id: number | null; username: string | null; display_name: string | null; avatar_id: number | null }>(
      `SELECT i.code, i.uses, i.created_at, u.id, u.username, u.display_name, u.avatar_id
       FROM invites i LEFT JOIN users u ON u.id = i.created_by WHERE i.guild_id = ? ORDER BY i.created_at DESC`,
      Number(guildId),
    ).map((r) => ({ code: r.code, guildId, uses: r.uses, createdAt: r.created_at, createdBy: userOrNull(r.id, r.username, r.display_name, r.avatar_id) }));
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
    // anexos com link assinado (só quem recebe a mensagem recebe o link)
    const attachments = new Map<number, Attachment[]>();
    const now = Date.now();
    for (const r of this.all<FileRow>(`SELECT ${FILE_COLUMNS} FROM files WHERE kind = 'attachment' AND message_id IN (${marks}) ORDER BY position, id`, ...ids)) {
      const filename = r.filename ?? "arquivo";
      attachments.set(r.message_id!, [
        ...(attachments.get(r.message_id!) ?? []),
        { id: String(r.id), filename, size: r.size, contentType: r.content_type, width: r.width, height: r.height, url: signAttachment(this.attachmentSecret, String(r.id), filename, now) },
      ]);
    }
    return rows.map((r) => ({
      id: String(r.id),
      channelId: String(r.channel_id),
      author: { id: String(r.author_id), username: r.username, displayName: r.display_name, avatar: avatarOf(r.avatar_id) },
      content: r.content,
      createdAt: r.created_at,
      editedAt: r.edited_at,
      replyTo: toReference(r),
      reactions: reactions.get(r.id) ?? [],
      mentions: mentions.get(r.id) ?? [],
      attachments: attachments.get(r.id) ?? [],
    }));
  }

  private setMentions(messageId: Id, mentionIds: Id[]): void {
    this.run("DELETE FROM message_mentions WHERE message_id = ?", Number(messageId));
    for (const userId of mentionIds) this.run("INSERT OR IGNORE INTO message_mentions (message_id, user_id) VALUES (?, ?)", Number(messageId), Number(userId));
  }

  /**
   * `mentionIds` já validados (membros do servidor), incluindo o autor da mensagem respondida.
   * `attachmentIds`: anexos pendentes já conferidos (`pendingAttachments`).
   */
  createMessage(channelId: Id, author: User, content: string, replyToId: Id | null = null, mentionIds: Id[] = [], attachmentIds: Id[] = []): Message {
    const id = nextId();
    this.transaction(() => {
      this.run(
        "INSERT INTO messages (id, channel_id, author_id, content, created_at, reply_to_id) VALUES (?, ?, ?, ?, ?, ?)",
        Number(id), Number(channelId), Number(author.id), content, Date.now(), replyToId === null ? null : Number(replyToId),
      );
      this.setMentions(id, mentionIds);
      // a ordem é a da fila de quem enviou (não a de quem terminou de subir primeiro)
      attachmentIds.forEach((fileId, position) =>
        this.run("UPDATE files SET message_id = ?, position = ? WHERE id = ? AND message_id IS NULL", Number(id), position, Number(fileId)),
      );
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
    // Conversa direta: toda mensagem de outra pessoa conta como menção (selo e notificação).
    const rows = this.all<{ channel_id: number; last_read_id: number; last_message_id: number | null; mention_count: number }>(
      `WITH base AS (
         SELECT c.id AS channel_id, COALESCE(rs.last_read_id, MAX(mb.joined_at - ?, 0) * ?) AS last_read_id, 0 AS is_dm
           FROM channels c
           JOIN members mb ON mb.guild_id = c.guild_id AND mb.user_id = ?
           LEFT JOIN read_states rs ON rs.channel_id = c.id AND rs.user_id = ?
          WHERE c.type IN ('text', 'voice')
         UNION ALL
         SELECT c.id, COALESCE(rs.last_read_id, MAX(cr.joined_at - ?, 0) * ?), 1
           FROM channels c
           JOIN channel_recipients cr ON cr.channel_id = c.id AND cr.user_id = ? AND cr.open = 1
           LEFT JOIN read_states rs ON rs.channel_id = c.id AND rs.user_id = ?
          WHERE c.guild_id IS NULL)
       SELECT b.channel_id, b.last_read_id,
         (SELECT MAX(m.id) FROM messages m WHERE m.channel_id = b.channel_id) AS last_message_id,
         CASE WHEN b.is_dm = 1
           THEN (SELECT COUNT(*) FROM messages m WHERE m.channel_id = b.channel_id AND m.author_id <> ? AND m.id > b.last_read_id)
           ELSE (SELECT COUNT(*) FROM message_mentions mm JOIN messages m ON m.id = mm.message_id
                  WHERE mm.user_id = ? AND m.channel_id = b.channel_id AND m.author_id <> ? AND m.id > b.last_read_id)
         END AS mention_count
       FROM base b`,
      ID_EPOCH, ID_SEQUENCE_SIZE, uid, uid, ID_EPOCH, ID_SEQUENCE_SIZE, uid, uid, uid, uid, uid,
    );
    return rows.map((r) => ({
      channelId: String(r.channel_id),
      lastReadId: String(r.last_read_id),
      lastMessageId: r.last_message_id === null ? null : String(r.last_message_id),
      mentionCount: r.mention_count,
    }));
  }
}
