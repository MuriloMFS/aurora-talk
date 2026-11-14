import type { VoiceSettings } from "@aurora/platform";
import { effectiveProcessing, type VoicePrefs } from "./state/settings";

/** Preferências de voz da pessoa → o que o motor de mídia aplica (o perfil vira os três ajustes). */
export const voiceSettingsOf = (voice: VoicePrefs): VoiceSettings => ({
  inputDeviceId: voice.inputDeviceId,
  outputDeviceId: voice.outputDeviceId,
  inputVolume: voice.inputVolume,
  outputVolume: voice.outputVolume,
  ...effectiveProcessing(voice),
});

/** Apertar para falar só vale com o modo ligado e uma tecla escolhida. */
export const pushToTalkOn = (voice: VoicePrefs): boolean => voice.inputMode === "ptt" && voice.pttKey !== null;
