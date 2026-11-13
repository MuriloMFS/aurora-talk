import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { mkdtempSync, mkdirSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { FastifyInstance } from "fastify";
import { buildApp } from "./http.ts";
import { Gateway } from "./gateway.ts";
import { Store } from "./store.ts";

/** Atrás do Cloudflare Tunnel (cloudflared na mesma máquina → 127.0.0.1). */
let app: FastifyInstance;
let store: Store;
let releases = "";

beforeAll(async () => {
  releases = mkdtempSync(join(tmpdir(), "aurora-proxy-"));
  mkdirSync(join(releases, "1.3.1"));
  writeFileSync(join(releases, "1.3.1", "Aurora_1.3.1_x64-setup.exe"), "instalador");
  writeFileSync(
    join(releases, "latest.json"),
    JSON.stringify({ version: "1.3.1", platforms: { "windows-x86_64": { file: "Aurora_1.3.1_x64-setup.exe", signature: "sig" } } }),
  );
  store = new Store(":memory:");
  app = await buildApp({ store, gateway: new Gateway(store), releasesDir: releases, trustCloudflare: true });
});

afterAll(async () => {
  await app.close();
  store.close();
  rmSync(releases, { recursive: true, force: true });
});

const viaTunnel = { "x-forwarded-proto": "https", "x-forwarded-host": "aurora.exemplo.dev", host: "localhost:3300" };

describe("servidor atrás do Cloudflare Tunnel", () => {
  it("link de atualização sai com o endereço público em https", async () => {
    const res = await app.inject({ method: "GET", url: "/api/updates/windows/x86_64/1.3.0", headers: viaTunnel });
    expect(res.statusCode).toBe(200);
    expect(res.json().url).toBe("https://aurora.exemplo.dev/api/updates/download/1.3.1/Aurora_1.3.1_x64-setup.exe");
  });

  it("quem chega por http é levado para https (GET) ou recusado (escrita)", async () => {
    const get = await app.inject({ method: "GET", url: "/api/health?x=1", headers: { ...viaTunnel, "x-forwarded-proto": "http" } });
    expect(get.statusCode).toBe(301);
    expect(get.headers.location).toBe("https://aurora.exemplo.dev/api/health?x=1");
    const post = await app.inject({ method: "POST", url: "/api/auth/login", headers: { ...viaTunnel, "x-forwarded-proto": "http" }, payload: {} });
    expect(post.statusCode).toBe(403);
  });

  it("acesso https normal segue funcionando", async () => {
    const res = await app.inject({ method: "GET", url: "/api/health", headers: viaTunnel });
    expect(res.statusCode).toBe(200);
  });
});
