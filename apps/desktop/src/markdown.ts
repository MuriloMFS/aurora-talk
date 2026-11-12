/**
 * Markdown das mensagens (subconjunto no estilo de apps de chat), como ÁRVORE de dados:
 * a interface monta elementos React a partir dela — nunca HTML cru (sem risco de injeção).
 *
 *   **negrito**  *itálico*  _itálico_  __sublinhado__  ~~riscado~~  ||spoiler||
 *   `código`  ```bloco de código```  > citação  https://links  <@id> (menção)
 *   \* escapa um caractere de formatação
 */

export type Inline =
  | { type: "text"; text: string }
  | { type: "br" }
  | { type: "bold" | "italic" | "underline" | "strike" | "spoiler"; children: Inline[] }
  | { type: "code"; text: string }
  | { type: "link"; url: string }
  | { type: "mention"; userId: string };

export type Block =
  | { type: "paragraph"; children: Inline[] }
  | { type: "quote"; children: Inline[] }
  | { type: "codeblock"; lang: string | null; text: string };

const ESCAPABLE = "\\*_~|`>";
/** Caracteres escapados viram estes marcadores (área de uso privado) até o fim da análise. */
const escapeMark = (char: string) => String.fromCharCode(0xe000 + ESCAPABLE.indexOf(char));
const unescape = (text: string) => text.replace(/[-]/g, (c) => ESCAPABLE[c.charCodeAt(0) - 0xe000]!);

interface Rule {
  type: Exclude<Inline["type"], "text" | "br">;
  pattern: RegExp;
}

// Ordem = prioridade quando duas regras começam no mesmo lugar.
const RULES: Rule[] = [
  { type: "code", pattern: /`([^`\n]+)`/ },
  { type: "mention", pattern: /<@(\d{1,20})>/ },
  { type: "link", pattern: /\bhttps?:\/\/[^\s<>]*[^\s<>.,:;"')\]!?]/ },
  { type: "spoiler", pattern: /\|\|([\s\S]+?)\|\|/ },
  { type: "bold", pattern: /\*\*([\s\S]+?)\*\*/ },
  { type: "underline", pattern: /__([\s\S]+?)__/ },
  { type: "strike", pattern: /~~([\s\S]+?)~~/ },
  { type: "italic", pattern: /\*([^\s*](?:[\s\S]*?[^\s*])?)\*/ },
  // _itálico_ só entre espaços/pontuação: nomes_com_sublinhado continuam texto.
  { type: "italic", pattern: /(?<![\p{L}\p{N}_])_([^\s_](?:[^_]*?[^\s_])?)_(?![\p{L}\p{N}_])/u },
];

function textNodes(text: string): Inline[] {
  const out: Inline[] = [];
  text.split("\n").forEach((part, index) => {
    if (index > 0) out.push({ type: "br" });
    if (part) out.push({ type: "text", text: unescape(part) });
  });
  return out;
}

export function parseInline(source: string): Inline[] {
  const out: Inline[] = [];
  let rest = source;
  while (rest) {
    let best: { rule: Rule; match: RegExpExecArray } | null = null;
    for (const rule of RULES) {
      const match = rule.pattern.exec(rest);
      if (match && (!best || match.index < best.match.index)) best = { rule, match };
    }
    if (!best) {
      out.push(...textNodes(rest));
      break;
    }
    const { rule, match } = best;
    if (match.index > 0) out.push(...textNodes(rest.slice(0, match.index)));
    const inner = match[1] ?? "";
    switch (rule.type) {
      case "code":
        out.push({ type: "code", text: unescape(inner) });
        break;
      case "mention":
        out.push({ type: "mention", userId: inner });
        break;
      case "link":
        out.push({ type: "link", url: unescape(match[0]) });
        break;
      default:
        out.push({ type: rule.type, children: parseInline(inner) });
    }
    rest = rest.slice(match.index + match[0].length);
  }
  return out;
}

/** Junta linhas em parágrafos e citações (linhas que começam com "> "). */
function parseLines(text: string, blocks: Block[]): void {
  let paragraph: string[] = [];
  let quote: string[] = [];
  const flush = () => {
    if (paragraph.length) blocks.push({ type: "paragraph", children: parseInline(paragraph.join("\n")) });
    if (quote.length) blocks.push({ type: "quote", children: parseInline(quote.join("\n")) });
    paragraph = [];
    quote = [];
  };
  for (const line of text.split("\n")) {
    const quoted = /^> ?(.*)$/.exec(line);
    if (quoted) {
      if (paragraph.length) flush();
      quote.push(quoted[1]!);
    } else {
      if (quote.length) flush();
      paragraph.push(line);
    }
  }
  flush();
}

export function parseMarkdown(source: string): Block[] {
  const escaped = source.replace(/\\([\\*_~|`>])/g, (_, char: string) => escapeMark(char));
  const blocks: Block[] = [];
  const fence = /```(?:([\w+#.-]{1,20})\n)?\n?([\s\S]*?)```/g;
  let last = 0;
  for (const match of escaped.matchAll(fence)) {
    const before = escaped.slice(last, match.index).replace(/\n$/, "");
    if (before.trim()) parseLines(before, blocks);
    const text = unescape(match[2]!.replace(/\n$/, ""));
    if (text) blocks.push({ type: "codeblock", lang: match[1] ?? null, text });
    last = match.index + match[0].length;
  }
  const tail = escaped.slice(last).replace(/^\n/, "");
  if (tail.trim()) parseLines(tail, blocks);
  return blocks;
}

/** Texto puro (para notificações e trechos): sem marcação, com menções resolvidas. */
export function plainText(source: string, nameOf: (userId: string) => string): string {
  const flatten = (nodes: Inline[]): string =>
    nodes
      .map((node) => {
        switch (node.type) {
          case "text":
          case "code":
            return node.text;
          case "br":
            return " ";
          case "link":
            return node.url;
          case "mention":
            return `@${nameOf(node.userId)}`;
          case "spoiler":
            return "▒▒▒";
          default:
            return flatten(node.children);
        }
      })
      .join("");
  return parseMarkdown(source)
    .map((block) => (block.type === "codeblock" ? block.text : flatten(block.children)))
    .join(" ")
    .replace(/\s+/g, " ")
    .trim();
}
