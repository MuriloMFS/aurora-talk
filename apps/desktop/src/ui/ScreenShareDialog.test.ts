import { describe, expect, it } from "vitest";
import { audioHint, loadScreenShareOptions, screenShareErrorMessage } from "./ScreenShareDialog";

describe("som na transmissão de tela", () => {
  it("app instalado: promete sem eco só quando a captura é nativa", () => {
    expect(audioHint(true, "native", false)).toContain("ficam de fora, sem eco");
  });
  it("navegador sem exclusão do próprio áudio: avisa do eco", () => {
    expect(audioHint(true, "picker", false)).toContain("ouve o próprio eco");
    expect(audioHint(true, "picker", true)).toContain("sem eco");
  });
  it("desligado: só a imagem", () => {
    expect(audioHint(false, "native", true)).toContain("Só a imagem");
  });
  it("sem armazenamento: padrão com som ligado", () => {
    expect(loadScreenShareOptions()).toEqual({ surface: "monitor", quality: "standard", systemAudio: true });
  });
  it("falha de áudio sugere desligar a chave de som", () => {
    const error = Object.assign(new Error("Could not start audio source"), { name: "NotReadableError" });
    expect(screenShareErrorMessage(error)).toContain("Transmitir o som do computador");
  });
});
