import { useEffect, useState } from "react";
import { Play } from "lucide-react";
import type { DesktopSettings, PlatformInfo, PlatformPort, UpdateInfo } from "@aurora/platform";
import type { ThemePreference } from "@aurora/ui/theme";
import { SOUND_IDS, SOUND_LABELS, type SoundId, type SoundPlayer } from "../../sounds";
import { CHAT_FONT_SIZES, DEFAULT_SETTINGS, patchSettings, settingsStore, useSettings, type Density, type MotionPreference } from "../../state/settings";
import { ICON_SM } from "../shell";
import { FormStatus, RadioCards, SettingsGroup, SliderField, SwitchRow } from "./controls";

/* ---------------- Sons ---------------- */

export function SoundsSection({ player }: { player: SoundPlayer }) {
  const { sounds } = useSettings();
  const setEnabled = (id: SoundId, on: boolean) => patchSettings("sounds", { enabled: { ...sounds.enabled, [id]: on } });
  const setAll = (on: boolean) => patchSettings("sounds", { enabled: Object.fromEntries(SOUND_IDS.map((id) => [id, on])) as Record<SoundId, boolean> });
  const allOn = SOUND_IDS.every((id) => sounds.enabled[id]);
  return (
    <>
      <SettingsGroup title="Volume">
        <SliderField label="Volume dos sons do Aurora" value={sounds.volume} min={0} max={100} step={5} format={(v) => (v === 0 ? "Mudo" : `${v}%`)} onChange={(volume) => patchSettings("sounds", { volume })} />
      </SettingsGroup>
      <SettingsGroup title="Quando tocar" description="Sons curtos que avisam o que aconteceu, sem precisar olhar a tela.">
        <div>
          <button type="button" className="button button--secondary button--small" onClick={() => setAll(!allOn)}>
            {allOn ? "Desligar todos" : "Ligar todos"}
          </button>
        </div>
        {SOUND_IDS.map((id) => (
          <SwitchRow
            key={id}
            label={SOUND_LABELS[id]}
            checked={sounds.enabled[id]}
            onChange={(on) => setEnabled(id, on)}
            action={
              <button type="button" className="icon-button icon-button--small settings-switch__action" aria-label={`Ouvir: ${SOUND_LABELS[id]}`} title="Ouvir" onClick={() => player.play(id)}>
                <Play {...ICON_SM} />
              </button>
            }
          />
        ))}
      </SettingsGroup>
    </>
  );
}

/* ---------------- Notificações ---------------- */

export function NotificationsSection({ port }: { port: PlatformPort | null }) {
  const { notifications, sounds } = useSettings();
  const [status, setStatus] = useState<{ kind: "ok" | "error"; text: string } | null>(null);
  const test = () => {
    setStatus(null);
    port
      ?.notify({ title: "Aurora", body: "Assim aparece quando alguém mencionar você." })
      .then(() => setStatus({ kind: "ok", text: "Notificação enviada. Se não apareceu, confira as notificações do Windows para o Aurora." }))
      .catch(() => setStatus({ kind: "error", text: "O Windows não deixou mostrar a notificação. Libere as notificações do Aurora nas configurações do Windows." }));
  };
  return (
    <SettingsGroup title="Menções" description="Quando alguém escreve @você e você não está olhando aquele canal.">
      <SwitchRow
        label="Notificações na área de trabalho"
        hint="Mostra um aviso do Windows com quem mencionou e o trecho da mensagem."
        checked={notifications.desktop}
        onChange={(desktop) => patchSettings("notifications", { desktop })}
        action={
          <button type="button" className="button button--secondary button--small settings-switch__action" onClick={test} disabled={!notifications.desktop || !port}>
            Testar
          </button>
        }
      />
      <SwitchRow
        label="Som ao ser mencionado"
        checked={sounds.enabled.mention}
        onChange={(on) => patchSettings("sounds", { enabled: { ...sounds.enabled, mention: on } })}
      />
      <SwitchRow
        label="Piscar o ícone na barra de tarefas"
        hint="Só quando o Aurora está em segundo plano."
        checked={notifications.flash}
        onChange={(flash) => patchSettings("notifications", { flash })}
      />
      <SwitchRow
        label="Número de menções no ícone"
        hint="O selo vermelho sobre o ícone da barra de tarefas."
        checked={notifications.badge}
        onChange={(badge) => patchSettings("notifications", { badge })}
      />
      <FormStatus status={status} />
    </SettingsGroup>
  );
}

/* ---------------- Aparência ---------------- */

const THEMES: { value: ThemePreference; title: string; hint: string }[] = [
  { value: "dark", title: "Escuro", hint: "Padrão do Aurora" },
  { value: "light", title: "Claro", hint: "Fundo branco" },
  { value: "system", title: "Seguir o Windows", hint: "Muda junto com o sistema" },
];
const DENSITIES: { value: Density; title: string; hint: string }[] = [
  { value: "cozy", title: "Confortável", hint: "Com fotos e mais espaço entre as conversas." },
  { value: "compact", title: "Compacta", hint: "Sem fotos: cabem mais mensagens na tela." },
];

export function AppearanceSection({ theme, onThemeChange }: { theme: ThemePreference; onThemeChange: (theme: ThemePreference) => void }) {
  const { appearance } = useSettings();
  const index = CHAT_FONT_SIZES.indexOf(appearance.chatFontSize as (typeof CHAT_FONT_SIZES)[number]);
  return (
    <>
      <SettingsGroup title="Tema">
        <RadioCards legend="Cores do app" name="theme" value={theme} options={THEMES} columns onChange={onThemeChange} />
      </SettingsGroup>
      <SettingsGroup title="Mensagens">
        <RadioCards legend="Exibição" name="density" value={appearance.density} options={DENSITIES} onChange={(density) => patchSettings("appearance", { density })} />
        <SliderField
          label="Tamanho do texto das mensagens"
          value={Math.max(0, index)}
          min={0}
          max={CHAT_FONT_SIZES.length - 1}
          format={(i) => `${CHAT_FONT_SIZES[i] ?? 14} px`}
          onChange={(i) => patchSettings("appearance", { chatFontSize: CHAT_FONT_SIZES[i] ?? 14 })}
        />
        <p className="settings-preview message__content" aria-hidden="true">
          Assim fica o texto das conversas. Ajuste até ler sem esforço.
        </p>
      </SettingsGroup>
    </>
  );
}

/* ---------------- Acessibilidade ---------------- */

const MOTIONS: { value: MotionPreference; title: string; hint: string }[] = [
  { value: "system", title: "Seguir o Windows", hint: "Reduz se o Windows estiver com as animações desligadas." },
  { value: "reduce", title: "Sempre reduzir", hint: "Sem deslizes nem transições no Aurora." },
];

export function AccessibilitySection() {
  const { accessibility } = useSettings();
  return (
    <SettingsGroup title="Visão e movimento">
      <RadioCards legend="Reduzir movimento" name="motion" value={accessibility.motion} options={MOTIONS} onChange={(motion) => patchSettings("accessibility", { motion })} />
      <SwitchRow
        label="Contornos reforçados"
        hint="Divisórias e bordas mais fortes, para enxergar melhor onde começa cada área."
        checked={accessibility.strongBorders}
        onChange={(strongBorders) => patchSettings("accessibility", { strongBorders })}
      />
    </SettingsGroup>
  );
}

/* ---------------- Atalhos ---------------- */

export const SHORTCUTS: { keys: string[]; action: string }[] = [
  { keys: ["Ctrl", "Shift", "M"], action: "Ligar ou desligar o microfone (na voz)" },
  { keys: ["Ctrl", "Shift", "D"], action: "Ensurdecer ou voltar a ouvir (na voz)" },
  { keys: ["Ctrl", ","], action: "Abrir as configurações" },
  { keys: ["Esc"], action: "Fechar janelas, configurações e a resposta em andamento" },
  { keys: ["Enter"], action: "Enviar a mensagem" },
  { keys: ["Shift", "Enter"], action: "Quebrar a linha na mensagem" },
];

export function KeybindsSection() {
  return (
    <SettingsGroup title="Teclado" description="Funcionam com a janela do Aurora em foco. Atalhos que funcionam dentro de jogos (e apertar para falar) chegam numa próxima versão.">
      <dl className="shortcuts">
        {SHORTCUTS.map((shortcut) => (
          <div key={shortcut.action} className="shortcuts__row">
            <dt className="shortcuts__keys">
              {shortcut.keys.map((key, i) => (
                <span key={key}>
                  {i > 0 && <span aria-hidden="true"> + </span>}
                  <kbd className="kbd">{key}</kbd>
                </span>
              ))}
            </dt>
            <dd className="shortcuts__action">{shortcut.action}</dd>
          </div>
        ))}
      </dl>
    </SettingsGroup>
  );
}

/* ---------------- Idioma ---------------- */

export function LanguageSection() {
  return (
    <SettingsGroup title="Idioma do app" description="Outros idiomas chegam numa próxima versão.">
      <RadioCards legend="Idioma" name="language" value="pt-BR" options={[{ value: "pt-BR", title: "Português (Brasil)" }]} onChange={() => undefined} />
    </SettingsGroup>
  );
}

/* ---------------- Windows ---------------- */

export function WindowsSection({ port }: { port: PlatformPort | null }) {
  const [desktop, setDesktop] = useState<DesktopSettings | null | undefined>(undefined);
  const [status, setStatus] = useState<{ kind: "ok" | "error"; text: string } | null>(null);
  useEffect(() => {
    let alive = true;
    port
      ?.getDesktopSettings()
      .then((value) => alive && setDesktop(value))
      .catch(() => alive && setDesktop(null));
    return () => {
      alive = false;
    };
  }, [port]);

  if (desktop === undefined) return <p className="field__hint">Carregando…</p>;
  if (desktop === null) {
    return (
      <SettingsGroup title="Sistema" description="Estas opções existem só no app instalado no Windows.">
        <p className="field__hint">Baixe o Aurora para Windows para abrir junto com o sistema e ficar na bandeja.</p>
      </SettingsGroup>
    );
  }
  const change = (patch: Partial<DesktopSettings>) => {
    const next = { ...desktop, ...patch };
    setDesktop(next); // responde na hora; se o Windows recusar, volta
    setStatus(null);
    port
      ?.setDesktopSettings(next)
      .then(setDesktop)
      .catch((error: unknown) => {
        setDesktop(desktop);
        setStatus({ kind: "error", text: error instanceof Error ? error.message : "Não foi possível salvar. Tente de novo." });
      });
  };
  return (
    <SettingsGroup title="Sistema">
      <SwitchRow label="Abrir o Aurora ao iniciar o Windows" checked={desktop.openOnStartup} onChange={(openOnStartup) => change({ openOnStartup })} />
      <SwitchRow
        label="Iniciar minimizado"
        hint="Ao abrir com o Windows, fica só no ícone ao lado do relógio, sem mostrar a janela."
        checked={desktop.startMinimized}
        disabled={!desktop.openOnStartup}
        onChange={(startMinimized) => change({ startMinimized })}
      />
      <SwitchRow
        label="Fechar para a bandeja"
        hint="O X só esconde a janela: o Aurora (e a voz) continuam. Para sair de vez, clique com o botão direito no ícone ao lado do relógio."
        checked={desktop.closeToTray}
        onChange={(closeToTray) => change({ closeToTray })}
      />
      <FormStatus status={status} />
    </SettingsGroup>
  );
}

/* ---------------- Avançado ---------------- */

type CheckResult = "available" | "current" | "unsupported" | "error";
const CHECK_TEXT: Record<CheckResult, { kind: "ok" | "error"; text: string }> = {
  available: { kind: "ok", text: "Tem versão nova. Clique em “Atualizar agora” (o app fecha e volta atualizado)." },
  current: { kind: "ok", text: "Você já está na versão mais nova." },
  unsupported: { kind: "ok", text: "No navegador, você sempre usa a versão mais nova." },
  error: { kind: "error", text: "Não foi possível falar com o servidor de atualizações. Confira a conexão e tente de novo." },
};

export function AdvancedSection({
  info,
  serverUrl,
  availableUpdate,
  onCheckUpdate,
  onInstallUpdate,
}: {
  info: PlatformInfo | null;
  serverUrl: string;
  availableUpdate: UpdateInfo | null;
  onCheckUpdate: () => Promise<CheckResult>;
  onInstallUpdate: () => void;
}) {
  const [checking, setChecking] = useState(false);
  const [result, setResult] = useState<CheckResult | null>(null);
  const check = async () => {
    setChecking(true);
    setResult(await onCheckUpdate());
    setChecking(false);
  };
  const [confirmReset, setConfirmReset] = useState(false);
  const reset = () => {
    if (!confirmReset) {
      setConfirmReset(true);
      return;
    }
    settingsStore.update(() => DEFAULT_SETTINGS);
    setConfirmReset(false);
  };
  return (
    <>
      <SettingsGroup title="Sobre este app">
        <dl className="settings-facts">
          <div>
            <dt>Versão</dt>
            <dd>{info ? (info.kind === "tauri" ? info.appVersion : "web (desenvolvimento)") : "…"}</dd>
          </div>
          <div>
            <dt>Servidor</dt>
            <dd>{serverUrl}</dd>
          </div>
        </dl>
        <div className="settings-actions">
          <button type="button" className="button button--secondary" onClick={() => void check()} disabled={checking}>
            {checking ? "Procurando…" : "Procurar atualizações"}
          </button>
          {availableUpdate && (
            <button type="button" className="button button--primary" onClick={onInstallUpdate}>
              Atualizar agora (versão {availableUpdate.version})
            </button>
          )}
        </div>
        <FormStatus status={result ? CHECK_TEXT[result] : null} />
      </SettingsGroup>
      <SettingsGroup title="Recomeçar" description="Volta voz, sons, notificações, aparência e acessibilidade ao padrão. Sua conta e as opções do Windows não mudam.">
        <div>
          <button type="button" className={confirmReset ? "button button--danger" : "button button--secondary"} onClick={reset} onBlur={() => setConfirmReset(false)}>
            {confirmReset ? "Clique de novo para confirmar" : "Restaurar configurações padrão"}
          </button>
        </div>
      </SettingsGroup>
    </>
  );
}
