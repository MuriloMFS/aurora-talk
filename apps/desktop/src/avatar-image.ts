import { LIMITS, type Id } from "@aurora/schema";

/** Endereço do servidor de onde vêm as fotos (o mesmo da sessão). */
let mediaBase = "";
export const setMediaBase = (serverUrl: string) => {
  mediaBase = serverUrl.replace(/\/+$/, "");
};
export const fileUrl = (fileId: Id): string => `${mediaBase}/api/files/${encodeURIComponent(fileId)}`;
/** Caminho do servidor (ex.: link assinado de anexo) para endereço completo. */
export const mediaUrl = (path: string): string => (/^https?:/.test(path) ? path : `${mediaBase}${path}`);

/** Maior pedaço central com a proporção pedida (largura ÷ altura). */
export function centerCrop(width: number, height: number, aspect: number): { sx: number; sy: number; sw: number; sh: number } {
  const sw = Math.min(width, Math.round(height * aspect));
  const sh = Math.min(height, Math.round(sw / aspect));
  return { sx: Math.floor((width - sw) / 2), sy: Math.floor((height - sh) / 2), sw, sh };
}

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
export function prepareAvatar(file: Blob): Promise<Blob> {
  return prepareImage(file, LIMITS.avatarSize, LIMITS.avatarSize);
}

/** Capa do servidor: recorte central em 16:9, reduzida para 960×540. */
export function prepareBanner(file: Blob): Promise<Blob> {
  return prepareImage(file, LIMITS.bannerWidth, LIMITS.bannerHeight);
}

async function prepareImage(file: Blob, width: number, height: number): Promise<Blob> {
  if (file.size > AVATAR_SOURCE_MAX_BYTES) throw new Error("A imagem passa de 20 MB. Escolha uma menor.");
  let bitmap: ImageBitmap;
  try {
    bitmap = await createImageBitmap(file);
  } catch {
    throw new Error("Não deu para abrir essa imagem. Use PNG, JPEG, WebP ou GIF.");
  }
  const { sx, sy, sw, sh } = centerCrop(bitmap.width, bitmap.height, width / height);
  const scale = Math.min(1, width / sw);
  const canvas = document.createElement("canvas");
  canvas.width = Math.max(1, Math.round(sw * scale));
  canvas.height = Math.max(1, Math.round(sh * scale));
  const ctx = canvas.getContext("2d");
  if (!ctx) throw new Error("Não deu para preparar a imagem. Tente de novo.");
  ctx.imageSmoothingQuality = "high";
  ctx.drawImage(bitmap, sx, sy, sw, sh, 0, 0, canvas.width, canvas.height);
  bitmap.close();
  const toBlob = (type: string) => new Promise<Blob | null>((resolve) => canvas.toBlob(resolve, type, 0.9));
  const blob = (await toBlob("image/webp")) ?? (await toBlob("image/png"));
  if (!blob) throw new Error("Não deu para preparar a imagem. Tente de novo.");
  return blob;
}
