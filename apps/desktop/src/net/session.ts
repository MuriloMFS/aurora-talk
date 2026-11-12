import type { User } from "@aurora/schema";

export interface Session {
  serverUrl: string;
  token: string;
  user: User;
}

const SESSION_KEY = "aurora.session";
const SERVER_KEY = "aurora.server";
export const DEFAULT_SERVER_URL = "http://localhost:3000";

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
    return localStorage.getItem(SERVER_KEY) ?? DEFAULT_SERVER_URL;
  } catch {
    return DEFAULT_SERVER_URL;
  }
}
