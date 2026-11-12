#!/usr/bin/env node
// Uso: node contrast.mjs "#texto" "#fundo" [minimo=4.5]
// Calcula a razão de contraste WCAG 2.x e sai com código 1 se ficar abaixo do mínimo.
// Mínimos: 4.5 (texto normal) · 3 (texto grande e componentes de UI/indicadores).
const [fg, bg, minArg] = process.argv.slice(2);
if (!fg || !bg) {
  console.error('Uso: node contrast.mjs "#texto" "#fundo" [minimo=4.5]');
  process.exit(2);
}
const min = minArg ? Number(minArg) : 4.5;

function parse(hex) {
  let h = hex.trim().replace(/^#/, '');
  if (h.length === 3) h = [...h].map((c) => c + c).join('');
  if (!/^[0-9a-fA-F]{6}$/.test(h)) {
    console.error(`Cor inválida: "${hex}" (use #rgb ou #rrggbb)`);
    process.exit(2);
  }
  return [0, 2, 4].map((i) => parseInt(h.slice(i, i + 2), 16) / 255);
}
const lin = (c) => (c <= 0.03928 ? c / 12.92 : ((c + 0.055) / 1.055) ** 2.4);
const luminance = (hex) => {
  const [r, g, b] = parse(hex).map(lin);
  return 0.2126 * r + 0.7152 * g + 0.0722 * b;
};
const [hi, lo] = [luminance(fg), luminance(bg)].sort((a, b) => b - a);
const ratio = (hi + 0.05) / (lo + 0.05);
const ok = ratio >= min;
console.log(`${fg} sobre ${bg}: ${ratio.toFixed(2)}:1 — ${ok ? 'OK' : 'FALHA'} (mínimo ${min}:1)`);
process.exit(ok ? 0 : 1);
