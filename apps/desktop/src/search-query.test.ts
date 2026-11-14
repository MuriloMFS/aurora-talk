import { describe, expect, it } from "vitest";
import type { Channel, Member } from "@aurora/schema";
import { hasCriteria, highlightParts, parseDay, parseSearch } from "./search-query";

const member = (id: string, username: string, displayName: string) => ({ user: { id, username, displayName } }) as unknown as Member;
const channel = (id: string, name: string) => ({ id, name, type: "text" }) as unknown as Channel;
const ctx = {
  members: [member("1", "ana", "Ana Lima"), member("2", "joao_p", "João Pedro")],
  channels: [channel("10", "geral"), channel("11", "clipes-ação")],
};
const NOW = new Date(2026, 10, 14, 15, 0);

describe("busca de mensagens: filtros", () => {
  it("separa filtros do texto", () => {
    const q = parseSearch("mapa novo de:@ana em:#geral tem:link tem:imagem", ctx, NOW);
    expect(q).toMatchObject({ text: "mapa novo", authorId: "1", channelId: "10", has: ["link", "image"], problems: [] });
  });

  it("nomes sem acento, sem # e sem @, e pelo nome de exibição sem espaço", () => {
    expect(parseSearch("de:joaopedro", ctx, NOW).authorId).toBe("2");
    expect(parseSearch("de:JOAO_P", ctx, NOW).authorId).toBe("2");
    expect(parseSearch("em:clipes-acao", ctx, NOW).channelId).toBe("11");
  });

  it("datas: dd/mm/aaaa, dd/mm (ano atual) e aaaa-mm-dd; data impossível vira aviso", () => {
    expect(parseSearch("antes:01/11/2026", ctx, NOW).before).toBe(new Date(2026, 10, 1).getTime());
    expect(parseSearch("depois:05/03", ctx, NOW).after).toBe(new Date(2026, 2, 5).getTime());
    expect(parseDay("2026-02-28")).toBe(new Date(2026, 1, 28).getTime());
    expect(parseDay("31/02/2026")).toBeNull();
    expect(parseSearch("antes:ontem", ctx, NOW).problems).toEqual(["Data inválida em antes: use dd/mm/aaaa."]);
  });

  it("filtro sem sentido vira aviso em pt-BR", () => {
    const q = parseSearch("de:ninguem em:#nada tem:video de:", ctx, NOW);
    expect(q.problems).toEqual([
      'Ninguém aqui se chama "ninguem". Use o @usuário da pessoa.',
      'Não achei o canal "#nada".',
      '"tem:" aceita anexo, imagem ou link.',
      "Complete o filtro de: (ex.: de:@ana).",
    ]);
    expect(hasCriteria(q)).toBe(false);
    expect(hasCriteria(parseSearch("tem:anexo", ctx, NOW))).toBe(true);
  });

  it("destaca as palavras como o servidor acha (sem acento, começo de palavra)", () => {
    expect(highlightParts("Ação rápida no jogo", "acao jog")).toEqual([
      { text: "Ação", hit: true },
      { text: " rápida no ", hit: false },
      { text: "jogo", hit: true },
    ]);
    expect(highlightParts("nada aqui", "")).toEqual([{ text: "nada aqui", hit: false }]);
    expect(highlightParts("rejogar", "jog")).toEqual([{ text: "rejogar", hit: false }]);
  });
});
