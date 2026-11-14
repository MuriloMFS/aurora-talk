//! Motor de voz nativo do Linux (ADR-003, docs/13-linux.md, spike em docs/spikes/voz-nativa-linux.md).
//!
//! O WebKitGTK não tem WebRTC, então a voz não pode rodar dentro da interface como no Windows. Aqui o
//! SDK de Rust do LiveKit entra na sala com o próprio WebRTC, e o módulo de áudio dele (PulseAudio ou
//! ALSA) captura o microfone e toca o som dos outros, como o Chrome faz. Assim o cancelamento de eco
//! enxerga o que está tocando. A interface fala com isto pelo `NativeMediaEngine` (TypeScript).

use std::collections::HashSet;
use std::sync::Arc;

use livekit::options::TrackPublishOptions;
use livekit::prelude::*;
use livekit::webrtc::peer_connection_factory::IceServer;
use livekit::{AudioProcessingOptions, PlatformAudio, PlayoutDeviceId, RecordingDeviceId};
use serde::{Deserialize, Serialize};
use tauri::ipc::Channel;
use tauri::State;
use tokio::sync::Mutex;

/// Escolhas de voz que valem no motor nativo (mesmos nomes do `VoiceSettings` da interface).
#[derive(Deserialize, Clone)]
#[serde(rename_all = "camelCase")]
pub struct VoiceIn {
    input_device_id: String,
    output_device_id: String,
    echo_cancellation: bool,
    noise_suppression: bool,
    auto_gain_control: bool,
}

#[derive(Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct IceIn {
    urls: Vec<String>,
    username: Option<String>,
    credential: Option<String>,
}

#[derive(Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct JoinIn {
    muted: bool,
    deafened: bool,
    /// None = detecção de voz; Some(aberto) = apertar para falar.
    push_to_talk: Option<bool>,
    voice: VoiceIn,
}

/// O que a interface recebe enquanto está na sala.
#[derive(Serialize, Clone)]
#[serde(tag = "type", rename_all = "camelCase")]
pub enum MediaEvent {
    State { state: &'static str },
    Speaking { identities: Vec<String> },
}

#[derive(Serialize)]
pub struct DeviceOut {
    id: String,
    label: String,
}

#[derive(Serialize)]
pub struct DevicesOut {
    inputs: Vec<DeviceOut>,
    outputs: Vec<DeviceOut>,
}

struct Session {
    room: Arc<Room>,
    audio: PlatformAudio,
    microphone: LocalAudioTrack,
    user_muted: bool,
    push_to_talk: Option<bool>,
    deafened: Arc<std::sync::atomic::AtomicBool>,
    /// Saída escolhida (None = a padrão do sistema). Reaplicada quando chega áudio: o WebRTC só abre a
    /// saída nessa hora e volta para a padrão (medido no Kali: a escolha feita antes de entrar se perdia).
    output: Arc<std::sync::Mutex<Option<String>>>,
    events: tokio::task::JoinHandle<()>,
}

impl Session {
    /// Mudo vence a tecla; no apertar para falar, só abre com a tecla.
    fn apply_microphone(&self) {
        if self.user_muted || self.push_to_talk == Some(false) {
            self.microphone.mute();
        } else {
            self.microphone.unmute();
        }
    }
}

#[derive(Default)]
pub struct NativeMedia(Mutex<Option<Session>>);

fn processing(voice: &VoiceIn) -> AudioProcessingOptions {
    AudioProcessingOptions {
        echo_cancellation: voice.echo_cancellation,
        noise_suppression: voice.noise_suppression,
        auto_gain_control: voice.auto_gain_control,
        ..Default::default()
    }
}

/// A saída escolhida, se ela existir na lista agora.
fn chosen_output(audio: &PlatformAudio, voice: &VoiceIn) -> Option<String> {
    (voice.output_device_id != "default" && audio.playout_devices().any(|d| d.id.as_str() == voice.output_device_id)).then(|| voice.output_device_id.clone())
}

fn apply_output(audio: &PlatformAudio, output: &Option<String>) {
    if let Some(id) = output {
        let _ = audio.switch_playout_device(&PlayoutDeviceId::from_unchecked_guid(id));
    }
}

/// "default" = o padrão do sistema; outro id = o dispositivo escolhido nas configurações.
fn select_devices(audio: &PlatformAudio, voice: &VoiceIn, switching: bool) -> Result<(), String> {
    if voice.input_device_id != "default" && audio.recording_devices().any(|d| d.id.as_str() == voice.input_device_id) {
        let id = RecordingDeviceId::from_unchecked_guid(&voice.input_device_id);
        if switching { audio.switch_recording_device(&id) } else { audio.set_recording_device(&id) }.map_err(|e| e.to_string())?;
    }
    if voice.output_device_id != "default" && audio.playout_devices().any(|d| d.id.as_str() == voice.output_device_id) {
        let id = PlayoutDeviceId::from_unchecked_guid(&voice.output_device_id);
        if switching { audio.switch_playout_device(&id) } else { audio.set_playout_device(&id) }.map_err(|e| e.to_string())?;
    }
    Ok(())
}

fn set_remote_audio_enabled(room: &Room, enabled: bool) {
    for participant in room.remote_participants().values() {
        for publication in participant.track_publications().values() {
            if let Some(RemoteTrack::Audio(track)) = publication.track() {
                track.rtc_track().set_enabled(enabled);
            }
        }
    }
}

/// Microfones e saídas que o sistema oferece (para as configurações de voz).
#[tauri::command]
pub fn native_media_devices() -> Result<DevicesOut, String> {
    let audio = PlatformAudio::new().map_err(|e| e.to_string())?;
    let inputs = audio.recording_devices().map(|d| DeviceOut { id: d.id.as_str().to_string(), label: d.name.clone() }).collect();
    let outputs = audio.playout_devices().map(|d| DeviceOut { id: d.id.as_str().to_string(), label: d.name.clone() }).collect();
    Ok(DevicesOut { inputs, outputs })
}

/// Entra na sala do LiveKit com a credencial que o servidor do Aurora deu (`/voice`).
#[tauri::command]
pub async fn native_media_join(
    state: State<'_, NativeMedia>,
    url: String,
    token: String,
    ice_servers: Vec<IceIn>,
    options: JoinIn,
    on_event: Channel<MediaEvent>,
) -> Result<(), String> {
    let mut slot = state.0.lock().await;
    if let Some(old) = slot.take() {
        old.events.abort();
        let _ = old.room.close().await;
    }
    let audio = PlatformAudio::new().map_err(|e| format!("Não foi possível abrir o áudio do sistema: {e}"))?;
    select_devices(&audio, &options.voice, false)?;
    let _ = audio.configure_audio_processing(processing(&options.voice));

    let mut room_options = RoomOptions::default();
    if !ice_servers.is_empty() {
        // a configuração não pode ser montada de fora (non_exhaustive): só troca a lista de servidores
        room_options.rtc_config.ice_servers = ice_servers
            .into_iter()
            .map(|s| IceServer { urls: s.urls, username: s.username.unwrap_or_default(), password: s.credential.unwrap_or_default() })
            .collect();
    }
    let _ = on_event.send(MediaEvent::State { state: "connecting" });
    let (room, mut events) = Room::connect(&url, &token, room_options).await.map_err(|e| e.to_string())?;
    let room = Arc::new(room);

    let microphone = LocalAudioTrack::create_audio_track("microphone", audio.rtc_source());
    let publish = TrackPublishOptions { source: TrackSource::Microphone, ..Default::default() };
    if let Err(error) = room.local_participant().publish_track(LocalTrack::Audio(microphone.clone()), publish).await {
        let _ = room.close().await;
        return Err(error.to_string());
    }

    let deafened = Arc::new(std::sync::atomic::AtomicBool::new(options.deafened));
    let events_room = Arc::clone(&room);
    let events_deafened = Arc::clone(&deafened);
    let output = Arc::new(std::sync::Mutex::new(chosen_output(&audio, &options.voice)));
    let events_output = Arc::clone(&output);
    let events_audio = audio.clone();
    let events_channel = on_event.clone();
    let events = tokio::spawn(async move {
        let mut last: HashSet<String> = HashSet::new();
        while let Some(event) = events.recv().await {
            match event {
                RoomEvent::ActiveSpeakersChanged { speakers } => {
                    let now: HashSet<String> = speakers.iter().map(|p| p.identity().to_string()).collect();
                    if now != last {
                        let _ = events_channel.send(MediaEvent::Speaking { identities: now.iter().cloned().collect() });
                        last = now;
                    }
                }
                // quem entra enquanto estou ensurdecido também fica mudo para mim
                RoomEvent::TrackSubscribed { track: RemoteTrack::Audio(track), .. } => {
                    if events_deafened.load(std::sync::atomic::Ordering::SeqCst) {
                        track.rtc_track().set_enabled(false);
                    }
                    if let Ok(output) = events_output.lock() {
                        apply_output(&events_audio, &output);
                    }
                }
                RoomEvent::Reconnecting => {
                    let _ = events_channel.send(MediaEvent::State { state: "reconnecting" });
                }
                RoomEvent::Reconnected => {
                    let _ = events_channel.send(MediaEvent::State { state: "connected" });
                }
                RoomEvent::Disconnected { .. } => {
                    let _ = events_channel.send(MediaEvent::State { state: "disconnected" });
                    break;
                }
                _ => {}
            }
        }
        drop(events_room);
    });

    let session = Session { room, audio, microphone, user_muted: options.muted || options.deafened, push_to_talk: options.push_to_talk, deafened, output, events };
    session.apply_microphone();
    if options.deafened {
        set_remote_audio_enabled(&session.room, false);
    }
    *slot = Some(session);
    let _ = on_event.send(MediaEvent::State { state: "connected" });
    Ok(())
}

#[tauri::command]
pub async fn native_media_leave(state: State<'_, NativeMedia>) -> Result<(), String> {
    if let Some(session) = state.0.lock().await.take() {
        session.events.abort();
        let _ = session.room.close().await;
        drop(session.audio);
    }
    Ok(())
}

#[tauri::command]
pub async fn native_media_set_muted(state: State<'_, NativeMedia>, muted: bool) -> Result<(), String> {
    if let Some(session) = state.0.lock().await.as_mut() {
        session.user_muted = muted;
        session.apply_microphone();
    }
    Ok(())
}

#[tauri::command]
pub async fn native_media_set_push_to_talk(state: State<'_, NativeMedia>, open: Option<bool>) -> Result<(), String> {
    if let Some(session) = state.0.lock().await.as_mut() {
        session.push_to_talk = open;
        session.apply_microphone();
    }
    Ok(())
}

#[tauri::command]
pub async fn native_media_set_deafened(state: State<'_, NativeMedia>, deafened: bool) -> Result<(), String> {
    if let Some(session) = state.0.lock().await.as_ref() {
        session.deafened.store(deafened, std::sync::atomic::Ordering::SeqCst);
        set_remote_audio_enabled(&session.room, !deafened);
    }
    Ok(())
}

/// Troca microfone, saída ou processamento no meio da chamada.
#[tauri::command]
pub async fn native_media_apply_settings(state: State<'_, NativeMedia>, voice: VoiceIn) -> Result<(), String> {
    if let Some(session) = state.0.lock().await.as_ref() {
        select_devices(&session.audio, &voice, true)?;
        if let Ok(mut output) = session.output.lock() {
            *output = chosen_output(&session.audio, &voice);
        }
        session.audio.configure_audio_processing(processing(&voice)).map_err(|e| e.to_string())?;
    }
    Ok(())
}
