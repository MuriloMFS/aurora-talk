import { createHash, createHmac, randomBytes, timingSafeEqual } from "node:crypto";

/* ---------------- verificação em duas etapas (TOTP, RFC 6238) ---------------- */

const BASE32 = "ABCDEFGHIJKLMNOPQRSTUVWXYZ234567";
/** Janela de 30 s e 6 dígitos: o que todo app autenticador usa por padrão. */
export const TOTP_STEP_SECONDS = 30;
const DIGITS = 6;

export function base32Encode(bytes: Uint8Array): string {
  let bits = 0;
  let value = 0;
  let out = "";
  for (const byte of bytes) {
    value = (value << 8) | byte;
    bits += 8;
    while (bits >= 5) {
      out += BASE32[(value >>> (bits - 5)) & 31];
      bits -= 5;
    }
  }
  if (bits > 0) out += BASE32[(value << (5 - bits)) & 31];
  return out;
}

export function base32Decode(text: string): Buffer {
  const clean = text.toUpperCase().replace(/[\s=-]/g, "");
  let bits = 0;
  let value = 0;
  const out: number[] = [];
  for (const char of clean) {
    const index = BASE32.indexOf(char);
    if (index < 0) throw new Error("base32 inválido");
    value = (value << 5) | index;
    bits += 5;
    if (bits >= 8) {
      out.push((value >>> (bits - 8)) & 255);
      bits -= 8;
    }
  }
  return Buffer.from(out);
}

/** Segredo novo de 160 bits (o tamanho recomendado para HMAC-SHA1). */
export const newTotpSecret = (): string => base32Encode(randomBytes(20));

/** Código de um passo de tempo (HOTP, RFC 4226). */
export function hotp(secret: Buffer, counter: number, digits = DIGITS): string {
  const message = Buffer.alloc(8);
  message.writeBigUInt64BE(BigInt(counter));
  const hmac = createHmac("sha1", secret).update(message).digest();
  const offset = hmac[hmac.length - 1]! & 15;
  const code = (hmac.readUInt32BE(offset) & 0x7fffffff) % 10 ** digits;
  return String(code).padStart(digits, "0");
}

export const totpStep = (now = Date.now()) => Math.floor(now / 1000 / TOTP_STEP_SECONDS);

/**
 * Confere o código aceitando um passo antes e um depois (relógio do celular um pouco fora). Devolve o
 * passo usado, para o servidor recusar o mesmo código de novo (`lastStep`), ou `null`.
 */
export function verifyTotp(secretBase32: string, code: string, lastStep: number | null, now = Date.now()): number | null {
  if (!/^\d{6}$/.test(code)) return null;
  const secret = base32Decode(secretBase32);
  const current = totpStep(now);
  for (const step of [current, current - 1, current + 1]) {
    if (lastStep !== null && step <= lastStep) continue;
    const expected = Buffer.from(hotp(secret, step));
    if (timingSafeEqual(expected, Buffer.from(code))) return step;
  }
  return null;
}

/** Endereço que o app autenticador entende (vira o QR code). */
export const otpauthUri = (issuer: string, account: string, secret: string) =>
  `otpauth://totp/${encodeURIComponent(`${issuer}:${account}`)}?secret=${secret}&issuer=${encodeURIComponent(issuer)}&algorithm=SHA1&digits=${DIGITS}&period=${TOTP_STEP_SECONDS}`;

/* ---------------- códigos de recuperação ---------------- */

/** Sem letras parecidas (0/O, 1/I/L). 10 caracteres ≈ 50 bits cada código. */
const RECOVERY_ALPHABET = "abcdefghjkmnpqrstuvwxyz23456789";
export const RECOVERY_CODE_COUNT = 10;

export function newRecoveryCodes(count = RECOVERY_CODE_COUNT): string[] {
  return Array.from({ length: count }, () => {
    const bytes = randomBytes(10);
    let code = "";
    for (const byte of bytes) code += RECOVERY_ALPHABET[byte % RECOVERY_ALPHABET.length];
    return `${code.slice(0, 5)}-${code.slice(5)}`;
  });
}

/** Como o código é guardado (aceita com ou sem hífen, maiúsculas ou minúsculas). */
export const hashRecoveryCode = (code: string) => createHash("sha256").update(`recovery:${code.toLowerCase().replace(/[^a-z0-9]/g, "")}`).digest("hex");
export const looksLikeRecoveryCode = (code: string) => /^[a-z0-9]{5}-?[a-z0-9]{5}$/i.test(code.trim());

/* ---------------- aparelhos conectados ---------------- */

/** Nome do aparelho para a lista de sessões (o app manda; senão, um palpite pelo User-Agent). */
export function deviceName(sent: string | undefined, userAgent: string | undefined): string {
  const clean = sent?.replace(/[\u0000-\u001f\u007f]/g, "").trim().slice(0, 60);
  if (clean) return clean;
  const ua = userAgent ?? "";
  const browser = /Edg\//.test(ua) ? "Edge" : /Firefox\//.test(ua) ? "Firefox" : /Chrome\//.test(ua) ? "Chrome" : /Safari\//.test(ua) ? "Safari" : null;
  const os = /Windows/.test(ua) ? "Windows" : /Android/.test(ua) ? "Android" : /iPhone|iPad/.test(ua) ? "iPhone/iPad" : /Mac OS/.test(ua) ? "Mac" : /Linux/.test(ua) ? "Linux" : null;
  return browser ? `${browser}${os ? ` no ${os}` : ""}` : "Aparelho desconhecido";
}
