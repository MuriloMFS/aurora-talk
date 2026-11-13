import { describe, expect, it } from "vitest";
import type { Member, Role, User } from "@aurora/schema";
import { auditDetail, auditSentence, highestRole, memberColor, memberGroups, untilText } from "./roles";

const role = (id: string, position: number, extra: Partial<Role> = {}): Role => ({ id, guildId: "10", name: id, color: null, position, permissions: 0, hoist: false, ...extra });
const user = (id: string, displayName: string): User => ({ id, username: displayName.toLowerCase(), displayName });
const member = (u: User, online: boolean, roles: string[] = []): Member => ({ user: u, joinedAt: 0, online, roles });

const roles = [role("10", 0, { name: "@todos" }), role("mod", 3, { name: "Moderação", hoist: true, color: 2 }), role("vip", 2, { name: "VIP", hoist: true }), role("dj", 1, { name: "DJ", color: 6 })];

describe("cargos na interface", () => {
  it("cargo mais alto e a cor: vale a do cargo colorido mais alto", () => {
    expect(highestRole(roles, ["dj", "vip"])?.id).toBe("vip");
    expect(memberColor(roles, { roles: ["dj", "vip"] })).toBe(6); // VIP é mais alto, mas não tem cor
    expect(memberColor(roles, { roles: ["mod", "dj"] })).toBe(2);
    expect(memberColor(roles, { roles: [] })).toBeNull();
  });

  it("lista de membros: grupos dos cargos separados, depois Online e Offline (offline não separa por cargo)", () => {
    const groups = memberGroups(
      [
        member(user("1", "Zé"), true, ["mod", "vip"]),
        member(user("2", "Ana"), true, ["vip"]),
        member(user("3", "Bia"), true, ["dj"]),
        member(user("4", "Caio"), false, ["mod"]),
        member(user("5", "Duda"), true),
      ],
      roles,
    );
    expect(groups.map((g) => [g.label, g.members.map((m) => m.user.displayName)])).toEqual([
      ["Moderação", ["Zé"]],
      ["VIP", ["Ana"]],
      ["Online", ["Bia", "Duda"]],
      ["Offline", ["Caio"]],
    ]);
  });

  it("registro de auditoria em português", () => {
    const ana = user("1", "Ana");
    expect(auditSentence({ actor: ana, action: "member_kick", targetName: "caio", detail: null })).toBe("Ana expulsou caio");
    expect(auditSentence({ actor: ana, action: "member_role_add", targetName: "Beto", detail: "Moderação" })).toBe("Ana deu o cargo Moderação a Beto");
    expect(auditSentence({ actor: null, action: "channel_delete", targetName: "#memes", detail: null })).toBe("Alguém excluiu o canal #memes");
    expect(auditDetail({ action: "member_ban", detail: "flood" })).toBe("Motivo: flood");
    expect(auditDetail({ action: "member_role_add", detail: "Moderação" })).toBeNull();
    expect(auditDetail({ action: "guild_update", detail: "nome: A → B" })).toBe("nome: A → B");
    expect(auditSentence({ actor: ana, action: "member_timeout", targetName: "caio", detail: "10 minutos" })).toBe("Ana deixou caio de castigo por 10 minutos");
    expect(auditDetail({ action: "member_timeout", detail: "10 minutos" })).toBeNull();
    const now = new Date(2026, 10, 13, 9, 0).getTime();
    expect(untilText(new Date(2026, 10, 13, 14, 32).getTime(), now)).toBe("até 14:32");
    expect(untilText(new Date(2026, 10, 15, 8, 5).getTime(), now)).toBe("até 15/11, 08:05");
    expect(auditSentence({ actor: ana, action: "voice_move", targetName: "caio", detail: "Sala → Sala 2" })).toBe("Ana moveu caio na voz");
    expect(auditDetail({ action: "voice_move", detail: "Sala → Sala 2" })).toBe("Sala → Sala 2");
    expect(auditSentence({ actor: ana, action: "channel_permissions", targetName: "#staff", detail: "@todos: bloqueia Ver canais" })).toBe("Ana mudou as permissões do canal #staff");
  });
});
