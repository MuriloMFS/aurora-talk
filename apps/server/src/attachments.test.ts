import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { DatabaseSync } from "node:sqlite";
import { existsSync, mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { AddressInfo } from "node:net";
import type { FastifyInstance } from "fastify";
import { LIMITS, PERMISSIONS, type Attachment, type AuthResponse, type Channel, type Guild, type Invite, type Message } from "@aurora/schema";
import { buildApp } from "./http.ts";
import { Gateway } from "./gateway.ts";
import { Store } from "./store.ts";
import { cleanFilename, signAttachment } from "./files.ts";
import { GatewayTestClient, request } from "./test-utils.ts";

let app: FastifyInstance & { sweepFiles?: (now?: number) => Promise<void> };
let store: Store;
let base = "";
let filesDir = "";
const api = <T = unknown>(method: string, path: string, token?: string, body?: unknown) => request<T>(base, method, path, token, body);
const PNG = new Uint8Array([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a, 0, 0, 0, 13, 0x49, 0x48, 0x44, 0x52, 7, 7, 7]);
const upload = async (token: string, channelId: string, bytes: Uint8Array, query = "filename=foto.png&width=800&height=600") => {
  const res = await fetch(`${base}/api/channels/${channelId}/attachments?${query}`, { method: "POST", headers: { Authorization: `Bearer ${token}`, "Content-Type": "application/octet-stream" }, body: bytes });
  return { status: res.status, data: (await res.json()) as Attachment & { error?: { code: string; message: string } } };
};

beforeAll(async () => {
  store = new Store(":memory:");
  filesDir = join(mkdtempSync(join(tmpdir(), "aurora-anexos-")), "files");
  app = await buildApp({ store, gateway: new Gateway(store), filesDir });
  await app.listen({ port: 0, host: "127.0.0.1" });
  base = `http://127.0.0.1:${(app.server.address() as AddressInfo).port}`;
});

afterAll(async () => {
  await app.close();
  store.close();
});

describe("nome de arquivo", () => {
  it("sem pastas, sem caracteres perigosos, curto e mantendo a extensão", () => {
    expect(cleanFilename("C:\\Users\\ana\\Fotos\\praia.jpg", 120)).toBe("praia.jpg");
    expect(cleanFilename("../../etc/passwd", 120)).toBe("passwd");
    expect(cleanFilename('a"b<c>.txt', 120)).toBe("abc.txt");
    expect(cleanFilename("...", 120)).toBe("arquivo");
    expect(cleanFilename(undefined, 120)).toBe("arquivo");
    expect(cleanFilename(`${"x".repeat(200)}.pdf`, 20)).toBe(`${"x".repeat(16)}.pdf`);
  });
});

describe("anexos", () => {
  let ana: AuthResponse;
  let beto: AuthResponse;
  let guild: Guild;
  let geral: Channel;

  it("imagem: envia, vai na mensagem com link assinado e abre na hora para quem vê o canal", async () => {
    const reg = (u: string) => api<AuthResponse>("POST", "/api/auth/register", undefined, { username: u, password: "senha-forte-1" }).then((r) => r.data);
    [ana, beto] = await Promise.all([reg("ana4"), reg("beto4")]);
    guild = (await api<Guild>("POST", "/api/guilds", ana.token, { name: "Anexos" })).data;
    const invite = (await api<Invite>("POST", `/api/guilds/${guild.id}/invites`, ana.token)).data;
    await api("POST", `/api/invites/${invite.code}`, beto.token);
    geral = guild.channels.find((c) => c.type === "text")!;

    const up = await upload(ana.token, geral.id, PNG);
    expect(up.status).toBe(201);
    expect(up.data).toMatchObject({ filename: "foto.png", contentType: "image/png", width: 800, height: 600, url: "" });

    const { client: betoWs } = await GatewayTestClient.identify(base, beto.token, 2);
    const sent = await api<Message>("POST", `/api/channels/${geral.id}/messages`, ana.token, { content: "", attachmentIds: [up.data.id] });
    expect(sent.status).toBe(201); // só a imagem, sem texto
    const attachment = (await betoWs.event("MESSAGE_CREATE")).d.attachments![0]!;
    expect(attachment).toMatchObject({ id: up.data.id, filename: "foto.png", size: PNG.length });
    expect(attachment.url).toMatch(/^\/api\/attachments\/\d+\/foto\.png\?ex=[0-9a-z]+&sig=/);

    const file = await fetch(base + attachment.url);
    expect(file.status).toBe(200);
    expect(file.headers.get("content-type")).toBe("image/png");
    expect(file.headers.get("content-disposition")).toMatch(/^inline/);
    expect(file.headers.get("x-content-type-options")).toBe("nosniff");
    expect(new Uint8Array(await file.arrayBuffer())).toEqual(PNG);
    // o histórico também traz o link
    const history = (await api<Message[]>("GET", `/api/channels/${geral.id}/messages`, beto.token)).data;
    expect(history.at(-1)!.attachments![0]!.url).toBe(attachment.url);
    betoWs.close();
  });

  it("os anexos ficam na ordem em que foram escolhidos, não na que terminaram de subir", async () => {
    const a = await upload(ana.token, geral.id, PNG, "filename=a.png");
    const b = await upload(ana.token, geral.id, PNG, "filename=b.png");
    const msg = (await api<Message>("POST", `/api/channels/${geral.id}/messages`, ana.token, { content: "ordem", attachmentIds: [b.data.id, a.data.id] })).data;
    expect(msg.attachments!.map((x) => x.filename)).toEqual(["b.png", "a.png"]);
  });

  it("link adulterado, de outro anexo ou vencido não abre", async () => {
    const up = await upload(ana.token, geral.id, PNG);
    const msg = (await api<Message>("POST", `/api/channels/${geral.id}/messages`, ana.token, { content: "outra", attachmentIds: [up.data.id] })).data;
    const url = msg.attachments![0]!.url;
    expect((await fetch(base + url.replace(/sig=./, "sig=X"))).status).toBe(404);
    expect((await fetch(base + url.replace(/ex=[0-9a-z]+/, "ex=zzzzzzzz"))).status).toBe(404); // mudar a validade quebra a assinatura
    const otherId = (await api<Message[]>("GET", `/api/channels/${geral.id}/messages`, ana.token)).data[0]!.attachments![0]!.id;
    expect((await fetch(base + url.replace(`/attachments/${up.data.id}/`, `/attachments/${otherId}/`))).status).toBe(404);
    const old = signAttachment(store.attachmentSecret, up.data.id, "foto.png", Date.now() - 26 * 3_600_000);
    expect((await fetch(base + old)).status).toBe(404);
    expect((await fetch(`${base}/api/attachments/${up.data.id}/foto.png`)).status).toBe(404); // sem assinatura
  });

  it("arquivo que não é imagem vai como download (mesmo que diga ser .png)", async () => {
    const html = new TextEncoder().encode("<html><script>alert(1)</script></html>");
    const up = await upload(ana.token, geral.id, html, "filename=pagina.png&width=10&height=10");
    expect(up.data).toMatchObject({ contentType: "application/octet-stream", width: null, height: null });
    const msg = (await api<Message>("POST", `/api/channels/${geral.id}/messages`, ana.token, { content: "veja", attachmentIds: [up.data.id] })).data;
    const res = await fetch(base + msg.attachments![0]!.url);
    expect(res.headers.get("content-type")).toBe("application/octet-stream");
    expect(res.headers.get("content-disposition")).toMatch(/^attachment; filename="pagina\.png"/);
  });

  it("só usa anexo próprio, do mesmo canal e ainda não enviado; limites de quantidade e tamanho", async () => {
    const mine = await upload(ana.token, geral.id, PNG);
    const other = await api<{ error: { code: string } }>("POST", `/api/channels/${geral.id}/messages`, beto.token, { content: "roubei", attachmentIds: [mine.data.id] });
    expect(other.data.error.code).toBe("attachment_not_found");
    const outro = (await api<Channel>("POST", `/api/guilds/${guild.id}/channels`, ana.token, { name: "outro" })).data;
    expect((await api("POST", `/api/channels/${outro.id}/messages`, ana.token, { content: "x", attachmentIds: [mine.data.id] })).status).toBe(400);
    await api("POST", `/api/channels/${geral.id}/messages`, ana.token, { content: "ok", attachmentIds: [mine.data.id] });
    expect((await api("POST", `/api/channels/${geral.id}/messages`, ana.token, { content: "de novo", attachmentIds: [mine.data.id] })).status).toBe(400);

    const many = Array.from({ length: LIMITS.attachmentsPerMessage + 1 }, (_, i) => String(i + 1));
    expect((await api("POST", `/api/channels/${geral.id}/messages`, ana.token, { content: "x", attachmentIds: many })).status).toBe(400);
    expect((await api("POST", `/api/channels/${geral.id}/messages`, ana.token, { content: "   " })).status).toBe(400); // vazia

    const big = new Uint8Array(LIMITS.attachmentMaxBytes + 1);
    // recusado antes de ler o corpo: 413, ou a conexão cai no meio do envio
    const refused = await upload(ana.token, geral.id, big).then((r) => r.status, () => "conexão encerrada");
    expect([413, "conexão encerrada"]).toContain(refused);
    expect((await upload(ana.token, geral.id, new Uint8Array())).status).toBe(400);
  });

  it("quem não pode escrever (ou não vê o canal) não envia arquivo", async () => {
    const priv = (await api<Channel>("POST", `/api/guilds/${guild.id}/channels`, ana.token, { name: "privado", private: true })).data;
    expect((await upload(beto.token, priv.id, PNG)).status).toBe(404);
    await api("PUT", `/api/channels/${geral.id}/overwrites/role/${guild.id}`, ana.token, { allow: 0, deny: PERMISSIONS.SEND_MESSAGES });
    expect((await upload(beto.token, geral.id, PNG)).status).toBe(403);
    await api("DELETE", `/api/channels/${geral.id}/overwrites/role/${guild.id}`, ana.token);
  });

  it("apagar a mensagem apaga o arquivo; o que ficou sem mensagem por 1 h é limpo", async () => {
    const up = await upload(ana.token, geral.id, PNG);
    const msg = (await api<Message>("POST", `/api/channels/${geral.id}/messages`, ana.token, { content: "some", attachmentIds: [up.data.id] })).data;
    expect(existsSync(join(filesDir, up.data.id))).toBe(true);
    await api("DELETE", `/api/messages/${msg.id}`, ana.token);
    expect(existsSync(join(filesDir, up.data.id))).toBe(false);
    expect((await fetch(base + msg.attachments![0]!.url)).status).toBe(404);

    const abandoned = await upload(ana.token, geral.id, PNG);
    await app.sweepFiles!(Date.now()); // ainda novo: fica
    expect(existsSync(join(filesDir, abandoned.data.id))).toBe(true);
    await app.sweepFiles!(Date.now() + 61 * 60_000);
    expect(existsSync(join(filesDir, abandoned.data.id))).toBe(false);
    expect(store.getFile(abandoned.data.id)).toBeUndefined();
  });

  it("canal apagado: os arquivos dele são limpos na próxima varredura", async () => {
    const tmp = (await api<Channel>("POST", `/api/guilds/${guild.id}/channels`, ana.token, { name: "temporario" })).data;
    const up = await upload(ana.token, tmp.id, PNG);
    await api("POST", `/api/channels/${tmp.id}/messages`, ana.token, { content: "x", attachmentIds: [up.data.id] });
    await api("DELETE", `/api/channels/${tmp.id}`, ana.token);
    await app.sweepFiles!(Date.now() + 61 * 60_000);
    expect(existsSync(join(filesDir, up.data.id))).toBe(false);
  });
});

describe("migração 1.8", () => {
  it("a tabela de arquivos da 1.7 ganha as colunas de anexo e as fotos continuam", () => {
    const dir = mkdtempSync(join(tmpdir(), "aurora-migracao-anexos-"));
    const path = join(dir, "antigo.db");
    const old = new DatabaseSync(path);
    old.exec(`CREATE TABLE users (id INTEGER PRIMARY KEY, username TEXT NOT NULL UNIQUE, display_name TEXT NOT NULL, password_hash TEXT NOT NULL, created_at INTEGER NOT NULL, avatar_id INTEGER);
      CREATE TABLE files (id INTEGER PRIMARY KEY, owner_id INTEGER, kind TEXT NOT NULL, content_type TEXT NOT NULL, size INTEGER NOT NULL, sha256 TEXT NOT NULL, created_at INTEGER NOT NULL);
      INSERT INTO users VALUES (1, 'ana', 'Ana', 'x', 0, 50);
      INSERT INTO files VALUES (50, 1, 'avatar', 'image/png', 10, 'abc', 0);`);
    old.close();
    const migrated = new Store(path);
    expect(migrated.getFile("50")).toMatchObject({ kind: "avatar", contentType: "image/png", messageId: null });
    expect(migrated.getUser("1")?.avatar).toBe("50");
    expect(migrated.orphanAttachments(Date.now())).toEqual([]); // foto não é anexo: nunca é varrida
    migrated.close();
    rmSync(dir, { recursive: true, force: true });
  });
});
