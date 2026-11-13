import { useEffect, useLayoutEffect, useRef, useState, type KeyboardEvent as ReactKeyboardEvent } from "react";
import { AtSign, Ban, Check, ChevronDown, Clock, LogOut, MessageCircle, Shield, UserCheck, UserMinus, UserPlus, UserRound, X } from "lucide-react";
import { canManageRole, canModerate, computePermissions, hasPermission, type Id, type Member, type Role, type User } from "@aurora/schema";
import { ApiError, type ApiClient } from "../net/api";
import { presenceOf, type ChatState } from "../state/chat-store";
import { untilText } from "../roles";
import { Modal } from "./Modal";
import { Avatar, ICON_SM } from "./shell";
import { BanDialog, TimeoutDialog } from "./settings/GuildSettingsScreen";
import { PRESENCE_LABEL, customStatusText } from "./status";

export interface UserMenuTarget {
  user: User;
  /** Servidor onde a pessoa foi clicada (ações de cargo e moderação valem nele); `null` = fora de servidor. */
  guildId: Id | null;
  x: number;
  y: number;
}

/** Pede ao compositor aberto para inserir "@usuario " (o campo escuta este evento). */
export const MENTION_EVENT = "aurora:mention";

type Dialog = "profile" | "kick" | "ban" | "timeout" | "block" | null;
const errorText = (error: unknown) => (error instanceof ApiError ? error.message : "Não deu certo. Confira a conexão e tente de novo.");

/**
 * Menu ao clicar numa pessoa: cada opção aparece só para quem pode usá-la (o servidor confere de novo).
 */
export function UserMenu({
  target,
  state,
  api,
  onClose,
  onMessage,
  onNotice,
}: {
  target: UserMenuTarget;
  state: ChatState;
  api: ApiClient;
  onClose: () => void;
  onMessage: (user: User) => void;
  onNotice: (text: string) => void;
}) {
  const { user, guildId } = target;
  const me = state.me!;
  const self = user.id === me.id;
  const ref = useRef<HTMLDivElement>(null);
  const [rolesOpen, setRolesOpen] = useState(false);
  const [dialog, setDialog] = useState<Dialog>(null);
  const [position, setPosition] = useState({ left: target.x, top: target.y });

  const guild = guildId ? state.guilds[guildId] : undefined;
  const members = guildId ? (state.members[guildId] ?? {}) : {};
  const member: Member | undefined = members[user.id];
  const ctx = guild ? { guildId: guild.id, ownerId: guild.ownerId, roles: guild.roles } : null;
  const actor = { userId: me.id, roleIds: members[me.id]?.roles ?? [] };
  const targetActor = { userId: user.id, roleIds: member?.roles ?? [] };
  const relationship = state.relationships[user.id]?.type ?? null;
  const manageableRoles: Role[] = ctx && member ? guild!.roles.filter((r) => r.id !== guild!.id && canManageRole(ctx, actor, r)) : [];
  const can = (permission: "KICK_MEMBERS" | "BAN_MEMBERS" | "MODERATE_MEMBERS") => Boolean(ctx && member && canModerate(ctx, actor, targetActor, permission));
  const targetIsAdmin = Boolean(ctx && member && hasPermission(computePermissions(ctx, user.id, member.roles), "ADMINISTRATOR"));
  const timedOut = member?.timeoutUntil != null && member.timeoutUntil > Date.now() ? member.timeoutUntil : null;
  const canTimeout = can("MODERATE_MEMBERS") && !targetIsAdmin;
  const hasModeration = can("KICK_MEMBERS") || can("BAN_MEMBERS") || canTimeout;

  // não sai da tela
  useLayoutEffect(() => {
    const el = ref.current;
    if (!el) return;
    const r = el.getBoundingClientRect();
    const margin = 8;
    setPosition({
      left: Math.max(margin, Math.min(target.x, window.innerWidth - r.width - margin)),
      top: Math.max(margin, Math.min(target.y, window.innerHeight - r.height - margin)),
    });
  }, [target.x, target.y, rolesOpen]);

  useEffect(() => {
    if (dialog) return;
    ref.current?.querySelector<HTMLButtonElement>('[role="menuitem"], [role="menuitemcheckbox"]')?.focus();
    const onPointer = (event: PointerEvent) => {
      if (!ref.current?.contains(event.target as Node)) onClose();
    };
    document.addEventListener("pointerdown", onPointer);
    return () => document.removeEventListener("pointerdown", onPointer);
  }, [onClose, dialog]);

  const items = () => [...(ref.current?.querySelectorAll<HTMLButtonElement>('[role="menuitem"], [role="menuitemcheckbox"]') ?? [])];
  const onKeyDown = (event: ReactKeyboardEvent) => {
    const list = items();
    const index = list.indexOf(document.activeElement as HTMLButtonElement);
    if (event.key === "Escape") {
      event.preventDefault();
      event.stopPropagation();
      onClose();
    } else if (event.key === "ArrowDown" || event.key === "ArrowUp") {
      event.preventDefault();
      list[(index + (event.key === "ArrowDown" ? 1 : -1) + list.length) % list.length]?.focus();
    } else if (event.key === "Tab") onClose();
  };

  /** Faz e fecha; erro vira aviso no chat. */
  const act = (work: () => Promise<unknown>, ok?: string) => {
    onClose();
    work()
      .then(() => ok && onNotice(ok))
      .catch((error: unknown) => onNotice(errorText(error)));
  };

  if (dialog === "profile") return <ProfileDialog user={user} member={member} roles={guild?.roles ?? []} state={state} onClose={onClose} />;
  if (dialog === "timeout")
    return <TimeoutDialog user={user} onCancel={onClose} onConfirm={(minutes) => act(() => api.timeoutMember(guildId!, user.id, minutes), `${user.displayName} está de castigo.`)} />;
  if (dialog === "ban") return <BanDialog user={user} onCancel={onClose} onConfirm={(reason) => act(() => api.banMember(guildId!, user.id, reason), `${user.displayName} foi banido.`)} />;
  if (dialog === "kick" || dialog === "block") {
    const kick = dialog === "kick";
    return (
      <Modal
        title={kick ? `Expulsar ${user.displayName}?` : `Bloquear ${user.displayName}?`}
        description={
          kick
            ? "A pessoa sai do servidor agora, mas pode voltar se receber um convite."
            : "A pessoa não consegue mais mandar mensagem direta nem pedir amizade, e as mensagens dela nos servidores ficam escondidas para você. Ela não é avisada."
        }
        onClose={onClose}
      >
        <div className="modal__actions">
          <button type="button" className="button button--secondary" onClick={onClose}>
            Cancelar
          </button>
          <button
            type="button"
            className="button button--danger"
            onClick={() => (kick ? act(() => api.kickMember(guildId!, user.id), `${user.displayName} foi expulso.`) : act(() => api.blockUser(user.id), `${user.displayName} foi bloqueado.`))}
          >
            {kick ? "Expulsar" : "Bloquear"}
          </button>
        </div>
      </Modal>
    );
  }

  return (
    <div ref={ref} className="user-menu" role="menu" aria-label={`Ações para ${user.displayName}`} style={{ left: position.left, top: position.top }} onKeyDown={onKeyDown}>
      <Item icon={<UserRound {...ICON_SM} />} label="Perfil" onClick={() => setDialog("profile")} />
      <Item
        icon={<AtSign {...ICON_SM} />}
        label="Mencionar"
        onClick={() => {
          window.dispatchEvent(new CustomEvent(MENTION_EVENT, { detail: user.username }));
          onClose();
        }}
      />
      {!self && relationship !== "blocked" && <Item icon={<MessageCircle {...ICON_SM} />} label="Mensagem" onClick={() => (onClose(), onMessage(user))} />}

      {!self && (
        <>
          <Divider />
          {relationship === null && <Item icon={<UserPlus {...ICON_SM} />} label="Adicionar amigo" onClick={() => act(() => api.requestFriendById(user.id), `Pedido enviado para ${user.displayName}.`)} />}
          {relationship === "incoming" && <Item icon={<UserCheck {...ICON_SM} />} label="Aceitar pedido de amizade" onClick={() => act(() => api.acceptFriend(user.id), `Agora você e ${user.displayName} são amigos.`)} />}
          {relationship === "outgoing" && <Item icon={<X {...ICON_SM} />} label="Cancelar pedido de amizade" onClick={() => act(() => api.removeRelationship(user.id))} />}
          {relationship === "friend" && <Item icon={<UserMinus {...ICON_SM} />} label="Desfazer amizade" onClick={() => act(() => api.removeRelationship(user.id))} />}
          {relationship === "blocked" ? (
            <Item icon={<Ban {...ICON_SM} />} label="Desbloquear" onClick={() => act(() => api.removeRelationship(user.id), `${user.displayName} foi desbloqueado.`)} />
          ) : (
            <Item icon={<Ban {...ICON_SM} />} label="Bloquear" danger onClick={() => setDialog("block")} />
          )}
        </>
      )}

      {manageableRoles.length > 0 && (
        <>
          <Divider />
          <button type="button" role="menuitem" className="user-menu__item" aria-expanded={rolesOpen} onClick={() => setRolesOpen((open) => !open)}>
            <Shield {...ICON_SM} />
            <span className="user-menu__label">Cargos</span>
            <ChevronDown {...ICON_SM} className={rolesOpen ? "user-menu__chevron user-menu__chevron--open" : "user-menu__chevron"} />
          </button>
          {rolesOpen &&
            manageableRoles.map((role) => {
              const has = member!.roles.includes(role.id);
              return (
                <button
                  key={role.id}
                  type="button"
                  role="menuitemcheckbox"
                  aria-checked={has}
                  className="user-menu__item user-menu__item--nested"
                  onClick={() =>
                    api.setMemberRole(guildId!, user.id, role.id, !has).catch((error: unknown) => onNotice(errorText(error)))
                  }
                >
                  <span className="role-dot" data-color={role.color ?? "none"} aria-hidden="true" />
                  <span className="user-menu__label">{role.name}</span>
                  {has && <Check {...ICON_SM} />}
                </button>
              );
            })}
        </>
      )}

      {hasModeration && (
        <>
          <Divider />
          {canTimeout &&
            (timedOut ? (
              <Item icon={<Clock {...ICON_SM} />} label={`Tirar castigo (${untilText(timedOut)})`} onClick={() => act(() => api.timeoutMember(guildId!, user.id, null), `${user.displayName} saiu do castigo.`)} />
            ) : (
              <Item icon={<Clock {...ICON_SM} />} label={`Castigar ${user.displayName}`} danger onClick={() => setDialog("timeout")} />
            ))}
          {can("KICK_MEMBERS") && <Item icon={<LogOut {...ICON_SM} />} label={`Expulsar ${user.displayName}`} danger onClick={() => setDialog("kick")} />}
          {can("BAN_MEMBERS") && <Item icon={<Ban {...ICON_SM} />} label={`Banir ${user.displayName}`} danger onClick={() => setDialog("ban")} />}
        </>
      )}
    </div>
  );
}

function Item({ icon, label, danger, onClick }: { icon: React.ReactNode; label: string; danger?: boolean; onClick: () => void }) {
  return (
    <button type="button" role="menuitem" className={danger ? "user-menu__item user-menu__item--danger" : "user-menu__item"} onClick={onClick}>
      {icon}
      <span className="user-menu__label">{label}</span>
    </button>
  );
}

const Divider = () => <div className="user-menu__divider" role="separator" />;

/** Perfil: foto, nome, @, status, cargos e desde quando está no servidor. */
function ProfileDialog({ user, member, roles, state, onClose }: { user: User; member: Member | undefined; roles: readonly Role[]; state: ChatState; onClose: () => void }) {
  const presence = presenceOf(state, user.id);
  const custom = customStatusText(presence.customStatus);
  const memberRoles = member ? roles.filter((r) => member.roles.includes(r.id)) : [];
  return (
    <Modal title={user.displayName} description={`@${user.username}`} onClose={onClose}>
      <div className="profile">
        <div className="profile__banner" aria-hidden="true" />
        <div className="profile__head">
          <Avatar user={user} size="xl" status={presence.status} />
          <div className="profile__status">
            <span>{PRESENCE_LABEL[presence.status]}</span>
            {custom && <span className="profile__custom">{custom}</span>}
          </div>
        </div>
        {memberRoles.length > 0 && (
          <section>
            <h3 className="profile__label">Cargos</h3>
            <ul className="chips">
              {memberRoles.map((role) => (
                <li key={role.id} className="chip">
                  <span className="role-dot" data-color={role.color ?? "none"} aria-hidden="true" />
                  {role.name}
                </li>
              ))}
            </ul>
          </section>
        )}
        {member && (
          <section>
            <h3 className="profile__label">Membro desde</h3>
            <p className="profile__text">{new Date(member.joinedAt).toLocaleDateString("pt-BR", { day: "numeric", month: "long", year: "numeric" })}</p>
          </section>
        )}
      </div>
    </Modal>
  );
}
