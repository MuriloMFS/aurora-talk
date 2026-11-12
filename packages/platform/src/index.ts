/**
 * PlatformPort (ADR-002): a UI NUNCA chama APIs do Tauri direto — só esta porta.
 * Implementações: `tauri` (produto) e `browser` (dev/testes no navegador).
 * A interface cresce por necessidade real; todo método existe nas duas variantes.
 */
import { isTauri } from "@tauri-apps/api/core";
import type { ScreenShareOptions, ScreenShareResult } from "./screen-share";

export * from "./screen-share";

export type PlatformKind = "tauri" | "browser";

export interface PlatformInfo {
  kind: PlatformKind;
  /** Versão do app instalado (Tauri) ou "dev" no navegador. */
  appVersion: string;
  /**
   * Som do computador na transmissão de tela:
   * "native" = o app captura sozinho, sem as vozes da sala (sem eco);
   * "picker" = depende da opção de áudio do seletor do sistema.
   */
  systemAudio: "native" | "picker";
}

/** Som do sistema capturado pelo app (sem o próprio app), já como trilha WebRTC. */
export interface SystemAudioCapture {
  track: MediaStreamTrack;
  /** Para a captura nativa e encerra a trilha. Pode ser chamado mais de uma vez. */
  stop(): Promise<void>;
}

export interface UpdateInfo {
  version: string;
  currentVersion: string;
  notes: string | null;
}

export interface UpdateProgress {
  downloaded: number;
  total: number | null;
}

export interface PlatformPort {
  readonly kind: PlatformKind;
  getInfo(): Promise<PlatformInfo>;
  /** Pergunta ao servidor Aurora se há versão nova. `null` = já está atualizado (ou não suportado). */
  checkForUpdate(serverUrl: string): Promise<UpdateInfo | null>;
  /** Baixa, confere a assinatura e instala a atualização encontrada; o app fecha e volta atualizado. */
  installUpdate(onProgress?: (progress: UpdateProgress) => void): Promise<void>;
  /**
   * Captura o som do computador EXCETO o do próprio app (as vozes da sala ficam de fora).
   * Só quando `getInfo().systemAudio === "native"`; senão rejeita com mensagem para a pessoa.
   */
  captureSystemAudio(): Promise<SystemAudioCapture>;
  /** Abre um link no navegador padrão, nunca dentro do app. Só `http(s)`; o resto é ignorado. */
  openExternal(url: string): Promise<void>;
  /** Notificação do sistema (Windows). Sem permissão, não faz nada. */
  notify(notification: { title: string; body: string }): Promise<void>;
  /** Selo com o número de menções no ícone da barra de tarefas (0 tira o selo). */
  setBadge(count: number): Promise<void>;
  /** Pisca o ícone na barra de tarefas se o app estiver em segundo plano. */
  requestAttention(): Promise<void>;
}

/** Só links da web saem do app (evita `file:`, `javascript:` etc.). */
export const isWebUrl = (url: string): boolean => {
  try {
    const parsed = new URL(url);
    return parsed.protocol === "https:" || parsed.protocol === "http:";
  } catch {
    return false;
  }
};

/** Texto do selo: até 9, depois "9+". */
export const badgeText = (count: number): string | null => (count <= 0 ? null : count > 9 ? "9+" : String(count));

/* ---------------- MediaEngine (ADR-002): voz ---------------- */

export type VoiceConnectionState = "connecting" | "connected" | "reconnecting" | "disconnected";

/** Uma tela sendo compartilhada na sala (a minha ou de outra pessoa). */
export interface ScreenShare {
  /** ID do usuário que compartilha. */
  identity: string;
  local: boolean;
  /** Liga o vídeo a um elemento <video>; devolve a função que desliga. */
  attach(element: HTMLVideoElement): () => void;
}

export interface MediaEngineEvents {
  onStateChange(state: VoiceConnectionState): void;
  /** Identidades (IDs de usuário) falando agora na sala. */
  onSpeakingChange(speaking: ReadonlySet<string>): void;
  /** Telas compartilhadas na sala mudaram (alguém começou/parou, inclusive eu). */
  onScreenSharesChange(shares: ScreenShare[]): void;
}

/** Voz/vídeo. A UI nunca chama o LiveKit (ou um motor nativo futuro) direto — só esta interface. */
export interface MediaEngine {
  join(credentials: { url: string; token: string }, events: MediaEngineEvents, options: { muted: boolean; deafened: boolean }): Promise<void>;
  leave(): Promise<void>;
  setMuted(muted: boolean): Promise<void>;
  setDeafened(deafened: boolean): void;
  /**
   * Abre o seletor do sistema (já na aba de `surface`) e transmite na qualidade pedida.
   * Cancelar o seletor rejeita com NotAllowedError. Se só o áudio falhar, a tela segue sem som (`audio: "failed"`).
   */
  startScreenShare(options: ScreenShareOptions): Promise<ScreenShareResult>;
  stopScreenShare(): Promise<void>;
}

/** Hoje: WebRTC do próprio WebView via LiveKit. Carregado sob demanda (só quem entra em voz baixa o código). */
export async function createMediaEngine(): Promise<MediaEngine> {
  const [{ LiveKitMediaEngine }, platform] = await Promise.all([import("./livekit-media"), createPlatform()]);
  return new LiveKitMediaEngine(platform, await platform.getInfo());
}

export function detectPlatformKind(): PlatformKind {
  return isTauri() ? "tauri" : "browser";
}

export async function createPlatform(kind: PlatformKind = detectPlatformKind()): Promise<PlatformPort> {
  if (kind === "tauri") {
    const { createTauriPlatform } = await import("./tauri");
    return createTauriPlatform();
  }
  const { createBrowserPlatform } = await import("./browser");
  return createBrowserPlatform();
}
