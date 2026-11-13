import { describe, expect, it } from "vitest";
import { centerSquare, fileUrl, setMediaBase } from "./avatar-image";

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
});
