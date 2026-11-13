//! Opções do app que dependem do Windows (seção "Windows" das configurações):
//! iniciar com o sistema, iniciar minimizado e fechar para a bandeja.
//! Ficam no lado nativo porque valem antes de a interface carregar (ao ligar o PC, ao fechar a janela).

use std::path::PathBuf;
use std::sync::Mutex;

use serde::{Deserialize, Serialize};
use tauri::{AppHandle, Manager, State};
use tauri_plugin_autostart::ManagerExt;

/// Argumento passado pelo Windows quando o app abre junto com o sistema.
pub const AUTOSTART_ARG: &str = "--autostart";
const FILE_NAME: &str = "desktop-settings.json";

/// O que fica salvo em arquivo (iniciar com o sistema é o próprio registro do Windows).
#[derive(Clone, Copy, Debug, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase", default)]
pub struct Prefs {
    pub start_minimized: bool,
    /// Fechar a janela só esconde (o app segue na bandeja, com a voz ligada).
    pub close_to_tray: bool,
}

impl Default for Prefs {
    fn default() -> Self {
        Self { start_minimized: false, close_to_tray: true }
    }
}

#[derive(Default)]
pub struct DesktopPrefs(pub Mutex<Prefs>);

#[derive(Debug, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct DesktopSettings {
    pub open_on_startup: bool,
    pub start_minimized: bool,
    pub close_to_tray: bool,
}

fn file(app: &AppHandle) -> Option<PathBuf> {
    app.path().app_config_dir().ok().map(|dir| dir.join(FILE_NAME))
}

/// Lê o arquivo; ausente ou estragado = padrão (nunca impede o app de abrir).
pub fn parse(text: &str) -> Prefs {
    serde_json::from_str(text).unwrap_or_default()
}

pub fn load(app: &AppHandle) -> Prefs {
    file(app).and_then(|path| std::fs::read_to_string(path).ok()).map(|text| parse(&text)).unwrap_or_default()
}

fn save(app: &AppHandle, prefs: &Prefs) -> Result<(), String> {
    let path = file(app).ok_or("Não achei a pasta de configurações do app.")?;
    if let Some(dir) = path.parent() {
        std::fs::create_dir_all(dir).map_err(|e| format!("Não foi possível salvar as configurações: {e}"))?;
    }
    let text = serde_json::to_string_pretty(prefs).map_err(|e| e.to_string())?;
    std::fs::write(path, text).map_err(|e| format!("Não foi possível salvar as configurações: {e}"))
}

pub fn close_to_tray(app: &AppHandle) -> bool {
    app.state::<DesktopPrefs>().0.lock().map(|p| p.close_to_tray).unwrap_or(true)
}

/// Abriu junto com o Windows e a pessoa pediu para começar minimizado (só na bandeja)?
pub fn should_start_hidden(prefs: &Prefs, args: &[String]) -> bool {
    prefs.start_minimized && args.iter().any(|arg| arg == AUTOSTART_ARG)
}

#[tauri::command]
pub fn get_desktop_settings(app: AppHandle, prefs: State<'_, DesktopPrefs>) -> Result<DesktopSettings, String> {
    let current = *prefs.0.lock().map_err(|e| e.to_string())?;
    Ok(DesktopSettings {
        open_on_startup: app.autolaunch().is_enabled().unwrap_or(false),
        start_minimized: current.start_minimized,
        close_to_tray: current.close_to_tray,
    })
}

#[tauri::command]
pub fn set_desktop_settings(app: AppHandle, prefs: State<'_, DesktopPrefs>, settings: DesktopSettings) -> Result<DesktopSettings, String> {
    let autolaunch = app.autolaunch();
    let enabled = autolaunch.is_enabled().unwrap_or(false);
    if settings.open_on_startup != enabled {
        let result = if settings.open_on_startup { autolaunch.enable() } else { autolaunch.disable() };
        result.map_err(|e| format!("O Windows não deixou mudar o início automático: {e}"))?;
    }
    let next = Prefs { start_minimized: settings.start_minimized, close_to_tray: settings.close_to_tray };
    save(&app, &next)?;
    *prefs.0.lock().map_err(|e| e.to_string())? = next;
    get_desktop_settings(app.clone(), prefs)
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn arquivo_ausente_ou_estragado_vira_padrao() {
        assert_eq!(parse(""), Prefs::default());
        assert_eq!(parse("{lixo"), Prefs::default());
        assert_eq!(parse(r#"{"startMinimized":true}"#), Prefs { start_minimized: true, close_to_tray: true });
        assert!(Prefs::default().close_to_tray);
    }

    #[test]
    fn so_comeca_escondido_se_abriu_com_o_windows() {
        let minimized = Prefs { start_minimized: true, close_to_tray: true };
        let with_windows = vec!["aurora.exe".to_string(), AUTOSTART_ARG.to_string()];
        let by_hand = vec!["aurora.exe".to_string()];
        assert!(should_start_hidden(&minimized, &with_windows));
        assert!(!should_start_hidden(&minimized, &by_hand));
        assert!(!should_start_hidden(&Prefs::default(), &with_windows));
    }
}
