import { describe, expect, it } from "vitest";
import {
  base32Decode,
  base32Encode,
  deviceName,
  hashRecoveryCode,
  hotp,
  newRecoveryCodes,
  newTotpSecret,
  otpauthUri,
  totpStep,
  verifyTotp,
} from "./security.ts";

describe("TOTP", () => {
  // Vetores oficiais: RFC 4226 (apêndice D) e RFC 6238 (apêndice B, SHA-1, 8 dígitos).
  const rfcSecret = Buffer.from("12345678901234567890");

  it("HOTP bate com a RFC 4226", () => {
    const expected = ["755224", "287082", "359152", "969429", "338314", "254676", "287922", "162583", "399871", "520489"];
    expect(expected.map((_, i) => hotp(rfcSecret, i))).toEqual(expected);
  });

  it("TOTP bate com a RFC 6238", () => {
    const vectors: [number, string][] = [
      [59, "94287082"],
      [1111111109, "07081804"],
      [1111111111, "14050471"],
      [1234567890, "89005924"],
      [2000000000, "69279037"],
    ];
    for (const [seconds, code] of vectors) expect(hotp(rfcSecret, totpStep(seconds * 1000), 8)).toBe(code);
  });

  it("base32 vai e volta; segredo novo tem 160 bits", () => {
    expect(base32Encode(Buffer.from("12345678901234567890"))).toBe("GEZDGNBVGY3TQOJQGEZDGNBVGY3TQOJQ");
    const secret = newTotpSecret();
    expect(secret).toMatch(/^[A-Z2-7]{32}$/);
    expect(base32Decode(secret)).toHaveLength(20);
  });

  it("aceita um passo de folga para cada lado, recusa o resto e não aceita o mesmo código duas vezes", () => {
    const secret = newTotpSecret();
    const now = 1_700_000_000_000;
    const code = (offset: number) => hotp(base32Decode(secret), totpStep(now) + offset);
    expect(verifyTotp(secret, code(0), null, now)).toBe(totpStep(now));
    expect(verifyTotp(secret, code(-1), null, now)).toBe(totpStep(now) - 1);
    expect(verifyTotp(secret, code(1), null, now)).toBe(totpStep(now) + 1);
    expect(verifyTotp(secret, code(2), null, now)).toBeNull();
    expect(verifyTotp(secret, code(0), totpStep(now), now)).toBeNull(); // já usado
    expect(verifyTotp(secret, "12345", null, now)).toBeNull();
    expect(verifyTotp(secret, "abcdef", null, now)).toBeNull();
  });

  it("endereço para o app autenticador", () => {
    expect(otpauthUri("Aurora", "ana", "ABC")).toBe("otpauth://totp/Aurora%3Aana?secret=ABC&issuer=Aurora&algorithm=SHA1&digits=6&period=30");
  });
});

describe("códigos de recuperação e aparelhos", () => {
  it("10 códigos diferentes, sem letras confusas; o hash ignora hífen e maiúsculas", () => {
    const codes = newRecoveryCodes();
    expect(new Set(codes).size).toBe(10);
    for (const code of codes) expect(code).toMatch(/^[a-hjkmnp-z2-9]{5}-[a-hjkmnp-z2-9]{5}$/);
    expect(hashRecoveryCode("ABCDE-FGHJK")).toBe(hashRecoveryCode("abcdefghjk"));
  });

  it("nome do aparelho: o que o app manda, ou um palpite pelo navegador", () => {
    expect(deviceName("Aurora para Windows", undefined)).toBe("Aurora para Windows");
    expect(deviceName(undefined, "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/140 Safari/537.36 Edg/140")).toBe("Edge no Windows");
    expect(deviceName("", "curl/8")).toBe("Aparelho desconhecido");
    expect(deviceName("a\u0000b".padEnd(100, "x"), undefined)).toHaveLength(60);
  });
});
