import { describe, expect, it } from "vitest";
import { parseInline, parseMarkdown, plainText } from "./markdown";

const t = (text: string) => ({ type: "text", text });

describe("parseInline", () => {
  it("texto simples e quebras de linha", () => {
    expect(parseInline("oi\ntudo bem")).toEqual([t("oi"), { type: "br" }, t("tudo bem")]);
  });

  it("negrito, itálico (* e _), sublinhado, riscado e spoiler, inclusive aninhados", () => {
    expect(parseInline("**forte _e itálico_**")).toEqual([{ type: "bold", children: [t("forte "), { type: "italic", children: [t("e itálico")] }] }]);
    expect(parseInline("_leve_ __sub__ ~~fora~~ ||segredo||")).toEqual([
      { type: "italic", children: [t("leve")] },
      t(" "),
      { type: "underline", children: [t("sub")] },
      t(" "),
      { type: "strike", children: [t("fora")] },
      t(" "),
      { type: "spoiler", children: [t("segredo")] },
    ]);
  });

  it("nomes_com_sublinhado e 2 * 3 * 4 continuam texto", () => {
    expect(parseInline("arquivo_de_teste.ts")).toEqual([t("arquivo_de_teste.ts")]);
    expect(parseInline("2 * 3 * 4")).toEqual([t("2 * 3 * 4")]);
  });

  it("código em linha não interpreta nada dentro", () => {
    expect(parseInline("use `**não negrito**` aqui")).toEqual([t("use "), { type: "code", text: "**não negrito**" }, t(" aqui")]);
  });

  it("links sem a pontuação final; menções", () => {
    expect(parseInline("veja https://exemplo.com/a?b=1, e <@42>.")).toEqual([
      t("veja "),
      { type: "link", url: "https://exemplo.com/a?b=1" },
      t(", e "),
      { type: "mention", userId: "42" },
      t("."),
    ]);
  });

  it("javascript: e outros esquemas não viram link", () => {
    expect(parseInline("javascript:alert(1)")).toEqual([t("javascript:alert(1)")]);
  });

  it("HTML é só texto", () => {
    expect(parseInline("<b>oi</b><img src=x onerror=alert(1)>")).toEqual([t("<b>oi</b><img src=x onerror=alert(1)>")]);
  });
});

describe("parseMarkdown", () => {
  it("bloco de código com linguagem, entre parágrafos", () => {
    expect(parseMarkdown("antes\n```ts\nconst a = 1;\n```\ndepois")).toEqual([
      { type: "paragraph", children: [t("antes")] },
      { type: "codeblock", lang: "ts", text: "const a = 1;" },
      { type: "paragraph", children: [t("depois")] },
    ]);
  });

  it("bloco de código na mesma linha e sem fechar fica texto", () => {
    expect(parseMarkdown("```oi```")).toEqual([{ type: "codeblock", lang: null, text: "oi" }]);
    expect(parseMarkdown("```sem fim")).toEqual([{ type: "paragraph", children: [t("```sem fim")] }]);
  });

  it("citações agrupam linhas seguidas", () => {
    expect(parseMarkdown("> um\n> **dois**\nfim")).toEqual([
      { type: "quote", children: [t("um"), { type: "br" }, { type: "bold", children: [t("dois")] }] },
      { type: "paragraph", children: [t("fim")] },
    ]);
  });

  it("escape: \\* mostra o asterisco literal", () => {
    expect(parseMarkdown("\\*\\*não negrito\\*\\*")).toEqual([{ type: "paragraph", children: [t("**não negrito**")] }]);
  });
});

describe("plainText", () => {
  it("tira a marcação, resolve menções e esconde spoiler", () => {
    expect(plainText("**oi** <@1>, ||surpresa||\n> citação", (id) => (id === "1" ? "Ana" : "?"))).toBe("oi @Ana, ▒▒▒ citação");
  });
});
