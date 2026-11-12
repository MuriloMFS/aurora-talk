import { describe, expect, it } from "vitest";
import { badgeText, createPlatform, detectPlatformKind, isWebUrl } from "./index";

describe("PlatformPort", () => {
  it("detecta 'browser' fora do runtime do Tauri", () => {
    expect(detectPlatformKind()).toBe("browser");
  });

  it("a implementação browser responde sem APIs nativas", async () => {
    const platform = await createPlatform("browser");
    expect(platform.kind).toBe("browser");
    await expect(platform.getInfo()).resolves.toEqual({ kind: "browser", appVersion: "dev", systemAudio: "picker" });
  });

  it("só links da web saem do app; selo vira 9+ acima de 9", () => {
    expect(isWebUrl("https://exemplo.com/a")).toBe(true);
    expect(isWebUrl("http://192.168.0.2:3000")).toBe(true);
    for (const url of ["javascript:alert(1)", "file:///C:/Windows", "tauri://localhost", "nada"]) expect(isWebUrl(url)).toBe(false);
    expect([0, 1, 9, 10, 250].map(badgeText)).toEqual([null, "1", "9", "9+", "9+"]);
  });

  it("no navegador o som do computador vem do seletor (sem captura nativa)", async () => {
    const platform = await createPlatform("browser");
    await expect(platform.captureSystemAudio()).rejects.toThrow("seletor de tela");
  });

  it("no navegador não há atualização e instalar falha com mensagem clara", async () => {
    const platform = await createPlatform("browser");
    await expect(platform.checkForUpdate("http://localhost:3000")).resolves.toBeNull();
    await expect(platform.installUpdate()).rejects.toThrow("só existe no app instalado");
  });
});
