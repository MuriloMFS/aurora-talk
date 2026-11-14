/**
 * PlatformPort (ADR-002): a UI NUNCA chama APIs do Tauri direto — só esta porta.
 * Implementações: `tauri` (produto) e `browser` (dev/testes no navegador).
 * A interface cresce por necessidade real; todo método existe nas duas variantes.
 */
import { isTauri } from "@tauri-apps/api/core";
import type { VoiceSettings } from "./audio";
import type { ScreenShareOptions, ScreenShareResult } from "./screen-share";

export * from "./audio";
import { listAudioDevices, startMicrophoneTest, type AudioDevices, type MicrophoneTest } from "./audio";
export * from "./screen-share";
export * from "./push-to-talk";

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
  /**
   * Apertar para falar: "global" = funciona com o app em segundo plano (inclusive com um jogo na frente);
   * "focused" = só com a janela do app em foco (navegador).
   */
  pushToTalk: "global" | "focused";
  /**
   * Motor de voz: "web" = WebRTC do navegador interno (Windows, navegador); "native" = WebRTC do
   * próprio app em Rust (Linux, onde o WebKitGTK não tem WebRTC, ADR-003).
   */
  media: "web" | "native";
}

/** Som do sistema capturado pelo app (sem o próprio app), já como trilha WebRTC. */
export interface SystemAudioCapture {
  track: MediaStreamTrack;
  /** Para a captura nativa e encerra a trilha. Pode ser chamado mais de uma vez. */
  stop(): Promise<void>;
}

/** Opções que dependem do sistema (só no app instalado). */
export interface DesktopSettings {
  /** Abrir o Aurora quando o Windows iniciar. */
  openOnStartup: boolean;
  /** Ao abrir com o Windows, ficar só na bandeja. */
  startMinimized: boolean;
  /** Fechar a janela só esconde: o app continua na bandeja (e na voz). */
  closeToTray: boolean;
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
  /** Opções do Windows (bandeja, iniciar com o sistema). `null` = não existem aqui (navegador). */
  getDesktopSettings(): Promise<DesktopSettings | null>;
  /** Salva e aplica; devolve o que ficou valendo. */
  setDesktopSettings(settings: DesktopSettings): Promise<DesktopSettings>;
  /**
   * Segundos desde o último uso do teclado ou do mouse: no app, no computador inteiro (o Windows sabe);
   * no navegador, só dentro da página. Serve para o status "Ausente" automático.
   */
  getIdleSeconds(): Promise<number>;
  /**
   * Observa a tecla (ou botão do mouse) de apertar para falar — código de `pttCodeFromEvent` — e avisa
   * quando desce (true) e sobe (false). Devolve a função que para de observar.
   */
  watchPushToTalk(code: string, onChange: (pressed: boolean) => void): Promise<() => void>;
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

/** Onde e como entrar na sala de mídia. `iceServers` = retransmissor TURN (quem está fora da rede do servidor). */
export interface MediaCredentials {
  url: string;
  token: string;
  iceServers?: { urls: string[]; username?: string; credential?: string }[];
}

/** Voz/vídeo. A UI nunca chama o LiveKit (ou um motor nativo futuro) direto — só esta interface. */
export interface MediaEngine {
  /** `pushToTalk`: false = entra no modo apertar para falar com a tecla solta (microfone pronto, fechado). */
  join(credentials: MediaCredentials, events: MediaEngineEvents, options: { muted: boolean; deafened: boolean; voice?: VoiceSettings; pushToTalk?: boolean | null }): Promise<void>;
  /** Troca microfone, alto-falante, volumes ou processamento, inclusive no meio da chamada. */
  applyVoiceSettings(settings: VoiceSettings): Promise<void>;
  leave(): Promise<void>;
  setMuted(muted: boolean): Promise<void>;
  setDeafened(deafened: boolean): void;
  /**
   * Apertar para falar: true = tecla apertada (microfone aberto), false = solta (fechado, mas pronto
   * para abrir na hora), null = modo desligado (detecção de voz). Mudo continua vencendo a tecla.
   */
  setPushToTalk(open: boolean | null): Promise<void>;
  /**
   * Abre o seletor do sistema (já na aba de `surface`) e transmite na qualidade pedida.
   * Cancelar o seletor rejeita com NotAllowedError. Se só o áudio falhar, a tela segue sem som (`audio: "failed"`).
   */
  startScreenShare(options: ScreenShareOptions): Promise<ScreenShareResult>;
  stopScreenShare(): Promise<void>;
}

/** Hoje: WebRTC do próprio WebView via LiveKit. Carregado sob demanda (só quem entra em voz baixa o código). */
export async function createMediaEngine(): Promise<MediaEngine> {
  // Escolha por plataforma e capacidade (ADR-002/003): no Linux, o motor nativo do app; sem WebRTC e sem
  // motor nativo, a voz avisa em vez de falhar calada; nos demais, o WebRTC do navegador interno.
  const platform = await createPlatform();
  const info = await platform.getInfo();
  if (info.media === "native") {
    const { NativeMediaEngine } = await import("./native-media");
    return new NativeMediaEngine();
  }
  if (typeof (globalThis as { RTCPeerConnection?: unknown }).RTCPeerConnection === "undefined") return new UnavailableMediaEngine();
  const { LiveKitMediaEngine } = await import("./livekit-media");
  return new LiveKitMediaEngine(platform, info);
}

/** Teste de microfone: pelo app quando é ele que cuida do áudio (`deviceName` = nome da lista); senão, pelo navegador. */
export async function startVoiceMicrophoneTest(info: Pick<PlatformInfo, "media"> | null, settings: VoiceSettings, deviceName: string): Promise<MicrophoneTest> {
  if (info?.media === "native") {
    const { startNativeMicrophoneTest } = await import("./native-media");
    return startNativeMicrophoneTest(deviceName);
  }
  return startMicrophoneTest(settings);
}

/** Microfones e saídas: pelo motor nativo quando é ele que cuida do áudio; senão, pelo navegador. */
export async function listVoiceDevices(info: Pick<PlatformInfo, "media"> | null): Promise<AudioDevices> {
  if (info?.media === "native") {
    const { listNativeAudioDevices } = await import("./native-media");
    return listNativeAudioDevices();
  }
  return listAudioDevices();
}

/** A voz não existe neste aparelho ainda; `message` diz o que houve e o que fazer. */
export class MediaUnavailableError extends Error {
  override name = "MediaUnavailableError";
}

const unavailableText = (): string =>
  /Linux/i.test(globalThis.navigator?.userAgent ?? "")
    ? "A voz ainda não funciona no app para Linux: ela chega com o motor de voz nativo, numa próxima versão. O chat e o resto funcionam normalmente."
    : "A voz não funciona neste aparelho: o navegador interno não tem WebRTC. Atualize o sistema e tente de novo.";

/** Motor para quando não há WebRTC: toda tentativa de entrar na voz explica por quê. */
export class UnavailableMediaEngine implements MediaEngine {
  async join(): Promise<void> {
    throw new MediaUnavailableError(unavailableText());
  }
  async applyVoiceSettings(): Promise<void> {}
  async leave(): Promise<void> {}
  async setMuted(): Promise<void> {}
  setDeafened(): void {}
  async setPushToTalk(): Promise<void> {}
  async startScreenShare(): Promise<never> {
    throw new MediaUnavailableError(unavailableText());
  }
  async stopScreenShare(): Promise<void> {}
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
