import { useEffect, useId, useRef, useState, type FormEvent, type KeyboardEvent as ReactKeyboardEvent } from "react";
import { Pencil, SmilePlus, X } from "lucide-react";
import { LIMITS, activeCustomStatus, type CustomStatus, type PresenceStatus, type UserStatus } from "@aurora/schema";
import { IDLE_MINUTES, patchSettings, useSettings } from "../state/settings";
import { EmojiPicker } from "./EmojiPicker";
import { Modal } from "./Modal";
import { ICON_SM } from "./shell";
import { SettingsGroup } from "./settings/controls";

/** Textos dos status (o ponto colorido sempre vem com forma e texto: guia visual §6.6). */
export const PRESENCE_LABEL: Record<PresenceStatus, string> = { online: "Online", idle: "Ausente", dnd: "Não perturbe", offline: "Offline" };
const CHOICES: { status: UserStatus; label: string; hint: string; dot: PresenceStatus }[] = [
  { status: "online", label: "Online", hint: "Fica ausente sozinho quando você para de mexer no computador.", dot: "online" },
  { status: "idle", label: "Ausente", hint: "Aparece como ausente o tempo todo.", dot: "idle" },
  { status: "dnd", label: "Não perturbe", hint: "Sem som, notificação nem ícone piscando. O número de menções continua.", dot: "dnd" },
  { status: "invisible", label: "Invisível", hint: "Aparece offline para todo mundo, mas você usa tudo normalmente.", dot: "offline" },
];
export const statusLabel = (status: UserStatus) => CHOICES.find((c) => c.status === status)!.label;

/** "📚 Estudando" */
export const customStatusText = (custom: CustomStatus | null | undefined) => {
  const active = activeCustomStatus(custom);
  return active ? [active.emoji, active.text].filter(Boolean).join(" ") : null;
};

/** Menu de status, aberto pelo meu avatar no painel do usuário. */
export function StatusMenu({
  status,
  customStatus,
  onStatus,
  onEditCustom,
  onClearCustom,
  onClose,
}: {
  status: UserStatus;
  customStatus: CustomStatus | null;
  onStatus: (status: UserStatus) => void;
  onEditCustom: () => void;
  onClearCustom: () => void;
  onClose: () => void;
}) {
  const ref = useRef<HTMLDivElement>(null);
  const items = () => [...(ref.current?.querySelectorAll<HTMLButtonElement>('[role="menuitemradio"], [role="menuitem"]') ?? [])];
  useEffect(() => {
    (items().find((b) => b.getAttribute("aria-checked") === "true") ?? items()[0])?.focus();
    const onPointer = (event: PointerEvent) => {
      if (!ref.current?.parentElement?.contains(event.target as Node)) onClose();
    };
    document.addEventListener("pointerdown", onPointer);
    return () => document.removeEventListener("pointerdown", onPointer);
  }, [onClose]);
  const onKeyDown = (event: ReactKeyboardEvent) => {
    const list = items();
    const index = list.indexOf(document.activeElement as HTMLButtonElement);
    if (event.key === "Escape") {
      event.preventDefault();
      event.stopPropagation();
      onClose();
    } else if (event.key === "ArrowDown" || event.key === "ArrowUp") {
      event.preventDefault();
      list[(index + (event.key === "ArrowDown" ? 1 : -1) + list.length) % list.length]?.focus();
    } else if (event.key === "Tab") onClose();
  };
  const custom = customStatusText(customStatus);
  return (
    <div ref={ref} className="status-menu" role="menu" aria-label="Seu status" onKeyDown={onKeyDown}>
      {CHOICES.map((choice) => (
        <button
          key={choice.status}
          type="button"
          role="menuitemradio"
          aria-checked={status === choice.status}
          className="status-menu__item"
          onClick={() => {
            onStatus(choice.status);
            onClose();
          }}
        >
          <span className={`presence presence--${choice.dot} status-menu__dot`} aria-hidden="true" />
          <span className="status-menu__text">
            <span className="status-menu__label">{choice.label}</span>
            <span className="status-menu__hint">{choice.hint}</span>
          </span>
        </button>
      ))}
      <div className="status-menu__divider" aria-hidden="true" />
      <button
        type="button"
        role="menuitem"
        className="status-menu__item"
        onClick={() => {
          onEditCustom();
          onClose();
        }}
      >
        {custom ? <Pencil {...ICON_SM} /> : <SmilePlus {...ICON_SM} />}
        <span className="status-menu__label">{custom ? `Editar: ${custom}` : "Definir status personalizado"}</span>
      </button>
      {custom && (
        <button
          type="button"
          role="menuitem"
          className="status-menu__item"
          onClick={() => {
            onClearCustom();
            onClose();
          }}
        >
          <X {...ICON_SM} />
          <span className="status-menu__label">Limpar status personalizado</span>
        </button>
      )}
    </div>
  );
}

/** Quando o status personalizado some sozinho. */
const CLEAR_AFTER: { id: string; label: string; at: (now: Date) => number | null }[] = [
  { id: "never", label: "Não limpar", at: () => null },
  { id: "30m", label: "Daqui a 30 minutos", at: (now) => now.getTime() + 30 * 60_000 },
  { id: "1h", label: "Daqui a 1 hora", at: (now) => now.getTime() + 60 * 60_000 },
  { id: "4h", label: "Daqui a 4 horas", at: (now) => now.getTime() + 4 * 60 * 60_000 },
  {
    id: "today",
    label: "Hoje (à meia-noite)",
    at: (now) => new Date(now.getFullYear(), now.getMonth(), now.getDate() + 1).getTime(),
  },
];
export const clearAfterTime = (id: string, now = new Date()) => (CLEAR_AFTER.find((c) => c.id === id) ?? CLEAR_AFTER[0]!).at(now);

export function CustomStatusDialog({ current, onSave, onClose }: { current: CustomStatus | null; onSave: (custom: CustomStatus | null) => Promise<void>; onClose: () => void }) {
  const active = activeCustomStatus(current);
  const [text, setText] = useState(active?.text ?? "");
  const [emoji, setEmoji] = useState<string | null>(active?.emoji ?? null);
  const [clearAfter, setClearAfter] = useState("never");
  const [picking, setPicking] = useState(false);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const textId = useId();
  const clearId = useId();
  const emojiButton = useRef<HTMLButtonElement>(null);
  const submit = async (event: FormEvent) => {
    event.preventDefault();
    const trimmed = text.trim();
    setBusy(true);
    setError(null);
    try {
      await onSave(trimmed || emoji ? { text: trimmed, emoji, expiresAt: clearAfterTime(clearAfter) } : null);
      onClose();
    } catch (caught) {
      setError(caught instanceof Error ? caught.message : "Não foi possível salvar o status. Tente de novo.");
      setBusy(false);
    }
  };
  return (
    <Modal title="Status personalizado" description="Aparece embaixo do seu nome para quem vê você online." onClose={onClose}>
      <form className="form" onSubmit={submit}>
        <div className="field">
          <label htmlFor={textId} className="field__label">
            O que você está fazendo?
          </label>
          <div className="custom-status__row">
            <span className="custom-status__emoji">
              <button
                ref={emojiButton}
                type="button"
                className="icon-button"
                aria-label={emoji ? `Emoji do status: ${emoji}. Trocar` : "Escolher emoji do status"}
                aria-expanded={picking}
                onClick={() => setPicking((open) => !open)}
              >
                {emoji ? <span className="custom-status__emoji-char">{emoji}</span> : <SmilePlus {...ICON_SM} />}
              </button>
              {picking && (
                <EmojiPicker
                  onPick={(picked) => {
                    setEmoji(picked);
                    setPicking(false);
                    emojiButton.current?.focus();
                  }}
                  onClose={() => setPicking(false)}
                />
              )}
            </span>
            <input id={textId} className="input" value={text} maxLength={LIMITS.customStatusMax} placeholder="Estudando, viajando, no trabalho…" onChange={(e) => setText(e.target.value)} />
            {(text || emoji) && (
              <button
                type="button"
                className="icon-button"
                aria-label="Apagar texto e emoji"
                onClick={() => {
                  setText("");
                  setEmoji(null);
                }}
              >
                <X {...ICON_SM} />
              </button>
            )}
          </div>
        </div>
        <div className="field">
          <label htmlFor={clearId} className="field__label">
            Limpar depois de
          </label>
          <select id={clearId} className="input" value={clearAfter} onChange={(e) => setClearAfter(e.target.value)}>
            {CLEAR_AFTER.map((c) => (
              <option key={c.id} value={c.id}>
                {c.label}
              </option>
            ))}
          </select>
        </div>
        {error && (
          <p className="form-error" role="alert">
            {error}
          </p>
        )}
        <div className="modal__actions">
          <button type="button" className="button button--secondary" onClick={onClose}>
            Cancelar
          </button>
          <button type="submit" className="button button--primary" disabled={busy}>
            {busy ? "Salvando…" : text.trim() || emoji ? "Salvar" : "Tirar status"}
          </button>
        </div>
      </form>
    </Modal>
  );
}

/** Minha conta → depois de quanto tempo parado o status vira "Ausente". */
export function IdleSetting() {
  const settings = useSettings();
  const id = useId();
  return (
    <SettingsGroup title="Ausente automático" description="Conta o tempo sem mexer no teclado e no mouse do computador (no navegador, só dentro da página).">
      <div className="field">
        <label htmlFor={id} className="field__label">
          Ficar ausente depois de
        </label>
        <select id={id} className="input" value={settings.presence.idleMinutes} onChange={(e) => patchSettings("presence", { idleMinutes: Number(e.target.value) })}>
          {IDLE_MINUTES.map((m) => (
            <option key={m} value={m}>
              {m === 0 ? "Nunca" : `${m} minutos`}
            </option>
          ))}
        </select>
      </div>
    </SettingsGroup>
  );
}
