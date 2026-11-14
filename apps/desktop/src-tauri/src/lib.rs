use std::sync::Mutex;

mod desktop_settings;
#[cfg(target_os = "linux")]
mod linux_idle;
#[cfg(target_os = "linux")]
mod mic_test;
#[cfg(target_os = "linux")]
mod native_media;
mod push_to_talk;
mod system_audio;

use desktop_settings::DesktopPrefs;
use serde::Serialize;
use tauri::menu::{Menu, MenuItem, PredefinedMenuItem};
use tauri::tray::{MouseButton, MouseButtonState, TrayIconBuilder, TrayIconEvent};
use tauri::{AppHandle, Emitter, Manager, State, WindowEvent};
use tauri_plugin_autostart::MacosLauncher;
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
    // `bundle_type`: como o app foi instalado (nsis, msi, appimage, deb). No Linux, o servidor manda o
    // pacote do mesmo tipo (o AppImage troca o arquivo; o .deb instala pelo dpkg).
    let endpoint = format!("{base}/api/updates/{{{{target}}}}/{{{{arch}}}}/{{{{current_version}}}}?bundle={{{{bundle_type}}}}");
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

/// Selo de menções no ícone do app. No Windows, uma imagem (RGBA, quadrada) desenhada pela interface
/// sobre o ícone da barra de tarefas; no Linux, o contador do lançador (onde a área de trabalho mostra).
/// `None`/0 tira o selo.
#[tauri::command]
fn set_taskbar_badge(window: tauri::WebviewWindow, rgba: Option<Vec<u8>>, size: u32, count: Option<i64>) -> Result<(), String> {
    #[cfg(windows)]
    {
        let _ = count;
        let icon = match rgba {
            Some(pixels) if pixels.len() == (size as usize) * (size as usize) * 4 && (8..=64).contains(&size) => {
                Some(tauri::image::Image::new_owned(pixels, size, size))
            }
            Some(_) => return Err("Imagem do selo inválida.".into()),
            None => None,
        };
        window.set_overlay_icon(icon).map_err(|e| e.to_string())
    }
    #[cfg(not(windows))]
    {
        let _ = (rgba, size);
        window.set_badge_count(count.filter(|n| *n > 0)).map_err(|e| e.to_string())
    }
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

/// Segundos desde o último uso do teclado ou do mouse no computador inteiro (status "Ausente").
#[tauri::command]
fn idle_seconds() -> u64 {
    #[cfg(windows)]
    {
        use windows::Win32::System::SystemInformation::GetTickCount;
        use windows::Win32::UI::Input::KeyboardAndMouse::{GetLastInputInfo, LASTINPUTINFO};
        let mut info = LASTINPUTINFO { cbSize: std::mem::size_of::<LASTINPUTINFO>() as u32, dwTime: 0 };
        // SAFETY: estrutura do tamanho certo, preenchida pelo Windows; sem ponteiros guardados.
        if unsafe { GetLastInputInfo(&mut info) }.as_bool() {
            let now = unsafe { GetTickCount() };
            return u64::from(now.wrapping_sub(info.dwTime)) / 1000;
        }
        0
    }
    #[cfg(target_os = "linux")]
    {
        linux_idle::idle_seconds()
    }
    #[cfg(not(any(windows, target_os = "linux")))]
    {
        0
    }
}

/// Traz a janela principal para a frente (segunda instância, clique em notificação).
fn show_main_window(app: &AppHandle) {
    if let Some(window) = app.get_webview_window("main") {
        let _ = window.unminimize();
        let _ = window.show();
        let _ = window.set_focus();
    }
}

/// Ícone na bandeja (ao lado do relógio): clicar abre a janela; o menu tem "Sair" de verdade,
/// já que fechar a janela pode só escondê-la (fechar para a bandeja).
fn create_tray(app: &AppHandle) -> tauri::Result<()> {
    let show = MenuItem::with_id(app, "show", "Abrir o Aurora", true, None::<&str>)?;
    let quit = MenuItem::with_id(app, "quit", "Sair do Aurora", true, None::<&str>)?;
    let menu = Menu::with_items(app, &[&show, &PredefinedMenuItem::separator(app)?, &quit])?;
    let mut tray = TrayIconBuilder::with_id("main")
        .tooltip("Aurora")
        .menu(&menu)
        .show_menu_on_left_click(false)
        .on_menu_event(|app, event| match event.id.as_ref() {
            "show" => show_main_window(app),
            "quit" => app.exit(0),
            _ => {}
        })
        .on_tray_icon_event(|tray, event| {
            if let TrayIconEvent::Click { button: MouseButton::Left, button_state: MouseButtonState::Up, .. } = event {
                show_main_window(tray.app_handle());
            }
        });
    if let Some(icon) = app.default_window_icon() {
        tray = tray.icon(icon.clone());
    }
    tray.build(app)?;
    Ok(())
}

#[cfg_attr(mobile, tauri::mobile_entry_point)]
pub fn run() {
    let builder = tauri::Builder::default();
    #[cfg(target_os = "linux")]
    let builder = builder.manage(native_media::NativeMedia::default()).manage(mic_test::MicTest::default())
        .invoke_handler(tauri::generate_handler![
            check_update,
            install_update,
            set_taskbar_badge,
            request_attention,
            idle_seconds,
            system_audio::system_audio_start,
            system_audio::system_audio_stop,
            push_to_talk::ptt_watch,
            push_to_talk::ptt_stop,
            desktop_settings::get_desktop_settings,
            desktop_settings::set_desktop_settings,
            native_media::native_media_devices,
            native_media::native_media_join,
            native_media::native_media_leave,
            native_media::native_media_set_muted,
            native_media::native_media_set_push_to_talk,
            native_media::native_media_set_deafened,
            native_media::native_media_apply_settings,
            mic_test::mic_test_start,
            mic_test::mic_test_stop
        ]);
    #[cfg(not(target_os = "linux"))]
    let builder = builder
        .invoke_handler(tauri::generate_handler![
            check_update,
            install_update,
            set_taskbar_badge,
            request_attention,
            idle_seconds,
            system_audio::system_audio_start,
            system_audio::system_audio_stop,
            push_to_talk::ptt_watch,
            push_to_talk::ptt_stop,
            desktop_settings::get_desktop_settings,
            desktop_settings::set_desktop_settings
        ]);
    builder
        // Primeiro plugin, de propósito: abrir o Aurora de novo (ou clicar numa notificação) só traz
        // a janela que já está aberta, em vez de iniciar uma segunda cópia.
        .plugin(tauri_plugin_single_instance::init(|app, _args, _cwd| show_main_window(app)))
        .plugin(tauri_plugin_notification::init())
        .plugin(tauri_plugin_opener::init())
        .plugin(tauri_plugin_updater::Builder::new().build())
        .plugin(tauri_plugin_autostart::init(MacosLauncher::LaunchAgent, Some(vec![desktop_settings::AUTOSTART_ARG])))
        .manage(PendingUpdate::default())
        .manage(DesktopPrefs::default())
        .manage(system_audio::SystemAudio::default())
        .manage(push_to_talk::PushToTalk::default())

        // Fechar para a bandeja: a janela some, o app (e a voz) continuam. "Sair" fica no menu da bandeja.
        .on_window_event(|window, event| {
            if let WindowEvent::CloseRequested { api, .. } = event {
                if window.label() == "main" && desktop_settings::close_to_tray(window.app_handle()) {
                    api.prevent_close();
                    let _ = window.hide();
                }
            }
        })
        .setup(|app| {
            let prefs = desktop_settings::load(app.handle());
            *app.state::<DesktopPrefs>().0.lock().expect("preferências do desktop") = prefs;
            create_tray(app.handle())?;
            #[cfg(windows)]
            if let Some(window) = app.get_webview_window("main") {
                media_permissions::allow_for_app(&window)?;
            }
            // A janela nasce escondida (tauri.conf.json) para não piscar quando abre com o Windows
            // em modo minimizado; nos demais casos aparece já aqui.
            let args: Vec<String> = std::env::args().collect();
            if !desktop_settings::should_start_hidden(&prefs, &args) {
                if let Some(window) = app.get_webview_window("main") {
                    window.show()?;
                }
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

#[cfg(test)]
mod idle_tests {
    /// O Windows responde o tempo desde o último uso do teclado/mouse (algo plausível: menos de 30 dias).
    #[test]
    fn idle_seconds_responde_um_tempo_plausivel() {
        let seconds = super::idle_seconds();
        assert!(seconds < 30 * 24 * 3600, "tempo parado absurdo: {seconds}");
    }
}
