import { useSyncExternalStore } from "react";
import { PTT_RELEASE_DEFAULT, PTT_RELEASE_MAX, PTT_RELEASE_MIN, pttVirtualKey } from "@aurora/platform";
import { SOUND_IDS, type SoundId } from "../sounds";

/**
 * Preferências deste aparelho (como as "configurações do usuário" do app, por máquina).
 * Ficam no armazenamento local; um valor estranho ou de versão antiga volta ao padrão, nunca quebra.
 * O tema continua em `@aurora/ui/theme` (o script anti-flash do index.html lê a mesma chave).
 * As opções do Windows (iniciar com o sistema, bandeja) ficam no lado nativo: PlatformPort.
 */
export type Density = "cozy" | "compact";
/** "system" = segue o Windows; "reduce" = sempre reduzir. */
export type MotionPreference = "system" | "reduce";
/** Perfil de entrada do microfone: isolar a voz (tudo ligado), estúdio (som puro) ou escolher. */
export type InputProfile = "isolation" | "studio" | "custom";
/** Como o microfone abre: detecção de voz (aberto o tempo todo) ou apertar para falar. */
export type InputMode = "voice" | "ptt";

export interface VoicePrefs {
  /** "default" = o dispositivo padrão do Windows. */
  inputDeviceId: string;
  outputDeviceId: string;
  /** Volume do microfone, 0–200 (%). */
  inputVolume: number;
  /** Volume de quem fala na sala, 0–100 (%). */
  outputVolume: number;
  profile: InputProfile;
  /** Só valem no perfil "custom". */
  echoCancellation: boolean;
  noiseSuppression: boolean;
  autoGainControl: boolean;
  inputMode: InputMode;
  /** Tecla (KeyboardEvent.code) ou "Mouse3/4/5" do apertar para falar; null = ainda não escolhida. */
  pttKey: string | null;
  /** Nome da tecla como a pessoa vê no teclado (guardado na escolha). */
  pttKeyLabel: string | null;
  /** Atraso ao soltar a tecla, em ms. */
  pttReleaseMs: number;
}

export interface AppSettings {
  voice: VoicePrefs;
  sounds: { volume: number; enabled: Record<SoundId, boolean> };
  notifications: {
    /** Notificação do Windows quando mencionarem você fora de vista. */
    desktop: boolean;
    /** Número de menções sobre o ícone da barra de tarefas. */
    badge: boolean;
    /** Piscar o ícone quando mencionarem você com o app em segundo plano. */
    flash: boolean;
  };
  appearance: {
    density: Density;
    /** Tamanho do texto das mensagens, 12–24 px. */
    chatFontSize: number;
    /** Escala em que chatFontSize foi escolhido (ver TYPE_SCALE). */
    typeScale: number;
  };
  accessibility: {
    motion: MotionPreference;
    /** Contornos mais fortes nos divisores (mais fácil de ver as áreas). */
    strongBorders: boolean;
  };
  presence: {
    /** Minutos sem mexer no computador até ficar "Ausente" (0 = nunca). */
    idleMinutes: number;
  };
}

export const IDLE_MINUTES = [0, 5, 10, 15, 30] as const;

export const CHAT_FONT_SIZES = [12, 13, 14, 15, 16, 18, 20, 24] as const;

/** Versão da escala de texto. Na 2 o padrão do chat caiu de 16 para 14 px (Inter calibrada). */
export const TYPE_SCALE = 2;
/** Altura de linha do chat para um tamanho de fonte (mesma proporção da escala). */
export const chatLineHeight = (size: number) => Math.round(size * 1.43);

export const DEFAULT_SETTINGS: AppSettings = {
  voice: {
    inputDeviceId: "default",
    outputDeviceId: "default",
    inputVolume: 100,
    outputVolume: 100,
    profile: "isolation",
    echoCancellation: true,
    noiseSuppression: true,
    autoGainControl: true,
    inputMode: "voice",
    pttKey: null,
    pttKeyLabel: null,
    pttReleaseMs: PTT_RELEASE_DEFAULT,
  },
  sounds: { volume: 50, enabled: Object.fromEntries(SOUND_IDS.map((id) => [id, true])) as Record<SoundId, boolean> },
  notifications: { desktop: true, badge: true, flash: true },
  appearance: { density: "cozy", chatFontSize: 14, typeScale: TYPE_SCALE },
  accessibility: { motion: "system", strongBorders: false },
  presence: { idleMinutes: 10 },
};

/** Processamento de voz que vale de fato, conforme o perfil. */
export function effectiveProcessing(voice: VoicePrefs): { echoCancellation: boolean; noiseSuppression: boolean; autoGainControl: boolean } {
  if (voice.profile === "isolation") return { echoCancellation: true, noiseSuppression: true, autoGainControl: true };
  if (voice.profile === "studio") return { echoCancellation: false, noiseSuppression: false, autoGainControl: false };
  return { echoCancellation: voice.echoCancellation, noiseSuppression: voice.noiseSuppression, autoGainControl: voice.autoGainControl };
}

/* ---------------- validação (tudo que vem do armazenamento é suspeito) ---------------- */

type Raw = Record<string, unknown>;
const obj = (value: unknown): Raw => (value && typeof value === "object" && !Array.isArray(value) ? (value as Raw) : {});
const bool = (value: unknown, fallback: boolean) => (typeof value === "boolean" ? value : fallback);
const oneOf = <T extends string>(value: unknown, options: readonly T[], fallback: T): T => (options.includes(value as T) ? (value as T) : fallback);
const num = (value: unknown, min: number, max: number, fallback: number) =>
  typeof value === "number" && Number.isFinite(value) ? Math.min(max, Math.max(min, Math.round(value))) : fallback;
/** IDs de dispositivo do navegador: texto curto, sem nada estranho. */
const deviceId = (value: unknown) => (typeof value === "string" && value.length > 0 && value.length <= 256 ? value : "default");

export function sanitizeSettings(raw: unknown): AppSettings {
  const root = obj(raw);
  const d = DEFAULT_SETTINGS;
  const voice = obj(root.voice);
  const sounds = obj(root.sounds);
  const enabled = obj(sounds.enabled);
  const notifications = obj(root.notifications);
  const appearance = obj(root.appearance);
  const accessibility = obj(root.accessibility);
  const presence = obj(root.presence);
  const pttKey = typeof voice.pttKey === "string" && pttVirtualKey(voice.pttKey) !== null ? voice.pttKey : null;
  const savedSize = num(appearance.chatFontSize, 12, 24, d.appearance.chatFontSize);
  // quem nunca mexeu ficou com o padrão antigo (16): passa para o novo padrão
  const fontSize = appearance.typeScale !== TYPE_SCALE && savedSize === 16 ? d.appearance.chatFontSize : savedSize;
  return {
    voice: {
      inputDeviceId: deviceId(voice.inputDeviceId),
      outputDeviceId: deviceId(voice.outputDeviceId),
      inputVolume: num(voice.inputVolume, 0, 200, d.voice.inputVolume),
      outputVolume: num(voice.outputVolume, 0, 100, d.voice.outputVolume),
      profile: oneOf(voice.profile, ["isolation", "studio", "custom"], d.voice.profile),
      echoCancellation: bool(voice.echoCancellation, d.voice.echoCancellation),
      noiseSuppression: bool(voice.noiseSuppression, d.voice.noiseSuppression),
      autoGainControl: bool(voice.autoGainControl, d.voice.autoGainControl),
      inputMode: oneOf(voice.inputMode, ["voice", "ptt"], d.voice.inputMode),
      pttKey: pttKey,
      pttKeyLabel: pttKey && typeof voice.pttKeyLabel === "string" && voice.pttKeyLabel.length <= 40 ? voice.pttKeyLabel : null,
      pttReleaseMs: num(voice.pttReleaseMs, PTT_RELEASE_MIN, PTT_RELEASE_MAX, d.voice.pttReleaseMs),
    },
    sounds: {
      volume: num(sounds.volume, 0, 100, d.sounds.volume),
      enabled: Object.fromEntries(SOUND_IDS.map((id) => [id, bool(enabled[id], true)])) as Record<SoundId, boolean>,
    },
    notifications: {
      desktop: bool(notifications.desktop, d.notifications.desktop),
      badge: bool(notifications.badge, d.notifications.badge),
      flash: bool(notifications.flash, d.notifications.flash),
    },
    appearance: {
      density: oneOf(appearance.density, ["cozy", "compact"], d.appearance.density),
      chatFontSize: CHAT_FONT_SIZES.reduce((best, size) => (Math.abs(size - fontSize) < Math.abs(best - fontSize) ? size : best), d.appearance.chatFontSize as number),
      typeScale: TYPE_SCALE,
    },
    accessibility: {
      motion: oneOf(accessibility.motion, ["system", "reduce"], d.accessibility.motion),
      strongBorders: bool(accessibility.strongBorders, d.accessibility.strongBorders),
    },
    presence: {
      idleMinutes: (IDLE_MINUTES as readonly number[]).includes(presence.idleMinutes as number) ? (presence.idleMinutes as number) : d.presence.idleMinutes,
    },
  };
}

/* ---------------- armazenamento + store ---------------- */

export const SETTINGS_STORAGE_KEY = "aurora.settings";

export function loadSettings(storage: Pick<Storage, "getItem"> | undefined = globalThis.localStorage): AppSettings {
  try {
    return sanitizeSettings(JSON.parse(storage?.getItem(SETTINGS_STORAGE_KEY) ?? "null"));
  } catch {
    return DEFAULT_SETTINGS; // armazenamento bloqueado ou JSON quebrado
  }
}

function saveSettings(settings: AppSettings): void {
  try {
    globalThis.localStorage?.setItem(SETTINGS_STORAGE_KEY, JSON.stringify(settings));
  } catch {
    // sem persistência: a escolha vale até fechar o app
  }
}

export interface SettingsStore {
  get(): AppSettings;
  update(change: (current: AppSettings) => AppSettings): void;
  subscribe(listener: () => void): () => void;
}

export function createSettingsStore(initial: AppSettings = loadSettings(), persist: (s: AppSettings) => void = saveSettings): SettingsStore {
  let current = initial;
  const listeners = new Set<() => void>();
  return {
    get: () => current,
    update(change) {
      const next = sanitizeSettings(change(current));
      if (JSON.stringify(next) === JSON.stringify(current)) return;
      current = next;
      persist(current);
      for (const listener of listeners) listener();
    },
    subscribe(listener) {
      listeners.add(listener);
      return () => listeners.delete(listener);
    },
  };
}

/** Uma só para o app inteiro (como o tema). */
export const settingsStore = createSettingsStore();

export function useSettings(store: SettingsStore = settingsStore): AppSettings {
  return useSyncExternalStore(store.subscribe, store.get, store.get);
}

/** Atalho para mudar um grupo: `patchSettings("sounds", { volume: 30 })`. */
export function patchSettings<K extends keyof AppSettings>(key: K, patch: Partial<AppSettings[K]>, store: SettingsStore = settingsStore): void {
  store.update((current) => ({ ...current, [key]: { ...current[key], ...patch } }));
}
