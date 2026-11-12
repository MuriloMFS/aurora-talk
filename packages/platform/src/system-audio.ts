/**
 * Formato do som do sistema capturado pelo Rust (apps/desktop/src-tauri/src/system_audio.rs).
 * Mantenha os dois lados iguais: PCM float 32, intercalado, 48 kHz, estéreo.
 */
export const SYSTEM_AUDIO_FORMAT = { sampleRate: 48_000, channels: 2 } as const;

/**
 * Bloco de bytes vindo do Rust -> parâmetros de um AudioData.
 * `framesBefore` = quadros já enviados; o carimbo de tempo segue a contagem de amostras
 * (sem buracos falsos quando o Windows entrega pacotes de tamanhos variados).
 * `null` = bloco vazio ou corrompido (tamanho que não fecha quadros inteiros).
 */
export function pcmChunkToAudioDataInit(buffer: ArrayBuffer, framesBefore: number): AudioDataInit | null {
  const bytesPerFrame = SYSTEM_AUDIO_FORMAT.channels * Float32Array.BYTES_PER_ELEMENT;
  if (buffer.byteLength === 0 || buffer.byteLength % bytesPerFrame !== 0) return null;
  const numberOfFrames = buffer.byteLength / bytesPerFrame;
  return {
    format: "f32", // intercalado
    sampleRate: SYSTEM_AUDIO_FORMAT.sampleRate,
    numberOfChannels: SYSTEM_AUDIO_FORMAT.channels,
    numberOfFrames,
    timestamp: Math.round((framesBefore * 1_000_000) / SYSTEM_AUDIO_FORMAT.sampleRate),
    data: buffer,
  };
}
