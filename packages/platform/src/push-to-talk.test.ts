import { describe, expect, it } from "vitest";
import { PushToTalkGate, pttCodeFromEvent, pttKeyLabel, pttVirtualKey, type PttTimers } from "./push-to-talk";

/** Relógio falso simples: avança na mão. */
function fakeTimers() {
  let now = 0;
  let seq = 0;
  const pending = new Map<number, { at: number; fn: () => void }>();
  const timers: PttTimers = {
    set(fn, ms) {
      const id = ++seq;
      pending.set(id, { at: now + ms, fn });
      return id;
    },
    clear(handle) {
      pending.delete(handle as number);
    },
  };
  const advance = (ms: number) => {
    now += ms;
    for (const [id, timer] of [...pending].sort((a, b) => a[1].at - b[1].at)) {
      if (timer.at <= now) {
        pending.delete(id);
        timer.fn();
      }
    }
  };
  return { timers, advance };
}

describe("apertar para falar", () => {
  it("traduz teclas para o código virtual do Windows", () => {
    expect(pttVirtualKey("KeyV")).toBe(0x56);
    expect(pttVirtualKey("Digit0")).toBe(0x30);
    expect(pttVirtualKey("Numpad7")).toBe(0x67);
    expect(pttVirtualKey("F1")).toBe(0x70);
    expect(pttVirtualKey("F24")).toBe(0x87);
    expect(pttVirtualKey("Backquote")).toBe(0xc0);
    expect(pttVirtualKey("ControlLeft")).toBe(0xa2);
    expect(pttVirtualKey("Mouse4")).toBe(0x05);
    expect(pttVirtualKey("Mouse5")).toBe(0x06);
    expect(pttVirtualKey("F25")).toBeNull();
    expect(pttVirtualKey("Escape")).toBeNull();
    expect(pttVirtualKey("Mouse1")).toBeNull();
    expect(pttVirtualKey("")).toBeNull();
  });

  it("nomes em pt-BR para a tela", () => {
    expect(pttKeyLabel("KeyV")).toBe("V");
    expect(pttKeyLabel("Space")).toBe("Espaço");
    expect(pttKeyLabel("Mouse4")).toBe("Botão lateral do mouse (voltar)");
    expect(pttKeyLabel("Numpad1")).toBe("Num 1");
    expect(pttKeyLabel("Backquote", "'")).toBe("'");
    expect(pttKeyLabel("Backquote")).toBe("Backquote");
  });

  it("captura: Esc, clique esquerdo e direito não servem; botões do meio e laterais servem", () => {
    expect(pttCodeFromEvent({ type: "keydown", code: "KeyB" })).toBe("KeyB");
    expect(pttCodeFromEvent({ type: "keydown", code: "Escape" })).toBeNull();
    expect(pttCodeFromEvent({ type: "keydown", code: "MediaPlayPause" })).toBeNull();
    expect(pttCodeFromEvent({ type: "mousedown", button: 0 })).toBeNull();
    expect(pttCodeFromEvent({ type: "mousedown", button: 2 })).toBeNull();
    expect(pttCodeFromEvent({ type: "mousedown", button: 1 })).toBe("Mouse3");
    expect(pttCodeFromEvent({ type: "mousedown", button: 3 })).toBe("Mouse4");
    expect(pttCodeFromEvent({ type: "pointerdown", button: 4 })).toBe("Mouse5");
  });

  it("abre na hora, fecha depois do atraso; apertar de novo no atraso cancela o fechamento", () => {
    const { timers, advance } = fakeTimers();
    const changes: boolean[] = [];
    const gate = new PushToTalkGate(200, (open) => changes.push(open), timers);
    gate.set(true);
    expect(changes).toEqual([true]);
    gate.set(true); // repetição do sistema: nada
    gate.set(false);
    advance(150);
    expect(gate.isOpen).toBe(true);
    gate.set(true); // voltou a apertar antes de fechar
    advance(500);
    expect(changes).toEqual([true]);
    gate.set(false);
    advance(199);
    expect(gate.isOpen).toBe(true);
    advance(1);
    expect(changes).toEqual([true, false]);
  });

  it("sem atraso fecha na hora; atraso fora da faixa é preso aos limites", () => {
    const { timers, advance } = fakeTimers();
    const changes: boolean[] = [];
    const gate = new PushToTalkGate(0, (open) => changes.push(open), timers);
    gate.set(true);
    gate.set(false);
    expect(changes).toEqual([true, false]);
    gate.setReleaseDelay(99_999);
    gate.set(true);
    gate.set(false);
    advance(999);
    expect(gate.isOpen).toBe(true);
    advance(1);
    expect(gate.isOpen).toBe(false);
  });

  it("encerrar fecha na hora, mesmo com a tecla apertada ou no atraso", () => {
    const { timers, advance } = fakeTimers();
    const changes: boolean[] = [];
    const gate = new PushToTalkGate(300, (open) => changes.push(open), timers);
    gate.set(true);
    gate.dispose();
    expect(changes).toEqual([true, false]);
    advance(1000);
    expect(changes).toEqual([true, false]);
  });
});
