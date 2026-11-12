import type { Message } from "@aurora/schema";

/** Mensagens do mesmo autor com menos de 7 min compartilham cabeçalho (guia visual §6.3). */
export const GROUP_WINDOW_MS = 7 * 60 * 1000;
export const AVATAR_PALETTE_SIZE = 8;

export interface MessageRow {
  message: Message;
  startsGroup: boolean;
}

export function groupMessages(messages: readonly Message[]): MessageRow[] {
  return messages.map((message, index) => {
    const previous = index > 0 ? messages[index - 1] : undefined;
    const startsGroup =
      previous === undefined ||
      previous.author.id !== message.author.id ||
      message.createdAt - previous.createdAt >= GROUP_WINDOW_MS ||
      message.replyTo !== null; // resposta sempre mostra o cabeçalho (fica claro quem respondeu a quem)
    return { message, startsGroup };
  });
}

/** Cor de avatar estável derivada do ID (0..7 → tokens --avatar-N). */
export function avatarIndex(id: string): number {
  let hash = 0;
  for (const char of id) hash = (hash * 31 + char.charCodeAt(0)) >>> 0;
  return hash % AVATAR_PALETTE_SIZE;
}

export function initials(name: string): string {
  const parts = name.trim().split(/\s+/).filter(Boolean);
  const first = parts[0]?.[0] ?? "?";
  const last = parts.length > 1 ? (parts[parts.length - 1]?.[0] ?? "") : "";
  return (first + last).toUpperCase();
}

const timeFormat = new Intl.DateTimeFormat("pt-BR", { hour: "2-digit", minute: "2-digit" });
const dateTimeFormat = new Intl.DateTimeFormat("pt-BR", { day: "2-digit", month: "2-digit", hour: "2-digit", minute: "2-digit" });

export function formatTime(timestamp: number, now: number = Date.now()): string {
  const sameDay = new Date(timestamp).toDateString() === new Date(now).toDateString();
  return sameDay ? timeFormat.format(timestamp) : dateTimeFormat.format(timestamp);
}

/** "Ana está digitando…", "Ana e Bia estão digitando…", "Várias pessoas estão digitando…". */
export function typingText(names: readonly string[]): string {
  if (names.length === 0) return "";
  if (names.length === 1) return `${names[0]} está digitando…`;
  if (names.length === 2) return `${names[0]} e ${names[1]} estão digitando…`;
  return "Várias pessoas estão digitando…";
}
