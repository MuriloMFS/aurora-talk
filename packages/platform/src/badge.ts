import { badgeText } from "./index";

/** Lado do selo em pixels (o Windows reduz para 16 px lógicos; 32 fica nítido em telas HiDPI). */
export const BADGE_SIZE = 32;

/** Cor de um token do tema (o selo usa as mesmas cores do selo de menção da interface). */
function token(name: string, fallback: string): string {
  const value = getComputedStyle(document.documentElement).getPropertyValue(name).trim();
  return value || fallback;
}

/** Desenha o selo (círculo + número) e devolve os pixels RGBA, ou `null` para tirar o selo. */
export function drawBadge(count: number): Uint8ClampedArray | null {
  const text = badgeText(count);
  if (!text) return null;
  const canvas = document.createElement("canvas");
  canvas.width = canvas.height = BADGE_SIZE;
  const ctx = canvas.getContext("2d");
  if (!ctx) return null;
  const half = BADGE_SIZE / 2;
  ctx.fillStyle = token("--mention-bg", "red");
  ctx.beginPath();
  ctx.arc(half, half, half, 0, Math.PI * 2);
  ctx.fill();
  ctx.fillStyle = token("--mention-fg", "white");
  ctx.font = `bold ${text.length > 1 ? 17 : 22}px ${token("--font-ui", "sans-serif")}`;
  ctx.textAlign = "center";
  ctx.textBaseline = "middle";
  ctx.fillText(text, half, half + 1);
  return ctx.getImageData(0, 0, BADGE_SIZE, BADGE_SIZE).data;
}
