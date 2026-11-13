import { byPositionDesc, type AuditLogEntry, type Id, type Member, type Role } from "@aurora/schema";

/** Nomes das cores de cargo (a cor vem dos tokens --avatar-0…7, já com contraste conferido). */
export const ROLE_COLOR_NAMES = ["Verde-azulado", "Roxo", "Vermelho", "Azul", "Âmbar", "Rosa", "Verde", "Laranja"] as const;

/** Cargo mais alto do membro entre os que passam no filtro (ex.: só os que têm cor). */
export function highestRole(roles: readonly Role[], memberRoleIds: readonly Id[], filter: (role: Role) => boolean = () => true): Role | undefined {
  return [...roles].sort(byPositionDesc).find((role) => memberRoleIds.includes(role.id) && filter(role));
}

/** Cor que aparece ao lado do nome: a do cargo colorido mais alto. */
export const memberColor = (roles: readonly Role[], member: Pick<Member, "roles">): number | null =>
  highestRole(roles, member.roles, (role) => role.color !== null)?.color ?? null;

export interface MemberGroup {
  key: string;
  label: string;
  members: Member[];
}

/**
 * Lista de membros: um grupo por cargo marcado como "mostrar separado" (do mais alto ao mais baixo),
 * depois "Online" e por fim "Offline" (offline não é separado por cargo). Grupo vazio não aparece.
 */
export type MemberGrouping = "role" | "status";
const STATUS_GROUPS: { key: "online" | "idle" | "dnd" | "offline"; label: string }[] = [
  { key: "online", label: "Online" },
  { key: "idle", label: "Ausente" },
  { key: "dnd", label: "Não perturbe" },
  { key: "offline", label: "Offline" },
];
const statusOf = (m: Member) => m.status ?? (m.online ? "online" : "offline");

/**
 * Grupos da lista de membros.
 * - por cargo (padrão): cargos "mostrar separado" (só quem está online), depois Online e Offline;
 * - por status: Online, Ausente, Não perturbe e Offline.
 * Dentro de cada grupo, em ordem alfabética.
 */
export function memberGroups(members: readonly Member[], roles: readonly Role[], grouping: MemberGrouping = "role"): MemberGroup[] {
  const byName = (a: Member, b: Member) => a.user.displayName.localeCompare(b.user.displayName, "pt-BR");
  if (grouping === "status") {
    return STATUS_GROUPS.map(({ key, label }) => ({ key, label, members: members.filter((m) => statusOf(m) === key).sort(byName) })).filter((g) => g.members.length > 0);
  }
  const hoisted = [...roles].filter((role) => role.hoist).sort(byPositionDesc);
  const groups: MemberGroup[] = hoisted.map((role) => ({ key: role.id, label: role.name, members: [] }));
  const online: Member[] = [];
  const offline: Member[] = [];
  for (const member of members) {
    if (!member.online) {
      offline.push(member);
      continue;
    }
    const top = highestRole(hoisted, member.roles);
    if (top) groups.find((g) => g.key === top.id)!.members.push(member);
    else online.push(member);
  }
  return [...groups, { key: "online", label: "Online", members: online }, { key: "offline", label: "Offline", members: offline }]
    .filter((group) => group.members.length > 0)
    .map((group) => ({ ...group, members: group.members.sort(byName) }));
}

/** Uma linha do registro de auditoria em português ("Ana expulsou caio"). */
export function auditSentence(entry: Pick<AuditLogEntry, "actor" | "action" | "targetName" | "detail">): string {
  const who = entry.actor?.displayName ?? "Alguém";
  const target = entry.targetName;
  switch (entry.action) {
    case "guild_update":
      return `${who} alterou o servidor`;
    case "channel_create":
      return `${who} criou o canal ${target}`;
    case "channel_update":
      return `${who} alterou o canal ${target}`;
    case "channel_delete":
      return `${who} excluiu o canal ${target}`;
    case "role_create":
      return `${who} criou o cargo ${target}`;
    case "role_update":
      return `${who} alterou o cargo ${target}`;
    case "role_delete":
      return `${who} excluiu o cargo ${target}`;
    case "member_role_add":
      return `${who} deu o cargo ${entry.detail ?? ""} a ${target}`.replace("  ", " ");
    case "member_role_remove":
      return `${who} tirou o cargo ${entry.detail ?? ""} de ${target}`.replace("  ", " ");
    case "member_kick":
      return `${who} expulsou ${target}`;
    case "member_ban":
      return `${who} baniu ${target}`;
    case "member_unban":
      return `${who} desfez o banimento de ${target}`;
    case "invite_delete":
      return `${who} revogou o convite ${target}`;
    case "channel_permissions":
      return `${who} mudou as permissões do canal ${target}`;
    case "member_timeout":
      return `${who} deixou ${target} de castigo${entry.detail ? ` por ${entry.detail}` : ""}`;
    case "member_timeout_remove":
      return `${who} tirou ${target} do castigo`;
    case "voice_mute":
      return `${who} silenciou ${target} na voz`;
    case "voice_unmute":
      return `${who} tirou o silêncio de ${target} na voz`;
    case "voice_move":
      return `${who} moveu ${target} na voz`;
    case "voice_disconnect":
      return `${who} desconectou ${target} da voz`;
    default:
      return `${who} fez uma alteração`;
  }
}

/** Detalhe que aparece embaixo da frase (o cargo já está na frase de dar/tirar cargo). */
export const auditDetail = (entry: Pick<AuditLogEntry, "action" | "detail">): string | null =>
  entry.action === "member_role_add" || entry.action === "member_role_remove" || entry.action === "member_timeout"
    ? null
    : entry.action === "member_ban" && entry.detail
      ? `Motivo: ${entry.detail}`
      : entry.detail;

/** "até 14:32" (hoje) ou "até 15/11, 14:32" — fim do castigo no relógio de quem lê. */
export function untilText(until: number, now: number = Date.now()): string {
  const end = new Date(until);
  const time = end.toLocaleTimeString("pt-BR", { hour: "2-digit", minute: "2-digit" });
  const sameDay = new Date(now).toDateString() === end.toDateString();
  return sameDay ? `até ${time}` : `até ${end.toLocaleDateString("pt-BR", { day: "2-digit", month: "2-digit" })}, ${time}`;
}
