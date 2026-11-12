import { mentionToken, type Id, type Member, type User } from "@aurora/schema";

/** Remove acentos e caixa para comparar nomes ("Ána" ~ "ana"). */
const fold = (value: string) => value.normalize("NFD").replace(/\p{M}/gu, "").toLowerCase();

/** O cursor está logo depois de um "@algo"? Devolve onde começa o "@" e o que foi digitado. */
export function mentionQueryAt(text: string, caret: number): { start: number; query: string } | null {
  const match = /(?:^|\s)@([\p{L}\p{N}._]{0,32})$/u.exec(text.slice(0, caret));
  if (!match) return null;
  return { start: caret - match[1]!.length - 1, query: match[1]! };
}

/** Sugestões para o "@": usuário ou palavra do nome de exibição começando pelo que foi digitado. */
export function filterMembers(members: Member[], query: string, limit = 8): Member[] {
  const q = fold(query);
  const score = (member: Member) => {
    const username = fold(member.user.username);
    const words = fold(member.user.displayName).split(/\s+/);
    if (!q) return 1;
    if (username.startsWith(q)) return 3;
    if (words.some((w) => w.startsWith(q))) return 2;
    return 0;
  };
  return members
    .map((member) => ({ member, score: score(member) }))
    .filter((x) => x.score > 0)
    .sort((a, b) => b.score - a.score || Number(b.member.online) - Number(a.member.online) || a.member.user.displayName.localeCompare(b.member.user.displayName, "pt-BR"))
    .slice(0, limit)
    .map((x) => x.member);
}

/** Texto digitado -> texto enviado: "@usuario" de membros vira "<@id>". Ponto final não faz parte do nome. */
export function encodeMentions(text: string, members: readonly User[]): string {
  const byUsername = new Map(members.map((user) => [user.username, user]));
  return text.replace(/(^|[^\p{L}\p{N}_.@<])@([a-z0-9_.]{2,32})/gu, (whole, before: string, name: string) => {
    let candidate = name;
    while (!byUsername.has(candidate) && candidate.endsWith(".")) candidate = candidate.slice(0, -1);
    const user = byUsername.get(candidate);
    return user ? `${before}${mentionToken(user.id)}${name.slice(candidate.length)}` : whole;
  });
}

/** Texto guardado -> texto para editar: "<@id>" volta a ser "@usuario". */
export function decodeMentions(content: string, usersById: Readonly<Record<Id, User | undefined>>): string {
  return content.replace(/<@(\d{1,20})>/g, (token, id: string) => {
    const user = usersById[id];
    return user ? `@${user.username}` : token;
  });
}
