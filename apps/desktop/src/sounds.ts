import type { Id, VoiceState } from "@aurora/schema";

/**
 * Sons de feedback do Aurora. São ORIGINAIS: sintetizados na hora com Web Audio (notas simples com
 * envelope), sem arquivos de áudio — nada de sons de outros apps (identidade original do projeto).
 */
export const SOUND_IDS = [
  "mute",
  "unmute",
  "deafen",
  "undeafen",
  "voiceConnect",
  "voiceDisconnect",
  "userJoin",
  "userLeave",
  "streamStart",
  "streamStop",
  "mention",
  "pttOn",
  "pttOff",
] as const;
export type SoundId = (typeof SOUND_IDS)[number];

/** Rótulos da tela de configurações (pt-BR, sentence case). */
export const SOUND_LABELS: Record<SoundId, string> = {
  mute: "Desligar o microfone",
  unmute: "Ligar o microfone",
  deafen: "Ensurdecer",
  undeafen: "Voltar a ouvir",
  voiceConnect: "Você entrou na voz",
  voiceDisconnect: "Você saiu da voz",
  userJoin: "Alguém entrou na sua sala",
  userLeave: "Alguém saiu da sua sala",
  streamStart: "Transmissão de tela começou",
  streamStop: "Transmissão de tela terminou",
  mention: "Menção a você",
  pttOn: "Apertar para falar: microfone abriu",
  pttOff: "Apertar para falar: microfone fechou",
};

interface Note {
  /** Frequência em Hz. */
  freq: number;
  /** Início, em segundos a partir do disparo. */
  at: number;
  /** Duração até o som sumir, em segundos. */
  dur: number;
  type?: OscillatorType;
  /** Volume relativo da nota (0–1). */
  gain?: number;
}

// Notas (Hz): G4 392 · A4 440 · C5 523,25 · D5 587,33 · E5 659,25 · G5 783,99 · A5 880 · B5 987,77 · C6 1046,5 · E6 1318,51
const n = (freq: number, at: number, dur: number, type: OscillatorType = "sine", gain = 1): Note => ({ freq, at, dur, type, gain });

export const SOUND_NOTES: Record<SoundId, readonly Note[]> = {
  mute: [n(783.99, 0, 0.08, "triangle"), n(523.25, 0.07, 0.12, "triangle")],
  unmute: [n(523.25, 0, 0.08, "triangle"), n(783.99, 0.07, 0.12, "triangle")],
  deafen: [n(659.25, 0, 0.07, "triangle"), n(523.25, 0.06, 0.07, "triangle"), n(392, 0.12, 0.16, "triangle")],
  undeafen: [n(392, 0, 0.07, "triangle"), n(523.25, 0.06, 0.07, "triangle"), n(659.25, 0.12, 0.16, "triangle")],
  voiceConnect: [n(523.25, 0, 0.1), n(659.25, 0.06, 0.1), n(783.99, 0.12, 0.1), n(1046.5, 0.18, 0.28)],
  voiceDisconnect: [n(783.99, 0, 0.1), n(659.25, 0.07, 0.1), n(523.25, 0.14, 0.1), n(392, 0.21, 0.3)],
  userJoin: [n(659.25, 0, 0.1, "sine", 0.8), n(987.77, 0.08, 0.18, "sine", 0.8)],
  userLeave: [n(987.77, 0, 0.1, "sine", 0.8), n(659.25, 0.08, 0.18, "sine", 0.8)],
  streamStart: [n(392, 0, 0.08, "triangle"), n(587.33, 0.07, 0.08, "triangle"), n(783.99, 0.14, 0.22, "triangle")],
  streamStop: [n(783.99, 0, 0.08, "triangle"), n(587.33, 0.07, 0.08, "triangle"), n(392, 0.14, 0.22, "triangle")],
  // sino: fundamental + 2º harmônico baixinho
  // clique curto e baixinho (toca a cada fala): sobe ao abrir, desce ao fechar
  pttOn: [n(1046.5, 0, 0.05, "sine", 0.45)],
  pttOff: [n(783.99, 0, 0.05, "sine", 0.35)],
  mention: [n(880, 0, 0.12), n(1760, 0, 0.12, "sine", 0.2), n(1318.51, 0.1, 0.32), n(2637.02, 0.1, 0.32, "sine", 0.15)],
};

/** Duração total de um som (para testes e para não sobrepor demais). */
export const soundDuration = (id: SoundId): number => Math.max(...SOUND_NOTES[id].map((note) => note.at + note.dur));

const NOTE_PEAK = 0.22;
const ATTACK_S = 0.006;

type SinkAudioContext = AudioContext & { setSinkId?: (id: string) => Promise<void> };

/** Toca os sons no alto-falante escolhido, no volume escolhido. Sem Web Audio, fica mudo (nunca quebra). */
export class SoundPlayer {
  private context: SinkAudioContext | null = null;
  private master: GainNode | null = null;
  private outputDeviceId = "default";
  private volume = 0.5;

  /** 0–1. */
  setVolume(volume: number): void {
    this.volume = Math.min(1, Math.max(0, volume));
    if (this.master) this.master.gain.value = this.volume;
  }

  async setOutputDevice(deviceId: string): Promise<void> {
    this.outputDeviceId = deviceId || "default";
    await this.applySink();
  }

  play(id: SoundId): void {
    if (this.volume <= 0) return;
    const context = this.ensureContext();
    if (!context || !this.master) return;
    if (context.state === "suspended") void context.resume().catch(() => undefined);
    const start = context.currentTime + 0.01;
    for (const note of SOUND_NOTES[id]) {
      const osc = context.createOscillator();
      const gain = context.createGain();
      osc.type = note.type ?? "sine";
      osc.frequency.value = note.freq;
      const t0 = start + note.at;
      const peak = NOTE_PEAK * (note.gain ?? 1);
      gain.gain.setValueAtTime(0.0001, t0);
      gain.gain.exponentialRampToValueAtTime(peak, t0 + ATTACK_S);
      gain.gain.exponentialRampToValueAtTime(0.0001, t0 + note.dur);
      osc.connect(gain).connect(this.master);
      osc.start(t0);
      osc.stop(t0 + note.dur + 0.02);
    }
  }

  private ensureContext(): SinkAudioContext | null {
    if (this.context) return this.context;
    if (typeof AudioContext === "undefined") return null;
    try {
      this.context = new AudioContext({ latencyHint: "interactive" }) as SinkAudioContext;
      this.master = this.context.createGain();
      this.master.gain.value = this.volume;
      this.master.connect(this.context.destination);
      void this.applySink();
      return this.context;
    } catch {
      return null;
    }
  }

  private async applySink(): Promise<void> {
    const context = this.context;
    if (!context?.setSinkId) return;
    // "" = saída padrão do sistema
    await context.setSinkId(this.outputDeviceId === "default" ? "" : this.outputDeviceId).catch(() => undefined);
  }
}

/**
 * Som para uma mudança de voz de OUTRA pessoa, do ponto de vista de quem está em `myChannelId`.
 * Os meus próprios sons (entrar, mutar…) saem das minhas ações, não dos eventos.
 */
export function voiceEventSound(
  previous: Pick<VoiceState, "channelId" | "streaming"> | undefined,
  next: { userId: Id; channelId: Id | null; streaming: boolean },
  meId: Id,
  myChannelId: Id | null,
): SoundId | null {
  if (next.userId === meId || !myChannelId) return null;
  const wasHere = previous?.channelId === myChannelId;
  const isHere = next.channelId === myChannelId;
  if (!wasHere && isHere) return "userJoin";
  if (wasHere && !isHere) return "userLeave";
  if (wasHere && isHere && previous && previous.streaming !== next.streaming) return next.streaming ? "streamStart" : "streamStop";
  return null;
}
