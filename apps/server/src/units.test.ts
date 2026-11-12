import { describe, expect, it } from "vitest";
import { hashPassword, newInviteCode, verifyPassword } from "./auth.ts";
import { idTimestamp, isValidId, nextId } from "./ids.ts";
import { RateLimiter } from "./rate-limit.ts";

describe("ids", () => {
  it("são únicos, crescentes e cabem em Number", () => {
    const ids = Array.from({ length: 5000 }, () => nextId());
    expect(new Set(ids).size).toBe(ids.length);
    for (let i = 1; i < ids.length; i++) expect(Number(ids[i])).toBeGreaterThan(Number(ids[i - 1]));
    expect(ids.every(isValidId)).toBe(true);
  });

  it("guardam o instante de criação", () => {
    const now = Date.now();
    expect(Math.abs(idTimestamp(nextId(now)) - now)).toBeLessThan(5);
  });

  it("isValidId rejeita lixo", () => {
    expect(isValidId("abc")).toBe(false);
    expect(isValidId("1".repeat(17))).toBe(false);
    expect(isValidId("")).toBe(false);
  });
});

describe("senhas", () => {
  it("verifica a senha correta e recusa a errada", async () => {
    const stored = await hashPassword("senha-forte-1");
    expect(stored.startsWith("scrypt$")).toBe(true);
    expect(await verifyPassword("senha-forte-1", stored)).toBe(true);
    expect(await verifyPassword("senha-errada", stored)).toBe(false);
    expect(await verifyPassword("x", "formato-invalido")).toBe(false);
  });

  it("dois hashes da mesma senha são diferentes (salt)", async () => {
    expect(await hashPassword("abc12345")).not.toBe(await hashPassword("abc12345"));
  });
});

describe("convites e limitador", () => {
  it("código de convite tem 8 caracteres sem ambíguos", () => {
    const code = newInviteCode();
    expect(code).toMatch(/^[A-Za-z0-9]{8}$/);
    expect(code).not.toMatch(/[0O1lI]/);
  });

  it("libera até o limite na janela e reabre depois", () => {
    const limiter = new RateLimiter(2, 1000);
    expect([limiter.allow("k", 0), limiter.allow("k", 1), limiter.allow("k", 2)]).toEqual([true, true, false]);
    expect(limiter.allow("k", 1001)).toBe(true);
  });
});
