/**
 * Resolução e persistência do tema (guia visual §3.1 e §9).
 * - Preferência: escuro (padrão) · claro · seguir o sistema.
 * - O tema efetivo vai sempre em `data-theme` no <html>.
 * - O script inline em index.html aplica o tema antes do 1º paint (sem flash);
 *   ele precisa usar a mesma chave de armazenamento (`THEME_STORAGE_KEY`).
 */
export type ThemePreference = "dark" | "light" | "system";
export type ResolvedTheme = "dark" | "light";

export const THEME_STORAGE_KEY = "aurora.theme";
export const DEFAULT_THEME: ThemePreference = "dark";
const PREFERENCES: readonly ThemePreference[] = ["dark", "light", "system"];

export function isThemePreference(value: unknown): value is ThemePreference {
  return typeof value === "string" && (PREFERENCES as readonly string[]).includes(value);
}

export function resolveTheme(preference: ThemePreference, systemPrefersDark: boolean): ResolvedTheme {
  if (preference === "system") return systemPrefersDark ? "dark" : "light";
  return preference;
}

/** Próxima preferência no ciclo escuro → claro → sistema → escuro. */
export function nextPreference(current: ThemePreference): ThemePreference {
  const index = PREFERENCES.indexOf(current);
  return PREFERENCES[(index + 1) % PREFERENCES.length] ?? DEFAULT_THEME;
}

export function readPreference(): ThemePreference {
  try {
    const stored = globalThis.localStorage?.getItem(THEME_STORAGE_KEY);
    return isThemePreference(stored) ? stored : DEFAULT_THEME;
  } catch {
    return DEFAULT_THEME; // armazenamento bloqueado: usa o padrão
  }
}

export function savePreference(preference: ThemePreference): void {
  try {
    globalThis.localStorage?.setItem(THEME_STORAGE_KEY, preference);
  } catch {
    // sem persistência; o tema continua aplicado nesta sessão
  }
}

function systemPrefersDark(): boolean {
  return globalThis.matchMedia?.("(prefers-color-scheme: dark)").matches ?? true;
}

export function applyTheme(preference: ThemePreference): ResolvedTheme {
  const resolved = resolveTheme(preference, systemPrefersDark());
  document.documentElement.dataset.theme = resolved;
  return resolved;
}

/** Reaplica o tema quando o SO muda, enquanto a preferência for "system". Retorna o cancelamento. */
export function watchSystemTheme(getPreference: () => ThemePreference, onChange: (t: ResolvedTheme) => void): () => void {
  const media = globalThis.matchMedia?.("(prefers-color-scheme: dark)");
  if (!media) return () => {};
  const listener = () => {
    if (getPreference() === "system") onChange(applyTheme("system"));
  };
  media.addEventListener("change", listener);
  return () => media.removeEventListener("change", listener);
}
