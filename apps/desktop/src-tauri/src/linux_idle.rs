//! Tempo parado no Linux (status "Ausente"): cada área de trabalho expõe isso de um jeito.
//! Tenta, nesta ordem: Cinnamon (Muffin), GNOME (Mutter), KDE (org.freedesktop.ScreenSaver) e,
//! em qualquer sessão X11, a extensão de proteção de tela do servidor gráfico. Sem nenhuma, 0.

use std::time::Duration;

/// (serviço, caminho, interface, método) que devolvem milissegundos parado.
const DBUS_SOURCES: [(&str, &str, &str, &str); 3] = [
    ("org.cinnamon.Muffin.IdleMonitor", "/org/cinnamon/Muffin/IdleMonitor/Core", "org.cinnamon.Muffin.IdleMonitor", "GetIdletime"),
    ("org.gnome.Mutter.IdleMonitor", "/org/gnome/Mutter/IdleMonitor/Core", "org.gnome.Mutter.IdleMonitor", "GetIdletime"),
    ("org.freedesktop.ScreenSaver", "/org/freedesktop/ScreenSaver", "org.freedesktop.ScreenSaver", "GetSessionIdleTime"),
];

fn from_dbus() -> Option<u64> {
    let connection = zbus::blocking::Connection::session().ok()?;
    for (service, path, interface, method) in DBUS_SOURCES {
        let Ok(reply) = connection.call_method(Some(service), path, Some(interface), method, &()) else { continue };
        let body = reply.body();
        // Muffin/Mutter devolvem u64; o do KDE, u32
        if let Ok(ms) = body.deserialize::<u64>() {
            return Some(ms);
        }
        if let Ok(ms) = body.deserialize::<u32>() {
            return Some(u64::from(ms));
        }
    }
    None
}

fn from_x11() -> Option<u64> {
    use x11rb::connection::Connection as _;
    use x11rb::protocol::screensaver::ConnectionExt as _;
    let (connection, screen) = x11rb::connect(None).ok()?;
    let root = connection.setup().roots.get(screen)?.root;
    let info = connection.screensaver_query_info(root).ok()?.reply().ok()?;
    Some(u64::from(info.ms_since_user_input))
}

/// Segundos desde o último uso do teclado ou do mouse na sessão (0 se não houver como saber).
pub fn idle_seconds() -> u64 {
    from_dbus().or_else(from_x11).map(|ms| Duration::from_millis(ms).as_secs()).unwrap_or(0)
}
