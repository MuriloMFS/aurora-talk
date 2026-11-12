import { describe, expect, it } from "vitest";
import { DEFAULT_THEME, isThemePreference, nextPreference, readPreference, resolveTheme } from "./theme";

describe("resolveTheme", () => {
  it("respeita escolha explícita independentemente do sistema", () => {
    expect(resolveTheme("dark", false)).toBe("dark");
    expect(resolveTheme("light", true)).toBe("light");
  });

  it("segue o sistema quando a preferência é 'system'", () => {
    expect(resolveTheme("system", true)).toBe("dark");
    expect(resolveTheme("system", false)).toBe("light");
  });
});

describe("nextPreference", () => {
  it("percorre escuro → claro → sistema → escuro", () => {
    expect(nextPreference("dark")).toBe("light");
    expect(nextPreference("light")).toBe("system");
    expect(nextPreference("system")).toBe("dark");
  });
});

describe("isThemePreference", () => {
  it("rejeita valores desconhecidos", () => {
    expect(isThemePreference("dark")).toBe(true);
    expect(isThemePreference("blue")).toBe(false);
    expect(isThemePreference(null)).toBe(false);
  });
});

describe("readPreference", () => {
  it("usa o padrão quando não há armazenamento disponível", () => {
    expect(readPreference()).toBe(DEFAULT_THEME);
  });
});
