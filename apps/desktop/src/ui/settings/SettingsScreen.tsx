import { useEffect, useId, useRef, useState, type ReactNode } from "react";
import { Accessibility, Bell, Keyboard, Languages, LogOut, Mic, Monitor, Palette, Settings2, UserRound, Volume2, X, type LucideIcon } from "lucide-react";
import type { User, DmPolicy } from "@aurora/schema";
import type { PlatformInfo, PlatformPort, UpdateInfo } from "@aurora/platform";
import type { ThemePreference } from "@aurora/ui/theme";
import type { ApiClient } from "../../net/api";
import type { SoundPlayer } from "../../sounds";
import { ICON, ICON_SM } from "../shell";
import { AccountSection } from "./AccountSection";
import { DmPrivacy } from "../home";
import { IdleSetting } from "../status";
import { VoiceSection } from "./VoiceSection";
import { AccessibilitySection, AdvancedSection, AppearanceSection, KeybindsSection, LanguageSection, NotificationsSection, SoundsSection, WindowsSection } from "./sections";

export type SettingsSectionId = "account" | "voice" | "sounds" | "notifications" | "appearance" | "accessibility" | "keybinds" | "language" | "windows" | "advanced";

const NAV: { group: string; items: { id: SettingsSectionId; label: string; Icon: LucideIcon }[] }[] = [
  { group: "Configurações de usuário", items: [{ id: "account", label: "Minha conta", Icon: UserRound }] },
  {
    group: "Configurações do app",
    items: [
      { id: "voice", label: "Voz e vídeo", Icon: Mic },
      { id: "sounds", label: "Sons", Icon: Volume2 },
      { id: "notifications", label: "Notificações", Icon: Bell },
      { id: "appearance", label: "Aparência", Icon: Palette },
      { id: "accessibility", label: "Acessibilidade", Icon: Accessibility },
      { id: "keybinds", label: "Atalhos de teclado", Icon: Keyboard },
      { id: "language", label: "Idioma", Icon: Languages },
      { id: "windows", label: "Windows", Icon: Monitor },
      { id: "advanced", label: "Avançado", Icon: Settings2 },
    ],
  },
];
const LABELS = Object.fromEntries(NAV.flatMap((g) => g.items.map((i) => [i.id, i.label]))) as Record<SettingsSectionId, string>;

export interface SettingsScreenProps {
  initialSection?: SettingsSectionId;
  me: User;
  api: ApiClient;
  serverUrl: string;
  port: PlatformPort | null;
  platform: PlatformInfo | null;
  sounds: SoundPlayer;
  theme: ThemePreference;
  onThemeChange: (theme: ThemePreference) => void;
  onUserUpdated: (user: User) => void;
  /** Quem pode me mandar mensagem direta (fica no servidor). */
  dmPolicy: DmPolicy;
  onDmPolicy: (policy: DmPolicy) => void;
  availableUpdate: UpdateInfo | null;
  onCheckUpdate: () => Promise<"available" | "current" | "unsupported" | "error">;
  onInstallUpdate: () => void;
  onLogout: () => void;
  onClose: () => void;
}

/**
 * Configurações em tela cheia: menu de seções à esquerda, conteúdo à direita.
 * Esc ou o X fecham e devolvem o foco para onde a pessoa estava (guia visual §6.8).
 */
export function SettingsScreen(props: SettingsScreenProps) {
  const [section, setSection] = useState<SettingsSectionId>(props.initialSection ?? "account");
  const titleId = useId();
  const rootRef = useRef<HTMLDivElement>(null);
  const contentRef = useRef<HTMLDivElement>(null);
  const { onClose } = props;

  useEffect(() => {
    const previous = document.activeElement as HTMLElement | null;
    rootRef.current?.querySelector<HTMLElement>('[aria-current="page"]')?.focus();
    const onKey = (event: KeyboardEvent) => {
      if (event.key !== "Escape" || event.defaultPrevented) return;
      event.preventDefault();
      onClose();
    };
    document.addEventListener("keydown", onKey);
    return () => {
      document.removeEventListener("keydown", onKey);
      previous?.focus();
    };
  }, [onClose]);

  const open = (id: SettingsSectionId) => {
    setSection(id);
    contentRef.current?.scrollTo({ top: 0 });
  };

  let body: ReactNode;
  switch (section) {
    case "account":
      body = (
        <>
          <AccountSection me={props.me} api={props.api} onUserUpdated={props.onUserUpdated} onLogout={props.onLogout} />
          <DmPrivacy dmPolicy={props.dmPolicy} api={props.api} onChange={props.onDmPolicy} />
          <IdleSetting />
        </>
      );
      break;
    case "voice":
      body = <VoiceSection platform={props.platform} />;
      break;
    case "sounds":
      body = <SoundsSection player={props.sounds} />;
      break;
    case "notifications":
      body = <NotificationsSection port={props.port} />;
      break;
    case "appearance":
      body = <AppearanceSection theme={props.theme} onThemeChange={props.onThemeChange} />;
      break;
    case "accessibility":
      body = <AccessibilitySection />;
      break;
    case "keybinds":
      body = <KeybindsSection />;
      break;
    case "language":
      body = <LanguageSection />;
      break;
    case "windows":
      body = <WindowsSection port={props.port} />;
      break;
    case "advanced":
      body = (
        <AdvancedSection
          info={props.platform}
          serverUrl={props.serverUrl}
          availableUpdate={props.availableUpdate}
          onCheckUpdate={props.onCheckUpdate}
          onInstallUpdate={props.onInstallUpdate}
        />
      );
      break;
  }

  return (
    <div ref={rootRef} className="settings" role="dialog" aria-modal="true" aria-labelledby={titleId}>
      <nav className="settings__nav" aria-label="Seções das configurações">
        <div className="settings__nav-inner">
          {NAV.map((group) => (
            <div key={group.group} className="settings__nav-group">
              <h2 className="settings__nav-heading">{group.group}</h2>
              <ul>
                {group.items.map(({ id, label, Icon }) => (
                  <li key={id}>
                    <button type="button" className="settings__nav-item" aria-current={section === id ? "page" : undefined} onClick={() => open(id)}>
                      <Icon {...ICON_SM} />
                      {label}
                    </button>
                  </li>
                ))}
              </ul>
            </div>
          ))}
          <div className="settings__nav-group">
            <button type="button" className="settings__nav-item settings__nav-item--danger" onClick={props.onLogout}>
              <LogOut {...ICON_SM} />
              Sair da conta
            </button>
          </div>
          <p className="settings__version">
            Aurora {props.platform ? (props.platform.kind === "tauri" ? `v${props.platform.appVersion}` : "web") : ""}
          </p>
        </div>
      </nav>
      <div ref={contentRef} className="settings__content">
        <div className="settings__inner">
          <header className="settings__header">
            <h1 id={titleId} className="settings__title">
              {LABELS[section]}
            </h1>
            <button type="button" className="icon-button settings__close" aria-label="Fechar configurações (Esc)" title="Fechar (Esc)" onClick={onClose}>
              <X {...ICON} />
            </button>
          </header>
          {body}
        </div>
      </div>
    </div>
  );
}
