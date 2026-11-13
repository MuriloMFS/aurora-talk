import { describe, expect, it } from "vitest";
import { DEFAULT_VOICE_SETTINGS, captureConstraints, deviceLabel, levelFromSamples } from "./audio";

describe("áudio: microfone e alto-falante", () => {
  it("dispositivo padrão não força ID; um escolhido é preferido, sem travar se sumir", () => {
    expect(captureConstraints(DEFAULT_VOICE_SETTINGS)).toEqual({ echoCancellation: true, noiseSuppression: true, autoGainControl: true });
    const chosen = captureConstraints({ ...DEFAULT_VOICE_SETTINGS, inputDeviceId: "abc", noiseSuppression: false });
    expect(chosen).toEqual({ deviceId: { ideal: "abc" }, echoCancellation: true, noiseSuppression: false, autoGainControl: true });
  });

  it("nomes do Windows em português", () => {
    expect(deviceLabel({ deviceId: "default", label: "Default - Headset (Logitech PRO X)" }, 0)).toBe("Padrão do Windows (Headset (Logitech PRO X))");
    expect(deviceLabel({ deviceId: "default", label: "Padrão - Microfone (Realtek)" }, 0)).toBe("Padrão do Windows (Microfone (Realtek))");
    expect(deviceLabel({ deviceId: "communications", label: "Communications - Headset" }, 1)).toBe("Comunicações do Windows (Headset)");
    expect(deviceLabel({ deviceId: "x1", label: "" }, 2)).toBe("Dispositivo 3");
    expect(deviceLabel({ deviceId: "x2", label: "Microfone USB" }, 3)).toBe("Microfone USB");
  });

  it("medidor: silêncio = 0, fala normal no meio, saturado = 1", () => {
    expect(levelFromSamples(new Float32Array(512))).toBe(0);
    const speech = new Float32Array(512).map((_, i) => 0.03 * Math.sin(i / 3)); // ~ −33 dB
    expect(levelFromSamples(speech)).toBeGreaterThan(0.3);
    expect(levelFromSamples(speech)).toBeLessThan(0.6);
    expect(levelFromSamples(new Float32Array(512).fill(1))).toBe(1);
  });
});
