import { describe, expect, it } from "vitest";
import { DEFAULT_SETTINGS, SETTINGS_STORAGE_KEY, createSettingsStore, effectiveProcessing, loadSettings, sanitizeSettings, type AppSettings } from "./settings";
import { SOUND_IDS, SOUND_LABELS, SOUND_NOTES, soundDuration, voiceEventSound } from "../sounds";

describe("preferências deste aparelho", () => {
  it("sem nada salvo (ou lixo), tudo volta ao padrão", () => {
    expect(sanitizeSettings(null)).toEqual(DEFAULT_SETTINGS);
    expect(sanitizeSettings("texto")).toEqual(DEFAULT_SETTINGS);
    expect(loadSettings({ getItem: () => "{json quebrado" })).toEqual(DEFAULT_SETTINGS);
    expect(loadSettings({ getItem: () => { throw new Error("bloqueado"); } })).toEqual(DEFAULT_SETTINGS);
  });

  it("valores fora da faixa são presos aos limites; tipos errados viram padrão", () => {
    const s = sanitizeSettings({
      voice: { inputVolume: 999, outputVolume: -5, profile: "hacker", inputDeviceId: 42, echoCancellation: "sim" },
      sounds: { volume: 70.6, enabled: { mute: false, desconhecido: false } },
      appearance: { density: "compact", chatFontSize: 17 },
      accessibility: { motion: "reduce", strongBorders: "sim" },
    });
    expect(s.voice).toMatchObject({ inputVolume: 200, outputVolume: 0, profile: "isolation", inputDeviceId: "default", echoCancellation: true });
    expect(s.sounds.volume).toBe(71);
    expect(s.sounds.enabled.mute).toBe(false);
    expect(s.sounds.enabled.unmute).toBe(true);
    expect(Object.keys(s.sounds.enabled)).toEqual([...SOUND_IDS]); // chave estranha não entra
    expect(s.appearance).toEqual({ density: "compact", chatFontSize: 16 }); // 17 → tamanho válido mais perto
    expect(s.accessibility).toEqual({ motion: "reduce", strongBorders: false });
  });

  it("perfil de entrada decide o processamento de voz", () => {
    const custom = { ...DEFAULT_SETTINGS.voice, profile: "custom" as const, echoCancellation: true, noiseSuppression: false, autoGainControl: false };
    expect(effectiveProcessing({ ...custom, profile: "isolation" })).toEqual({ echoCancellation: true, noiseSuppression: true, autoGainControl: true });
    expect(effectiveProcessing({ ...custom, profile: "studio" })).toEqual({ echoCancellation: false, noiseSuppression: false, autoGainControl: false });
    expect(effectiveProcessing(custom)).toEqual({ echoCancellation: true, noiseSuppression: false, autoGainControl: false });
  });

  it("store: salva, avisa quem escuta e ignora mudança que não muda nada", () => {
    const saved: AppSettings[] = [];
    const store = createSettingsStore(DEFAULT_SETTINGS, (s) => saved.push(s));
    let calls = 0;
    store.subscribe(() => calls++);
    store.update((s) => ({ ...s, sounds: { ...s.sounds, volume: 20 } }));
    store.update((s) => ({ ...s }));
    expect(store.get().sounds.volume).toBe(20);
    expect(calls).toBe(1);
    expect(saved).toHaveLength(1);
    expect(SETTINGS_STORAGE_KEY).toBe("aurora.settings");
  });
});

describe("sons de feedback", () => {
  it("todo som tem rótulo e notas curtas (feedback, não música)", () => {
    for (const id of SOUND_IDS) {
      expect(SOUND_LABELS[id]).toMatch(/^[A-ZÁÉÍÓÚÂÊÔÃÕÇ]/);
      expect(SOUND_NOTES[id].length).toBeGreaterThan(0);
      expect(soundDuration(id)).toBeLessThan(0.6);
      for (const note of SOUND_NOTES[id]) expect(note.freq).toBeGreaterThan(100);
    }
  });

  it("entrar e sair da minha sala, e transmissões dentro dela", () => {
    const me = "1";
    const room = "30";
    const other = (channelId: string | null, streaming = false) => ({ userId: "2", channelId, streaming });
    expect(voiceEventSound(undefined, other(room), me, room)).toBe("userJoin");
    expect(voiceEventSound({ channelId: "31", streaming: false }, other(room), me, room)).toBe("userJoin"); // veio de outra sala
    expect(voiceEventSound({ channelId: room, streaming: false }, other(null), me, room)).toBe("userLeave");
    expect(voiceEventSound({ channelId: room, streaming: false }, other("31"), me, room)).toBe("userLeave");
    expect(voiceEventSound({ channelId: room, streaming: false }, other(room, true), me, room)).toBe("streamStart");
    expect(voiceEventSound({ channelId: room, streaming: true }, other(room, false), me, room)).toBe("streamStop");
    expect(voiceEventSound({ channelId: room, streaming: false }, other(room), me, room)).toBeNull(); // só mutou
    expect(voiceEventSound(undefined, other("31"), me, room)).toBeNull(); // outra sala
    expect(voiceEventSound(undefined, other(room), me, null)).toBeNull(); // não estou na voz
    expect(voiceEventSound(undefined, { userId: me, channelId: room, streaming: false }, me, room)).toBeNull(); // eu mesmo
  });
});
