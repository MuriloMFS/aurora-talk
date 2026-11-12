/**
 * IDs ordenados no tempo, únicos por processo, que cabem em `Number` (53 bits):
 *   (ms desde 2026-01-01) × 1024 + sequência (0..1023)
 * Válido por ~270 anos. Exposto como string na API (migração futura para 64 bits).
 */
export const ID_EPOCH = Date.UTC(2026, 0, 1);
/** IDs por milissegundo; `(instante - ID_EPOCH) × ID_SEQUENCE_SIZE` é o menor ID daquele instante. */
export const ID_SEQUENCE_SIZE = 1024;
const SEQUENCE_SIZE = ID_SEQUENCE_SIZE;

let lastMs = -1;
let sequence = 0;

export function nextId(now: number = Date.now()): string {
  let ms = Math.max(now - ID_EPOCH, lastMs, 0);
  if (ms === lastMs) {
    sequence += 1;
    if (sequence >= SEQUENCE_SIZE) {
      ms = lastMs + 1; // esgotou a sequência deste ms: avança o relógio lógico
      sequence = 0;
    }
  } else {
    sequence = 0;
  }
  lastMs = ms;
  return String(ms * SEQUENCE_SIZE + sequence);
}

export function idTimestamp(id: string): number {
  return Math.floor(Number(id) / SEQUENCE_SIZE) + ID_EPOCH;
}

/** Aceita apenas IDs no formato emitido por `nextId` (evita consultas com lixo). */
export function isValidId(value: string): boolean {
  return /^\d{1,16}$/.test(value) && Number.isSafeInteger(Number(value));
}
