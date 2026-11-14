/**
 * Cargos e permissões do servidor (docs/09-configuracoes-do-servidor.md). Função pura, usada pelo
 * servidor (que confere tudo) e pelo app (que só esconde o que a pessoa não pode).
 *
 * Regras:
 * - Todo servidor tem o cargo base **@todos** (id = id do servidor, posição 0), que vale para todos.
 * - Permissão do membro = OU das permissões do @todos e dos cargos dele. Dono e Administrador: tudo.
 * - Hierarquia (para gerenciar pessoas e cargos, não para somar permissões): só se mexe em cargos
 *   e pessoas ABAIXO do seu cargo mais alto, e só se dá a um cargo o que você mesmo tem.
 * - Por canal (fase 2): sobrescritas do @todos, depois dos cargos (somadas), depois do membro, cada uma
 *   negando e depois permitindo. Sem "Ver canal", nada mais no canal vale. De castigo: só ver.
 */
import type { Id } from "./index.ts";

export const PERMISSIONS = {
  ADMINISTRATOR: 1 << 0,
  MANAGE_GUILD: 1 << 1,
  MANAGE_ROLES: 1 << 2,
  MANAGE_CHANNELS: 1 << 3,
  KICK_MEMBERS: 1 << 4,
  BAN_MEMBERS: 1 << 5,
  VIEW_AUDIT_LOG: 1 << 6,
  CREATE_INVITE: 1 << 7,
  SEND_MESSAGES: 1 << 8,
  ADD_REACTIONS: 1 << 9,
  MANAGE_MESSAGES: 1 << 10,
  CONNECT: 1 << 11,
  SPEAK: 1 << 12,
  STREAM: 1 << 13,
  // 1.6
  VIEW_CHANNEL: 1 << 14,
  MODERATE_MEMBERS: 1 << 15,
  MUTE_MEMBERS: 1 << 16,
  MOVE_MEMBERS: 1 << 17,
  // 1.17
  SEND_POLLS: 1 << 18,
} as const;

export type PermissionName = keyof typeof PERMISSIONS;
export const ALL_PERMISSIONS: number = Object.values(PERMISSIONS).reduce((all, bit) => all | bit, 0);

/** O que o @todos de um servidor novo pode fazer: ver os canais, conversar, reagir, convidar e usar a voz. */
export const DEFAULT_EVERYONE_PERMISSIONS: number =
  PERMISSIONS.VIEW_CHANNEL |
  PERMISSIONS.CREATE_INVITE |
  PERMISSIONS.SEND_MESSAGES |
  PERMISSIONS.ADD_REACTIONS |
  PERMISSIONS.CONNECT |
  PERMISSIONS.SPEAK |
  PERMISSIONS.STREAM |
  PERMISSIONS.SEND_POLLS;

/** Permissões que mudam canal a canal (as outras valem para o servidor inteiro). */
export const CHANNEL_PERMISSIONS: number =
  PERMISSIONS.VIEW_CHANNEL |
  PERMISSIONS.SEND_MESSAGES |
  PERMISSIONS.ADD_REACTIONS |
  PERMISSIONS.MANAGE_MESSAGES |
  PERMISSIONS.CONNECT |
  PERMISSIONS.SPEAK |
  PERMISSIONS.STREAM |
  PERMISSIONS.MUTE_MEMBERS |
  PERMISSIONS.MOVE_MEMBERS |
  PERMISSIONS.SEND_POLLS;

/** Textos da tela de cargos (pt-BR), na ordem em que aparecem, por grupo. */
export const PERMISSION_INFO: { group: string; items: { name: PermissionName; label: string; hint: string }[] }[] = [
  {
    group: "Gerais",
    items: [
      { name: "ADMINISTRATOR", label: "Administrador", hint: "Pode tudo, inclusive o que vier depois. Dê só a quem você confia muito." },
      { name: "MANAGE_GUILD", label: "Gerenciar servidor", hint: "Renomear o servidor, ver e revogar convites." },
      { name: "MANAGE_ROLES", label: "Gerenciar cargos", hint: "Criar, editar e excluir cargos abaixo do seu, e dar ou tirar esses cargos." },
      { name: "VIEW_CHANNEL", label: "Ver canais", hint: "Ver os canais e ler as mensagens. Sem isto, os canais somem (dá para liberar canal a canal)." },
      { name: "MANAGE_CHANNELS", label: "Gerenciar canais", hint: "Criar, renomear e excluir canais, e mudar as permissões de cada um." },
      { name: "VIEW_AUDIT_LOG", label: "Ver registro de auditoria", hint: "Ver quem mudou o quê no servidor." },
      { name: "CREATE_INVITE", label: "Criar convite", hint: "Gerar códigos para chamar gente nova." },
    ],
  },
  {
    group: "Membros",
    items: [
      { name: "KICK_MEMBERS", label: "Expulsar membros", hint: "Tirar alguém do servidor. A pessoa pode voltar com um convite." },
      { name: "BAN_MEMBERS", label: "Banir membros", hint: "Tirar alguém e impedir que volte. Também ver e desfazer banimentos." },
      { name: "MODERATE_MEMBERS", label: "Castigar membros", hint: "Deixar alguém só olhando (sem escrever, reagir nem falar) por um tempo." },
    ],
  },
  {
    group: "Texto",
    items: [
      { name: "SEND_MESSAGES", label: "Enviar mensagens", hint: "Escrever nos canais de texto." },
      { name: "ADD_REACTIONS", label: "Adicionar reações", hint: "Reagir às mensagens com emoji e votar em enquetes." },
      { name: "SEND_POLLS", label: "Criar enquetes", hint: "Criar enquetes nos canais de texto." },
      { name: "MANAGE_MESSAGES", label: "Gerenciar mensagens", hint: "Apagar mensagens de outras pessoas." },
    ],
  },
  {
    group: "Voz",
    items: [
      { name: "CONNECT", label: "Conectar", hint: "Entrar nos canais de voz." },
      { name: "SPEAK", label: "Falar", hint: "Usar o microfone na voz." },
      { name: "STREAM", label: "Transmitir", hint: "Compartilhar a tela." },
      { name: "MUTE_MEMBERS", label: "Silenciar membros", hint: "Desligar o microfone de outras pessoas na voz." },
      { name: "MOVE_MEMBERS", label: "Mover membros", hint: "Levar pessoas de uma sala de voz para outra, ou tirá-las da voz." },
    ],
  },
];

/** Sobrescrita de um canal: libera (`allow`) ou bloqueia (`deny`) permissões para um cargo ou uma pessoa. */
export interface Overwrite {
  targetType: "role" | "member";
  targetId: Id;
  allow: number;
  deny: number;
}

export interface Role {
  id: Id;
  guildId: Id;
  name: string;
  /** Índice da paleta de cores de cargo (0–7) ou `null` (sem cor). */
  color: number | null;
  /** 0 = @todos; maior = mais alto na hierarquia. */
  position: number;
  permissions: number;
  /** Aparece como grupo separado na lista de membros. */
  hoist: boolean;
}

/** Nome com que o cargo base aparece (o id dele é o id do servidor). */
export const EVERYONE_ROLE_NAME = "@todos";
export const ROLE_COLORS = 8;
export const ROLE_NAME_MAX = 32;
export const ROLES_PER_GUILD = 50;

export const hasPermission = (permissions: number, name: PermissionName): boolean =>
  (permissions & PERMISSIONS.ADMINISTRATOR) !== 0 || (permissions & PERMISSIONS[name]) !== 0;

export interface PermissionContext {
  guildId: Id;
  ownerId: Id;
  roles: readonly Role[];
}

/** Permissões efetivas de alguém no servidor. `roleIds` = cargos do membro (sem o @todos). */
export function computePermissions(ctx: PermissionContext, userId: Id, roleIds: readonly Id[]): number {
  if (userId === ctx.ownerId) return ALL_PERMISSIONS;
  let permissions = ctx.roles.find((role) => role.id === ctx.guildId)?.permissions ?? 0;
  for (const role of ctx.roles) if (roleIds.includes(role.id)) permissions |= role.permissions;
  return permissions & PERMISSIONS.ADMINISTRATOR ? ALL_PERMISSIONS : permissions & ALL_PERMISSIONS;
}

/** Posição do cargo mais alto (o dono fica acima de todos; sem cargos = 0, o @todos). */
export function highestPosition(ctx: PermissionContext, userId: Id, roleIds: readonly Id[]): number {
  if (userId === ctx.ownerId) return Number.POSITIVE_INFINITY;
  let highest = 0;
  for (const role of ctx.roles) if (roleIds.includes(role.id) && role.position > highest) highest = role.position;
  return highest;
}

export interface Actor {
  userId: Id;
  roleIds: readonly Id[];
}

/** Pode editar, excluir, dar ou tirar este cargo? (Gerenciar cargos + cargo abaixo do seu mais alto.) */
export function canManageRole(ctx: PermissionContext, actor: Actor, role: Pick<Role, "id" | "position">): boolean {
  if (!hasPermission(computePermissions(ctx, actor.userId, actor.roleIds), "MANAGE_ROLES")) return false;
  if (actor.userId === ctx.ownerId) return true;
  return role.position < highestPosition(ctx, actor.userId, actor.roleIds);
}

/** `actor` está acima de `target` na hierarquia? (Nunca vale para o dono como alvo nem para si mesmo.) */
export function outranks(ctx: PermissionContext, actor: Actor, target: Actor): boolean {
  if (actor.userId === target.userId || target.userId === ctx.ownerId) return false;
  return highestPosition(ctx, target.userId, target.roleIds) < highestPosition(ctx, actor.userId, actor.roleIds);
}

export type ModerationPermission = "KICK_MEMBERS" | "BAN_MEMBERS" | "MODERATE_MEMBERS";

/** Pode expulsar/banir/castigar esta pessoa? (Permissão + o cargo mais alto dela abaixo do seu; nunca o dono nem a si mesmo.) */
export function canModerate(ctx: PermissionContext, actor: Actor, target: Actor, permission: ModerationPermission): boolean {
  if (!hasPermission(computePermissions(ctx, actor.userId, actor.roleIds), permission)) return false;
  return outranks(ctx, actor, target);
}

/** Ao editar um cargo, só se dá o que se tem: o resto fica como estava. */
export function clampGrantedPermissions(actorPermissions: number, previous: number, requested: number): number {
  const allowed = actorPermissions & ALL_PERMISSIONS;
  return ((requested & allowed) | (previous & ~allowed)) & ALL_PERMISSIONS;
}

/**
 * Permissões num canal. `timeoutUntil` = fim do castigo (ms); de castigo, só dá para ver.
 * Dono e Administrador ignoram sobrescritas e castigo.
 */
export function computeChannelPermissions(
  ctx: PermissionContext,
  userId: Id,
  roleIds: readonly Id[],
  overwrites: readonly Overwrite[],
  timeoutUntil: number | null = null,
  now: number = Date.now(),
): number {
  const base = computePermissions(ctx, userId, roleIds);
  if (base & PERMISSIONS.ADMINISTRATOR) return ALL_PERMISSIONS;
  let permissions = base;
  const apply = (allow: number, deny: number) => {
    permissions = (permissions & ~(deny & CHANNEL_PERMISSIONS)) | (allow & CHANNEL_PERMISSIONS);
  };
  const everyone = overwrites.find((o) => o.targetType === "role" && o.targetId === ctx.guildId);
  if (everyone) apply(everyone.allow, everyone.deny);
  let roleAllow = 0;
  let roleDeny = 0;
  for (const o of overwrites) {
    if (o.targetType === "role" && o.targetId !== ctx.guildId && roleIds.includes(o.targetId)) {
      roleAllow |= o.allow;
      roleDeny |= o.deny;
    }
  }
  apply(roleAllow, roleDeny);
  const member = overwrites.find((o) => o.targetType === "member" && o.targetId === userId);
  if (member) apply(member.allow, member.deny);
  if (!(permissions & PERMISSIONS.VIEW_CHANNEL)) return 0;
  return applyTimeout(permissions, timeoutUntil, now);
}

/** De castigo (e sem ser Administrador): sobra só "Ver canais". Vale no servidor e em cada canal. */
export function applyTimeout(permissions: number, timeoutUntil: number | null | undefined, now: number = Date.now()): number {
  if (permissions & PERMISSIONS.ADMINISTRATOR) return permissions;
  return timeoutUntil != null && timeoutUntil > now ? permissions & PERMISSIONS.VIEW_CHANNEL : permissions;
}

/** Canal privado = o @todos não vê (aparece com cadeado). */
export const isPrivateChannel = (guildId: Id, overwrites: readonly Overwrite[]): boolean =>
  overwrites.some((o) => o.targetType === "role" && o.targetId === guildId && (o.deny & PERMISSIONS.VIEW_CHANNEL) !== 0);

/** Durações de castigo oferecidas na tela (minutos); o máximo aceito é 28 dias. */
export const TIMEOUT_MINUTES = [1, 5, 10, 60, 24 * 60, 7 * 24 * 60] as const;
export const TIMEOUT_MAX_MINUTES = 28 * 24 * 60;

/** "5 minutos", "1 hora", "1 semana"… (duração do castigo, na tela e no registro de auditoria). */
export function formatDuration(minutes: number): string {
  const units: [number, string, string][] = [
    [7 * 24 * 60, "semana", "semanas"],
    [24 * 60, "dia", "dias"],
    [60, "hora", "horas"],
  ];
  for (const [size, one, many] of units) {
    if (minutes % size === 0) return minutes === size ? `1 ${one}` : `${minutes / size} ${many}`;
  }
  return minutes === 1 ? "1 minuto" : `${minutes} minutos`;
}

/** Ordem de exibição: do mais alto para o mais baixo (o @todos por último). */
export const byPositionDesc = (a: Pick<Role, "position" | "id">, b: Pick<Role, "position" | "id">): number =>
  b.position - a.position || Number(a.id) - Number(b.id);
