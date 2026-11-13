import { createHmac, timingSafeEqual } from "node:crypto";
import { mkdirSync } from "node:fs";
import { readFile, rm, writeFile } from "node:fs/promises";
import { join } from "node:path";

/** Imagens aceitas. SVG fica de fora de propósito: é um documento que pode rodar script. */
export type ImageType = "image/png" | "image/jpeg" | "image/gif" | "image/webp";

const startsWith = (bytes: Uint8Array, signature: readonly number[], offset = 0) => signature.every((b, i) => bytes[offset + i] === b);
const ascii = (text: string) => [...text].map((c) => c.charCodeAt(0));

/**
 * Tipo da imagem pelos primeiros bytes (a "assinatura" do formato). Não confia na extensão nem no
 * Content-Type que o cliente mandou: um .exe renomeado para .png não passa.
 */
export function detectImageType(bytes: Uint8Array): ImageType | null {
  if (startsWith(bytes, [0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a])) return "image/png";
  if (startsWith(bytes, [0xff, 0xd8, 0xff])) return "image/jpeg";
  if (startsWith(bytes, ascii("GIF87a")) || startsWith(bytes, ascii("GIF89a"))) return "image/gif";
  if (startsWith(bytes, ascii("RIFF")) && startsWith(bytes, ascii("WEBP"), 8)) return "image/webp";
  return null;
}

/** Nome de arquivo seguro para mostrar e para o download: sem pastas, sem caracteres de controle, curto. */
export function cleanFilename(raw: string | undefined, max: number): string {
  const name = (raw ?? "")
    .split(/[\\/]/)
    .pop()!
    .replace(/[\u0000-\u001f\u007f"<>:|?*]/g, "")
    .trim()
    .replace(/^\.+/, "");
  if (!name) return "arquivo";
  if (name.length <= max) return name;
  const dot = name.lastIndexOf(".");
  const ext = dot > 0 && name.length - dot <= 10 ? name.slice(dot) : "";
  return name.slice(0, max - ext.length) + ext;
}

const HOUR = 3_600_000;

/**
 * Link de anexo assinado: vale de 24 a 25 h (a validade anda de hora em hora, então o mesmo link se
 * repete dentro da hora e o cache funciona). Quem não recebeu a mensagem não tem como montar o link.
 */
export function signAttachment(secret: string, id: string, filename: string, now = Date.now()): string {
  const expires = (Math.floor(now / HOUR) + 25) * HOUR;
  const ex = expires.toString(36);
  return `/api/attachments/${id}/${encodeURIComponent(filename)}?ex=${ex}&sig=${attachmentSignature(secret, id, ex)}`;
}

export function attachmentSignature(secret: string, id: string, ex: string): string {
  return createHmac("sha256", secret).update(`attachment:${id}:${ex}`).digest("base64url");
}

/** Assinatura certa e ainda no prazo? (Comparação em tempo constante.) */
export function verifyAttachment(secret: string, id: string, ex: unknown, sig: unknown, now = Date.now()): boolean {
  if (typeof ex !== "string" || typeof sig !== "string" || !/^[0-9a-z]{1,12}$/.test(ex)) return false;
  if (parseInt(ex, 36) < now) return false;
  const expected = Buffer.from(attachmentSignature(secret, id, ex));
  const given = Buffer.from(sig);
  return expected.length === given.length && timingSafeEqual(expected, given);
}

/** Arquivos enviados, em disco. O nome no disco é só o id (nunca o nome que veio do cliente). */
export class FileStore {
  readonly dir: string;

  constructor(dir: string) {
    this.dir = dir;
    mkdirSync(dir, { recursive: true });
  }

  private path(id: string): string {
    if (!/^\d{1,20}$/.test(id)) throw new Error("id de arquivo inválido");
    return join(this.dir, id);
  }

  write(id: string, bytes: Uint8Array): Promise<void> {
    return writeFile(this.path(id), bytes, { flag: "wx" });
  }

  read(id: string): Promise<Buffer> {
    return readFile(this.path(id));
  }

  /** Apagar o que não existe não é erro. */
  remove(id: string): Promise<void> {
    return rm(this.path(id), { force: true });
  }
}
