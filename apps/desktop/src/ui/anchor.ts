import type { MouseEvent } from "react";

/** Onde abrir um menu: no ponto do clique, ou junto do elemento quando veio do teclado (Enter/Espaço). */
export function anchorOf(event: MouseEvent<HTMLElement>): { x: number; y: number } {
  if (event.detail > 0 && (event.clientX || event.clientY)) return { x: event.clientX, y: event.clientY };
  const r = event.currentTarget.getBoundingClientRect();
  return { x: r.left, y: r.bottom };
}
