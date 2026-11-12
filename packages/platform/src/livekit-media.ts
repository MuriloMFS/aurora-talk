import { AudioPresets, ConnectionState, Room, RoomEvent, Track, type RemoteTrack } from "livekit-client";
import type { MediaEngine, MediaEngineEvents, PlatformInfo, PlatformPort, ScreenShare, SystemAudioCapture, VoiceConnectionState } from "./index";
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

  private readonly platform: PlatformPort;
  private readonly info: PlatformInfo;

  constructor(platform: PlatformPort, info: PlatformInfo) {
    this.platform = platform;
    this.info = info;
  }

  async join(credentials: { url: string; token: string }, events: MediaEngineEvents, options: { muted: boolean; deafened: boolean }): Promise<void> {
    await this.leave();
    const room = new Room({
      adaptiveStream: true,
      dynacast: true,
      // cancelamento de eco, supressão de ruído e ganho automático do próprio navegador
      audioCaptureDefaults: { echoCancellation: true, noiseSuppression: true, autoGainControl: true },
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
    await room.connect(credentials.url, credentials.token);
    await room.localParticipant.setMicrophoneEnabled(!options.muted && !options.deafened);
    events.onStateChange("connected");
  }

  async leave(): Promise<void> {
    const room = this.room;
    this.room = null;
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
    await this.room?.localParticipant.setMicrophoneEnabled(!muted);
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
