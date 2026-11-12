import { describe, expect, it } from "vitest";
import { SCREEN_SHARE_PROFILES, canExcludeOwnAudio, classifyScreenShareError, displayMediaOptions } from "./screen-share";

const domError = (name: string, message = "") => Object.assign(new Error(message), { name });

describe("displayMediaOptions", () => {
  it("abre o seletor na tela inteira e oferece o áudio do sistema", () => {
    const options = displayMediaOptions({ surface: "monitor", quality: "standard" });
    expect(options.video).toMatchObject({ displaySurface: "monitor", width: { ideal: 1920 }, height: { ideal: 1080 }, frameRate: { ideal: 30, max: 30 } });
    expect(options.audio).toBe(true);
    expect(options.systemAudio).toBe("include");
    expect(options.selfBrowserSurface).toBe("exclude");
    expect(options.monitorTypeSurfaces).toBe("include");
  });

  it("'uma janela' esconde a aba de telas do seletor", () => {
    const options = displayMediaOptions({ surface: "window", quality: "light" });
    expect(options.video).toMatchObject({ displaySurface: "window", width: { ideal: 1280 } });
    expect(options.monitorTypeSurfaces).toBe("exclude");
  });

  it("áudio pelo seletor: com suporte, tira o som do próprio app da captura (sem eco)", () => {
    expect(displayMediaOptions({ surface: "monitor", quality: "standard" }, { audio: "picker", excludeOwnAudio: true }).audio).toEqual({ restrictOwnAudio: true });
    expect(displayMediaOptions({ surface: "monitor", quality: "standard" }, { audio: "picker", excludeOwnAudio: false }).audio).toBe(true);
  });

  it("áudio nativo (ou sem som): o seletor nem oferece áudio", () => {
    const options = displayMediaOptions({ surface: "monitor", quality: "standard" }, { audio: "none", excludeOwnAudio: true });
    expect(options.audio).toBe(false);
    expect(options.systemAudio).toBe("exclude");
  });

  it("sem navegador (Node), não promete excluir o próprio áudio", () => {
    expect(canExcludeOwnAudio()).toBe(false);
  });

  it("nunca usa min/exact (getDisplayMedia rejeita com TypeError)", () => {
    for (const quality of ["light", "standard", "smooth"] as const) {
      const text = JSON.stringify(displayMediaOptions({ surface: "monitor", quality }));
      expect(text).not.toMatch(/"(min|exact)"/);
    }
  });

  it("perfis: fluida é 60 fps e prioriza movimento; as outras, nitidez", () => {
    expect(SCREEN_SHARE_PROFILES.smooth).toMatchObject({ frameRate: 60, contentHint: "motion" });
    expect(SCREEN_SHARE_PROFILES.standard.contentHint).toBe("detail");
    expect(SCREEN_SHARE_PROFILES.light.maxBitrate).toBeLessThan(SCREEN_SHARE_PROFILES.standard.maxBitrate);
  });
});

describe("classifyScreenShareError", () => {
  it("fechar o seletor é cancelamento, não erro", () => {
    expect(classifyScreenShareError(domError("NotAllowedError", "Permission denied"))).toBe("cancelled");
  });
  it("bloqueio do sistema operacional", () => {
    expect(classifyScreenShareError(domError("NotAllowedError", "Permission denied by system"))).toBe("blocked");
  });
  it("falha do áudio do sistema", () => {
    expect(classifyScreenShareError(domError("NotReadableError", "Could not start audio source"))).toBe("audio");
  });
  it("captura ocupada/abortada", () => {
    expect(classifyScreenShareError(domError("NotReadableError", "Could not start video source"))).toBe("busy");
    expect(classifyScreenShareError(domError("AbortError", "Invalid state"))).toBe("busy");
  });
  it("sem suporte e desconhecidos", () => {
    expect(classifyScreenShareError(domError("NotSupportedError"))).toBe("unsupported");
    expect(classifyScreenShareError(new Error("timeout"))).toBe("unknown");
    expect(classifyScreenShareError(null)).toBe("unknown");
  });
});
