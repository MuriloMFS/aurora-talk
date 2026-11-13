import { afterAll, beforeAll, describe, expect, it } from "vitest";
import type { AddressInfo } from "node:net";
import type { FastifyInstance } from "fastify";
import type { AuthResponse, SecurityInfo } from "@aurora/schema";
import { buildApp } from "./http.ts";
import { Gateway } from "./gateway.ts";
import { Store } from "./store.ts";
import { base32Decode, hotp, totpStep } from "./security.ts";
import { GatewayTestClient, request } from "./test-utils.ts";

let app: FastifyInstance;
let store: Store;
let base = "";
const api = <T = unknown>(method: string, path: string, token?: string, body?: unknown) => request<T>(base, method, path, token, body);
type Err = { error: { code: string; message: string } };
/** Código que o app autenticador mostraria agora (ou num passo vizinho). */
const codeFor = (secret: string, offset = 0) => hotp(base32Decode(secret), totpStep() + offset);

beforeAll(async () => {
  store = new Store(":memory:");
  app = await buildApp({ store, gateway: new Gateway(store), limits: { auth: 1000, mfa: 20 } });
  await app.listen({ port: 0, host: "127.0.0.1" });
  base = `http://127.0.0.1:${(app.server.address() as AddressInfo).port}`;
});

afterAll(async () => {
  await app.close();
  store.close();
});

describe("segurança da conta", () => {
  let ana: AuthResponse;
  let secret = "";
  let recoveryCodes: string[] = [];

  it("aparelhos conectados: cada login aparece com nome; dá para desconectar um ou todos os outros", async () => {
    ana = (await api<AuthResponse>("POST", "/api/auth/register", undefined, { username: "ana7", password: "senha-forte-1", device: "Aurora para Windows" })).data;
    const celular = (await api<AuthResponse>("POST", "/api/auth/login", undefined, { username: "ana7", password: "senha-forte-1", device: "Celular da Ana" })).data;
    const notebook = (await api<AuthResponse>("POST", "/api/auth/login", undefined, { username: "ana7", password: "senha-forte-1" })).data;
    const info = (await api<SecurityInfo>("GET", "/api/users/@me/security", ana.token)).data;
    expect(info).toMatchObject({ totpEnabled: false, recoveryCodesLeft: 0 });
    expect(info.sessions.map((s) => s.device).sort()).toEqual(["Aparelho desconhecido", "Aurora para Windows", "Celular da Ana"].sort());
    expect(info.sessions.filter((s) => s.current).map((s) => s.device)).toEqual(["Aurora para Windows"]);
    expect(JSON.stringify(info)).not.toContain(celular.token); // o id não é o token

    const { client: celularWs } = await GatewayTestClient.identify(base, celular.token, 2);
    const target = info.sessions.find((s) => s.device === "Celular da Ana")!;
    expect((await api("DELETE", `/api/users/@me/sessions/${target.id}`, ana.token)).status).toBe(204);
    expect(await celularWs.closed).toBe(4004); // caiu na hora
    expect((await api("GET", "/api/users/@me", celular.token)).status).toBe(401);

    expect((await api("DELETE", "/api/users/@me/sessions", ana.token)).status).toBe(204);
    expect((await api("GET", "/api/users/@me", notebook.token)).status).toBe(401);
    expect((await api("GET", "/api/users/@me", ana.token)).status).toBe(200); // este continua
    expect((await api<SecurityInfo>("GET", "/api/users/@me/security", ana.token)).data.sessions).toHaveLength(1);
  });

  it("ligar a verificação em duas etapas: pede a senha, confirma com um código do app e entrega 10 códigos de recuperação", async () => {
    expect((await api<Err>("POST", "/api/users/@me/totp/setup", ana.token, { password: "errada" })).data.error.code).toBe("invalid_password");
    const setup = (await api<{ secret: string; uri: string }>("POST", "/api/users/@me/totp/setup", ana.token, { password: "senha-forte-1" })).data;
    secret = setup.secret;
    expect(setup.uri).toContain(`secret=${secret}`);
    expect(setup.uri).toContain("Aurora%3Aana7");
    // ainda não está ligada: o login continua só com senha
    expect((await api("POST", "/api/auth/login", undefined, { username: "ana7", password: "senha-forte-1" })).status).toBe(200);
    expect((await api<Err>("POST", "/api/users/@me/totp/enable", ana.token, { code: "000000" })).data.error.code).toBe("mfa_invalid");
    const enabled = await api<{ recoveryCodes: string[] }>("POST", "/api/users/@me/totp/enable", ana.token, { code: codeFor(secret) });
    expect(enabled.status).toBe(200);
    recoveryCodes = enabled.data.recoveryCodes;
    expect(recoveryCodes).toHaveLength(10);
    expect((await api<SecurityInfo>("GET", "/api/users/@me/security", ana.token)).data).toMatchObject({ totpEnabled: true, recoveryCodesLeft: 10 });
  });

  it("login com duas etapas: sem código pede o código; código certo entra; o mesmo código não vale duas vezes", async () => {
    const noCode = await api<Err>("POST", "/api/auth/login", undefined, { username: "ana7", password: "senha-forte-1" });
    expect(noCode.status).toBe(401);
    expect(noCode.data.error.code).toBe("mfa_required");
    // senha errada continua dizendo só "usuário ou senha incorretos" (não revela que há 2FA)
    expect((await api<Err>("POST", "/api/auth/login", undefined, { username: "ana7", password: "errada" })).data.error.code).toBe("invalid_credentials");
    const code = codeFor(secret, 1);
    expect((await api("POST", "/api/auth/login", undefined, { username: "ana7", password: "senha-forte-1", code })).status).toBe(200);
    expect((await api<Err>("POST", "/api/auth/login", undefined, { username: "ana7", password: "senha-forte-1", code })).data.error.code).toBe("mfa_invalid");
    // código de recuperação também entra, e só uma vez
    expect((await api("POST", "/api/auth/login", undefined, { username: "ana7", password: "senha-forte-1", code: recoveryCodes[0]!.toUpperCase() })).status).toBe(200);
    expect((await api("POST", "/api/auth/login", undefined, { username: "ana7", password: "senha-forte-1", code: recoveryCodes[0] })).status).toBe(401);
    expect((await api<SecurityInfo>("GET", "/api/users/@me/security", ana.token)).data.recoveryCodesLeft).toBe(9);
  });

  it("esqueci a senha: código de recuperação troca a senha e derruba todos os aparelhos", async () => {
    const before = ana.token;
    const wrong = await api<Err>("POST", "/api/auth/recover", undefined, { username: "ana7", code: "aaaaa-bbbbb", newPassword: "senha-nova-123" });
    expect(wrong.data.error.code).toBe("recover_failed");
    expect((await api<Err>("POST", "/api/auth/recover", undefined, { username: "ninguem", code: recoveryCodes[1], newPassword: "senha-nova-123" })).data.error.code).toBe("recover_failed");
    const recovered = await api<AuthResponse>("POST", "/api/auth/recover", undefined, { username: "ana7", code: recoveryCodes[1], newPassword: "senha-nova-123", device: "Notebook novo" });
    expect(recovered.status).toBe(200);
    expect((await api("GET", "/api/users/@me", before)).status).toBe(401);
    expect((await api("POST", "/api/auth/recover", undefined, { username: "ana7", code: recoveryCodes[1], newPassword: "outra-senha-1" })).status).toBe(400); // já usado
    expect((await api("POST", "/api/auth/login", undefined, { username: "ana7", password: "senha-forte-1", code: codeFor(secret, -1) })).status).toBe(401); // senha antiga
    ana = recovered.data;
  });

  it("códigos novos invalidam os antigos; desligar pede senha e código", async () => {
    const fresh = (await api<{ recoveryCodes: string[] }>("POST", "/api/users/@me/recovery-codes", ana.token, { password: "senha-nova-123" })).data.recoveryCodes;
    expect((await api("POST", "/api/auth/login", undefined, { username: "ana7", password: "senha-nova-123", code: recoveryCodes[2] })).status).toBe(401);
    expect((await api<Err>("POST", "/api/users/@me/totp/disable", ana.token, { password: "senha-nova-123", code: "123456" })).data.error.code).toBe("mfa_invalid");
    expect((await api("POST", "/api/users/@me/totp/disable", ana.token, { password: "senha-nova-123", code: fresh[0] })).status).toBe(200);
    expect((await api<SecurityInfo>("GET", "/api/users/@me/security", ana.token)).data.totpEnabled).toBe(false);
    expect((await api("POST", "/api/auth/login", undefined, { username: "ana7", password: "senha-nova-123" })).status).toBe(200); // só senha de novo
  });

  it("tentativas de código são limitadas (não dá para chutar os 6 dígitos)", async () => {
    const setup = (await api<{ secret: string }>("POST", "/api/users/@me/totp/setup", ana.token, { password: "senha-nova-123" })).data;
    await api("POST", "/api/users/@me/totp/enable", ana.token, { code: codeFor(setup.secret) });
    const statuses: number[] = [];
    for (let i = 0; i < 25; i++) statuses.push((await api("POST", "/api/auth/login", undefined, { username: "ana7", password: "senha-nova-123", code: String(100000 + i) })).status);
    expect(statuses).toContain(429);
  });
});
