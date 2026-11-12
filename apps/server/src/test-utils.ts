import type { ServerFrame } from "@aurora/schema";

/** Chamada REST de teste: devolve status e corpo JSON (ou undefined). */
export async function request<T = unknown>(base: string, method: string, path: string, token?: string, body?: unknown): Promise<{ status: number; data: T }> {
  const headers: Record<string, string> = {};
  if (token) headers.Authorization = `Bearer ${token}`;
  if (body !== undefined) headers["Content-Type"] = "application/json";
  const res = await fetch(base + path, { method, headers, body: body === undefined ? undefined : JSON.stringify(body) });
  const text = await res.text();
  return { status: res.status, data: (text ? JSON.parse(text) : undefined) as T };
}

/** Cliente de gateway de teste: guarda os frames e espera pelo que for pedido. */
export class GatewayTestClient {
  private readonly buffer: ServerFrame[] = [];
  private readonly waiters: { match: (f: ServerFrame) => boolean; resolve: (f: ServerFrame) => void }[] = [];
  readonly closed: Promise<number>;
  readonly opened: Promise<unknown>;
  private readonly ws: WebSocket;

  constructor(base: string) {
    this.ws = new WebSocket(`${base.replace("http", "ws")}/gateway`);
    this.ws.addEventListener("message", (event) => {
      const frame = JSON.parse(String(event.data)) as ServerFrame;
      const index = this.waiters.findIndex((w) => w.match(frame));
      if (index >= 0) this.waiters.splice(index, 1)[0]!.resolve(frame);
      else this.buffer.push(frame);
    });
    this.opened = new Promise((resolve) => this.ws.addEventListener("open", resolve, { once: true }));
    this.closed = new Promise((resolve) => this.ws.addEventListener("close", (event) => resolve(event.code)));
  }

  /** `v` = versão do protocolo do cliente (sem `v` = app 1.2.x). */
  static async identify(base: string, token: string, v?: number): Promise<{ client: GatewayTestClient; ready: Extract<ServerFrame, { op: "ready" }> }> {
    const client = new GatewayTestClient(base);
    await client.opened;
    client.send(v === undefined ? { op: "identify", token } : { op: "identify", token, v });
    const ready = await client.next((f) => f.op === "ready");
    return { client, ready: ready as Extract<ServerFrame, { op: "ready" }> };
  }

  send(frame: unknown): void {
    this.ws.send(JSON.stringify(frame));
  }

  next(match: (frame: ServerFrame) => boolean, timeoutMs = 3000): Promise<ServerFrame> {
    const index = this.buffer.findIndex(match);
    if (index >= 0) return Promise.resolve(this.buffer.splice(index, 1)[0]!);
    return new Promise((resolve, reject) => {
      const timer = setTimeout(() => reject(new Error("timeout esperando frame")), timeoutMs);
      this.waiters.push({ match, resolve: (f) => (clearTimeout(timer), resolve(f)) });
    });
  }

  event<T extends string>(t: T, timeoutMs?: number): Promise<Extract<ServerFrame, { op: "dispatch"; t: T }>> {
    return this.next((f) => f.op === "dispatch" && f.t === t, timeoutMs) as Promise<Extract<ServerFrame, { op: "dispatch"; t: T }>>;
  }

  /** Garante que NENHUM evento do tipo chega no intervalo. */
  async expectNoEvent(t: string, waitMs = 300): Promise<void> {
    await new Promise((r) => setTimeout(r, waitMs));
    if (this.buffer.some((f) => f.op === "dispatch" && f.t === t)) throw new Error(`evento inesperado ${t}`);
  }

  close(): void {
    this.ws.close();
  }
}
