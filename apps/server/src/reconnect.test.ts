/**
 * Reconexão ponta a ponta: o cliente de gateway do APP (apps/desktop) contra o servidor real.
 * O servidor cai e volta na mesma porta; o cliente deve reconectar sozinho e receber um novo READY.
 */
import { afterAll, expect, it } from "vitest";
import type { AddressInfo } from "node:net";
import type { FastifyInstance } from "fastify";
import type { AuthResponse } from "@aurora/schema";
import { GatewayClient, type ConnectionStatus } from "../../desktop/src/net/gateway.ts";
import { buildApp } from "./http.ts";
import { Gateway } from "./gateway.ts";
import { Store } from "./store.ts";

const store = new Store(":memory:");
let app: FastifyInstance | undefined;

async function start(port = 0): Promise<number> {
  app = await buildApp({ store, gateway: new Gateway(store) });
  await app.listen({ port, host: "127.0.0.1" });
  return (app.server.address() as AddressInfo).port;
}

afterAll(async () => {
  await app?.close();
  store.close();
});

it("cliente do app reconecta sozinho quando o servidor reinicia", async () => {
  const port = await start();
  const base = `http://127.0.0.1:${port}`;
  const res = await fetch(`${base}/api/auth/register`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ username: "rita", password: "senha-forte-9" }),
  });
  const { token } = (await res.json()) as AuthResponse;

  const statuses: ConnectionStatus[] = [];
  let readyCount = 0;
  let resolveReady: () => void = () => {};
  const nextReady = () => new Promise<void>((resolve) => (resolveReady = resolve));

  const client = new GatewayClient(base, token, {
    onStatus: (status) => statuses.push(status),
    onReady: () => {
      readyCount += 1;
      resolveReady();
    },
    onDispatch: () => {},
    onInvalidSession: () => {},
  });

  let ready = nextReady();
  client.start();
  await ready;
  expect(readyCount).toBe(1);

  ready = nextReady();
  await app!.close(); // servidor cai (fecha as conexões)
  await start(port); // e volta na mesma porta
  await ready;

  expect(readyCount).toBe(2);
  expect(statuses).toContain("reconnecting");
  expect(statuses.at(-1)).toBe("ready");
  client.stop();
}, 15_000);
