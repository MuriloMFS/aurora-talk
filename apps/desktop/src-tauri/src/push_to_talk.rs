//! Apertar para falar global: com o Aurora em segundo plano ou um jogo na frente.
//!
//! Consulta SÓ a tecla escolhida (`GetAsyncKeyState`) a cada poucos milissegundos, e só enquanto a
//! interface pede (a pessoa está numa sala de voz no modo "apertar para falar"). Não instala gancho
//! global de teclado: o app nunca vê as outras teclas digitadas.

use std::sync::atomic::{AtomicU64, Ordering};
use std::sync::Arc;
use std::time::Duration;

use tauri::ipc::Channel;
use tauri::State;

/// Intervalo da consulta: atraso médio de ~4 ms entre apertar e o app perceber.
const POLL_INTERVAL: Duration = Duration::from_millis(8);

/// Geração da consulta em andamento: começar outra ou parar invalida a anterior.
#[derive(Default)]
pub struct PushToTalk(Arc<AtomicU64>);

/// Códigos virtuais aceitos: botão do meio e laterais do mouse (0x04–0x06) e teclas (0x08–0xFE).
/// Clique esquerdo e direito (0x01, 0x02) ficam de fora: abririam o microfone a cada clique.
pub fn valid_key(vk: u16) -> bool {
    (0x04..=0x06).contains(&vk) || (0x08..=0xFE).contains(&vk)
}

#[cfg(windows)]
fn is_down(vk: u16) -> bool {
    use windows::Win32::UI::Input::KeyboardAndMouse::GetAsyncKeyState;
    // SAFETY: só lê o estado de uma tecla; bit mais alto = apertada agora.
    (unsafe { GetAsyncKeyState(i32::from(vk)) } as u16) & 0x8000 != 0
}

#[cfg(not(windows))]
fn is_down(_vk: u16) -> bool {
    false
}

/// Começa a observar a tecla `vk`; avisa em `on_change` cada vez que ela desce (true) ou sobe (false).
#[tauri::command]
pub fn ptt_watch(state: State<'_, PushToTalk>, vk: u16, on_change: Channel<bool>) -> Result<(), String> {
    if !valid_key(vk) {
        return Err("Essa tecla não pode ser usada para apertar para falar. Escolha outra.".into());
    }
    let generation = state.0.fetch_add(1, Ordering::SeqCst) + 1;
    let current = Arc::clone(&state.0);
    std::thread::Builder::new()
        .name("aurora-ptt".into())
        .spawn(move || {
            let mut pressed = false;
            while current.load(Ordering::SeqCst) == generation {
                let now = is_down(vk);
                if now != pressed {
                    pressed = now;
                    if on_change.send(now).is_err() {
                        break; // a tela fechou o canal
                    }
                }
                std::thread::sleep(POLL_INTERVAL);
            }
        })
        .map_err(|e| e.to_string())?;
    Ok(())
}

/// Para de observar (saiu da sala, trocou de modo ou de tecla).
#[tauri::command]
pub fn ptt_stop(state: State<'_, PushToTalk>) {
    state.0.fetch_add(1, Ordering::SeqCst);
}

#[cfg(test)]
mod tests {
    use super::valid_key;

    /// Medição (rodar à mão: `cargo test --lib medir_latencia -- --ignored --nocapture`).
    /// Simula F24 (tecla que não existe nos teclados comuns) e mede quanto a consulta leva para ver
    /// a tecla descer, no mesmo laço e intervalo do app.
    #[cfg(windows)]
    #[test]
    #[ignore]
    fn medir_latencia() {
        use std::time::Instant;
        use windows::Win32::UI::Input::KeyboardAndMouse::{SendInput, INPUT, INPUT_0, INPUT_KEYBOARD, KEYBDINPUT, KEYEVENTF_KEYUP, VK_F24};
        let send = |up: bool| {
            let input = INPUT {
                r#type: INPUT_KEYBOARD,
                Anonymous: INPUT_0 { ki: KEYBDINPUT { wVk: VK_F24, dwFlags: if up { KEYEVENTF_KEYUP } else { Default::default() }, ..Default::default() } },
            };
            unsafe { SendInput(&[input], std::mem::size_of::<INPUT>() as i32) };
        };
        // o mesmo laço do app numa thread; esta thread aperta em momentos que não batem com ele
        let detected = std::sync::Arc::new(std::sync::Mutex::new(Vec::<Instant>::new()));
        let stop = std::sync::Arc::new(std::sync::atomic::AtomicBool::new(false));
        let watcher = {
            let (detected, stop) = (detected.clone(), stop.clone());
            std::thread::spawn(move || {
                let mut pressed = false;
                while !stop.load(std::sync::atomic::Ordering::SeqCst) {
                    let now = super::is_down(VK_F24.0);
                    if now != pressed {
                        pressed = now;
                        if now {
                            detected.lock().unwrap().push(Instant::now());
                        }
                    }
                    std::thread::sleep(super::POLL_INTERVAL);
                }
            })
        };
        let mut pressed_at = Vec::new();
        for i in 0..100u64 {
            std::thread::sleep(std::time::Duration::from_micros(30_000 + i * 1373 % 9000));
            pressed_at.push(Instant::now());
            send(false);
            std::thread::sleep(std::time::Duration::from_millis(40));
            send(true);
        }
        std::thread::sleep(std::time::Duration::from_millis(50));
        stop.store(true, std::sync::atomic::Ordering::SeqCst);
        watcher.join().unwrap();
        let detected = detected.lock().unwrap();
        assert_eq!(detected.len(), pressed_at.len(), "perdeu apertos");
        let mut samples: Vec<f64> = pressed_at.iter().zip(detected.iter()).map(|(p, d)| d.duration_since(*p).as_secs_f64() * 1000.0).collect();
        samples.sort_by(|a, b| a.partial_cmp(b).unwrap());
        let avg = samples.iter().sum::<f64>() / samples.len() as f64;
        println!("deteccao (ms): media {avg:.1} · p50 {:.1} · p95 {:.1} · max {:.1}", samples[50], samples[95], samples[99]);
    }

    #[test]
    fn so_aceita_teclas_e_botoes_extras_do_mouse() {
        assert!(!valid_key(0x00));
        assert!(!valid_key(0x01)); // clique esquerdo
        assert!(!valid_key(0x02)); // clique direito
        assert!(!valid_key(0x03)); // cancel
        assert!(valid_key(0x04)); // botão do meio
        assert!(valid_key(0x05));
        assert!(valid_key(0x06));
        assert!(!valid_key(0x07));
        assert!(valid_key(0x56)); // V
        assert!(valid_key(0x87)); // F24
        assert!(!valid_key(0xFF));
        assert!(!valid_key(0x1234));
    }
}
