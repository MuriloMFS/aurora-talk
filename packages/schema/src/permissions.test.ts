import { describe, expect, it } from "vitest";
import {
  ALL_PERMISSIONS,
  DEFAULT_EVERYONE_PERMISSIONS,
  PERMISSIONS,
  PERMISSION_INFO,
  CHANNEL_PERMISSIONS,
  canManageRole,
  canModerate,
  clampGrantedPermissions,
  computeChannelPermissions,
  computePermissions,
  hasPermission,
  highestPosition,
  isPrivateChannel,
  type Overwrite,
  type PermissionContext,
  type Role,
} from "./permissions.ts";

const GUILD = "100";
const OWNER = "1";
const role = (id: string, position: number, permissions: number): Role => ({ id, guildId: GUILD, name: id, color: null, position, permissions, hoist: false });

/** Gerador determinístico (os testes de propriedade se repetem igual em qualquer máquina). */
function rng(seed: number) {
  let state = seed >>> 0;
  return () => {
    state = (state * 1664525 + 1013904223) >>> 0;
    return state / 2 ** 32;
  };
}

function randomGuild(next: () => number): PermissionContext {
  const count = 1 + Math.floor(next() * 6);
  const roles = [role(GUILD, 0, Math.floor(next() * (ALL_PERMISSIONS + 1)) & ~PERMISSIONS.ADMINISTRATOR)];
  for (let i = 1; i <= count; i++) roles.push(role(String(200 + i), i, Math.floor(next() * (ALL_PERMISSIONS + 1))));
  return { guildId: GUILD, ownerId: OWNER, roles };
}
const randomRoles = (next: () => number, ctx: PermissionContext) => ctx.roles.filter((r) => r.id !== GUILD && next() < 0.4).map((r) => r.id);

describe("permissões (exemplos)", () => {
  const ctx: PermissionContext = {
    guildId: GUILD,
    ownerId: OWNER,
    roles: [role(GUILD, 0, DEFAULT_EVERYONE_PERMISSIONS), role("mod", 2, PERMISSIONS.KICK_MEMBERS | PERMISSIONS.MANAGE_MESSAGES | PERMISSIONS.MANAGE_ROLES), role("vip", 1, PERMISSIONS.STREAM)],
  };

  it("@todos vale para todo mundo; cargos somam; dono e administrador podem tudo", () => {
    expect(computePermissions(ctx, "9", [])).toBe(DEFAULT_EVERYONE_PERMISSIONS);
    expect(hasPermission(computePermissions(ctx, "9", ["mod"]), "KICK_MEMBERS")).toBe(true);
    expect(hasPermission(computePermissions(ctx, "9", []), "KICK_MEMBERS")).toBe(false);
    expect(computePermissions(ctx, OWNER, [])).toBe(ALL_PERMISSIONS);
    const admin = { ...ctx, roles: [...ctx.roles, role("admin", 3, PERMISSIONS.ADMINISTRATOR)] };
    expect(computePermissions(admin, "9", ["admin"])).toBe(ALL_PERMISSIONS);
  });

  it("hierarquia: moderador expulsa quem está abaixo, nunca quem está acima, igual, o dono ou ele mesmo", () => {
    const mod = { userId: "5", roleIds: ["mod"] };
    expect(canModerate(ctx, mod, { userId: "6", roleIds: ["vip"] }, "KICK_MEMBERS")).toBe(true);
    expect(canModerate(ctx, mod, { userId: "6", roleIds: [] }, "KICK_MEMBERS")).toBe(true);
    expect(canModerate(ctx, mod, { userId: "7", roleIds: ["mod"] }, "KICK_MEMBERS")).toBe(false); // mesmo nível
    expect(canModerate(ctx, mod, { userId: OWNER, roleIds: [] }, "KICK_MEMBERS")).toBe(false);
    expect(canModerate(ctx, mod, mod, "KICK_MEMBERS")).toBe(false);
    expect(canModerate(ctx, mod, { userId: "6", roleIds: [] }, "BAN_MEMBERS")).toBe(false); // sem a permissão
  });

  it("cargos: só os abaixo do seu; e só se dá o que se tem", () => {
    const mod = { userId: "5", roleIds: ["mod"] };
    expect(canManageRole(ctx, mod, { id: "vip", position: 1 })).toBe(true);
    expect(canManageRole(ctx, mod, { id: "mod", position: 2 })).toBe(false);
    expect(canManageRole(ctx, mod, { id: GUILD, position: 0 })).toBe(true);
    const mine = computePermissions(ctx, "5", ["mod"]);
    // tentou dar Administrador e Banir (não tem): ficam como estavam (desligados)
    const granted = clampGrantedPermissions(mine, PERMISSIONS.STREAM, PERMISSIONS.STREAM | PERMISSIONS.ADMINISTRATOR | PERMISSIONS.BAN_MEMBERS | PERMISSIONS.KICK_MEMBERS);
    expect(granted).toBe(PERMISSIONS.STREAM | PERMISSIONS.KICK_MEMBERS);
  });

  it("canal privado: o @todos não vê, o cargo liberado vê; a pessoa pode ser liberada ou barrada sozinha", () => {
    const { VIEW_CHANNEL, SEND_MESSAGES } = PERMISSIONS;
    const priv: Overwrite[] = [
      { targetType: "role", targetId: GUILD, allow: 0, deny: VIEW_CHANNEL },
      { targetType: "role", targetId: "vip", allow: VIEW_CHANNEL, deny: 0 },
    ];
    expect(isPrivateChannel(GUILD, priv)).toBe(true);
    expect(isPrivateChannel(GUILD, [])).toBe(false);
    expect(computeChannelPermissions(ctx, "9", [], priv)).toBe(0);
    expect(hasPermission(computeChannelPermissions(ctx, "9", ["vip"], priv), "VIEW_CHANNEL")).toBe(true);
    expect(hasPermission(computeChannelPermissions(ctx, "9", ["vip"], priv), "SEND_MESSAGES")).toBe(true);
    // a pessoa: a sobrescrita dela vence a do cargo
    const withMember = [...priv, { targetType: "member" as const, targetId: "9", allow: 0, deny: VIEW_CHANNEL }];
    expect(computeChannelPermissions(ctx, "9", ["vip"], withMember)).toBe(0);
    const invited = [...priv, { targetType: "member" as const, targetId: "8", allow: VIEW_CHANNEL, deny: 0 }];
    expect(hasPermission(computeChannelPermissions(ctx, "8", [], invited), "VIEW_CHANNEL")).toBe(true);
    // dono vê sempre
    expect(computeChannelPermissions(ctx, OWNER, [], withMember)).toBe(ALL_PERMISSIONS);
    // só leitura: vê, não escreve
    const readOnly: Overwrite[] = [{ targetType: "role", targetId: GUILD, allow: 0, deny: SEND_MESSAGES }];
    const perms = computeChannelPermissions(ctx, "9", [], readOnly);
    expect(hasPermission(perms, "VIEW_CHANNEL")).toBe(true);
    expect(hasPermission(perms, "SEND_MESSAGES")).toBe(false);
    // permissões do servidor (expulsar etc.) não mudam por canal
    const kick: Overwrite[] = [{ targetType: "role", targetId: GUILD, allow: 0, deny: PERMISSIONS.KICK_MEMBERS }];
    expect(hasPermission(computeChannelPermissions(ctx, "5", ["mod"], kick), "KICK_MEMBERS")).toBe(true);
  });

  it("castigo: só ver, até a hora marcada; dono e administrador não ficam de castigo", () => {
    const now = 1_000_000;
    expect(computeChannelPermissions(ctx, "9", [], [], now + 1, now)).toBe(PERMISSIONS.VIEW_CHANNEL);
    expect(computeChannelPermissions(ctx, "9", [], [], now, now)).toBe(DEFAULT_EVERYONE_PERMISSIONS);
    expect(computeChannelPermissions(ctx, OWNER, [], [], now + 1, now)).toBe(ALL_PERMISSIONS);
    // castigo não mostra canal escondido
    const hidden: Overwrite[] = [{ targetType: "role", targetId: GUILD, allow: 0, deny: PERMISSIONS.VIEW_CHANNEL }];
    expect(computeChannelPermissions(ctx, "9", [], hidden, now + 1, now)).toBe(0);
  });

  it("toda permissão tem texto na tela, e só uma vez", () => {
    const names = PERMISSION_INFO.flatMap((g) => g.items.map((i) => i.name));
    expect(new Set(names).size).toBe(names.length);
    expect(names.sort()).toEqual(Object.keys(PERMISSIONS).sort());
  });
});

describe("permissões (propriedades, 500 servidores aleatórios cada)", () => {
  it("dono tem tudo; ter Administrador = tudo; nunca sai bit fora das permissões conhecidas", () => {
    const next = rng(1);
    for (let i = 0; i < 500; i++) {
      const ctx = randomGuild(next);
      const roles = randomRoles(next, ctx);
      const perms = computePermissions(ctx, "9", roles);
      expect(computePermissions(ctx, OWNER, roles)).toBe(ALL_PERMISSIONS);
      expect(perms & ~ALL_PERMISSIONS).toBe(0);
      const hasAdmin = ctx.roles.some((r) => roles.includes(r.id) && r.permissions & PERMISSIONS.ADMINISTRATOR);
      if (hasAdmin) expect(perms).toBe(ALL_PERMISSIONS);
    }
  });

  it("ganhar um cargo nunca tira permissão (a soma só cresce) e o @todos está sempre incluído", () => {
    const next = rng(2);
    for (let i = 0; i < 500; i++) {
      const ctx = randomGuild(next);
      const roles = randomRoles(next, ctx);
      const extra = ctx.roles[1 + Math.floor(next() * (ctx.roles.length - 1))]!.id;
      const before = computePermissions(ctx, "9", roles);
      const after = computePermissions(ctx, "9", [...roles, extra]);
      expect(after & before).toBe(before);
      const everyone = ctx.roles.find((r) => r.id === GUILD)!.permissions;
      expect(before & everyone).toBe(everyone & ALL_PERMISSIONS);
    }
  });

  it("ninguém (fora o dono) mexe em cargo igual ou acima do seu mais alto, nem modera quem está no mesmo nível ou acima", () => {
    const next = rng(3);
    for (let i = 0; i < 500; i++) {
      const ctx = randomGuild(next);
      const actor = { userId: "5", roleIds: randomRoles(next, ctx) };
      const target = { userId: "6", roleIds: randomRoles(next, ctx) };
      const top = highestPosition(ctx, actor.userId, actor.roleIds);
      for (const r of ctx.roles) if (r.position >= top) expect(canManageRole(ctx, actor, r)).toBe(false);
      if (highestPosition(ctx, target.userId, target.roleIds) >= top) {
        expect(canModerate(ctx, actor, target, "KICK_MEMBERS")).toBe(false);
        expect(canModerate(ctx, actor, target, "BAN_MEMBERS")).toBe(false);
      }
      expect(canModerate(ctx, actor, { userId: OWNER, roleIds: [] }, "BAN_MEMBERS")).toBe(false);
    }
  });

  it("canal: sem sobrescritas = permissões do servidor; nunca dá algo do servidor que a pessoa não tem; sem Ver = nada", () => {
    const next = rng(5);
    const randomOverwrites = (ctx: PermissionContext): Overwrite[] => {
      const list: Overwrite[] = [];
      for (const r of ctx.roles) {
        if (next() < 0.5) list.push({ targetType: "role", targetId: r.id, allow: Math.floor(next() * (ALL_PERMISSIONS + 1)), deny: Math.floor(next() * (ALL_PERMISSIONS + 1)) });
      }
      if (next() < 0.4) list.push({ targetType: "member", targetId: "9", allow: Math.floor(next() * (ALL_PERMISSIONS + 1)), deny: Math.floor(next() * (ALL_PERMISSIONS + 1)) });
      return list;
    };
    for (let i = 0; i < 500; i++) {
      const ctx = randomGuild(next);
      const roles = randomRoles(next, ctx);
      const base = computePermissions(ctx, "9", roles);
      const overwrites = randomOverwrites(ctx);
      const perms = computeChannelPermissions(ctx, "9", roles, overwrites);
      if (base & PERMISSIONS.ADMINISTRATOR) {
        expect(perms).toBe(ALL_PERMISSIONS);
        continue;
      }
      expect(computeChannelPermissions(ctx, "9", roles, [])).toBe(base & PERMISSIONS.VIEW_CHANNEL ? base : 0);
      expect(perms & ~ALL_PERMISSIONS).toBe(0);
      // o que não é de canal só pode vir do servidor
      expect(perms & ~CHANNEL_PERMISSIONS & ~base).toBe(0);
      if (!(perms & PERMISSIONS.VIEW_CHANNEL)) expect(perms).toBe(0);
      // a sobrescrita da pessoa decide sozinha os bits que ela menciona
      const mine = overwrites.find((o) => o.targetType === "member");
      if (mine && perms) {
        expect(perms & mine.allow & CHANNEL_PERMISSIONS).toBe(mine.allow & CHANNEL_PERMISSIONS);
      }
      // de castigo: no máximo ver
      expect(computeChannelPermissions(ctx, "9", roles, overwrites, 2, 1) & ~PERMISSIONS.VIEW_CHANNEL).toBe(0);
    }
  });

  it("dar permissões a um cargo nunca concede o que quem edita não tem", () => {
    const next = rng(4);
    for (let i = 0; i < 500; i++) {
      const actorPerms = Math.floor(next() * (ALL_PERMISSIONS + 1)) & ~PERMISSIONS.ADMINISTRATOR;
      const previous = Math.floor(next() * (ALL_PERMISSIONS + 1));
      const requested = Math.floor(next() * (ALL_PERMISSIONS + 1));
      const result = clampGrantedPermissions(actorPerms, previous, requested);
      const gained = result & ~previous;
      expect(gained & ~actorPerms).toBe(0); // tudo que apareceu, quem edita tinha
      const lost = previous & ~result;
      expect(lost & ~actorPerms).toBe(0); // e só tirou o que tinha
    }
  });
});
