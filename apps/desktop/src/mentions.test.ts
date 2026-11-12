import { describe, expect, it } from "vitest";
import type { Member, User } from "@aurora/schema";
import { decodeMentions, encodeMentions, filterMembers, mentionQueryAt } from "./mentions";

const ana: User = { id: "1", username: "ana", displayName: "Ána Lima" };
const bruno: User = { id: "2", username: "bruno.s", displayName: "Bruno" };
const beto: User = { id: "3", username: "beto", displayName: "Roberto Alves" };
const member = (user: User, online = true): Member => ({ user, joinedAt: 0, online });

describe("mentionQueryAt", () => {
  it("detecta o @ no começo ou depois de espaço", () => {
    expect(mentionQueryAt("@an", 3)).toEqual({ start: 0, query: "an" });
    expect(mentionQueryAt("oi @", 4)).toEqual({ start: 3, query: "" });
    expect(mentionQueryAt("oi @bruno.s", 11)).toEqual({ start: 3, query: "bruno.s" });
  });
  it("e-mail e texto depois de espaço não abrem sugestões", () => {
    expect(mentionQueryAt("ana@exemplo", 11)).toBeNull();
    expect(mentionQueryAt("@ana oi", 7)).toBeNull();
  });
});

describe("filterMembers", () => {
  const members = [member(ana), member(bruno, false), member(beto)];
  it("usuário primeiro, depois palavra do nome; sem acento e sem caixa", () => {
    expect(filterMembers(members, "b").map((m) => m.user.id)).toEqual(["3", "2"]); // online antes
    expect(filterMembers(members, "ALV").map((m) => m.user.id)).toEqual(["3"]);
    expect(filterMembers(members, "ana").map((m) => m.user.id)).toEqual(["1"]);
    expect(filterMembers(members, "lima").map((m) => m.user.id)).toEqual(["1"]);
  });
  it("vazio lista todos (até o limite)", () => {
    expect(filterMembers(members, "", 2)).toHaveLength(2);
  });
});

describe("encodeMentions / decodeMentions", () => {
  const users = [ana, bruno, beto];
  it("vira <@id> só para membros; ponto final e e-mail ficam como estão", () => {
    expect(encodeMentions("oi @ana e @bruno.s. Tchau @fulano", users)).toBe("oi <@1> e <@2>. Tchau @fulano");
    expect(encodeMentions("@beto!", users)).toBe("<@3>!");
    expect(encodeMentions("escreva para ana@beto.com", users)).toBe("escreva para ana@beto.com");
  });
  it("volta para @usuario ao editar (id desconhecido fica como token)", () => {
    expect(decodeMentions("oi <@1> e <@9>", { "1": ana })).toBe("oi @ana e <@9>");
  });
});
