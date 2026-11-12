use std::sync::Mutex;

mod system_audio;

use serde::Serialize;
use tauri::{AppHandle, Emitter, Manager, State};
use tauri_plugin_updater::{Update, UpdaterExt};

/// Como o Discord (Electron) faz: o app concede microfone/câmera às PRÓPRIAS telas, sem a caixa de
/// permissão padrão do WebView2. Pedidos de qualquer outra origem continuam com o comportamento padrão.
#[cfg(windows)]
mod media_permissions {
    use webview2_com::Microsoft::Web::WebView2::Win32::{
        ICoreWebView2, ICoreWebView2PermissionRequestedEventArgs, COREWEBVIEW2_PERMISSION_KIND,
        COREWEBVIEW2_PERMISSION_KIND_CAMERA, COREWEBVIEW2_PERMISSION_KIND_MICROPHONE, COREWEBVIEW2_PERMISSION_STATE_ALLOW,
    };
    use webview2_com::{take_pwstr, PermissionRequestedEventHandler};
    use windows::core::PWSTR;

    /// Telas do app: produção (`tauri.localhost`) e desenvolvimento (Vite em `localhost:1420`).
    fn is_app_origin(uri: &str) -> bool {
        ["http://tauri.localhost/", "https://tauri.localhost/", "tauri://localhost/", "http://localhost:1420/"]
            .iter()
            .any(|origin| uri.starts_with(origin))
    }

    fn on_permission_requested(
        _sender: Option<ICoreWebView2>,
        args: Option<ICoreWebView2PermissionRequestedEventArgs>,
    ) -> windows::core::Result<()> {
        let Some(args) = args else { return Ok(()) };
        let mut kind = COREWEBVIEW2_PERMISSION_KIND::default();
        unsafe { args.PermissionKind(&mut kind)? };
        if kind != COREWEBVIEW2_PERMISSION_KIND_MICROPHONE && kind != COREWEBVIEW2_PERMISSION_KIND_CAMERA {
            return Ok(());
        }
        let mut uri = PWSTR::null();
        unsafe { args.Uri(&mut uri)? };
        if is_app_origin(&take_pwstr(uri)) {
            unsafe { args.SetState(COREWEBVIEW2_PERMISSION_STATE_ALLOW)? };
        }
        Ok(())
    }

    pub fn allow_for_app(window: &tauri::WebviewWindow) -> tauri::Result<()> {
        window.with_webview(|webview| {
            let Ok(core) = (unsafe { webview.controller().CoreWebView2() }) else { return };
            let handler = PermissionRequestedEventHandler::create(Box::new(on_permission_requested));
            let mut token = 0i64;
            let _ = unsafe { core.add_PermissionRequested(&handler, &mut token) };
        })
    }

    #[cfg(test)]
    mod tests {
        use super::is_app_origin;

        #[test]
        fn so_libera_as_telas_do_app() {
            assert!(is_app_origin("http://tauri.localhost/"));
            assert!(is_app_origin("http://localhost:1420/"));
            assert!(!is_app_origin("https://exemplo.com/"));
            assert!(!is_app_origin("http://tauri.localhost.exemplo.com/"));
            assert!(!is_app_origin("http://localhost:1421/"));
        }
    }
}

/// Atualização encontrada por `check_update`, aguardando `install_update`.
#[derive(Default)]
struct PendingUpdate(Mutex<Option<Update>>);

#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
struct UpdateInfo {
    version: String,
    current_version: String,
    notes: Option<String>,
}

#[derive(Clone, Serialize)]
#[serde(rename_all = "camelCase")]
struct UpdateProgress {
    downloaded: u64,
    total: Option<u64>,
}

/// Consulta o servidor Aurora em que o usuário está. O endpoint é definido em tempo de
/// execução porque cada instalação aponta para um servidor diferente (ex.: o IP do PC do dono).
/// A integridade vem da assinatura: o app só instala pacotes assinados pela chave do projeto.
#[tauri::command]
async fn check_update(
    app: AppHandle,
    pending: State<'_, PendingUpdate>,
    server_url: String,
) -> Result<Option<UpdateInfo>, String> {
    let base = server_url.trim().trim_end_matches('/');
    if !(base.starts_with("http://") || base.starts_with("https://")) {
        return Err("Endereço de servidor inválido.".into());
    }
    let endpoint = format!("{base}/api/updates/{{{{target}}}}/{{{{arch}}}}/{{{{current_version}}}}");
    let url = url::Url::parse(&endpoint).map_err(|e| e.to_string())?;
    let update = app
        .updater_builder()
        .endpoints(vec![url])
        .map_err(|e| e.to_string())?
        .build()
        .map_err(|e| e.to_string())?
        .check()
        .await
        .map_err(|e| e.to_string())?;
    let info = update.as_ref().map(|u| UpdateInfo {
        version: u.version.clone(),
        current_version: u.current_version.clone(),
        notes: u.body.clone(),
    });
    *pending.0.lock().map_err(|e| e.to_string())? = update;
    Ok(info)
}

/// Baixa (com progresso no evento `update-progress`), confere a assinatura e instala.
/// No Windows o instalador encerra o app sozinho; nos demais sistemas o app reinicia.
#[tauri::command]
async fn install_update(app: AppHandle, pending: State<'_, PendingUpdate>) -> Result<(), String> {
    let update = pending
        .0
        .lock()
        .map_err(|e| e.to_string())?
        .take()
        .ok_or_else(|| "Nenhuma atualização pendente.".to_string())?;
    let mut downloaded: u64 = 0;
    update
        .download_and_install(
            |chunk, total| {
                downloaded += chunk as u64;
                let _ = app.emit("update-progress", UpdateProgress { downloaded, total });
            },
            || {},
        )
        .await
        .map_err(|e| e.to_string())?;
    app.restart();
}

/// Selo de menções sobre o ícone da barra de tarefas (Windows). A imagem (RGBA, quadrada) é
/// desenhada pela interface; `None` tira o selo.
#[tauri::command]
fn set_taskbar_badge(window: tauri::WebviewWindow, rgba: Option<Vec<u8>>, size: u32) -> Result<(), String> {
    let icon = match rgba {
        Some(pixels) if pixels.len() == (size as usize) * (size as usize) * 4 && (8..=64).contains(&size) => {
            Some(tauri::image::Image::new_owned(pixels, size, size))
        }
        Some(_) => return Err("Imagem do selo inválida.".into()),
        None => None,
    };
    window.set_overlay_icon(icon).map_err(|e| e.to_string())
}

/// Pisca o ícone na barra de tarefas (menção com o app em segundo plano).
#[tauri::command]
fn request_attention(window: tauri::WebviewWindow) -> Result<(), String> {
    if window.is_focused().unwrap_or(false) {
        return Ok(());
    }
    window
        .request_user_attention(Some(tauri::UserAttentionType::Informational))
        .map_err(|e| e.to_string())
}

/// Traz a janela principal para a frente (segunda instância, clique em notificação).
fn show_main_window(app: &AppHandle) {
    if let Some(window) = app.get_webview_window("main") {
        let _ = window.unminimize();
        let _ = window.show();
        let _ = window.set_focus();
    }
}

#[cfg_attr(mobile, tauri::mobile_entry_point)]
pub fn run() {
    tauri::Builder::default()
        // Primeiro plugin, de propósito: abrir o Aurora de novo (ou clicar numa notificação) só traz
        // a janela que já está aberta, em vez de iniciar uma segunda cópia.
        .plugin(tauri_plugin_single_instance::init(|app, _args, _cwd| show_main_window(app)))
        .plugin(tauri_plugin_notification::init())
        .plugin(tauri_plugin_opener::init())
        .plugin(tauri_plugin_updater::Builder::new().build())
        .manage(PendingUpdate::default())
        .manage(system_audio::SystemAudio::default())
        .invoke_handler(tauri::generate_handler![
            check_update,
            install_update,
            set_taskbar_badge,
            request_attention,
            system_audio::system_audio_start,
            system_audio::system_audio_stop
        ])
        .setup(|app| {
            #[cfg(windows)]
            if let Some(window) = app.get_webview_window("main") {
                media_permissions::allow_for_app(&window)?;
            }
            if cfg!(debug_assertions) {
                app.handle().plugin(
                    tauri_plugin_log::Builder::default()
                        .level(log::LevelFilter::Info)
                        .build(),
                )?;
            }
            Ok(())
        })
        .run(tauri::generate_context!())
        .expect("error while building tauri application");
}
