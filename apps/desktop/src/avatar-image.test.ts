import { describe, expect, it } from "vitest";
import { centerCrop, centerSquare, fileUrl, setMediaBase } from "./avatar-image";

describe("foto de perfil", () => {
  it("recorta o quadrado central de fotos em pé, deitadas e quadradas", () => {
    expect(centerSquare(1000, 600)).toEqual({ sx: 200, sy: 0, size: 600 });
    expect(centerSquare(600, 1001)).toEqual({ sx: 0, sy: 200, size: 600 });
    expect(centerSquare(256, 256)).toEqual({ sx: 0, sy: 0, size: 256 });
  });

  it("endereço da foto vem do servidor da sessão", () => {
    setMediaBase("https://aurora.exemplo.dev/");
    expect(fileUrl("123")).toBe("https://aurora.exemplo.dev/api/files/123");
  });

  it("capa: recorte central em 16:9 de fotos em pé, deitadas e já 16:9", () => {
    expect(centerCrop(1920, 1080, 16 / 9)).toEqual({ sx: 0, sy: 0, sw: 1920, sh: 1080 });
    expect(centerCrop(1000, 1000, 16 / 9)).toEqual({ sx: 0, sy: 218, sw: 1000, sh: 563 });
    expect(centerCrop(3000, 1000, 16 / 9)).toEqual({ sx: 611, sy: 0, sw: 1778, sh: 1000 });
  });
});
