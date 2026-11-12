/**
 * Compartilhamento de tela — regras puras (sem LiveKit), para a UI e os testes.
 * O seletor de janela/tela em si é do sistema (WebView2/navegador): ele não pode ser
 * redesenhado nem dispensado pela página. Aqui decidimos o que pedir a ele.
 */

/** O que a pessoa quer mostrar. Vira dica para o seletor do sistema abrir na aba certa. */
export type ScreenShareSurface = "monitor" | "window";

export type ScreenShareQuality = "light" | "standard" | "smooth";

export interface ScreenShareOptions {
  surface: ScreenShareSurface;
  quality: ScreenShareQuality;
  /** Levar o som do computador junto (jogos, vídeos, música). */
  systemAudio: boolean;
}

export interface ScreenShareProfile {
  width: number;
  height: number;
  frameRate: number;
  /** Teto do codificador, em bits por segundo. */
  maxBitrate: number;
  /** "detail" preserva texto nítido; "motion" prefere fluidez (jogos, vídeos). */
  contentHint: "detail" | "motion";
}

export const SCREEN_SHARE_PROFILES: Readonly<Record<ScreenShareQuality, ScreenShareProfile>> = {
  light: { width: 1280, height: 720, frameRate: 30, maxBitrate: 1_500_000, contentHint: "detail" },
  standard: { width: 1920, height: 1080, frameRate: 30, maxBitrate: 5_000_000, contentHint: "detail" },
  smooth: { width: 1920, height: 1080, frameRate: 60, maxBitrate: 8_000_000, contentHint: "motion" },
};

export const DEFAULT_SCREEN_SHARE_OPTIONS: ScreenShareOptions = { surface: "monitor", quality: "standard", systemAudio: true };

/** Resultado de uma transmissão iniciada. */
export interface ScreenShareResult {
  /** "none": a pessoa não ligou o áudio no seletor; "failed": a tela foi, o áudio não. */
  audio: "shared" | "none" | "failed";
  /**
   * Com áudio: o som que o próprio Aurora toca (as vozes da sala) ficou FORA da captura?
   * `false` = a sala ouve o próprio eco na transmissão.
   */
  ownAudioExcluded: boolean;
}

/**
 * O motor consegue tirar da captura do áudio do sistema o som tocado pelo próprio app
 * (`restrictOwnAudio`, Chromium no Windows/macOS)? Sem isso, as vozes da sala voltam pela transmissão.
 */
export function canExcludeOwnAudio(): boolean {
  try {
    const supported = globalThis.navigator?.mediaDevices?.getSupportedConstraints?.() as Record<string, boolean> | undefined;
    return supported?.restrictOwnAudio === true;
  } catch {
    return false;
  }
}

/**
 * Opções de getDisplayMedia. Membros que o navegador não conhece são ignorados (WebIDL),
 * então dicas mais novas não quebram versões antigas do WebView2.
 */
export function displayMediaOptions(
  { surface, quality }: Pick<ScreenShareOptions, "surface" | "quality">,
  { audio, excludeOwnAudio }: { audio: "picker" | "none"; excludeOwnAudio: boolean } = { audio: "picker", excludeOwnAudio: false },
): DisplayMediaStreamOptions & Record<string, unknown> {
  const profile = SCREEN_SHARE_PROFILES[quality];
  return {
    video: {
      displaySurface: surface,
      width: { ideal: profile.width },
      height: { ideal: profile.height },
      frameRate: { ideal: profile.frameRate, max: profile.frameRate },
    },
    // "picker": o seletor oferece "áudio do sistema" e a pessoa decide lá (navegador).
    //   restrictOwnAudio: as vozes da sala (tocadas pelo Aurora) não entram na captura — sem eco.
    // "none": sem áudio no seletor — o app instalado captura o som nativamente (ou a pessoa não quer som).
    audio: audio === "none" ? false : excludeOwnAudio ? ({ restrictOwnAudio: true } as MediaTrackConstraints) : true,
    systemAudio: audio === "none" ? "exclude" : "include",
    // Nunca transmitir o próprio Aurora nem trocar para uma aba do WebView.
    selfBrowserSurface: "exclude",
    surfaceSwitching: "include",
    // "Uma janela": o seletor nem mostra a aba de telas.
    monitorTypeSurfaces: surface === "window" ? "exclude" : "include",
  };
}

export type ScreenShareFailure = "cancelled" | "audio" | "blocked" | "busy" | "unsupported" | "unknown";

/** Classifica o erro de getDisplayMedia/publicação para a UI explicar o que houve e o que fazer. */
export function classifyScreenShareError(error: unknown): ScreenShareFailure {
  const name = (error as { name?: unknown } | null)?.name;
  const message = String((error as { message?: unknown } | null)?.message ?? "");
  if (name === "NotAllowedError") return /system|permission denied by system/i.test(message) ? "blocked" : "cancelled";
  if (/audio/i.test(message)) return "audio";
  if (name === "NotReadableError" || name === "AbortError") return "busy";
  if (name === "NotSupportedError" || name === "DeviceUnsupportedError") return "unsupported";
  return "unknown";
}
