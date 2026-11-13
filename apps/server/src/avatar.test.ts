import { afterAll, beforeAll, describe, expect, it } from "vitest";
import type { AddressInfo } from "node:net";
import type { FastifyInstance } from "fastify";
import { LIMITS, type AuthResponse, type Guild, type Invite, type Message, type User } from "@aurora/schema";
import { buildApp } from "./http.ts";
import { Gateway } from "./gateway.ts";
import { Store } from "./store.ts";
import { detectImageType } from "./files.ts";
import { GatewayTestClient, request } from "./test-utils.ts";

let app: FastifyInstance;
let store: Store;
let base = "";
const api = <T = unknown>(method: string, path: string, token?: string, body?: unknown) => request<T>(base, method, path, token, body);
/** Envia bytes crus (como o app faz com a foto já recortada). */
const upload = async (token: string, bytes: Uint8Array, type = "image/png") => {
  const res = await fetch(`${base}/api/users/@me/avatar`, { method: "PUT", headers: { Authorization: `Bearer ${token}`, "Content-Type": type }, body: bytes });
  return { status: res.status, data: (await res.json()) as User & { error?: { code: string; message: string } } };
};
const PNG = new Uint8Array([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a, 0, 0, 0, 13, 0x49, 0x48, 0x44, 0x52, 1, 2, 3]);
const JPEG = new Uint8Array([0xff, 0xd8, 0xff, 0xe0, 0, 16, 0x4a, 0x46]);
const EXE = new Uint8Array([0x4d, 0x5a, 0x90, 0, 3, 0, 0, 0]); // "MZ": programa do Windows

beforeAll(async () => {
  store = new Store(":memory:");
  app = await buildApp({ store, gateway: new Gateway(store) });
  await app.listen({ port: 0, host: "127.0.0.1" });
  base = `http://127.0.0.1:${(app.server.address() as AddressInfo).port}`;
});

afterAll(async () => {
  await app.close();
  store.close();
});

describe("tipo de imagem pelos bytes", () => {
  it("reconhece PNG, JPEG, GIF e WebP; recusa o resto (inclusive SVG e programas)", () => {
    expect(detectImageType(PNG)).toBe("image/png");
    expect(detectImageType(JPEG)).toBe("image/jpeg");
    expect(detectImageType(new TextEncoder().encode("GIF89a..."))).toBe("image/gif");
    expect(detectImageType(new TextEncoder().encode("RIFF\0\0\0\0WEBPVP8 "))).toBe("image/webp");
    expect(detectImageType(new TextEncoder().encode("RIFF\0\0\0\0WAVEfmt "))).toBeNull();
    expect(detectImageType(new TextEncoder().encode("<svg xmlns='http://www.w3.org/2000/svg'><script>"))).toBeNull();
    expect(detectImageType(EXE)).toBeNull();
    expect(detectImageType(new Uint8Array())).toBeNull();
  });
});

describe("foto de perfil", () => {
  let ana: AuthResponse;
  let beto: AuthResponse;

  it("enviar: vira a foto da conta, todo mundo que divide servidor fica sabendo e ela aparece nas mensagens", async () => {
    const reg = (u: string) => api<AuthResponse>("POST", "/api/auth/register", undefined, { username: u, password: "senha-forte-1" }).then((r) => r.data);
    [ana, beto] = await Promise.all([reg("ana3"), reg("beto3")]);
    expect(ana.user.avatar).toBeNull();
    const guild = (await api<Guild>("POST", "/api/guilds", ana.token, { name: "Fotos" })).data;
    const invite = (await api<Invite>("POST", `/api/guilds/${guild.id}/invites`, ana.token)).data;
    await api("POST", `/api/invites/${invite.code}`, beto.token);
    const geral = guild.channels.find((c) => c.type === "text")!;
    await api("POST", `/api/channels/${geral.id}/messages`, ana.token, { content: "oi" });

    const { client: betoWs } = await GatewayTestClient.identify(base, beto.token, 2);
    const res = await upload(ana.token, PNG, "application/octet-stream"); // o tipo vem dos bytes, não do cabeçalho
    expect(res.status).toBe(200);
    const avatar = res.data.avatar!;
    expect(avatar).toMatch(/^\d+$/);
    expect((await betoWs.event("USER_UPDATE")).d).toMatchObject({ id: ana.user.id, avatar });

    const file = await fetch(`${base}/api/files/${avatar}`);
    expect(file.status).toBe(200);
    expect(file.headers.get("content-type")).toBe("image/png");
    expect(file.headers.get("x-content-type-options")).toBe("nosniff");
    expect(file.headers.get("cache-control")).toContain("immutable");
    expect(new Uint8Array(await file.arrayBuffer())).toEqual(PNG);

    expect((await api<User>("GET", "/api/users/@me", ana.token)).data.avatar).toBe(avatar);
    const messages = (await api<Message[]>("GET", `/api/channels/${geral.id}/messages`, beto.token)).data;
    expect(messages[0]!.author.avatar).toBe(avatar);
    const members = (await api<Guild>("POST", `/api/invites/${invite.code}`, beto.token)).data.members;
    expect(members.find((m) => m.user.id === ana.user.id)?.user.avatar).toBe(avatar);
    betoWs.close();
  });

  it("trocar apaga a foto antiga; tirar volta para as iniciais", async () => {
    const before = (await api<User>("GET", "/api/users/@me", ana.token)).data.avatar!;
    const changed = await upload(ana.token, JPEG, "image/jpeg");
    expect(changed.data.avatar).not.toBe(before);
    expect((await fetch(`${base}/api/files/${before}`)).status).toBe(404);
    const removed = await api<User>("DELETE", "/api/users/@me/avatar", ana.token);
    expect(removed.data.avatar).toBeNull();
    expect((await fetch(`${base}/api/files/${changed.data.avatar}`)).status).toBe(404);
  });

  it("recusa programa renomeado, arquivo vazio, grande demais e quem não está logado", async () => {
    const exe = await upload(ana.token, EXE, "image/png");
    expect(exe.status).toBe(415);
    expect(exe.data.error?.message).toMatch(/PNG, JPEG, WebP ou GIF/);
    expect((await upload(ana.token, new Uint8Array(), "image/png")).status).toBe(400);
    const big = new Uint8Array(LIMITS.avatarMaxBytes + 1);
    big.set(PNG);
    // recusado antes de ler o corpo: 413 com a mensagem, ou a conexão cai no meio do envio
    const tooBig = await upload(ana.token, big).catch(() => null);
    if (tooBig) {
      expect(tooBig.status).toBe(413);
      expect(tooBig.data.error?.code).toBe("too_large");
    }
    const svg = await fetch(`${base}/api/users/@me/avatar`, { method: "PUT", headers: { Authorization: `Bearer ${ana.token}`, "Content-Type": "image/svg+xml" }, body: "<svg/>" });
    expect(svg.status).toBe(415);
    expect((await fetch(`${base}/api/users/@me/avatar`, { method: "PUT", headers: { "Content-Type": "image/png" }, body: PNG })).status).toBe(401);
    expect((await fetch(`${base}/api/files/123`)).status).toBe(404);
    expect((await fetch(`${base}/api/files/..%2F..%2Fetc`)).status).toBe(404);
  });
});
