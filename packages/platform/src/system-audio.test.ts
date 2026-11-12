import { describe, expect, it } from "vitest";
import { SYSTEM_AUDIO_FORMAT, pcmChunkToAudioDataInit } from "./system-audio";

describe("pcmChunkToAudioDataInit", () => {
  it("bloco de 20 ms (960 quadros estéreo float) vira AudioData intercalado", () => {
    const init = pcmChunkToAudioDataInit(new ArrayBuffer(960 * 2 * 4), 0);
    expect(init).toMatchObject({ format: "f32", sampleRate: 48_000, numberOfChannels: 2, numberOfFrames: 960, timestamp: 0 });
  });

  it("o carimbo de tempo segue as amostras já enviadas (em microssegundos)", () => {
    expect(pcmChunkToAudioDataInit(new ArrayBuffer(8 * 100), 48_000)?.timestamp).toBe(1_000_000);
    expect(pcmChunkToAudioDataInit(new ArrayBuffer(8 * 100), 960)?.timestamp).toBe(20_000);
  });

  it("descarta bloco vazio ou que não fecha quadros inteiros", () => {
    expect(pcmChunkToAudioDataInit(new ArrayBuffer(0), 0)).toBeNull();
    expect(pcmChunkToAudioDataInit(new ArrayBuffer(12), 0)).toBeNull();
  });

  it("formato igual ao do Rust (48 kHz estéreo)", () => {
    expect(SYSTEM_AUDIO_FORMAT).toEqual({ sampleRate: 48_000, channels: 2 });
  });
});
