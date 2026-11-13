/**
 * Dispositivos de áudio, teste de microfone e volume do microfone. Usa só APIs do navegador
 * (iguais no WebView2 e no Chrome), por isso serve às duas implementações da PlatformPort.
 */

/** Como a voz deve soar (vem das configurações da pessoa). */
export interface VoiceSettings {
  /** "default" = o padrão do sistema. */
  inputDeviceId: string;
  outputDeviceId: string;
  /** Volume do microfone em % (0–200). */
  inputVolume: number;
  /** Volume de quem fala na sala em % (0–100). */
  outputVolume: number;
  echoCancellation: boolean;
  noiseSuppression: boolean;
  autoGainControl: boolean;
}

export const DEFAULT_VOICE_SETTINGS: VoiceSettings = {
  inputDeviceId: "default",
  outputDeviceId: "default",
  inputVolume: 100,
  outputVolume: 100,
  echoCancellation: true,
  noiseSuppression: true,
  autoGainControl: true,
};

export interface AudioDevice {
  id: string;
  label: string;
}

export interface AudioDevices {
  inputs: AudioDevice[];
  outputs: AudioDevice[];
}

/** Restrições de captura do microfone para a escolha da pessoa. `ideal`: se o aparelho sumiu, usa outro. */
export function captureConstraints(settings: VoiceSettings): MediaTrackConstraints {
  return {
    ...(settings.inputDeviceId !== "default" && { deviceId: { ideal: settings.inputDeviceId } }),
    echoCancellation: settings.echoCancellation,
    noiseSuppression: settings.noiseSuppression,
    autoGainControl: settings.autoGainControl,
  };
}

/** Nomes do Windows/Chromium em português ("Padrão - …", "Comunicações - …"). */
export function deviceLabel(device: Pick<MediaDeviceInfo, "deviceId" | "label">, index: number): string {
  const label = device.label.trim();
  if (device.deviceId === "default") return `Padrão do Windows${label ? ` (${label.replace(/^(Default|Padrão)\s*-\s*/i, "")})` : ""}`;
  if (device.deviceId === "communications") return `Comunicações do Windows${label ? ` (${label.replace(/^(Communications|Comunicações)\s*-\s*/i, "")})` : ""}`;
  return label || `Dispositivo ${index + 1}`;
}

/** Lista microfones e alto-falantes. Sem permissão, os nomes vêm vazios: pede o microfone uma vez para ler. */
export async function listAudioDevices(): Promise<AudioDevices> {
  const media = globalThis.navigator?.mediaDevices;
  if (!media?.enumerateDevices) return { inputs: [], outputs: [] };
  let devices = await media.enumerateDevices();
  if (devices.some((d) => d.kind === "audioinput" && !d.label) && media.getUserMedia) {
    try {
      const stream = await media.getUserMedia({ audio: true });
      stream.getTracks().forEach((t) => t.stop());
      devices = await media.enumerateDevices();
    } catch {
      // sem permissão: segue com os nomes genéricos
    }
  }
  const pick = (kind: MediaDeviceKind) => {
    const list = devices.filter((d) => d.kind === kind && d.deviceId);
    const items = list.map((d, i) => ({ id: d.deviceId, label: deviceLabel(d, i) }));
    // o "padrão" sempre existe e vem primeiro
    if (!items.some((d) => d.id === "default")) items.unshift({ id: "default", label: "Padrão do Windows" });
    return items.sort((a, b) => Number(b.id === "default") - Number(a.id === "default"));
  };
  return { inputs: pick("audioinput"), outputs: pick("audiooutput") };
}

/** Avisa quando um fone/microfone é ligado ou desligado. Devolve o cancelamento. */
export function onAudioDevicesChange(listener: () => void): () => void {
  const media = globalThis.navigator?.mediaDevices;
  if (!media?.addEventListener) return () => {};
  media.addEventListener("devicechange", listener);
  return () => media.removeEventListener("devicechange", listener);
}

/** Nível de 0 a 1 a partir de amostras (escala em dB de −60 a 0: fala normal fica no meio). */
export function levelFromSamples(samples: Float32Array): number {
  let sum = 0;
  for (const sample of samples) sum += sample * sample;
  const rms = Math.sqrt(sum / Math.max(1, samples.length));
  if (rms <= 0) return 0;
  const db = 20 * Math.log10(rms);
  return Math.min(1, Math.max(0, (db + 60) / 60));
}

type SinkAudioContext = AudioContext & { setSinkId?: (id: string) => Promise<void> };

export interface MicrophoneTest {
  /** Nível atual de 0 a 1 (chame num requestAnimationFrame). */
  level(): number;
  /** Ouvir a própria voz no alto-falante escolhido. */
  setMonitor(on: boolean): void;
  stop(): void;
}

/** Abre o microfone escolhido, com o processamento e o volume escolhidos, para medir (e ouvir). */
export async function startMicrophoneTest(settings: VoiceSettings): Promise<MicrophoneTest> {
  const stream = await navigator.mediaDevices.getUserMedia({ audio: captureConstraints(settings) });
  const context = new AudioContext() as SinkAudioContext;
  if (settings.outputDeviceId !== "default") await context.setSinkId?.(settings.outputDeviceId).catch(() => undefined);
  const source = context.createMediaStreamSource(stream);
  const gain = context.createGain();
  gain.gain.value = settings.inputVolume / 100;
  const analyser = context.createAnalyser();
  analyser.fftSize = 1024;
  const monitor = context.createGain();
  monitor.gain.value = 0;
  source.connect(gain);
  gain.connect(analyser);
  gain.connect(monitor).connect(context.destination);
  if (context.state === "suspended") await context.resume().catch(() => undefined);
  const samples = new Float32Array(analyser.fftSize);
  let stopped = false;
  return {
    level() {
      if (stopped) return 0;
      analyser.getFloatTimeDomainData(samples);
      return levelFromSamples(samples);
    },
    setMonitor(on) {
      monitor.gain.value = on ? 1 : 0;
    },
    stop() {
      if (stopped) return;
      stopped = true;
      stream.getTracks().forEach((t) => t.stop());
      void context.close().catch(() => undefined);
    },
  };
}
