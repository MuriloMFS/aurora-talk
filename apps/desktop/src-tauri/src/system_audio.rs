//! Som do sistema para a transmissão de tela, SEM o próprio Aurora (sem eco).
//!
//! Por que nativo (regra 3: "captura"): no WebView2, a captura de áudio do sistema via getDisplayMedia
//! falha com saídas multicanal (ex.: headset 7.1: "Could not start audio source") e o modo
//! `restrictOwnAudio` entrega silêncio. O Windows (10 2004+) tem o loopback POR PROCESSO: captura tudo o
//! que toca no PC exceto um processo e seus FILHOS DIRETOS (medido: netos não são excluídos).
//! As vozes da sala tocam no serviço de áudio do WebView2, filho direto do processo navegador
//! do WebView2 (que é filho do aurora.exe) — então o alvo da exclusão é o navegador do WebView2.
//!
//! Formato entregue à UI: PCM float 32, 48 kHz, estéreo intercalado, em blocos de ~20 ms por um
//! `Channel` do Tauri (bytes crus). A UI vira isso numa trilha WebRTC (MediaStreamTrackGenerator).

use std::sync::atomic::{AtomicBool, Ordering};
use std::sync::{mpsc, Arc, Mutex};
use std::thread::JoinHandle;
use std::time::Duration;

use tauri::ipc::{Channel, InvokeResponseBody};
use tauri::State;

pub const SAMPLE_RATE: u32 = 48_000;
pub const CHANNELS: u16 = 2;
const BYTES_PER_FRAME: usize = CHANNELS as usize * 4;
/// ~20 ms por mensagem: 50 mensagens/s, ~7,7 KB cada.
const CHUNK_BYTES: usize = (SAMPLE_RATE as usize / 50) * BYTES_PER_FRAME;

/// Junta pacotes do Windows (tamanhos variados) e libera blocos de pelo menos `min` bytes.
fn take_chunk(pending: &mut Vec<u8>, min: usize) -> Option<Vec<u8>> {
    (pending.len() >= min).then(|| std::mem::take(pending))
}

struct Running {
    stop: Arc<AtomicBool>,
    thread: JoinHandle<()>,
}

/// Captura em andamento (no máximo uma).
#[derive(Default)]
pub struct SystemAudio(Mutex<Option<Running>>);

impl SystemAudio {
    fn stop_current(&self) {
        let running = self.0.lock().ok().and_then(|mut guard| guard.take());
        if let Some(running) = running {
            running.stop.store(true, Ordering::Relaxed);
            let _ = running.thread.join();
        }
    }
}

/// Começa a capturar o som do sistema (menos o Aurora) e envia os blocos por `on_data`.
/// Só responde depois que o Windows aceitou a captura — erro aqui vira mensagem na UI.
#[tauri::command]
pub async fn system_audio_start(
    window: tauri::WebviewWindow,
    state: State<'_, SystemAudio>,
    on_data: Channel<InvokeResponseBody>,
) -> Result<(), String> {
    state.stop_current();
    // Quem tocar som "do Aurora" (vozes da sala) fica de fora: o navegador do WebView2 e seus filhos.
    let exclude_pid = tauri::async_runtime::spawn_blocking(move || webview_browser_pid(&window))
        .await
        .map_err(|e| e.to_string())?
        .ok_or("Não foi possível identificar o processo de áudio do Aurora para tirar o eco.")?;
    let stop = Arc::new(AtomicBool::new(false));
    let (ready_tx, ready_rx) = mpsc::channel::<Result<(), String>>();
    let thread = {
        let stop = stop.clone();
        std::thread::Builder::new()
            .name("aurora-system-audio".into())
            .spawn(move || capture::run(exclude_pid, on_data, stop, ready_tx))
            .map_err(|e| e.to_string())?
    };
    let ready = tauri::async_runtime::spawn_blocking(move || ready_rx.recv_timeout(Duration::from_secs(5)))
        .await
        .map_err(|e| e.to_string())?;
    match ready {
        Ok(Ok(())) => {
            *state.0.lock().map_err(|e| e.to_string())? = Some(Running { stop, thread });
            Ok(())
        }
        Ok(Err(message)) => Err(message),
        Err(_) => {
            stop.store(true, Ordering::Relaxed);
            Err("O Windows não respondeu ao pedido de captura do som.".into())
        }
    }
}

#[tauri::command]
pub fn system_audio_stop(state: State<'_, SystemAudio>) {
    state.stop_current();
}

/// PID do processo navegador do WebView2 desta janela (pai do serviço de áudio).
#[cfg(windows)]
fn webview_browser_pid(window: &tauri::WebviewWindow) -> Option<u32> {
    let (tx, rx) = mpsc::channel();
    window
        .with_webview(move |webview| {
            let pid = unsafe { webview.controller().CoreWebView2() }.ok().and_then(|core| {
                let mut pid = 0u32;
                unsafe { core.BrowserProcessId(&mut pid) }.ok().map(|_| pid)
            });
            let _ = tx.send(pid);
        })
        .ok()?;
    rx.recv_timeout(Duration::from_secs(2)).ok().flatten().filter(|pid| *pid != 0)
}

#[cfg(not(windows))]
fn webview_browser_pid(_window: &tauri::WebviewWindow) -> Option<u32> {
    Some(std::process::id())
}

#[cfg(windows)]
mod capture {
    use std::sync::atomic::{AtomicBool, Ordering};
    use std::sync::{mpsc, Arc};
    use std::time::Duration;

    use tauri::ipc::{Channel, InvokeResponseBody};
    use windows::core::{implement, Interface, IUnknown, HRESULT};
    use windows::Win32::Foundation::{CloseHandle, HANDLE};
    use windows::Win32::Media::Audio::{
        ActivateAudioInterfaceAsync, IActivateAudioInterfaceAsyncOperation, IActivateAudioInterfaceCompletionHandler,
        IActivateAudioInterfaceCompletionHandler_Impl, IAudioCaptureClient, IAudioClient, AUDCLNT_BUFFERFLAGS_SILENT,
        AUDCLNT_SHAREMODE_SHARED, AUDCLNT_STREAMFLAGS_AUTOCONVERTPCM, AUDCLNT_STREAMFLAGS_EVENTCALLBACK,
        AUDCLNT_STREAMFLAGS_LOOPBACK, AUDIOCLIENT_ACTIVATION_PARAMS, AUDIOCLIENT_ACTIVATION_PARAMS_0,
        AUDIOCLIENT_ACTIVATION_TYPE_PROCESS_LOOPBACK, AUDIOCLIENT_PROCESS_LOOPBACK_PARAMS,
        PROCESS_LOOPBACK_MODE_EXCLUDE_TARGET_PROCESS_TREE, VIRTUAL_AUDIO_DEVICE_PROCESS_LOOPBACK, WAVEFORMATEX,
    };
    use windows::Win32::System::Com::StructuredStorage::PROPVARIANT;
    use windows::Win32::System::Com::{CoInitializeEx, CoUninitialize, BLOB, COINIT_MULTITHREADED};
    use windows::Win32::System::Threading::{CreateEventW, WaitForSingleObject};
    use windows::Win32::System::Variant::VT_BLOB;

    use super::{take_chunk, BYTES_PER_FRAME, CHANNELS, CHUNK_BYTES, SAMPLE_RATE};

    const WAVE_FORMAT_IEEE_FLOAT: u16 = 3;
    /// Buffer pedido ao Windows: 20 ms (unidades de 100 ns).
    const BUFFER_100NS: i64 = 200_000;

    #[implement(IActivateAudioInterfaceCompletionHandler)]
    struct Activated(mpsc::Sender<()>);

    impl IActivateAudioInterfaceCompletionHandler_Impl for Activated_Impl {
        fn ActivateCompleted(&self, _operation: windows::core::Ref<IActivateAudioInterfaceAsyncOperation>) -> windows::core::Result<()> {
            let _ = self.0.send(());
            Ok(())
        }
    }

    struct Session {
        client: IAudioClient,
        capture: IAudioCaptureClient,
        event: HANDLE,
    }

    impl Drop for Session {
        fn drop(&mut self) {
            unsafe {
                let _ = self.client.Stop();
                let _ = CloseHandle(self.event);
            }
        }
    }

    /// Ativa o loopback do sistema excluindo `exclude_pid` e seus filhos diretos.
    fn open(exclude_pid: u32) -> Result<Session, String> {
        let params = AUDIOCLIENT_ACTIVATION_PARAMS {
            ActivationType: AUDIOCLIENT_ACTIVATION_TYPE_PROCESS_LOOPBACK,
            Anonymous: AUDIOCLIENT_ACTIVATION_PARAMS_0 {
                ProcessLoopbackParams: AUDIOCLIENT_PROCESS_LOOPBACK_PARAMS {
                    TargetProcessId: exclude_pid,
                    ProcessLoopbackMode: PROCESS_LOOPBACK_MODE_EXCLUDE_TARGET_PROCESS_TREE,
                },
            },
        };
        // PROPVARIANT do tipo BLOB apontando para `params` (que vive até o fim desta função).
        let mut variant = std::mem::ManuallyDrop::new(PROPVARIANT::default());
        unsafe {
            let inner = &mut variant.Anonymous.Anonymous;
            inner.vt = VT_BLOB;
            inner.Anonymous.blob = BLOB {
                cbSize: std::mem::size_of::<AUDIOCLIENT_ACTIVATION_PARAMS>() as u32,
                pBlobData: &params as *const _ as *mut u8,
            };
        }
        let (done_tx, done_rx) = mpsc::channel();
        let handler: IActivateAudioInterfaceCompletionHandler = Activated(done_tx).into();
        let operation = unsafe {
            ActivateAudioInterfaceAsync(VIRTUAL_AUDIO_DEVICE_PROCESS_LOOPBACK, &IAudioClient::IID, Some(&*variant as *const PROPVARIANT), &handler)
        }
        .map_err(|e| format!("Este Windows não permite capturar o som do sistema sem o Aurora ({e}). É preciso o Windows 10 versão 2004 ou mais novo."))?;
        done_rx
            .recv_timeout(Duration::from_secs(5))
            .map_err(|_| "O Windows não respondeu ao pedido de captura do som.".to_string())?;
        let mut result = HRESULT(0);
        let mut activated: Option<IUnknown> = None;
        unsafe { operation.GetActivateResult(&mut result, &mut activated) }.map_err(|e| e.to_string())?;
        result.ok().map_err(|e| format!("O Windows recusou a captura do som ({e})."))?;
        let client: IAudioClient = activated
            .ok_or("O Windows não entregou o cliente de áudio.")?
            .cast()
            .map_err(|e| e.to_string())?;

        let format = WAVEFORMATEX {
            wFormatTag: WAVE_FORMAT_IEEE_FLOAT,
            nChannels: CHANNELS,
            nSamplesPerSec: SAMPLE_RATE,
            nAvgBytesPerSec: SAMPLE_RATE * BYTES_PER_FRAME as u32,
            nBlockAlign: BYTES_PER_FRAME as u16,
            wBitsPerSample: 32,
            cbSize: 0,
        };
        unsafe {
            client.Initialize(
                AUDCLNT_SHAREMODE_SHARED,
                AUDCLNT_STREAMFLAGS_LOOPBACK | AUDCLNT_STREAMFLAGS_EVENTCALLBACK | AUDCLNT_STREAMFLAGS_AUTOCONVERTPCM,
                BUFFER_100NS,
                0,
                &format,
                None,
            )
        }
        .map_err(|e| format!("Não foi possível preparar a captura do som ({e})."))?;
        let event = unsafe { CreateEventW(None, false, false, None) }.map_err(|e| e.to_string())?;
        let session = (|| -> windows::core::Result<Session> {
            unsafe { client.SetEventHandle(event)? };
            let capture: IAudioCaptureClient = unsafe { client.GetService()? };
            unsafe { client.Start()? };
            Ok(Session { client: client.clone(), capture, event })
        })();
        session.map_err(|e| {
            unsafe {
                let _ = CloseHandle(event);
            }
            format!("Não foi possível iniciar a captura do som ({e}).")
        })
    }

    /// Lê tudo o que o Windows tem pronto e acrescenta em `pending` (silêncio vira zeros).
    fn drain(capture: &IAudioCaptureClient, pending: &mut Vec<u8>) -> windows::core::Result<()> {
        loop {
            if unsafe { capture.GetNextPacketSize()? } == 0 {
                return Ok(());
            }
            let mut data = std::ptr::null_mut();
            let mut frames = 0u32;
            let mut flags = 0u32;
            unsafe { capture.GetBuffer(&mut data, &mut frames, &mut flags, None, None)? };
            let bytes = frames as usize * BYTES_PER_FRAME;
            if flags & AUDCLNT_BUFFERFLAGS_SILENT.0 as u32 != 0 || data.is_null() {
                pending.resize(pending.len() + bytes, 0);
            } else {
                pending.extend_from_slice(unsafe { std::slice::from_raw_parts(data, bytes) });
            }
            unsafe { capture.ReleaseBuffer(frames)? };
        }
    }

    pub fn run(exclude_pid: u32, channel: Channel<InvokeResponseBody>, stop: Arc<AtomicBool>, ready: mpsc::Sender<Result<(), String>>) {
        if unsafe { CoInitializeEx(None, COINIT_MULTITHREADED) }.is_err() {
            let _ = ready.send(Err("Não foi possível preparar o áudio do Windows.".into()));
            return;
        }
        match open(exclude_pid) {
            Err(message) => {
                let _ = ready.send(Err(message));
            }
            Ok(session) => {
                let _ = ready.send(Ok(()));
                let mut pending = Vec::with_capacity(CHUNK_BYTES * 2);
                while !stop.load(Ordering::Relaxed) {
                    unsafe { WaitForSingleObject(session.event, 100) };
                    if drain(&session.capture, &mut pending).is_err() {
                        break; // dispositivo sumiu etc.: a UI segue com a tela, sem som
                    }
                    if let Some(chunk) = take_chunk(&mut pending, CHUNK_BYTES) {
                        if channel.send(InvokeResponseBody::Raw(chunk)).is_err() {
                            break; // a tela fechou o canal
                        }
                    }
                }
                drop(session);
            }
        }
        unsafe { CoUninitialize() };
    }
}

#[cfg(not(windows))]
mod capture {
    use std::sync::atomic::AtomicBool;
    use std::sync::{mpsc, Arc};
    use tauri::ipc::{Channel, InvokeResponseBody};

    pub fn run(_exclude_pid: u32, _channel: Channel<InvokeResponseBody>, _stop: Arc<AtomicBool>, ready: mpsc::Sender<Result<(), String>>) {
        let _ = ready.send(Err("A captura do som do sistema só existe no Windows por enquanto.".into()));
    }
}

#[cfg(test)]
mod tests {
    use super::{take_chunk, CHUNK_BYTES};

    #[test]
    fn junta_pacotes_ate_fechar_um_bloco() {
        let mut pending = vec![0u8; CHUNK_BYTES - 8];
        assert!(take_chunk(&mut pending, CHUNK_BYTES).is_none());
        pending.extend_from_slice(&[1u8; 16]);
        let chunk = take_chunk(&mut pending, CHUNK_BYTES).expect("bloco completo");
        assert_eq!(chunk.len(), CHUNK_BYTES + 8);
        assert!(pending.is_empty());
    }

    #[test]
    fn bloco_de_20_ms_em_48_khz_estereo_float() {
        assert_eq!(CHUNK_BYTES, 960 * 2 * 4);
    }
}
