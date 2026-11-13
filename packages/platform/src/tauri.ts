import { getVersion } from "@tauri-apps/api/app";
import { Channel, invoke } from "@tauri-apps/api/core";
import { listen } from "@tauri-apps/api/event";
import { isWebUrl, type DesktopSettings, type PlatformPort, type SystemAudioCapture, type UpdateInfo, type UpdateProgress } from "./index";
import { BADGE_SIZE, drawBadge } from "./badge";
import { pcmChunkToAudioDataInit } from "./system-audio";

/** API do Chromium (não está na lib DOM do TypeScript): trilha de áudio alimentada pela página. */
type AudioTrackGenerator = MediaStreamTrack & { writable: WritableStream<AudioData> };
type AudioTrackGeneratorCtor = new (init: { kind: "audio" }) => AudioTrackGenerator;

export function createTauriPlatform(): PlatformPort {
  return {
    kind: "tauri",
    async getInfo() {
      // A captura nativa (loopback por processo) é do Windows; nos demais, o seletor do sistema.
      const windows = /Windows/i.test(globalThis.navigator?.userAgent ?? "");
      return { kind: "tauri", appVersion: await getVersion(), systemAudio: windows ? "native" : "picker" };
    },
    // Comandos Rust em apps/desktop/src-tauri/src/lib.rs
    checkForUpdate(serverUrl) {
      return invoke<UpdateInfo | null>("check_update", { serverUrl });
    },
    async installUpdate(onProgress) {
      const unlisten = onProgress ? await listen<UpdateProgress>("update-progress", (event) => onProgress(event.payload)) : null;
      try {
        await invoke("install_update");
      } finally {
        unlisten?.();
      }
    },
    // Rust em apps/desktop/src-tauri/src/system_audio.rs: PCM float 48 kHz estéreo em blocos de ~20 ms.
    async captureSystemAudio(): Promise<SystemAudioCapture> {
      const Generator = (globalThis as { MediaStreamTrackGenerator?: AudioTrackGeneratorCtor }).MediaStreamTrackGenerator;
      if (typeof Generator !== "function" || typeof AudioData !== "function") {
        throw new Error("Esta versão do WebView2 não consegue montar a trilha de som. Atualize o Windows e tente de novo.");
      }
      const generator = new Generator({ kind: "audio" });
      const writer = generator.writable.getWriter();
      let framesSent = 0;
      const channel = new Channel<ArrayBuffer>();
      channel.onmessage = (buffer) => {
        const init = pcmChunkToAudioDataInit(buffer, framesSent);
        if (!init) return;
        framesSent += init.numberOfFrames;
        const data = new AudioData(init);
        writer.write(data).catch(() => data.close()); // trilha já encerrada
      };
      try {
        await invoke("system_audio_start", { onData: channel });
      } catch (error) {
        generator.stop();
        throw new Error(typeof error === "string" ? error : "Não foi possível capturar o som do computador.");
      }
      let stopped = false;
      return {
        track: generator,
        async stop() {
          if (stopped) return;
          stopped = true;
          channel.onmessage = () => undefined;
          await invoke("system_audio_stop").catch(() => undefined);
          writer.close().catch(() => undefined);
          generator.stop();
        },
      };
    },
    // Plugins oficiais (permissões em src-tauri/capabilities/default.json).
    async openExternal(url) {
      if (!isWebUrl(url)) return;
      await invoke("plugin:opener|open_url", { url });
    },
    async notify({ title, body }) {
      let granted = await invoke<boolean | null>("plugin:notification|is_permission_granted").catch(() => false);
      if (granted !== true) granted = (await invoke<string>("plugin:notification|request_permission").catch(() => "denied")) === "granted";
      if (granted) await invoke("plugin:notification|notify", { options: { title, body } });
    },
    async setBadge(count) {
      const pixels = drawBadge(count);
      await invoke("set_taskbar_badge", { rgba: pixels ? Array.from(pixels) : null, size: BADGE_SIZE });
    },
    async requestAttention() {
      await invoke("request_attention");
    },
    // Rust em apps/desktop/src-tauri/src/desktop_settings.rs (registro do Windows + arquivo do app).
    getDesktopSettings() {
      return invoke<DesktopSettings>("get_desktop_settings");
    },
    async setDesktopSettings(settings) {
      try {
        return await invoke<DesktopSettings>("set_desktop_settings", { settings });
      } catch (error) {
        throw new Error(typeof error === "string" ? error : "Não foi possível salvar as opções do Windows.");
      }
    },
  };
}
