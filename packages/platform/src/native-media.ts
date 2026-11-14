import { Channel, invoke } from "@tauri-apps/api/core";
import { DEFAULT_VOICE_SETTINGS, type AudioDevices, type MicrophoneTest, type VoiceSettings } from "./audio";
import { MediaUnavailableError, type MediaCredentials, type MediaEngine, type MediaEngineEvents, type VoiceConnectionState } from "./index";
import type { ScreenShareResult } from "./screen-share";

/**
 * Voz pelo motor nativo do app (Rust: apps/desktop/src-tauri/src/native_media.rs), usado no Linux, onde
 * o navegador interno (WebKitGTK) não tem WebRTC (ADR-003). O microfone, o alto-falante e o
 * processamento ficam no WebRTC do próprio app; aqui só chegam o estado e quem está falando.
 */
type NativeEvent = { type: "state"; state: VoiceConnectionState } | { type: "speaking"; identities: string[] };

const nativeVoice = (voice: VoiceSettings) => ({
  inputDeviceId: voice.inputDeviceId,
  outputDeviceId: voice.outputDeviceId,
  echoCancellation: voice.echoCancellation,
  noiseSuppression: voice.noiseSuppression,
  autoGainControl: voice.autoGainControl,
});

const errorText = (error: unknown, fallback: string) => (typeof error === "string" && error ? error : error instanceof Error ? error.message : fallback);

export class NativeMediaEngine implements MediaEngine {
  private voice: VoiceSettings = DEFAULT_VOICE_SETTINGS;
  private channel: Channel<NativeEvent> | null = null;

  async join(credentials: MediaCredentials, events: MediaEngineEvents, options: { muted: boolean; deafened: boolean; voice?: VoiceSettings; pushToTalk?: boolean | null }): Promise<void> {
    if (options.voice) this.voice = options.voice;
    const channel = new Channel<NativeEvent>();
    channel.onmessage = (event) => {
      if (event.type === "state") events.onStateChange(event.state);
      else events.onSpeakingChange(new Set(event.identities));
    };
    this.channel = channel;
    events.onScreenSharesChange([]);
    try {
      await invoke("native_media_join", {
        url: credentials.url,
        token: credentials.token,
        iceServers: credentials.iceServers ?? [],
        options: { muted: options.muted, deafened: options.deafened, pushToTalk: options.pushToTalk ?? null, voice: nativeVoice(this.voice) },
        onEvent: channel,
      });
    } catch (error) {
      this.channel = null;
      throw new Error(errorText(error, "Não foi possível conectar à voz."));
    }
  }

  async applyVoiceSettings(settings: VoiceSettings): Promise<void> {
    this.voice = settings;
    if (!this.channel) return;
    try {
      await invoke("native_media_apply_settings", { voice: nativeVoice(settings) });
    } catch (error) {
      throw new Error(errorText(error, "Não foi possível usar o dispositivo de áudio escolhido."));
    }
  }

  async leave(): Promise<void> {
    if (this.channel) this.channel.onmessage = () => undefined;
    this.channel = null;
    await invoke("native_media_leave").catch(() => undefined);
  }

  async setMuted(muted: boolean): Promise<void> {
    await invoke("native_media_set_muted", { muted });
  }

  setDeafened(deafened: boolean): void {
    void invoke("native_media_set_deafened", { deafened }).catch(() => undefined);
  }

  async setPushToTalk(open: boolean | null): Promise<void> {
    await invoke("native_media_set_push_to_talk", { open });
  }

  async startScreenShare(): Promise<ScreenShareResult> {
    throw new MediaUnavailableError("Compartilhar a tela no app para Linux chega numa próxima versão. A voz já funciona.");
  }

  async stopScreenShare(): Promise<void> {}
}

/** Microfones e saídas do sistema, pelo motor nativo (no Linux, a interface não enxerga os dispositivos). */
export async function listNativeAudioDevices(): Promise<AudioDevices> {
  return invoke<AudioDevices>("native_media_devices");
}

/**
 * Teste de microfone pelo app (Linux): mede o microfone `deviceName` (o nome da lista) sem entrar em
 * sala. Ouvir a própria voz não existe aqui (`setMonitor` não faz nada; a tela esconde a opção).
 */
export async function startNativeMicrophoneTest(deviceName: string): Promise<MicrophoneTest> {
  let current = 0;
  const channel = new Channel<number>();
  channel.onmessage = (value) => (current = value);
  try {
    await invoke("mic_test_start", { device: deviceName, onLevel: channel });
  } catch (error) {
    throw new Error(errorText(error, "Não foi possível abrir o microfone. Confira se ele está conectado e tente de novo."));
  }
  return {
    level: () => current,
    setMonitor: () => undefined,
    stop: () => {
      channel.onmessage = () => undefined;
      void invoke("mic_test_stop").catch(() => undefined);
    },
  };
}
