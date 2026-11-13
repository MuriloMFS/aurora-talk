import { useCallback, useEffect, useRef, useState } from "react";
import { applyTheme, readPreference, savePreference, watchSystemTheme, type ThemePreference } from "@aurora/ui/theme";
import { ChatApp } from "./ChatApp";
import { DEFAULT_SERVER_URL, IS_HOSTED, clearSession, isLocalAddress, lastServerUrl, loadSession, saveSession, type Session } from "./net/session";

/** Sessão de um servidor caseiro (1.x) na versão oficial: o servidor agora é outro, então entra de novo. */
const MOVED_NOTICE = "O Aurora agora funciona pela internet. Entre de novo; se for a primeira vez neste servidor, crie sua conta.";
const initialSession = (): Session | null => {
  const session = loadSession();
  if (session && IS_HOSTED && session.serverUrl !== DEFAULT_SERVER_URL && isLocalAddress(session.serverUrl)) {
    clearSession();
    return null;
  }
  return session;
};
const movedFromLocal = (() => {
  const session = loadSession();
  return Boolean(session && IS_HOSTED && session.serverUrl !== DEFAULT_SERVER_URL && isLocalAddress(session.serverUrl));
})();
import { AuthScreen } from "./ui/AuthScreen";
import { useSettings, type AppSettings } from "./state/settings";
import { UpdateButton, UpdateStatus, useAppUpdate } from "./ui/update";

/** Preferências visuais vão para o <html> (valem também na tela de login). */
function applyDisplaySettings({ appearance, accessibility }: AppSettings): void {
  const root = document.documentElement;
  root.dataset.density = appearance.density;
  root.style.setProperty("--chat-font-size", `${appearance.chatFontSize}px`);
  root.style.setProperty("--chat-line-height", `${Math.round(appearance.chatFontSize * 1.5)}px`);
  if (accessibility.motion === "reduce") root.dataset.motion = "reduce";
  else delete root.dataset.motion;
  if (accessibility.strongBorders) root.dataset.strongBorders = "";
  else delete root.dataset.strongBorders;
}

export function App() {
  // ---- tema (guia visual §3.1/§9) ----
  const [themePreference, setThemePreference] = useState<ThemePreference>(() => readPreference());
  const themeRef = useRef(themePreference);
  useEffect(() => {
    themeRef.current = themePreference;
    applyTheme(themePreference);
    savePreference(themePreference);
  }, [themePreference]);
  useEffect(() => watchSystemTheme(() => themeRef.current, () => {}), []);

  // ---- aparência e acessibilidade (Configurações → Aparência/Acessibilidade) ----
  const settings = useSettings();
  useEffect(() => applyDisplaySettings(settings), [settings]);

  // ---- sessão ----
  const [session, setSession] = useState<Session | null>(initialSession);
  const [notice, setNotice] = useState<string | null>(movedFromLocal ? MOVED_NOTICE : null);

  const logout = useCallback((message: string | null) => {
    clearSession();
    setSession(null);
    setNotice(message);
  }, []);

  // Atualizações vêm do servidor em uso (ou do último usado, na tela de login).
  const update = useAppUpdate(session?.serverUrl ?? lastServerUrl());

  return (
    <>
      <UpdateStatus phase={update.phase} onDismissError={update.dismissError} />
      {session ? (
        <ChatApp
          key={session.token}
          session={session}
          themePreference={themePreference}
          onThemeChange={setThemePreference}
          onLogout={logout}
          availableUpdate={update.available}
          onCheckUpdate={update.checkNow}
          onInstallUpdate={update.install}
        />
      ) : (
        <>
          {update.available && <UpdateButton update={update.available} onInstall={update.install} floating />}
          <AuthScreen
            initialServerUrl={lastServerUrl()}
            notice={notice}
            onAuthenticated={(next) => {
              saveSession(next);
              setNotice(null);
              setSession(next);
            }}
          />
        </>
      )}
    </>
  );
}
