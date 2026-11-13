import type { User } from "@aurora/schema";

export interface Session {
  serverUrl: string;
  token: string;
  user: User;
}

const SESSION_KEY = "aurora.session";
const SERVER_KEY = "aurora.server";
/**
 * Servidor oficial, embutido na versão publicada (`pnpm release -- -ServerUrl https://…`), como o
 * discord.com no Discord. Sem ele (desenvolvimento), o padrão é o servidor local.
 */
const HOSTED_SERVER_URL = (import.meta.env.VITE_AURORA_SERVER_URL as string | undefined)?.trim().replace(/\/+$/, "") || null;
export const IS_HOSTED = HOSTED_SERVER_URL !== null;
export const DEFAULT_SERVER_URL = HOSTED_SERVER_URL ?? "http://localhost:3000";

/** Endereço da própria máquina ou da rede local (servidor caseiro da 1.x, antes do servidor oficial). */
export function isLocalAddress(url: string): boolean {
  try {
    const host = new URL(url).hostname;
    return host === "localhost" || /^(127\.|10\.|192\.168\.|172\.(1[6-9]|2\d|3[01])\.)/.test(host) || host.endsWith(".local");
  } catch {
    return false;
  }
}

/** Aceita "192.168.0.10:3000", "localhost:3000/" etc. e devolve "http://host:porta". */
export function normalizeServerUrl(raw: string): string {
  let url = raw.trim().replace(/\/+$/, "");
  if (!/^https?:\/\//i.test(url)) url = `http://${url}`;
  return url;
}

export function loadSession(): Session | null {
  try {
    const raw = localStorage.getItem(SESSION_KEY);
    if (!raw) return null;
    const value = JSON.parse(raw) as Partial<Session>;
    return value.serverUrl && value.token && value.user ? (value as Session) : null;
  } catch {
    return null;
  }
}

export function saveSession(session: Session): void {
  try {
    localStorage.setItem(SESSION_KEY, JSON.stringify(session));
    localStorage.setItem(SERVER_KEY, session.serverUrl);
  } catch {
    // sem persistência: a sessão vale só enquanto o app estiver aberto
  }
}

export function clearSession(): void {
  try {
    localStorage.removeItem(SESSION_KEY);
  } catch {
    // nada a fazer
  }
}

export function lastServerUrl(): string {
  try {
    const stored = localStorage.getItem(SERVER_KEY);
    // versão oficial: um servidor caseiro antigo não vira o padrão de novo
    if (IS_HOSTED && stored && isLocalAddress(stored)) return DEFAULT_SERVER_URL;
    return stored ?? DEFAULT_SERVER_URL;
  } catch {
    return DEFAULT_SERVER_URL;
  }
}
