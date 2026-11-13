import { LIMITS, type Id } from "@aurora/schema";

/** Endereço do servidor de onde vêm as fotos (o mesmo da sessão). */
let mediaBase = "";
export const setMediaBase = (serverUrl: string) => {
  mediaBase = serverUrl.replace(/\/+$/, "");
};
export const fileUrl = (fileId: Id): string => `${mediaBase}/api/files/${encodeURIComponent(fileId)}`;
/** Caminho do servidor (ex.: link assinado de anexo) para endereço completo. */
export const mediaUrl = (path: string): string => (/^https?:/.test(path) ? path : `${mediaBase}${path}`);

/** Quadrado central da imagem (a foto de perfil é redonda/quadrada; corta o que sobra nas bordas). */
export function centerSquare(width: number, height: number): { sx: number; sy: number; size: number } {
  const size = Math.min(width, height);
  return { sx: Math.floor((width - size) / 2), sy: Math.floor((height - size) / 2), size };
}

/** Maior arquivo que o app aceita abrir para virar foto (ele é reduzido antes de enviar). */
export const AVATAR_SOURCE_MAX_BYTES = 20 * 1024 * 1024;

/**
 * Recorta o quadrado central e reduz para 256 px, em WebP (PNG se o navegador não fizer WebP).
 * O servidor recebe só a imagem pequena e confere o tipo pelos bytes.
 */
export async function prepareAvatar(file: Blob): Promise<Blob> {
  if (file.size > AVATAR_SOURCE_MAX_BYTES) throw new Error("A imagem passa de 20 MB. Escolha uma menor.");
  let bitmap: ImageBitmap;
  try {
    bitmap = await createImageBitmap(file);
  } catch {
    throw new Error("Não deu para abrir essa imagem. Use PNG, JPEG, WebP ou GIF.");
  }
  const { sx, sy, size } = centerSquare(bitmap.width, bitmap.height);
  const out = Math.min(LIMITS.avatarSize, size);
  const canvas = document.createElement("canvas");
  canvas.width = out;
  canvas.height = out;
  const ctx = canvas.getContext("2d");
  if (!ctx) throw new Error("Não deu para preparar a imagem. Tente de novo.");
  ctx.imageSmoothingQuality = "high";
  ctx.drawImage(bitmap, sx, sy, size, size, 0, 0, out, out);
  bitmap.close();
  const toBlob = (type: string) => new Promise<Blob | null>((resolve) => canvas.toBlob(resolve, type, 0.9));
  const blob = (await toBlob("image/webp")) ?? (await toBlob("image/png"));
  if (!blob) throw new Error("Não deu para preparar a imagem. Tente de novo.");
  return blob;
}
