import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { AddressInfo } from "node:net";
import type { FastifyInstance } from "fastify";
import { buildApp } from "./http.ts";
import { Gateway } from "./gateway.ts";
import { Store } from "./store.ts";
import { compareVersions } from "./updates.ts";

let app: FastifyInstance;
let store: Store;
let base = "";
let dir = "";

beforeAll(async () => {
  dir = mkdtempSync(join(tmpdir(), "aurora-releases-"));
  mkdirSync(join(dir, "1.2.0"));
  writeFileSync(join(dir, "1.2.0", "Aurora_1.2.0_x64-setup.exe"), "binario-fake");
  writeFileSync(join(dir, "1.2.0", "Aurora_1.2.0_amd64.AppImage"), "appimage-fake");
  writeFileSync(join(dir, "1.2.0", "Aurora_1.2.0_amd64.deb"), "deb-fake-maior");
  writeFileSync(join(dir, "segredo.txt"), "não deve vazar");
  writeFileSync(
    join(dir, "latest.json"),
    JSON.stringify({
      version: "1.2.0",
      notes: "Canais de voz",
      pub_date: "2026-11-12T12:00:00Z",
      platforms: {
        "windows-x86_64": { file: "Aurora_1.2.0_x64-setup.exe", signature: "assinatura-base64" },
        "linux-x86_64": { file: "Aurora_1.2.0_amd64.AppImage", signature: "assinatura-appimage" },
        "linux-x86_64-appimage": { file: "Aurora_1.2.0_amd64.AppImage", signature: "assinatura-appimage" },
        "linux-x86_64-deb": { file: "Aurora_1.2.0_amd64.deb", signature: "assinatura-deb" },
      },
    }),
  );
  store = new Store(":memory:");
  app = await buildApp({ store, gateway: new Gateway(store), releasesDir: dir });
  await app.listen({ port: 0, host: "127.0.0.1" });
  base = `http://127.0.0.1:${(app.server.address() as AddressInfo).port}`;
});

afterAll(async () => {
  await app.close();
  store.close();
  rmSync(dir, { recursive: true, force: true });
});

describe("atualizações do app", () => {
  it("compara versões numericamente", () => {
    expect(compareVersions("1.10.0", "1.9.9")).toBe(1);
    expect(compareVersions("1.0.1", "1.0.1")).toBe(0);
    expect(compareVersions("1.0.0", "1.0.1")).toBe(-1);
  });

  it("Linux: cada tipo de instalação recebe o seu pacote; sem tipo, o AppImage", async () => {
    const pick = async (query: string) => (await (await fetch(`${base}/api/updates/linux/x86_64/1.0.1${query}`)).json()) as { url: string; signature: string };
    expect(await pick("?bundle=deb")).toMatchObject({ signature: "assinatura-deb", url: `${base}/api/updates/download/1.2.0/Aurora_1.2.0_amd64.deb` });
    expect(await pick("?bundle=appimage")).toMatchObject({ signature: "assinatura-appimage" });
    expect(await pick("")).toMatchObject({ signature: "assinatura-appimage" });
    expect(await pick("?bundle=rpm")).toMatchObject({ signature: "assinatura-appimage" }); // tipo sem pacote: o padrão
    expect((await pick("?bundle=..%2F..%2Fx")).signature).toBe("assinatura-appimage"); // valor estranho é ignorado
    const windows = (await (await fetch(`${base}/api/updates/windows/x86_64/1.0.1?bundle=nsis`)).json()) as { signature: string };
    expect(windows.signature).toBe("assinatura-base64"); // Windows continua igual, com ou sem tipo
  });

  it("site: tamanhos e links fixos do Linux", async () => {
    const latest = (await (await fetch(`${base}/api/releases/latest`)).json()) as { linux: unknown };
    expect(latest.linux).toEqual({ appImage: { size: 13, download: "/download/linux" }, deb: { size: 14, download: "/download/linux-deb" } });
    const res = await fetch(`${base}/download/linux-deb`, { redirect: "manual" });
    expect(res.status).toBe(302);
    expect(res.headers.get("location")).toBe("/api/updates/download/1.2.0/Aurora_1.2.0_amd64.deb");
  });

  it("oferece a versão nova para quem está atrás, com URL e assinatura", async () => {
    const res = await fetch(`${base}/api/updates/windows/x86_64/1.0.1`);
    expect(res.status).toBe(200);
    const body = (await res.json()) as { version: string; url: string; signature: string; notes: string };
    expect(body).toMatchObject({ version: "1.2.0", signature: "assinatura-base64", notes: "Canais de voz" });
    expect(body.url).toBe(`${base}/api/updates/download/1.2.0/Aurora_1.2.0_x64-setup.exe`);

    const file = await fetch(body.url);
    expect(file.status).toBe(200);
    expect(await file.text()).toBe("binario-fake");
  });

  it("204 para quem já está atualizado, versão inválida ou plataforma sem pacote", async () => {
    expect((await fetch(`${base}/api/updates/windows/x86_64/1.2.0`)).status).toBe(204);
    expect((await fetch(`${base}/api/updates/windows/x86_64/9.0.0`)).status).toBe(204);
    expect((await fetch(`${base}/api/updates/windows/x86_64/abc`)).status).toBe(204);
    expect((await fetch(`${base}/api/updates/darwin/aarch64/1.0.0`)).status).toBe(204);
  });

  it("download não sai da pasta de versões", async () => {
    expect((await fetch(`${base}/api/updates/download/1.2.0/..%2Fsegredo.txt`)).status).toBe(404);
    expect((await fetch(`${base}/api/updates/download/1.2.0/inexistente.exe`)).status).toBe(404);
    expect((await fetch(`${base}/api/updates/download/..%2F..%2F/latest.json`)).status).toBe(404);
  });
});
