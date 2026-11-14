//! Teste de microfone no Linux (Configurações → Voz), sem entrar em sala.
//!
//! O módulo de áudio do WebRTC só captura com uma chamada de verdade, então o teste lê o mesmo microfone
//! direto do PulseAudio (também atende o PipeWire): o nome que o WebRTC mostra é a descrição da entrada
//! no PulseAudio, e "default: …" é a entrada padrão. Só mede o nível; nada é gravado nem enviado.

use std::cell::RefCell;
use std::rc::Rc;
use std::sync::atomic::{AtomicBool, Ordering};
use std::sync::Arc;

use libpulse_binding::context::{Context, FlagSet, State as ContextState};
use libpulse_binding::mainloop::standard::{IterateResult, Mainloop};
use libpulse_binding::sample::{Format, Spec};
use libpulse_binding::stream::Direction;
use libpulse_simple_binding::Simple;
use tauri::ipc::Channel;
use tauri::State;

#[derive(Default)]
pub struct MicTest(std::sync::Mutex<Option<Arc<AtomicBool>>>);

/// Nome da entrada do PulseAudio com esta descrição (None = a entrada padrão).
fn pulse_source_named(description: &str) -> Option<String> {
    if description.starts_with("default:") {
        return None;
    }
    let mut mainloop = Mainloop::new()?;
    let mut context = Context::new(&mainloop, "Aurora")?;
    context.connect(None, FlagSet::NOFLAGS, None).ok()?;
    loop {
        if let IterateResult::Quit(_) | IterateResult::Err(_) = mainloop.iterate(true) {
            return None;
        }
        match context.get_state() {
            ContextState::Ready => break,
            ContextState::Failed | ContextState::Terminated => return None,
            _ => {}
        }
    }
    let found: Rc<RefCell<Option<String>>> = Rc::new(RefCell::new(None));
    let done = Rc::new(RefCell::new(false));
    let (found_cb, done_cb, wanted) = (Rc::clone(&found), Rc::clone(&done), description.to_string());
    let _operation = context.introspect().get_source_info_list(move |result| match result {
        libpulse_binding::callbacks::ListResult::Item(info) => {
            let is_monitor = info.monitor_of_sink.is_some();
            if !is_monitor && info.description.as_deref() == Some(wanted.as_str()) {
                *found_cb.borrow_mut() = info.name.as_ref().map(|n| n.to_string());
            }
        }
        _ => *done_cb.borrow_mut() = true,
    });
    while !*done.borrow() {
        if let IterateResult::Quit(_) | IterateResult::Err(_) = mainloop.iterate(true) {
            break;
        }
    }
    context.disconnect();
    found.take()
}

/// Nível de 0 a 1 de um bloco (pico, com uma curva que deixa a fala no meio da barra).
pub fn level_of(samples: &[i16]) -> f32 {
    let peak = samples.iter().map(|s| (*s as i32).unsigned_abs()).max().unwrap_or(0) as f32 / 32768.0;
    peak.sqrt().min(1.0)
}

/// Começa a medir o microfone `device` (o nome que a lista mostra); manda o nível ~25 vezes por segundo.
#[tauri::command]
pub fn mic_test_start(state: State<'_, MicTest>, device: String, on_level: Channel<f32>) -> Result<(), String> {
    let stop = Arc::new(AtomicBool::new(false));
    if let Some(previous) = state.0.lock().map_err(|e| e.to_string())?.replace(Arc::clone(&stop)) {
        previous.store(true, Ordering::SeqCst);
    }
    let source = pulse_source_named(&device);
    let spec = Spec { format: Format::S16le, channels: 1, rate: 48_000 };
    let simple = Simple::new(None, "Aurora", Direction::Record, source.as_deref(), "Teste de microfone", &spec, None, None)
        .map_err(|_| "Não foi possível abrir o microfone. Confira se ele está conectado e tente de novo.".to_string())?;
    std::thread::Builder::new()
        .name("aurora-mic-test".into())
        .spawn(move || {
            let mut buffer = [0u8; 1920 * 2]; // 40 ms
            while !stop.load(Ordering::SeqCst) {
                if simple.read(&mut buffer).is_err() {
                    break;
                }
                let samples: Vec<i16> = buffer.chunks_exact(2).map(|b| i16::from_le_bytes([b[0], b[1]])).collect();
                if on_level.send(level_of(&samples)).is_err() {
                    break;
                }
            }
        })
        .map_err(|e| e.to_string())?;
    Ok(())
}

#[tauri::command]
pub fn mic_test_stop(state: State<'_, MicTest>) {
    if let Ok(mut slot) = state.0.lock() {
        if let Some(stop) = slot.take() {
            stop.store(true, Ordering::SeqCst);
        }
    }
}

#[cfg(test)]
mod tests {
    use super::level_of;

    #[test]
    fn nivel_vai_de_zero_a_um() {
        assert_eq!(level_of(&[0, 0, 0]), 0.0);
        assert_eq!(level_of(&[]), 0.0);
        assert!((level_of(&[i16::MIN]) - 1.0).abs() < 1e-6);
        let fala = level_of(&[0, 8192, -4096]); // pico de 25%: meio da barra
        assert!((fala - 0.5).abs() < 1e-3);
    }
}
