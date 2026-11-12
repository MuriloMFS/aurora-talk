import { describe, expect, it } from "vitest";
import type { Message, User } from "@aurora/schema";
import { AVATAR_PALETTE_SIZE, GROUP_WINDOW_MS, avatarIndex, groupMessages, initials, typingText } from "./messages";

const user = (id: string): User => ({ id, username: `u${id}`, displayName: `U${id}` });
const msg = (id: string, authorId: string, createdAt: number): Message => ({
  id,
  channelId: "c",
  author: user(authorId),
  content: id,
  createdAt,
  editedAt: null,
  replyTo: null,
  reactions: [],
  mentions: [],
});

describe("groupMessages", () => {
  it("agrupa o mesmo autor dentro da janela de 7 minutos", () => {
    const rows = groupMessages([msg("a", "1", 0), msg("b", "1", GROUP_WINDOW_MS - 1)]);
    expect(rows.map((r) => r.startsGroup)).toEqual([true, false]);
  });

  it("abre novo grupo ao trocar de autor ou passar da janela", () => {
    const rows = groupMessages([msg("a", "1", 0), msg("b", "2", 1), msg("c", "2", 1 + GROUP_WINDOW_MS)]);
    expect(rows.map((r) => r.startsGroup)).toEqual([true, true, true]);
  });
});

describe("avatarIndex", () => {
  it("é estável e sempre dentro da paleta", () => {
    for (const id of ["1", "2", "abc", "", "1234567890123456"]) {
      const value = avatarIndex(id);
      expect(value).toBe(avatarIndex(id));
      expect(value).toBeGreaterThanOrEqual(0);
      expect(value).toBeLessThan(AVATAR_PALETTE_SIZE);
    }
  });
});

describe("initials", () => {
  it("usa primeira e última palavra", () => {
    expect(initials("Ana Ribeiro")).toBe("AR");
    expect(initials("  carla  ")).toBe("C");
    expect(initials("Maria da Silva Santos")).toBe("MS");
    expect(initials("")).toBe("?");
  });
});

describe("typingText", () => {
  it("escreve a frase certa para 0, 1, 2 e 3+ pessoas", () => {
    expect(typingText([])).toBe("");
    expect(typingText(["Ana"])).toBe("Ana está digitando…");
    expect(typingText(["Ana", "Bia"])).toBe("Ana e Bia estão digitando…");
    expect(typingText(["Ana", "Bia", "Caio"])).toBe("Várias pessoas estão digitando…");
  });
});
