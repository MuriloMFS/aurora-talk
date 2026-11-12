import { describe, expect, it } from "vitest";
import { LIMITS, extractMentionIds, isValidEmoji, mentionToken, normalizeChannelName, normalizeVoiceChannelName } from "./index.ts";

describe("normalizeVoiceChannelName", () => {
  it("mantém espaços e maiúsculas, só aparando e juntando espaços", () => {
    expect(normalizeVoiceChannelName("  Sala   de  Estar ")).toBe("Sala de Estar");
    expect(normalizeVoiceChannelName("   ")).toBe("");
  });
});

describe("normalizeChannelName", () => {
  it("gera minúsculas com hífen, preservando acentos", () => {
    expect(normalizeChannelName("  Fora do Tópico  ")).toBe("fora-do-tópico");
    expect(normalizeChannelName("Anúncios!!!")).toBe("anúncios");
    expect(normalizeChannelName("a   b---c")).toBe("a-b-c");
  });

  it("remove hífens nas pontas e caracteres não permitidos", () => {
    expect(normalizeChannelName("--#geral--")).toBe("geral");
    expect(normalizeChannelName("@@@")).toBe("");
  });

  it("respeita o tamanho máximo", () => {
    expect(normalizeChannelName("x".repeat(500))).toHaveLength(LIMITS.channelNameMax);
  });
});

describe("menções", () => {
  it("token <@id> e extração sem repetir, na ordem do texto", () => {
    expect(mentionToken("42")).toBe("<@42>");
    expect(extractMentionIds("oi <@2> e <@1>, de novo <@2>")).toEqual(["2", "1"]);
    expect(extractMentionIds("<@abc> <@> @fulano")).toEqual([]);
  });
});

describe("isValidEmoji", () => {
  it("aceita emojis, tons de pele, bandeiras e combinações", () => {
    for (const emoji of ["👍", "👍🏽", "❤️", "🏳️‍🌈", "🇧🇷", "👨‍👩‍👧"]) expect(isValidEmoji(emoji)).toBe(true);
  });
  it("recusa texto, números soltos, espaço e vazio", () => {
    for (const value of ["oi", "1", " ", "", "👍 ", "<b>", "a👍"]) expect(isValidEmoji(value)).toBe(false);
  });
});
