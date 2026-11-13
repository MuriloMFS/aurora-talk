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
