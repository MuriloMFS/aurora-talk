import { AudioPresets, ConnectionState, Room, RoomEvent, Track, type AudioCaptureOptions, type LocalAudioTrack, type RemoteTrack } from "livekit-client";
import { DEFAULT_VOICE_SETTINGS, captureConstraints, type VoiceSettings } from "./audio";
import { MicrophoneGain } from "./gain-processor";
import type { MediaCredentials, MediaEngine, MediaEngineEvents, PlatformInfo, PlatformPort, ScreenShare, SystemAudioCapture, VoiceConnectionState } from "./index";
import { rtcConfigFor } from "./ice";
import { SCREEN_SHARE_PROFILES, canExcludeOwnAudio, displayMediaOptions, type ScreenShareOptions, type ScreenShareResult } from "./screen-share";

function toState(state: ConnectionState): VoiceConnectionState {
  switch (state) {
    case ConnectionState.Connecting:
      return "connecting";
    case ConnectionState.Connected:
      return "connected";
    case ConnectionState.Disconnected:
      return "disconnected";
    default:
      return "reconnecting"; // Reconnecting / SignalReconnecting
  }
}

type VideoTrack = Pick<RemoteTrack, "attach" | "detach">;

/** Configurações da pessoa no formato de captura do LiveKit. */
const captureOptions = (voice: VoiceSettings): AudioCaptureOptions => captureConstraints(voice) as AudioCaptureOptions;


function shareOf(identity: string, local: boolean, track: VideoTrack): ScreenShare {
  return {
    identity,
    local,
    attach(element) {
      track.attach(element);
      return () => void track.detach(element);
    },
  };
}

/** MediaEngine sobre LiveKit (WebRTC do WebView2 no Windows). */
export class LiveKitMediaEngine implements MediaEngine {
  private room: Room | null = null;
  private events: MediaEngineEvents | null = null;
  private deafened = false;
  private readonly audioElements = new Set<HTMLMediaElement>();
  /** Telas remotas por identidade. */
  private readonly remoteShares = new Map<string, VideoTrack>();
  /** Som do computador capturado pelo app (transmissão em andamento). */
  private systemAudio: SystemAudioCapture | null = null;
  /** Dispositivos, volumes e processamento escolhidos nas configurações. */
  private voice: VoiceSettings = DEFAULT_VOICE_SETTINGS;
  /** Microfone desligado pela pessoa (ou ensurdecida, ou sem permissão). */
  private userMuted = true;
  /** Apertar para falar: null = desligado; senão, se a tecla está apertada. */
  private pushToTalk: boolean | null = null;
  /** Mudanças do microfone em fila: apertar e soltar rápido não podem se atropelar. */
  private micQueue: Promise<void> = Promise.resolve();

  private readonly platform: PlatformPort;
  private readonly info: PlatformInfo;

  constructor(platform: PlatformPort, info: PlatformInfo) {
    this.platform = platform;
    this.info = info;
  }

  async join(credentials: MediaCredentials, events: MediaEngineEvents, options: { muted: boolean; deafened: boolean; voice?: VoiceSettings; pushToTalk?: boolean | null }): Promise<void> {
    await this.leave();
    if (options.voice) this.voice = options.voice;
    const room = new Room({
      adaptiveStream: true,
      dynacast: true,
      // microfone, cancelamento de eco, supressão de ruído e ganho automático conforme as configurações
      audioCaptureDefaults: captureOptions(this.voice),
      audioOutput: { deviceId: this.voice.outputDeviceId },
    });
    this.room = room;
    this.events = events;
    this.deafened = options.deafened;
    room.on(RoomEvent.ConnectionStateChanged, (state) => events.onStateChange(toState(state)));
    room.on(RoomEvent.ActiveSpeakersChanged, (speakers) => events.onSpeakingChange(new Set(speakers.map((p) => p.identity))));
    room.on(RoomEvent.TrackSubscribed, (track, publication, participant) => {
      if (track.kind === Track.Kind.Audio) this.attachAudio(track);
      else if (publication.source === Track.Source.ScreenShare) {
        this.remoteShares.set(participant.identity, track);
        this.emitShares();
      }
    });
    room.on(RoomEvent.TrackUnsubscribed, (track, publication, participant) => {
      if (track.kind === Track.Kind.Audio) this.detachAudio(track);
      else if (publication.source === Track.Source.ScreenShare) {
        this.remoteShares.delete(participant.identity);
        this.emitShares();
      }
    });
    // Minha tela começou/parou (inclusive pelo botão "Parar de compartilhar" do sistema).
    room.on(RoomEvent.LocalTrackPublished, (publication) => publication.source === Track.Source.ScreenShare && this.emitShares());
    room.on(RoomEvent.LocalTrackUnpublished, (publication) => publication.source === Track.Source.ScreenShare && this.emitShares());

    events.onStateChange("connecting");
    const rtcConfig = rtcConfigFor(credentials);
    await room.connect(credentials.url, credentials.token, rtcConfig && { rtcConfig });
    this.userMuted = options.muted || options.deafened;
    this.pushToTalk = options.pushToTalk ?? null;
    await this.updateMicrophone();
    events.onStateChange("connected");
  }

  async applyVoiceSettings(next: VoiceSettings): Promise<void> {
    const previous = this.voice;
    this.voice = next;
    const room = this.room;
    if (!room) return;
    room.options.audioCaptureDefaults = captureOptions(next);
    const captureChanged =
      previous.inputDeviceId !== next.inputDeviceId ||
      previous.echoCancellation !== next.echoCancellation ||
      previous.noiseSuppression !== next.noiseSuppression ||
      previous.autoGainControl !== next.autoGainControl;
    const microphone = this.microphone();
    if (captureChanged && microphone) await microphone.restartTrack(captureOptions(next));
    if (previous.outputDeviceId !== next.outputDeviceId) await room.switchActiveDevice("audiooutput", next.outputDeviceId);
    for (const element of this.audioElements) element.volume = next.outputVolume / 100;
    await this.applyMicrophoneVolume();
  }

  private microphone(): LocalAudioTrack | undefined {
    return this.room?.localParticipant.getTrackPublication(Track.Source.Microphone)?.track as LocalAudioTrack | undefined;
  }

  /** 100% = trilha original; diferente disso, passa pelo ganho antes de ir para a sala. */
  private async applyMicrophoneVolume(): Promise<void> {
    const microphone = this.microphone();
    if (!microphone) return;
    const factor = this.voice.inputVolume / 100;
    const current = microphone.getProcessor();
    if (current instanceof MicrophoneGain) {
      if (factor === 1) await microphone.stopProcessor();
      else current.setValue(factor);
      return;
    }
    if (factor !== 1) await microphone.setProcessor(new MicrophoneGain(factor));
  }

  async leave(): Promise<void> {
    const room = this.room;
    this.room = null;
    this.pushToTalk = null;
    this.userMuted = true;
    await this.stopSystemAudio();
    if (room) {
      room.removeAllListeners();
      await room.disconnect();
    }
    for (const element of this.audioElements) element.remove();
    this.audioElements.clear();
    this.remoteShares.clear();
    this.events?.onScreenSharesChange([]);
    this.events = null;
  }

  async setMuted(muted: boolean): Promise<void> {
    this.userMuted = muted;
    await this.updateMicrophone();
  }

  async setPushToTalk(open: boolean | null): Promise<void> {
    this.pushToTalk = open;
    await this.updateMicrophone();
  }

  /** Aplica (em fila) o estado do microfone: mudo vence; no apertar para falar, só abre com a tecla. */
  private updateMicrophone(): Promise<void> {
    const run = this.micQueue.then(() => this.applyMicrophoneState());
    this.micQueue = run.catch(() => undefined);
    return run;
  }

  private async applyMicrophoneState(): Promise<void> {
    const room = this.room;
    if (!room) return;
    const local = room.localParticipant;
    if (this.userMuted) {
      await local.setMicrophoneEnabled(false);
      return;
    }
    const open = this.pushToTalk !== false;
    const microphone = this.microphone();
    if (microphone) {
      // trilha já existe: abrir e fechar é só ligar/desligar o envio (rápido, sem pedir o dispositivo de novo)
      if (open && microphone.isMuted) await microphone.unmute();
      else if (!open && !microphone.isMuted) await microphone.mute();
      return;
    }
    if (open) {
      await local.setMicrophoneEnabled(true);
      await this.applyMicrophoneVolume(); // o microfone nasceu agora
      return;
    }
    // apertar para falar com a tecla solta: prepara o microfone já fechado, para a 1ª fala não demorar
    const [track] = await local.createTracks({ audio: captureOptions(this.voice) });
    if (!track || this.room !== room) {
      track?.stop();
      return;
    }
    await track.mute();
    await local.publishTrack(track, { source: Track.Source.Microphone });
    await this.applyMicrophoneVolume();
    if (this.pushToTalk !== false && !this.userMuted) await track.unmute(); // apertou enquanto preparava
  }

  setDeafened(deafened: boolean): void {
    this.deafened = deafened;
    for (const element of this.audioElements) element.muted = deafened;
  }

  /**
   * Captura e publica separadamente vídeo e áudio: se o áudio do sistema falhar,
   * a tela continua no ar (o `setScreenShareEnabled` do LiveKit derrubaria tudo junto).
   */
  async startScreenShare(options: ScreenShareOptions): Promise<ScreenShareResult> {
    const room = this.room;
    if (!room) throw new Error("Entre num canal de voz para compartilhar a tela.");
    const profile = SCREEN_SHARE_PROFILES[options.quality];
    // App instalado: o som vem da captura nativa (sem as vozes da sala); o seletor fica só com a imagem.
    const nativeAudio = options.systemAudio && this.info.systemAudio === "native";
    const pickerAudio = options.systemAudio && !nativeAudio ? "picker" : "none";
    // Nada de await antes daqui: o seletor do sistema exige o clique recente da pessoa.
    const stream = await navigator.mediaDevices.getDisplayMedia(displayMediaOptions(options, { audio: pickerAudio, excludeOwnAudio: canExcludeOwnAudio() }));
    const stopAll = () => stream.getTracks().forEach((track) => track.stop());
    const [video] = stream.getVideoTracks();
    if (!video) {
      stopAll();
      throw new DOMException("O sistema não entregou o vídeo da tela.", "NotReadableError");
    }
    if (this.room !== room) {
      stopAll(); // saiu da voz enquanto o seletor estava aberto
      throw new Error("Você saiu do canal de voz antes de escolher a tela.");
    }
    video.contentHint = profile.contentHint;
    try {
      await room.localParticipant.publishTrack(video, {
        source: Track.Source.ScreenShare,
        screenShareEncoding: { maxBitrate: profile.maxBitrate, maxFramerate: profile.frameRate },
        degradationPreference: profile.contentHint === "motion" ? "maintain-framerate" : "maintain-resolution",
      });
    } catch (error) {
      stopAll();
      throw error;
    }
    // "Parar de compartilhar" do sistema encerra o vídeo: o LiveKit despublica a tela; o som vai junto.
    video.addEventListener("ended", () => void this.unpublishScreenAudio(), { once: true });

    let audio: ScreenShareResult["audio"] = "none";
    let ownAudioExcluded = false;
    let sound: MediaStreamTrack | undefined;
    if (nativeAudio) {
      try {
        this.systemAudio = await this.platform.captureSystemAudio();
        sound = this.systemAudio.track;
        ownAudioExcluded = true; // o Rust exclui a árvore de processos do Aurora
      } catch (error) {
        audio = "failed";
        console.warn("[aurora] a tela foi, mas o som do computador não", error);
      }
    } else {
      sound = stream.getAudioTracks()[0];
      // O que vale é o que o navegador aplicou de fato, não o que pedimos.
      ownAudioExcluded = (sound?.getSettings() as { restrictOwnAudio?: boolean } | undefined)?.restrictOwnAudio === true;
    }
    if (sound) {
      try {
        await room.localParticipant.publishTrack(sound, {
          source: Track.Source.ScreenShareAudio,
          audioPreset: AudioPresets.musicHighQualityStereo,
          forceStereo: true,
          dtx: false,
        });
        audio = "shared";
      } catch (error) {
        await this.stopSystemAudio();
        sound.stop();
        audio = "failed";
        console.warn("[aurora] a tela foi, mas o som do computador não", error);
      }
    }
    this.emitShares();
    return { audio, ownAudioExcluded };
  }

  private async unpublishScreenAudio(): Promise<void> {
    const track = this.room?.localParticipant.getTrackPublication(Track.Source.ScreenShareAudio)?.track;
    if (track) await this.room?.localParticipant.unpublishTrack(track);
    await this.stopSystemAudio();
  }

  private async stopSystemAudio(): Promise<void> {
    const capture = this.systemAudio;
    this.systemAudio = null;
    await capture?.stop();
  }

  async stopScreenShare(): Promise<void> {
    await this.room?.localParticipant.setScreenShareEnabled(false);
    await this.stopSystemAudio();
    this.emitShares();
  }

  private emitShares(): void {
    const room = this.room;
    if (!room || !this.events) return;
    const shares: ScreenShare[] = [];
    const local = room.localParticipant.getTrackPublication(Track.Source.ScreenShare)?.track;
    if (local) shares.push(shareOf(room.localParticipant.identity, true, local));
    for (const [identity, track] of this.remoteShares) shares.push(shareOf(identity, false, track));
    this.events.onScreenSharesChange(shares);
  }

  private attachAudio(track: RemoteTrack): void {
    const element = track.attach();
    element.muted = this.deafened;
    element.volume = this.voice.outputVolume / 100;
    element.hidden = true;
    element.dataset.auroraVoice = "remote-audio";
    document.body.appendChild(element);
    this.audioElements.add(element);
  }

  private detachAudio(track: RemoteTrack): void {
    for (const element of track.detach()) {
      element.remove();
      this.audioElements.delete(element);
    }
  }
}
