import type { AudioProcessorOptions, Track, TrackProcessor } from "livekit-client";

/**
 * Volume do microfone (0–200%) aplicado antes de enviar: o LiveKit passa a trilha do microfone por
 * aqui e publica a trilha processada. Mutar continua sendo feito pelo LiveKit, na trilha publicada.
 */
export class MicrophoneGain implements TrackProcessor<Track.Kind.Audio, AudioProcessorOptions> {
  readonly name = "aurora-microphone-volume";
  processedTrack?: MediaStreamTrack;
  private gain: GainNode | null = null;
  private source: MediaStreamAudioSourceNode | null = null;
  private value: number;

  /** `value`: fator de ganho (1 = 100%). */
  constructor(value: number) {
    this.value = value;
  }

  async init(options: AudioProcessorOptions): Promise<void> {
    this.build(options);
  }

  async restart(options: AudioProcessorOptions): Promise<void> {
    this.teardown();
    this.build(options);
  }

  async destroy(): Promise<void> {
    this.teardown();
  }

  setValue(value: number): void {
    this.value = value;
    if (this.gain) this.gain.gain.value = value;
  }

  private build({ track, audioContext }: AudioProcessorOptions): void {
    this.source = audioContext.createMediaStreamSource(new MediaStream([track]));
    this.gain = audioContext.createGain();
    this.gain.gain.value = this.value;
    const destination = audioContext.createMediaStreamDestination();
    this.source.connect(this.gain).connect(destination);
    this.processedTrack = destination.stream.getAudioTracks()[0];
  }

  private teardown(): void {
    this.source?.disconnect();
    this.gain?.disconnect();
    this.processedTrack?.stop();
    this.source = null;
    this.gain = null;
    this.processedTrack = undefined;
  }
}
