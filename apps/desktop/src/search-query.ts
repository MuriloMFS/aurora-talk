import type { Channel, Id, Member, SearchHas } from "@aurora/schema";

/**
 * Texto da busca de mensagens → o que vai para o servidor. Filtros (sempre `nome:valor`, sem espaço):
 *   de:@pessoa · em:#canal · tem:anexo|imagem|link · antes:dd/mm/aaaa · depois:dd/mm/aaaa
 * O resto é o texto procurado. Valor que não faz sentido vira um aviso, nunca um erro silencioso.
 */
export interface ParsedSearch {
  text: string;
  authorId?: Id;
  channelId?: Id;
  has: SearchHas[];
  /** Instantes em ms (antes: até o começo do dia; depois: a partir do começo do dia). */
  before?: number;
  after?: number;
  /** Frases em pt-BR do que não deu para entender. */
  problems: string[];
}

const HAS_WORDS: Record<string, SearchHas> = { anexo: "file", arquivo: "file", imagem: "image", foto: "image", link: "link" };

/** "dd/mm/aaaa", "dd/mm" (ano atual) ou "aaaa-mm-dd" → meia-noite local daquele dia. */
export function parseDay(value: string, now = new Date()): number | null {
  let year: number;
  let month: number;
  let day: number;
  let m: RegExpExecArray | null;
  if ((m = /^(\d{1,2})\/(\d{1,2})(?:\/(\d{4}))?$/.exec(value))) {
    day = Number(m[1]);
    month = Number(m[2]);
    year = m[3] ? Number(m[3]) : now.getFullYear();
  } else if ((m = /^(\d{4})-(\d{1,2})-(\d{1,2})$/.exec(value))) {
    year = Number(m[1]);
    month = Number(m[2]);
    day = Number(m[3]);
  } else return null;
  const date = new Date(year, month - 1, day);
  if (date.getFullYear() !== year || date.getMonth() !== month - 1 || date.getDate() !== day) return null; // 31/02 etc.
  return date.getTime();
}

const fold = (text: string) => text.normalize("NFD").replace(/\p{M}/gu, "").toLowerCase();

export function parseSearch(input: string, ctx: { members: readonly Member[]; channels: readonly Channel[] }, now = new Date()): ParsedSearch {
  const result: ParsedSearch = { text: "", has: [], problems: [] };
  const words: string[] = [];
  for (const token of input.trim().split(/\s+/).filter(Boolean)) {
    const m = /^(de|em|tem|antes|depois):(.*)$/i.exec(token);
    if (!m) {
      words.push(token);
      continue;
    }
    const key = m[1]!.toLowerCase();
    const value = m[2]!;
    if (!value) {
      result.problems.push(`Complete o filtro ${key}: (ex.: ${EXAMPLES[key]}).`);
      continue;
    }
    if (key === "de") {
      const wanted = fold(value.replace(/^@/, ""));
      const member =
        ctx.members.find((x) => fold(x.user.username) === wanted) ??
        ctx.members.find((x) => fold(x.user.displayName).replace(/\s+/g, "") === wanted.replace(/\s+/g, ""));
      if (member) result.authorId = member.user.id;
      else result.problems.push(`Ninguém aqui se chama "${value}". Use o @usuário da pessoa.`);
    } else if (key === "em") {
      const wanted = fold(value.replace(/^#/, ""));
      const channel = ctx.channels.find((c) => fold(c.name) === wanted);
      if (channel) result.channelId = channel.id;
      else result.problems.push(`Não achei o canal "${value}".`);
    } else if (key === "tem") {
      const kind = HAS_WORDS[fold(value)];
      if (kind) {
        if (!result.has.includes(kind)) result.has.push(kind);
      } else result.problems.push(`"tem:" aceita anexo, imagem ou link.`);
    } else {
      const day = parseDay(value, now);
      if (day === null) result.problems.push(`Data inválida em ${key}: use dd/mm/aaaa.`);
      else if (key === "antes") result.before = day;
      else result.after = day;
    }
  }
  result.text = words.join(" ");
  return result;
}

const EXAMPLES: Record<string, string> = { de: "de:@ana", em: "em:#geral", tem: "tem:imagem", antes: "antes:01/11/2026", depois: "depois:01/11/2026" };

/** A busca tem algo para procurar? (o servidor recusa busca vazia) */
export const hasCriteria = (q: ParsedSearch) =>
  q.text.trim().length > 0 || q.authorId !== undefined || q.channelId !== undefined || q.has.length > 0 || q.before !== undefined || q.after !== undefined;

/** Sugestões de filtro para mostrar enquanto a pessoa digita. */
export const SEARCH_HINTS: { filter: string; label: string }[] = [
  { filter: "de:", label: "de uma pessoa" },
  { filter: "em:", label: "num canal" },
  { filter: "tem:", label: "anexo, imagem ou link" },
  { filter: "antes:", label: "antes de uma data" },
  { filter: "depois:", label: "depois de uma data" },
];

/**
 * Partes do texto com as palavras procuradas marcadas (sem acento e por começo de palavra, igual ao
 * servidor). Para destacar no resultado.
 */
export function highlightParts(content: string, query: string): { text: string; hit: boolean }[] {
  const terms = (fold(query).match(/[\p{L}\p{N}]+/gu) ?? []).filter(Boolean);
  if (terms.length === 0 || !content) return [{ text: content, hit: false }];
  const parts: { text: string; hit: boolean }[] = [];
  // percorre as palavras do conteúdo; o mapeamento de posição usa o texto original
  const wordRe = /[\p{L}\p{N}]+/gu;
  let last = 0;
  for (const match of content.matchAll(wordRe)) {
    const word = match[0];
    const start = match.index ?? 0;
    if (!terms.some((t) => fold(word).startsWith(t))) continue;
    if (start > last) parts.push({ text: content.slice(last, start), hit: false });
    parts.push({ text: word, hit: true });
    last = start + word.length;
  }
  if (last < content.length) parts.push({ text: content.slice(last), hit: false });
  return parts.length > 0 ? parts : [{ text: content, hit: false }];
}
