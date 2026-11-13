import { DatabaseSync } from "node:sqlite";
import { mkdirSync } from "node:fs";
import { dirname } from "node:path";
import { LIMITS, type Channel, type ChannelType, type Guild, type Id, type Invite, type Member, type Message, type MessageReference, type Reaction, type ReadState, type User, type VoiceState } from "@aurora/schema";
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
`;

interface UserRow { id: number; username: string; display_name: string }
interface ChannelRow { id: number; guild_id: number; name: string; position: number; type: ChannelType }
interface GuildRow { id: number; name: string; owner_id: number }
interface MemberRow extends UserRow { joined_at: number }
interface MessageRow {
  id: number; channel_id: number; author_id: number; content: string; created_at: number; edited_at: number | null; username: string; display_name: string;
  reply_to_id: number | null; reply_author_id: number | null; reply_username: string | null; reply_display_name: string | null; reply_content: string | null;
}

const toUser = (r: UserRow): User => ({ id: String(r.id), username: r.username, displayName: r.display_name });
const toChannel = (r: ChannelRow): Channel => ({
  id: String(r.id),
  guildId: String(r.guild_id),
  type: r.type === "voice" ? "voice" : "text",
  name: r.name,
  position: r.position,
});
const CHANNEL_COLUMNS = "id, guild_id, name, position, type";

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
      this.run("INSERT INTO channels (id, guild_id, name, position, type) VALUES (?, ?, ?, 0, 'text')", Number(nextId()), Number(guildId), "geral");
      this.run("INSERT INTO channels (id, guild_id, name, position, type) VALUES (?, ?, ?, 1, 'voice')", Number(nextId()), Number(guildId), "Sala de voz");
    });
    return this.getGuild(guildId, live)!;
  }

  getGuild(guildId: Id, live: LiveState): Guild | undefined {
    const row = this.one<GuildRow>("SELECT id, name, owner_id FROM guilds WHERE id = ?", Number(guildId));
    if (!row) return undefined;
    const channels = this.all<ChannelRow>(`SELECT ${CHANNEL_COLUMNS} FROM channels WHERE guild_id = ? ORDER BY position, id`, row.id).map(toChannel);
    const members = this.all<MemberRow>(
      "SELECT u.id, u.username, u.display_name, m.joined_at FROM members m JOIN users u ON u.id = m.user_id WHERE m.guild_id = ? ORDER BY m.joined_at",
      row.id,
    ).map((r): Member => ({ user: toUser(r), joinedAt: r.joined_at, online: live.isOnline(String(r.id)) }));
    const id = String(row.id);
    return { id, name: row.name, ownerId: String(row.owner_id), channels, members, voiceStates: live.voiceStatesOf(id) };
  }

  guildsOf(userId: Id, live: LiveState): Guild[] {
    return this.all<{ guild_id: number }>("SELECT guild_id FROM members WHERE user_id = ? ORDER BY joined_at", Number(userId))
      .map((r) => this.getGuild(String(r.guild_id), live))
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
    return { user, joinedAt, online: live.isOnline(user.id) };
  }

  getChannel(channelId: Id): Channel | undefined {
    const row = this.one<ChannelRow>(`SELECT ${CHANNEL_COLUMNS} FROM channels WHERE id = ?`, Number(channelId));
    return row ? toChannel(row) : undefined;
  }

  createChannel(guildId: Id, name: string, type: ChannelType = "text"): Channel {
    const id = nextId();
    const max = this.one<{ p: number | null }>("SELECT MAX(position) AS p FROM channels WHERE guild_id = ?", Number(guildId));
    const position = (max?.p ?? -1) + 1;
    this.run("INSERT INTO channels (id, guild_id, name, position, type) VALUES (?, ?, ?, ?, ?)", Number(id), Number(guildId), name, position, type);
    return { id, guildId, type, name, position };
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
