import { describe, expect, it } from "vitest";
import { LIMITS } from "@aurora/schema";
import { admitFiles, formatBytes } from "./attachments";

describe("anexos no app", () => {
  it("tamanho legível", () => {
    expect(formatBytes(512)).toBe("512 B");
    expect(formatBytes(820 * 1024)).toBe("820 KB");
    expect(formatBytes(3.4 * 1024 * 1024)).toBe("3,4 MB");
    expect(formatBytes(24 * 1024 * 1024)).toBe("24 MB");
  });

  it("fila: até 10 por mensagem; grande demais ou vazio entra marcado com erro", () => {
    const ok = { size: 10 };
    const big = { size: LIMITS.attachmentMaxBytes + 1 };
    const result = admitFiles(8, [ok, big, ok, ok]);
    expect(result.accepted.map((a) => a.error)).toEqual([null, "Passa de 25 MB"]);
    expect(result.overflow).toBe("Dá para enviar até 10 arquivos por mensagem. 2 ficaram de fora.");
    expect(admitFiles(0, [{ size: 0 }]).accepted[0]!.error).toBe("Arquivo vazio");
    expect(admitFiles(10, [ok]).overflow).toMatch(/Um ficou de fora/);
  });
});
