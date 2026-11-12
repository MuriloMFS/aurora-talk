import { useEffect, useRef, type KeyboardEvent } from "react";

/** Emojis mais usados em reações (Unicode puro: a fonte de emoji do Windows desenha). */
export const COMMON_EMOJIS = [
  "👍", "❤️", "😂", "🎉", "🔥", "👀", "😮", "😢",
  "😡", "👎", "✅", "❌", "🙏", "👏", "💯", "🤔",
  "😍", "🥳", "😎", "🤣", "😅", "😭", "🙌", "💪",
  "🤝", "👋", "✨", "⭐", "🚀", "🎮", "🍕", "☕",
  "😴", "🤯", "😬", "🫡", "🤡", "💀", "🥲", "😇",
] as const;

const COLUMNS = 8;
const RECENT_KEY = "aurora.recentEmojis";
const RECENT_MAX = COLUMNS;

export function loadRecentEmojis(): string[] {
  try {
    const saved = JSON.parse(localStorage.getItem(RECENT_KEY) ?? "[]") as unknown;
    return Array.isArray(saved) ? saved.filter((e): e is string => typeof e === "string").slice(0, RECENT_MAX) : [];
  } catch {
    return [];
  }
}

export function rememberEmoji(emoji: string): void {
  try {
    localStorage.setItem(RECENT_KEY, JSON.stringify([emoji, ...loadRecentEmojis().filter((e) => e !== emoji)].slice(0, RECENT_MAX)));
  } catch {
    // sem armazenamento: só não lembra
  }
}

/** Popover de reações. Setas navegam, Enter escolhe, Esc fecha (o foco volta para quem abriu). */
export function EmojiPicker({ onPick, onClose }: { onPick: (emoji: string) => void; onClose: () => void }) {
  const ref = useRef<HTMLDivElement>(null);
  const recent = loadRecentEmojis();

  useEffect(() => {
    ref.current?.querySelector<HTMLButtonElement>("button")?.focus();
    const onPointer = (event: PointerEvent) => {
      if (!ref.current?.contains(event.target as Node)) onClose();
    };
    document.addEventListener("pointerdown", onPointer);
    return () => document.removeEventListener("pointerdown", onPointer);
  }, [onClose]);

  const onKeyDown = (event: KeyboardEvent<HTMLDivElement>) => {
    if (event.key === "Escape") {
      event.preventDefault();
      event.stopPropagation();
      onClose();
      return;
    }
    const step = { ArrowRight: 1, ArrowLeft: -1, ArrowDown: COLUMNS, ArrowUp: -COLUMNS }[event.key];
    if (!step) return;
    event.preventDefault();
    const buttons = [...(ref.current?.querySelectorAll<HTMLButtonElement>("button") ?? [])];
    const index = buttons.indexOf(document.activeElement as HTMLButtonElement);
    buttons[Math.min(Math.max(index + step, 0), buttons.length - 1)]?.focus();
  };

  const pick = (emoji: string) => {
    rememberEmoji(emoji);
    onPick(emoji);
  };

  const grid = (label: string, emojis: readonly string[]) => (
    <div className="emoji-picker__section" role="group" aria-label={label}>
      <span className="emoji-picker__label" aria-hidden="true">
        {label}
      </span>
      <div className="emoji-picker__grid">
        {emojis.map((emoji) => (
          <button key={emoji} type="button" className="emoji-picker__item" aria-label={`Reagir com ${emoji}`} onClick={() => pick(emoji)}>
            {emoji}
          </button>
        ))}
      </div>
    </div>
  );

  return (
    <div ref={ref} className="emoji-picker" role="dialog" aria-label="Escolher reação" onKeyDown={onKeyDown}>
      {recent.length > 0 && grid("Recentes", recent)}
      {grid("Mais usados", COMMON_EMOJIS)}
    </div>
  );
}
