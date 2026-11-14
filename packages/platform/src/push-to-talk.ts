/**
 * Apertar para falar: qual tecla (ou botão do mouse) abre o microfone e o atraso ao soltar.
 * A tecla é guardada pelo `KeyboardEvent.code` (posição física, igual em qualquer layout) ou por
 * "Mouse3/4/5". O app nativo traduz para o código virtual do Windows e consulta SÓ essa tecla.
 */

/** Atraso ao soltar: faixa e padrão (ms), para não cortar o fim da frase. */
export const PTT_RELEASE_MIN = 0;
export const PTT_RELEASE_MAX = 1000;
export const PTT_RELEASE_DEFAULT = 200;

const NAMED_VK: Record<string, number> = {
  Mouse3: 0x04, // botão do meio
  Mouse4: 0x05, // lateral "voltar" (XBUTTON1)
  Mouse5: 0x06, // lateral "avançar" (XBUTTON2)
  Backspace: 0x08,
  Tab: 0x09,
  Enter: 0x0d,
  Pause: 0x13,
  CapsLock: 0x14,
  Space: 0x20,
  PageUp: 0x21,
  PageDown: 0x22,
  End: 0x23,
  Home: 0x24,
  ArrowLeft: 0x25,
  ArrowUp: 0x26,
  ArrowRight: 0x27,
  ArrowDown: 0x28,
  Insert: 0x2d,
  Delete: 0x2e,
  NumpadMultiply: 0x6a,
  NumpadAdd: 0x6b,
  NumpadSubtract: 0x6d,
  NumpadDecimal: 0x6e,
  NumpadDivide: 0x6f,
  NumLock: 0x90,
  ScrollLock: 0x91,
  ShiftLeft: 0xa0,
  ShiftRight: 0xa1,
  ControlLeft: 0xa2,
  ControlRight: 0xa3,
  AltLeft: 0xa4,
  AltRight: 0xa5,
  Semicolon: 0xba,
  Equal: 0xbb,
  Comma: 0xbc,
  Minus: 0xbd,
  Period: 0xbe,
  Slash: 0xbf,
  Backquote: 0xc0,
  IntlRo: 0xc1, // tecla "/ ?" do teclado ABNT2
  NumpadComma: 0xc2, // tecla "." extra do teclado numérico ABNT2
  BracketLeft: 0xdb,
  Backslash: 0xdc,
  BracketRight: 0xdd,
  Quote: 0xde,
  IntlBackslash: 0xe2, // tecla "\ |" ao lado do Shift esquerdo (ABNT2)
};

/** Código virtual do Windows para a tecla escolhida; `null` = não serve para apertar para falar. */
export function pttVirtualKey(code: string): number | null {
  let match: RegExpExecArray | null;
  if ((match = /^Key([A-Z])$/.exec(code))) return match[1]!.charCodeAt(0);
  if ((match = /^Digit([0-9])$/.exec(code))) return 0x30 + Number(match[1]);
  if ((match = /^Numpad([0-9])$/.exec(code))) return 0x60 + Number(match[1]);
  if ((match = /^F([1-9]|1[0-9]|2[0-4])$/.exec(code))) return 0x6f + Number(match[1]);
  return NAMED_VK[code] ?? null;
}

const NAMED_LABEL: Record<string, string> = {
  Mouse3: "Botão do meio do mouse",
  Mouse4: "Botão lateral do mouse (voltar)",
  Mouse5: "Botão lateral do mouse (avançar)",
  Backspace: "Backspace",
  Tab: "Tab",
  Enter: "Enter",
  Pause: "Pause",
  CapsLock: "Caps Lock",
  Space: "Espaço",
  PageUp: "Page Up",
  PageDown: "Page Down",
  End: "End",
  Home: "Home",
  ArrowLeft: "Seta para a esquerda",
  ArrowUp: "Seta para cima",
  ArrowRight: "Seta para a direita",
  ArrowDown: "Seta para baixo",
  Insert: "Insert",
  Delete: "Delete",
  NumpadMultiply: "Num *",
  NumpadAdd: "Num +",
  NumpadSubtract: "Num -",
  NumpadDecimal: "Num ,",
  NumpadDivide: "Num /",
  NumpadComma: "Num .",
  NumLock: "Num Lock",
  ScrollLock: "Scroll Lock",
  ShiftLeft: "Shift esquerdo",
  ShiftRight: "Shift direito",
  ControlLeft: "Ctrl esquerdo",
  ControlRight: "Ctrl direito",
  AltLeft: "Alt",
  AltRight: "Alt Gr",
};

/**
 * Nome da tecla para mostrar na tela. `key` é o caractere que o layout da pessoa produz (quando
 * conhecido), para teclas de símbolo saírem como ela vê no teclado.
 */
export function pttKeyLabel(code: string, key?: string): string {
  let match: RegExpExecArray | null;
  if ((match = /^Key([A-Z])$/.exec(code))) return match[1]!;
  if ((match = /^Digit([0-9])$/.exec(code))) return match[1]!;
  if ((match = /^Numpad([0-9])$/.exec(code))) return `Num ${match[1]}`;
  if (/^F([1-9]|1[0-9]|2[0-4])$/.test(code)) return code;
  if (NAMED_LABEL[code]) return NAMED_LABEL[code]!;
  if (key && key.length === 1 && key.trim()) return key.toUpperCase();
  return code;
}

/**
 * Tecla do teclado ou botão do mouse capturado na tela de configurações → código guardado.
 * Esc fica de fora (cancela a escolha); clique esquerdo e direito também (abririam o microfone a
 * cada clique). `null` = não serve.
 */
export function pttCodeFromEvent(event: { type: string; code?: string; button?: number }): string | null {
  if (event.type === "keydown" || event.type === "keyup") {
    const code = event.code ?? "";
    if (code === "Escape" || !code) return null;
    return pttVirtualKey(code) === null ? null : code;
  }
  if (event.type === "mousedown" || event.type === "mouseup" || event.type === "pointerdown" || event.type === "pointerup") {
    return event.button === 1 ? "Mouse3" : event.button === 3 ? "Mouse4" : event.button === 4 ? "Mouse5" : null;
  }
  return null;
}

/** Timers injetáveis (testes com relógio falso). */
export interface PttTimers {
  set(fn: () => void, ms: number): unknown;
  clear(handle: unknown): void;
}
const realTimers: PttTimers = {
  set: (fn, ms) => setTimeout(fn, ms),
  clear: (handle) => clearTimeout(handle as ReturnType<typeof setTimeout>),
};

/**
 * Portão do microfone: abre na hora em que a tecla desce; fecha `releaseMs` depois de subir.
 * Apertar de novo dentro do atraso cancela o fechamento. Só avisa quando o estado muda de fato.
 */
export class PushToTalkGate {
  private pressed = false;
  private open = false;
  private closing: unknown = null;
  private releaseMs: number;
  private readonly onChange: (open: boolean) => void;
  private readonly timers: PttTimers;

  constructor(releaseMs: number, onChange: (open: boolean) => void, timers: PttTimers = realTimers) {
    this.releaseMs = clampRelease(releaseMs);
    this.onChange = onChange;
    this.timers = timers;
  }

  get isOpen(): boolean {
    return this.open;
  }

  setReleaseDelay(ms: number): void {
    this.releaseMs = clampRelease(ms);
  }

  /** Estado da tecla vindo do sistema (repetições do mesmo estado são ignoradas). */
  set(pressed: boolean): void {
    if (pressed === this.pressed) return;
    this.pressed = pressed;
    if (pressed) {
      this.cancelClose();
      this.emit(true);
    } else if (this.releaseMs === 0) {
      this.emit(false);
    } else {
      this.cancelClose();
      this.closing = this.timers.set(() => {
        this.closing = null;
        if (!this.pressed) this.emit(false);
      }, this.releaseMs);
    }
  }

  /** Para tudo (saiu da sala, trocou de modo): fecha na hora, sem atraso. */
  dispose(): void {
    this.cancelClose();
    this.pressed = false;
    this.emit(false);
  }

  private cancelClose(): void {
    if (this.closing !== null) this.timers.clear(this.closing);
    this.closing = null;
  }

  private emit(open: boolean): void {
    if (open === this.open) return;
    this.open = open;
    this.onChange(open);
  }
}

const clampRelease = (ms: number) =>
  Number.isFinite(ms) ? Math.min(PTT_RELEASE_MAX, Math.max(PTT_RELEASE_MIN, Math.round(ms))) : PTT_RELEASE_DEFAULT;
