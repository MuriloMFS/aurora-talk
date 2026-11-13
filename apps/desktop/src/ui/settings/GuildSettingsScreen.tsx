import { useCallback, useEffect, useId, useMemo, useRef, useState, type FormEvent, type ReactNode } from "react";
import { ArrowDown, ArrowLeft, ArrowUp, Ban as BanIcon, Hash, Link2, Lock, LogOut, ScrollText, Settings2, Shield, Trash2, Users, Volume2, X, type LucideIcon } from "lucide-react";
import {
  EVERYONE_ROLE_NAME,
  LIMITS,
  PERMISSIONS,
  PERMISSION_INFO,
  ROLE_COLORS,
  ROLE_NAME_MAX,
  TIMEOUT_MINUTES,
  canManageRole,
  canModerate,
  computeChannelPermissions,
  computePermissions,
  formatDuration,
  hasPermission,
  isPrivateChannel,
  outranks,
  highestPosition,
  type Overwrite,
  type PermissionName,
  type AuditLogEntry,
  type Ban,
  type Channel,
  type Id,
  type InviteDetails,
  type Member,
  type Role,
  type User,
} from "@aurora/schema";
import { ApiError, type ApiClient } from "../../net/api";
import type { GuildEntry } from "../../state/chat-store";
import { ROLE_COLOR_NAMES, auditDetail, auditSentence, untilText } from "../../roles";
import { Modal } from "../Modal";
import { Avatar, ICON, ICON_SM } from "../shell";
import { FormStatus, SettingsGroup, SwitchRow } from "./controls";

export type GuildSectionId = "overview" | "roles" | "members" | "invites" | "bans" | "channels" | "audit";
type Status = { kind: "ok" | "error"; text: string } | null;

const errorText = (error: unknown, fallback = "Não foi possível concluir. Confira a conexão e tente de novo.") => (error instanceof ApiError ? error.message : fallback);
const when = (ms: number) => new Date(ms).toLocaleString("pt-BR", { dateStyle: "short", timeStyle: "short" });

export interface GuildSettingsProps {
  guild: GuildEntry;
  members: Readonly<Record<Id, Member>>;
  channels: Channel[];
  me: User;
  permissions: number;
  api: ApiClient;
  /** Sair ou excluir deu certo (o app não deve tratar o GUILD_DELETE como "você foi removido"). */
  onLeaving: (guildId: Id) => void;
  onClose: () => void;
}

/** Configurações do servidor: cada seção aparece só para quem tem a permissão dela (o servidor confere de novo). */
export function GuildSettingsScreen(props: GuildSettingsProps) {
  const { guild, permissions, me, onClose } = props;
  const can = (name: keyof typeof PERMISSIONS) => hasPermission(permissions, name);
  const isOwner = guild.ownerId === me.id;
  const nav: { id: GuildSectionId; label: string; Icon: LucideIcon; visible: boolean }[] = [
    { id: "overview", label: "Visão geral", Icon: Settings2, visible: true },
    { id: "roles", label: "Cargos", Icon: Shield, visible: can("MANAGE_ROLES") },
    { id: "members", label: "Membros", Icon: Users, visible: can("MANAGE_ROLES") || can("KICK_MEMBERS") || can("BAN_MEMBERS") || can("MODERATE_MEMBERS") },
    { id: "channels", label: "Canais", Icon: Hash, visible: can("MANAGE_CHANNELS") },
    { id: "invites", label: "Convites", Icon: Link2, visible: can("MANAGE_GUILD") },
    { id: "bans", label: "Banimentos", Icon: BanIcon, visible: can("BAN_MEMBERS") },
    { id: "audit", label: "Registro de auditoria", Icon: ScrollText, visible: can("VIEW_AUDIT_LOG") },
  ];
  const visible = nav.filter((item) => item.visible);
  const [section, setSection] = useState<GuildSectionId>("overview");
  const current = visible.some((item) => item.id === section) ? section : "overview"; // perdeu a permissão no meio: volta
  const [confirm, setConfirm] = useState<"leave" | "delete" | null>(null);
  const titleId = useId();
  const rootRef = useRef<HTMLDivElement>(null);

  useEffect(() => {
    const previous = document.activeElement as HTMLElement | null;
    rootRef.current?.querySelector<HTMLElement>('[aria-current="page"]')?.focus();
    const onKey = (event: KeyboardEvent) => {
      // com uma janela de confirmação aberta, o Esc é dela
      if (event.key !== "Escape" || event.defaultPrevented || document.querySelector(".modal-layer")) return;
      event.preventDefault();
      onClose();
    };
    document.addEventListener("keydown", onKey);
    return () => {
      document.removeEventListener("keydown", onKey);
      previous?.focus();
    };
  }, [onClose]);

  let body: ReactNode = null;
  if (current === "overview") body = <OverviewSection {...props} />;
  if (current === "roles") body = <RolesSection {...props} />;
  if (current === "members") body = <MembersSection {...props} />;
  if (current === "channels") body = <ChannelsSection {...props} />;
  if (current === "invites") body = <InvitesSection {...props} />;
  if (current === "bans") body = <BansSection {...props} />;
  if (current === "audit") body = <AuditSection {...props} />;

  return (
    <div ref={rootRef} className="settings" role="dialog" aria-modal="true" aria-labelledby={titleId}>
      <nav className="settings__nav" aria-label="Seções das configurações do servidor">
        <div className="settings__nav-inner">
          <div className="settings__nav-group">
            <h2 className="settings__nav-heading" title={guild.name}>
              {guild.name}
            </h2>
            <ul>
              {visible.map(({ id, label, Icon }) => (
                <li key={id}>
                  <button type="button" className="settings__nav-item" aria-current={current === id ? "page" : undefined} onClick={() => setSection(id)}>
                    <Icon {...ICON_SM} />
                    {label}
                  </button>
                </li>
              ))}
            </ul>
          </div>
          <div className="settings__nav-group">
            <button type="button" className="settings__nav-item settings__nav-item--danger" onClick={() => setConfirm(isOwner ? "delete" : "leave")}>
              {isOwner ? <Trash2 {...ICON_SM} /> : <LogOut {...ICON_SM} />}
              {isOwner ? "Excluir servidor" : "Sair do servidor"}
            </button>
          </div>
        </div>
      </nav>
      <div className="settings__content">
        <div className="settings__inner">
          <header className="settings__header">
            <h1 id={titleId} className="settings__title">
              {visible.find((item) => item.id === current)?.label}
            </h1>
            <button type="button" className="icon-button settings__close" aria-label="Fechar configurações do servidor (Esc)" title="Fechar (Esc)" onClick={onClose}>
              <X {...ICON} />
            </button>
          </header>
          {body}
        </div>
      </div>
      {confirm && <LeaveOrDeleteDialog {...props} mode={confirm} onCancel={() => setConfirm(null)} />}
    </div>
  );
}

/* ---------------- sair / excluir ---------------- */

function LeaveOrDeleteDialog({ guild, api, onLeaving, onClose, mode, onCancel }: GuildSettingsProps & { mode: "leave" | "delete"; onCancel: () => void }) {
  const [typed, setTyped] = useState("");
  const [busy, setBusy] = useState(false);
  const [status, setStatus] = useState<Status>(null);
  const inputId = useId();
  const deleting = mode === "delete";
  const ready = !deleting || typed.trim() === guild.name;
  const submit = async (event: FormEvent) => {
    event.preventDefault();
    if (!ready) return;
    setBusy(true);
    try {
      onLeaving(guild.id);
      await (deleting ? api.deleteGuild(guild.id) : api.leaveGuild(guild.id));
      onClose();
    } catch (error) {
      setStatus({ kind: "error", text: errorText(error) });
      setBusy(false);
    }
  };
  return (
    <Modal
      title={deleting ? `Excluir “${guild.name}”?` : `Sair de “${guild.name}”?`}
      description={
        deleting
          ? "Todos os canais, mensagens, cargos e convites somem para sempre, para todo mundo. Não dá para desfazer."
          : "Você deixa de ver os canais e a conversa. Para voltar, vai precisar de um convite novo."
      }
      onClose={onCancel}
    >
      <form className="form" onSubmit={submit}>
        {deleting && (
          <div className="field">
            <label htmlFor={inputId} className="field__label">
              Para confirmar, digite o nome do servidor
            </label>
            <input id={inputId} className="input" value={typed} autoComplete="off" onChange={(event) => setTyped(event.target.value)} />
          </div>
        )}
        <FormStatus status={status} />
        <div className="modal__actions">
          <button type="button" className="button button--secondary" onClick={onCancel}>
            Cancelar
          </button>
          <button type="submit" className="button button--danger" disabled={busy || !ready}>
            {busy ? "Aguarde…" : deleting ? "Excluir servidor" : "Sair do servidor"}
          </button>
        </div>
      </form>
    </Modal>
  );
}

/* ---------------- visão geral ---------------- */

function OverviewSection({ guild, members, permissions, api }: GuildSettingsProps) {
  const canEdit = hasPermission(permissions, "MANAGE_GUILD");
  const [name, setName] = useState(guild.name);
  const [busy, setBusy] = useState(false);
  const [status, setStatus] = useState<Status>(null);
  const id = useId();
  const owner = members[guild.ownerId]?.user;
  useEffect(() => setName(guild.name), [guild.name]);
  const trimmed = name.trim();
  const submit = async (event: FormEvent) => {
    event.preventDefault();
    setBusy(true);
    setStatus(null);
    try {
      await api.updateGuild(guild.id, trimmed);
      setStatus({ kind: "ok", text: "Nome salvo. Todo mundo no servidor já vê o nome novo." });
    } catch (error) {
      setStatus({ kind: "error", text: errorText(error) });
    } finally {
      setBusy(false);
    }
  };
  return (
    <>
      <SettingsGroup title="Nome do servidor" description={canEdit ? undefined : "Só quem tem “Gerenciar servidor” pode mudar."}>
        <form className="settings-inline-form" onSubmit={submit}>
          <label htmlFor={id} className="sr-only">
            Nome do servidor
          </label>
          <input id={id} className="input" value={name} maxLength={LIMITS.guildNameMax} disabled={!canEdit} onChange={(event) => setName(event.target.value)} />
          {canEdit && (
            <button type="submit" className="button button--primary" disabled={busy || trimmed.length < LIMITS.guildNameMin || trimmed === guild.name}>
              {busy ? "Salvando…" : "Salvar"}
            </button>
          )}
        </form>
        <FormStatus status={status} />
      </SettingsGroup>
      <SettingsGroup title="Sobre">
        <dl className="settings-facts">
          <div>
            <dt>Dono</dt>
            <dd>{owner ? `${owner.displayName} (@${owner.username})` : "—"}</dd>
          </div>
          <div>
            <dt>Membros</dt>
            <dd>{Object.keys(members).length}</dd>
          </div>
          <div>
            <dt>Cargos</dt>
            <dd>{guild.roles.length}</dd>
          </div>
        </dl>
      </SettingsGroup>
    </>
  );
}

/* ---------------- cargos ---------------- */

type RoleDraft = Pick<Role, "name" | "color" | "permissions" | "hoist">;
const draftOf = (role: Role): RoleDraft => ({ name: role.name, color: role.color, permissions: role.permissions, hoist: role.hoist });
const sameDraft = (a: RoleDraft, b: RoleDraft) => a.name.trim() === b.name.trim() && a.color === b.color && a.permissions === b.permissions && a.hoist === b.hoist;

function RoleDot({ color }: { color: number | null }) {
  return <span className="role-dot" data-color={color ?? "none"} aria-hidden="true" />;
}

function RolesSection({ guild, members, me, permissions, api }: GuildSettingsProps) {
  const ctx = useMemo(() => ({ guildId: guild.id, ownerId: guild.ownerId, roles: guild.roles }), [guild.id, guild.ownerId, guild.roles]);
  const actor = { userId: me.id, roleIds: members[me.id]?.roles ?? [] };
  const [selectedId, setSelectedId] = useState<Id>(guild.roles[0]?.id ?? guild.id);
  const selected = guild.roles.find((r) => r.id === selectedId) ?? guild.roles[guild.roles.length - 1]!;
  const [draft, setDraft] = useState<RoleDraft>(() => draftOf(selected));
  const [status, setStatus] = useState<Status>(null);
  const [busy, setBusy] = useState(false);
  const [confirmDelete, setConfirmDelete] = useState(false);
  const nameId = useId();
  const editable = canManageRole(ctx, actor, selected);
  const everyone = selected.id === guild.id;
  const dirty = !sameDraft(draft, draftOf(selected));
  const isOwnerOrAdmin = guild.ownerId === me.id || hasPermission(permissions, "ADMINISTRATOR");
  const memberCount = (roleId: Id) => (roleId === guild.id ? Object.keys(members).length : Object.values(members).filter((m) => m.roles.includes(roleId)).length);

  // outro cargo selecionado, ou o mesmo mudou no servidor sem edição pendente: recarrega o rascunho
  const selectedKey = JSON.stringify(draftOf(selected)) + selected.id;
  const lastKey = useRef(selectedKey);
  useEffect(() => {
    if (lastKey.current === selectedKey) return;
    const sameRole = lastKey.current.endsWith(selected.id);
    lastKey.current = selectedKey;
    if (!sameRole || !dirty) setDraft(draftOf(selected));
  }, [selectedKey, selected, dirty]);

  const run = async (work: () => Promise<unknown>, ok?: string) => {
    setBusy(true);
    setStatus(null);
    try {
      await work();
      if (ok) setStatus({ kind: "ok", text: ok });
    } catch (error) {
      setStatus({ kind: "error", text: errorText(error) });
    } finally {
      setBusy(false);
    }
  };
  const select = (roleId: Id) => {
    if (dirty) {
      setStatus({ kind: "error", text: "Salve ou descarte as alterações deste cargo antes de abrir outro." });
      return;
    }
    setStatus(null);
    setSelectedId(roleId);
  };
  const create = () =>
    run(async () => {
      const role = await api.createRole(guild.id);
      setSelectedId(role.id);
      setDraft(draftOf(role));
    }, "Cargo criado. Dê um nome e escolha as permissões.");
  const save = () =>
    run(async () => {
      await api.updateRole(guild.id, selected.id, { ...draft, name: draft.name.trim() });
    }, "Alterações salvas.");
  const togglePermission = (bit: number, on: boolean) => setDraft((d) => ({ ...d, permissions: on ? d.permissions | bit : d.permissions & ~bit }));

  return (
    <div className="role-layout">
      <div className="role-list">
        <button type="button" className="button button--primary button--small" onClick={() => void create()} disabled={busy}>
          Criar cargo
        </button>
        <p className="field__hint">Cargos mais altos mandam nos de baixo. Você só mexe nos que estão abaixo do seu.</p>
        <ul aria-label="Cargos, do mais alto para o mais baixo">
          {guild.roles.map((role, index) => {
            const movable = role.id !== guild.id && canManageRole(ctx, actor, role);
            const above = guild.roles[index - 1];
            const below = guild.roles[index + 1];
            return (
              <li key={role.id} className="role-list__row">
                <button type="button" className="role-list__item" aria-current={role.id === selected.id ? "true" : undefined} onClick={() => select(role.id)}>
                  <RoleDot color={role.color} />
                  <span className="role-list__name">{role.name}</span>
                  <span className="role-list__count" aria-label={`${memberCount(role.id)} membros`}>
                    {memberCount(role.id)}
                  </span>
                </button>
                {movable && (
                  <span className="role-list__move">
                    <button
                      type="button"
                      className="icon-button icon-button--small"
                      aria-label={`Subir ${role.name}`}
                      title="Subir"
                      disabled={busy || !above || !canManageRole(ctx, actor, above)}
                      onClick={() => void run(() => api.moveRole(guild.id, role.id, "up"))}
                    >
                      <ArrowUp {...ICON_SM} />
                    </button>
                    <button
                      type="button"
                      className="icon-button icon-button--small"
                      aria-label={`Descer ${role.name}`}
                      title="Descer"
                      disabled={busy || !below || below.id === guild.id}
                      onClick={() => void run(() => api.moveRole(guild.id, role.id, "down"))}
                    >
                      <ArrowDown {...ICON_SM} />
                    </button>
                  </span>
                )}
              </li>
            );
          })}
        </ul>
      </div>

      <div className="role-editor">
        {!editable && (
          <p className="settings-note" role="note">
            {everyone ? "Você não pode editar o @todos sem “Gerenciar cargos”." : "Este cargo está no mesmo nível ou acima do seu: dá para ver, mas não para mudar."}
          </p>
        )}
        <SettingsGroup title={everyone ? "@todos" : "Identidade"} description={everyone ? "Vale para todo mundo no servidor. Os outros cargos só somam permissões a ele." : undefined}>
          {!everyone && (
            <>
              <div className="field">
                <label htmlFor={nameId} className="field__label">
                  Nome do cargo
                </label>
                <input id={nameId} className="input" value={draft.name} maxLength={ROLE_NAME_MAX} disabled={!editable} onChange={(event) => setDraft((d) => ({ ...d, name: event.target.value }))} />
              </div>
              <fieldset className="color-picker" disabled={!editable}>
                <legend className="field__label">Cor</legend>
                <label className="color-swatch" title="Sem cor">
                  <input type="radio" name="role-color" checked={draft.color === null} onChange={() => setDraft((d) => ({ ...d, color: null }))} />
                  <span className="role-dot" data-color="none" aria-hidden="true" />
                  <span className="sr-only">Sem cor</span>
                </label>
                {Array.from({ length: ROLE_COLORS }, (_, color) => (
                  <label key={color} className="color-swatch" title={ROLE_COLOR_NAMES[color]}>
                    <input type="radio" name="role-color" checked={draft.color === color} onChange={() => setDraft((d) => ({ ...d, color }))} />
                    <span className="role-dot" data-color={color} aria-hidden="true" />
                    <span className="sr-only">{ROLE_COLOR_NAMES[color]}</span>
                  </label>
                ))}
              </fieldset>
              <SwitchRow
                label="Mostrar separado na lista de membros"
                hint="Quem tem este cargo aparece num grupo próprio, com o nome do cargo."
                checked={draft.hoist}
                disabled={!editable}
                onChange={(hoist) => setDraft((d) => ({ ...d, hoist }))}
              />
            </>
          )}
        </SettingsGroup>

        {PERMISSION_INFO.map((group) => (
          <SettingsGroup key={group.group} title={`Permissões: ${group.group.toLowerCase()}`}>
            {group.items.map((item) => {
              const bit = PERMISSIONS[item.name];
              const mine = isOwnerOrAdmin || (permissions & bit) !== 0;
              return (
                <SwitchRow
                  key={item.name}
                  label={item.label}
                  hint={mine ? item.hint : `${item.hint} Você não tem esta permissão, então não pode dá-la.`}
                  checked={(draft.permissions & bit) !== 0}
                  disabled={!editable || !mine}
                  onChange={(on) => togglePermission(bit, on)}
                />
              );
            })}
          </SettingsGroup>
        ))}

        {editable && !everyone && (
          <SettingsGroup title="Excluir cargo" description="Quem tem o cargo perde as permissões dele na hora.">
            <div>
              <button type="button" className="button button--danger" onClick={() => setConfirmDelete(true)} disabled={busy}>
                Excluir “{selected.name}”
              </button>
            </div>
          </SettingsGroup>
        )}

        <FormStatus status={status} />
        {dirty && editable && (
          <div className="save-bar" role="region" aria-label="Alterações não salvas">
            <span>Há alterações não salvas.</span>
            <button type="button" className="button button--secondary button--small" onClick={() => setDraft(draftOf(selected))} disabled={busy}>
              Descartar
            </button>
            <button type="button" className="button button--primary button--small" onClick={() => void save()} disabled={busy || !draft.name.trim()}>
              {busy ? "Salvando…" : "Salvar alterações"}
            </button>
          </div>
        )}
      </div>

      {confirmDelete && (
        <Modal title={`Excluir o cargo “${selected.name}”?`} description="As pessoas continuam no servidor; só perdem este cargo e o que ele liberava." onClose={() => setConfirmDelete(false)}>
          <div className="modal__actions">
            <button type="button" className="button button--secondary" onClick={() => setConfirmDelete(false)}>
              Cancelar
            </button>
            <button
              type="button"
              className="button button--danger"
              onClick={() => {
                setConfirmDelete(false);
                const id = selected.id;
                void run(async () => {
                  await api.deleteRole(guild.id, id);
                  setSelectedId(guild.id);
                }, "Cargo excluído.");
              }}
            >
              Excluir cargo
            </button>
          </div>
        </Modal>
      )}
    </div>
  );
}

/* ---------------- membros ---------------- */

function MembersSection({ guild, members, me, permissions, api }: GuildSettingsProps) {
  const ctx = { guildId: guild.id, ownerId: guild.ownerId, roles: guild.roles };
  const actor = { userId: me.id, roleIds: members[me.id]?.roles ?? [] };
  const [query, setQuery] = useState("");
  const [status, setStatus] = useState<Status>(null);
  const [banTarget, setBanTarget] = useState<User | null>(null);
  const [kickTarget, setKickTarget] = useState<User | null>(null);
  const [timeoutTarget, setTimeoutTarget] = useState<User | null>(null);
  const searchId = useId();
  const roleById = new Map(guild.roles.map((r) => [r.id, r]));
  const q = query.trim().toLowerCase();
  const list = Object.values(members)
    .filter((m) => !q || m.user.displayName.toLowerCase().includes(q) || m.user.username.includes(q))
    .sort((a, b) => a.user.displayName.localeCompare(b.user.displayName, "pt-BR"));
  const run = async (work: () => Promise<unknown>, ok: string) => {
    setStatus(null);
    try {
      await work();
      setStatus({ kind: "ok", text: ok });
    } catch (error) {
      setStatus({ kind: "error", text: errorText(error) });
    }
  };
  const canRoles = hasPermission(permissions, "MANAGE_ROLES");

  return (
    <>
      <div className="field">
        <label htmlFor={searchId} className="field__label">
          Buscar membro
        </label>
        <input id={searchId} className="input" type="search" value={query} placeholder="Nome ou @usuário" onChange={(event) => setQuery(event.target.value)} />
      </div>
      <FormStatus status={status} />
      <ul className="settings-list" aria-label={`Membros (${list.length})`}>
        {list.map((member) => {
          const target = { userId: member.user.id, roleIds: member.roles };
          const owner = member.user.id === guild.ownerId;
          const timedOutUntil = member.timeoutUntil != null && member.timeoutUntil > Date.now() ? member.timeoutUntil : null;
          const isAdmin = hasPermission(computePermissions(ctx, member.user.id, member.roles), "ADMINISTRATOR");
          const canTimeout = canModerate(ctx, actor, target, "MODERATE_MEMBERS") && !isAdmin;
          const addable = canRoles ? guild.roles.filter((r) => r.id !== guild.id && !member.roles.includes(r.id) && canManageRole(ctx, actor, r)) : [];
          const roles = member.roles.map((id) => roleById.get(id)).filter((r): r is Role => Boolean(r));
          return (
            <li key={member.user.id} className="settings-list__row member-row">
              <Avatar user={member.user} />
              <div className="member-row__text">
                <span className="member-row__name">
                  {member.user.displayName}
                  {owner && <span className="tag">Dono</span>}
                  {timedOutUntil && <span className="tag tag--warning">De castigo {untilText(timedOutUntil)}</span>}
                </span>
                <span className="member-row__sub">@{member.user.username}</span>
                <ul className="chips" aria-label={`Cargos de ${member.user.displayName}`}>
                  {roles.map((role) => (
                    <li key={role.id} className="chip">
                      <RoleDot color={role.color} />
                      {role.name}
                      {canManageRole(ctx, actor, role) && (
                        <button
                          type="button"
                          className="chip__remove"
                          aria-label={`Tirar ${role.name} de ${member.user.displayName}`}
                          title="Tirar cargo"
                          onClick={() => void run(() => api.setMemberRole(guild.id, member.user.id, role.id, false), `${role.name} tirado de ${member.user.displayName}.`)}
                        >
                          <X {...ICON_SM} />
                        </button>
                      )}
                    </li>
                  ))}
                  {addable.length > 0 && (
                    <li>
                      <select
                        className="chip chip--add"
                        aria-label={`Dar cargo a ${member.user.displayName}`}
                        value=""
                        onChange={(event) => {
                          const role = roleById.get(event.target.value);
                          if (role) void run(() => api.setMemberRole(guild.id, member.user.id, role.id, true), `${role.name} dado a ${member.user.displayName}.`);
                        }}
                      >
                        <option value="">+ Cargo</option>
                        {addable.map((r) => (
                          <option key={r.id} value={r.id}>
                            {r.name}
                          </option>
                        ))}
                      </select>
                    </li>
                  )}
                </ul>
              </div>
              <div className="settings-list__actions">
                {canTimeout &&
                  (timedOutUntil ? (
                    <button
                      type="button"
                      className="button button--secondary button--small"
                      onClick={() => void run(() => api.timeoutMember(guild.id, member.user.id, null), `${member.user.displayName} saiu do castigo.`)}
                    >
                      Tirar castigo
                    </button>
                  ) : (
                    <button type="button" className="button button--secondary button--small" onClick={() => setTimeoutTarget(member.user)}>
                      Castigar
                    </button>
                  ))}
                {canModerate(ctx, actor, target, "KICK_MEMBERS") && (
                  <button type="button" className="button button--secondary button--small" onClick={() => setKickTarget(member.user)}>
                    Expulsar
                  </button>
                )}
                {canModerate(ctx, actor, target, "BAN_MEMBERS") && (
                  <button type="button" className="button button--danger button--small" onClick={() => setBanTarget(member.user)}>
                    Banir
                  </button>
                )}
              </div>
            </li>
          );
        })}
      </ul>
      {list.length === 0 && <p className="field__hint">Ninguém com esse nome.</p>}

      {kickTarget && (
        <Modal title={`Expulsar ${kickTarget.displayName}?`} description="A pessoa sai do servidor agora, mas pode voltar se receber um convite." onClose={() => setKickTarget(null)}>
          <div className="modal__actions">
            <button type="button" className="button button--secondary" onClick={() => setKickTarget(null)}>
              Cancelar
            </button>
            <button
              type="button"
              className="button button--danger"
              onClick={() => {
                const target = kickTarget;
                setKickTarget(null);
                void run(() => api.kickMember(guild.id, target.id), `${target.displayName} foi expulso.`);
              }}
            >
              Expulsar
            </button>
          </div>
        </Modal>
      )}
      {timeoutTarget && (
        <TimeoutDialog
          user={timeoutTarget}
          onCancel={() => setTimeoutTarget(null)}
          onConfirm={(minutes) => {
            const target = timeoutTarget;
            setTimeoutTarget(null);
            void run(() => api.timeoutMember(guild.id, target.id, minutes), `${target.displayName} está de castigo por ${formatDuration(minutes)}.`);
          }}
        />
      )}
      {banTarget && (
        <BanDialog
          user={banTarget}
          onCancel={() => setBanTarget(null)}
          onConfirm={(reason) => {
            const target = banTarget;
            setBanTarget(null);
            void run(() => api.banMember(guild.id, target.id, reason), `${target.displayName} foi banido.`);
          }}
        />
      )}
    </>
  );
}

function TimeoutDialog({ user, onCancel, onConfirm }: { user: User; onCancel: () => void; onConfirm: (minutes: number) => void }) {
  const [minutes, setMinutes] = useState<number>(TIMEOUT_MINUTES[1]);
  return (
    <Modal
      title={`Castigar ${user.displayName}?`}
      description="Durante o castigo a pessoa continua no servidor e lê tudo, mas não escreve, não reage e sai da voz. Acaba sozinho no fim do tempo."
      onClose={onCancel}
    >
      <form
        className="form"
        onSubmit={(event) => {
          event.preventDefault();
          onConfirm(minutes);
        }}
      >
        <fieldset className="choice-group">
          <legend className="field__label">Por quanto tempo</legend>
          {TIMEOUT_MINUTES.map((value) => (
            <label key={value} className="choice">
              <input type="radio" name="timeout" checked={minutes === value} onChange={() => setMinutes(value)} />
              <span className="choice__text">
                <span className="choice__title">{formatDuration(value)}</span>
              </span>
            </label>
          ))}
        </fieldset>
        <div className="modal__actions">
          <button type="button" className="button button--secondary" onClick={onCancel}>
            Cancelar
          </button>
          <button type="submit" className="button button--danger">
            Castigar
          </button>
        </div>
      </form>
    </Modal>
  );
}

function BanDialog({ user, onCancel, onConfirm }: { user: User; onCancel: () => void; onConfirm: (reason: string) => void }) {
  const [reason, setReason] = useState("");
  const id = useId();
  return (
    <Modal title={`Banir ${user.displayName}?`} description="A pessoa sai do servidor e não consegue voltar, nem com convite, até alguém desfazer o banimento." onClose={onCancel}>
      <form
        className="form"
        onSubmit={(event) => {
          event.preventDefault();
          onConfirm(reason.trim());
        }}
      >
        <div className="field">
          <label htmlFor={id} className="field__label">
            Motivo (opcional)
          </label>
          <input id={id} className="input" value={reason} maxLength={LIMITS.banReasonMax} onChange={(event) => setReason(event.target.value)} />
          <span className="field__hint">Fica no registro de auditoria e na lista de banidos.</span>
        </div>
        <div className="modal__actions">
          <button type="button" className="button button--secondary" onClick={onCancel}>
            Cancelar
          </button>
          <button type="submit" className="button button--danger">
            Banir
          </button>
        </div>
      </form>
    </Modal>
  );
}

/* ---------------- canais ---------------- */

function ChannelsSection(props: GuildSettingsProps) {
  const { channels, api } = props;
  const [status, setStatus] = useState<Status>(null);
  const [deleting, setDeleting] = useState<Channel | null>(null);
  const [editingId, setEditingId] = useState<Id | null>(null);
  const editing = editingId ? channels.find((c) => c.id === editingId) : undefined;
  if (editing) return <ChannelPermissions {...props} channel={editing} onBack={() => setEditingId(null)} />;
  const run = async (work: () => Promise<unknown>, ok: string) => {
    setStatus(null);
    try {
      await work();
      setStatus({ kind: "ok", text: ok });
    } catch (error) {
      setStatus({ kind: "error", text: errorText(error) });
    }
  };
  const groups: { title: string; type: Channel["type"] }[] = [
    { title: "Canais de texto", type: "text" },
    { title: "Canais de voz", type: "voice" },
  ];
  return (
    <>
      <FormStatus status={status} />
      {groups.map((group) => (
        <SettingsGroup key={group.type} title={group.title}>
          <ul className="settings-list">
            {channels
              .filter((c) => c.type === group.type)
              .map((channel) => (
                <ChannelRow
                  key={channel.id}
                  channel={channel}
                  isPrivate={isPrivateChannel(props.guild.id, channel.overwrites)}
                  onRename={(name) => run(() => api.updateChannel(channel.id, name), "Canal renomeado.")}
                  onPermissions={() => setEditingId(channel.id)}
                  onDelete={() => setDeleting(channel)}
                />
              ))}
          </ul>
        </SettingsGroup>
      ))}
      {deleting && (
        <Modal
          title={`Excluir ${deleting.type === "text" ? `#${deleting.name}` : deleting.name}?`}
          description={deleting.type === "text" ? "Todas as mensagens do canal somem para sempre." : "Quem estiver na sala sai da voz."}
          onClose={() => setDeleting(null)}
        >
          <div className="modal__actions">
            <button type="button" className="button button--secondary" onClick={() => setDeleting(null)}>
              Cancelar
            </button>
            <button
              type="button"
              className="button button--danger"
              onClick={() => {
                const channel = deleting;
                setDeleting(null);
                void run(() => api.deleteChannel(channel.id), "Canal excluído.");
              }}
            >
              Excluir canal
            </button>
          </div>
        </Modal>
      )}
    </>
  );
}

function ChannelRow({
  channel,
  isPrivate,
  onRename,
  onPermissions,
  onDelete,
}: {
  channel: Channel;
  isPrivate: boolean;
  onRename: (name: string) => Promise<void>;
  onPermissions: () => void;
  onDelete: () => void;
}) {
  const [name, setName] = useState(channel.name);
  const id = useId();
  useEffect(() => setName(channel.name), [channel.name]);
  const Icon = channel.type === "text" ? Hash : Volume2;
  return (
    <li className="settings-list__row">
      <form
        className="channel-edit"
        onSubmit={(event) => {
          event.preventDefault();
          void onRename(name);
        }}
      >
        <Icon {...ICON_SM} />
        <label htmlFor={id} className="sr-only">
          Nome de {channel.name}
        </label>
        <input id={id} className="input" value={name} maxLength={LIMITS.channelNameMax} onChange={(event) => setName(event.target.value)} />
        {name.trim() !== channel.name && name.trim() && (
          <button type="submit" className="button button--primary button--small">
            Salvar
          </button>
        )}
      </form>
      {isPrivate && (
        <span className="tag" title="Só quem foi liberado vê">
          <Lock {...ICON_SM} aria-hidden="true" /> Privado
        </span>
      )}
      <button type="button" className="button button--secondary button--small" aria-label={`Permissões de ${channel.name}`} onClick={onPermissions}>
        Permissões
      </button>
      <button type="button" className="icon-button" aria-label={`Excluir ${channel.name}`} title="Excluir canal" onClick={onDelete}>
        <Trash2 {...ICON_SM} />
      </button>
    </li>
  );
}

/* ---------------- permissões de um canal ---------------- */

const CHANNEL_PERMISSION_NAMES: Record<Channel["type"], PermissionName[]> = {
  text: ["VIEW_CHANNEL", "SEND_MESSAGES", "ADD_REACTIONS", "MANAGE_MESSAGES"],
  voice: ["VIEW_CHANNEL", "CONNECT", "SPEAK", "STREAM", "MUTE_MEMBERS", "MOVE_MEMBERS"],
};
const PERMISSION_TEXT = new Map(PERMISSION_INFO.flatMap((g) => g.items).map((i) => [i.name, i]));
type TriState = "deny" | "inherit" | "allow";
const TRI_LABEL: Record<TriState, string> = { deny: "Negar", inherit: "Herdar", allow: "Permitir" };
const targetKey = (o: Pick<Overwrite, "targetType" | "targetId">) => `${o.targetType}:${o.targetId}`;

/**
 * Sobrescritas do canal: para cada cargo ou pessoa, cada permissão fica Negar / Herdar (vale o do servidor) / Permitir.
 * Cada clique já vale (o servidor confere permissão, hierarquia e não deixa você perder o acesso).
 */
function ChannelPermissions({ guild, members, me, permissions, api, channel, onBack }: GuildSettingsProps & { channel: Channel; onBack: () => void }) {
  const [status, setStatus] = useState<Status>(null);
  const [busy, setBusy] = useState(false);
  const everyoneKey = targetKey({ targetType: "role", targetId: guild.id });
  const [selectedKey, setSelectedKey] = useState(everyoneKey);
  const ctx = { guildId: guild.id, ownerId: guild.ownerId, roles: guild.roles };
  const myRoles = members[me.id]?.roles ?? [];
  const actor = { userId: me.id, roleIds: myRoles };
  const mine = computeChannelPermissions(ctx, me.id, myRoles, channel.overwrites);
  const isAdmin = hasPermission(permissions, "ADMINISTRATOR");
  const isPrivate = isPrivateChannel(guild.id, channel.overwrites);
  const everyone = channel.overwrites.find((o) => targetKey(o) === everyoneKey) ?? { targetType: "role" as const, targetId: guild.id, allow: 0, deny: 0 };
  const readOnly = (everyone.deny & PERMISSIONS.SEND_MESSAGES) !== 0;
  const Icon = channel.type === "text" ? Hash : Volume2;
  const label = channel.type === "text" ? `#${channel.name}` : channel.name;

  const nameOf = (o: Pick<Overwrite, "targetType" | "targetId">) =>
    o.targetType === "role" ? (o.targetId === guild.id ? EVERYONE_ROLE_NAME : (guild.roles.find((r) => r.id === o.targetId)?.name ?? "cargo removido")) : (members[o.targetId]?.user.displayName ?? "pessoa que saiu");
  const canEditTarget = (o: Pick<Overwrite, "targetType" | "targetId">) => {
    if (o.targetType === "role") {
      if (o.targetId === guild.id || guild.ownerId === me.id) return true;
      const role = guild.roles.find((r) => r.id === o.targetId);
      return role ? role.position < highestPosition(ctx, me.id, myRoles) : false;
    }
    const target = members[o.targetId];
    return o.targetId === me.id || (target ? outranks(ctx, actor, { userId: target.user.id, roleIds: target.roles }) : false);
  };

  const listed = [everyone, ...channel.overwrites.filter((o) => targetKey(o) !== everyoneKey)];
  const pending = listed.some((o) => targetKey(o) === selectedKey) ? null : selectedKey;
  const selected =
    listed.find((o) => targetKey(o) === selectedKey) ??
    (pending ? { targetType: pending.split(":")[0] as Overwrite["targetType"], targetId: pending.split(":")[1]!, allow: 0, deny: 0 } : everyone);
  const addable = [
    ...guild.roles.filter((r) => r.id !== guild.id && !listed.some((o) => o.targetType === "role" && o.targetId === r.id)).map((r) => ({ key: `role:${r.id}`, label: `Cargo: ${r.name}` })),
    ...Object.values(members)
      .filter((m) => !listed.some((o) => o.targetType === "member" && o.targetId === m.user.id))
      .sort((a, b) => a.user.displayName.localeCompare(b.user.displayName, "pt-BR"))
      .map((m) => ({ key: `member:${m.user.id}`, label: `Pessoa: ${m.user.displayName}` })),
  ];

  const save = async (overwrite: Overwrite, ok: string) => {
    setBusy(true);
    setStatus(null);
    try {
      await api.setOverwrite(channel.id, overwrite);
      setStatus({ kind: "ok", text: ok });
    } catch (error) {
      setStatus({ kind: "error", text: errorText(error) });
    } finally {
      setBusy(false);
    }
  };
  const setPrivate = async (on: boolean) => {
    // quem esconde o canal precisa continuar vendo: libera a si mesmo antes (dono e Administrador já veem tudo)
    if (on && !isAdmin && guild.ownerId !== me.id) {
      const self = channel.overwrites.find((o) => o.targetType === "member" && o.targetId === me.id) ?? { targetType: "member" as const, targetId: me.id, allow: 0, deny: 0 };
      if (!(self.allow & PERMISSIONS.VIEW_CHANNEL)) {
        try {
          await api.setOverwrite(channel.id, { ...self, allow: self.allow | PERMISSIONS.VIEW_CHANNEL, deny: self.deny & ~PERMISSIONS.VIEW_CHANNEL });
        } catch (error) {
          setStatus({ kind: "error", text: errorText(error) });
          return;
        }
      }
    }
    const bit = PERMISSIONS.VIEW_CHANNEL;
    await save(
      { ...everyone, deny: on ? everyone.deny | bit : everyone.deny & ~bit, allow: everyone.allow & ~bit },
      on ? "Canal privado. Libere abaixo os cargos ou pessoas que podem ver." : "Canal aberto: todo mundo com “Ver canais” vê de novo.",
    );
  };
  const setReadOnly = (on: boolean) => {
    const bit = PERMISSIONS.SEND_MESSAGES;
    void save(
      { ...everyone, deny: on ? everyone.deny | bit : everyone.deny & ~bit, allow: everyone.allow & ~bit },
      on ? "Só leitura: o @todos lê e reage, mas não escreve. Libere quem pode escrever abaixo." : "Todo mundo volta a poder escrever.",
    );
  };
  const stateOf = (bit: number): TriState => (selected.allow & bit ? "allow" : selected.deny & bit ? "deny" : "inherit");
  const setTri = (bit: number, value: TriState) => {
    const allow = value === "allow" ? selected.allow | bit : selected.allow & ~bit;
    const deny = value === "deny" ? selected.deny | bit : selected.deny & ~bit;
    void save({ targetType: selected.targetType, targetId: selected.targetId, allow, deny }, `Permissões de ${nameOf(selected)} salvas.`);
  };
  const editable = canEditTarget(selected);
  const owner = guild.ownerId === me.id;

  return (
    <>
      <div className="channel-perms__head">
        <button type="button" className="button button--ghost button--small" onClick={onBack}>
          <ArrowLeft {...ICON_SM} />
          Canais
        </button>
        <h2 className="channel-perms__title">
          <Icon {...ICON_SM} />
          {label}
        </h2>
      </div>
      <FormStatus status={status} />
      <SettingsGroup title="Atalhos">
        <SwitchRow
          label="Canal privado"
          hint="Só quem você liberar abaixo vê o canal. Quem administra vê tudo."
          checked={isPrivate}
          disabled={busy || !(owner || isAdmin || (mine & PERMISSIONS.VIEW_CHANNEL))}
          onChange={(on) => void setPrivate(on)}
        />
        {channel.type === "text" && (
          <SwitchRow
            label="Só leitura"
            hint="O @todos lê e reage, mas não escreve. Bom para avisos e regras."
            checked={readOnly}
            disabled={busy || !(owner || isAdmin || (mine & PERMISSIONS.SEND_MESSAGES))}
            onChange={setReadOnly}
          />
        )}
      </SettingsGroup>

      <SettingsGroup title="Permissões avançadas" description="Para cada cargo ou pessoa: Negar, Herdar (vale o que o servidor dá) ou Permitir. A regra da pessoa vence a dos cargos, que vence a do @todos.">
        <div className="channel-perms">
          <div className="channel-perms__targets">
            <ul aria-label="Cargos e pessoas com regras neste canal">
              {[...listed, ...(pending ? [selected] : [])].map((o) => (
                <li key={targetKey(o)}>
                  <button type="button" className="role-list__item" aria-current={targetKey(o) === targetKey(selected) ? "true" : undefined} onClick={() => setSelectedKey(targetKey(o))}>
                    {o.targetType === "role" ? <Shield {...ICON_SM} /> : <Users {...ICON_SM} />}
                    <span className="role-list__name">{nameOf(o)}</span>
                  </button>
                </li>
              ))}
            </ul>
            {addable.length > 0 && (
              <select className="input channel-perms__add" aria-label="Adicionar cargo ou pessoa" value="" onChange={(event) => event.target.value && setSelectedKey(event.target.value)}>
                <option value="">+ Cargo ou pessoa</option>
                {addable.map((a) => (
                  <option key={a.key} value={a.key}>
                    {a.label}
                  </option>
                ))}
              </select>
            )}
          </div>
          <div className="channel-perms__grid">
            {!editable && (
              <p className="settings-note" role="note">
                Este cargo ou pessoa está no mesmo nível ou acima do seu: dá para ver, mas não para mudar.
              </p>
            )}
            {CHANNEL_PERMISSION_NAMES[channel.type].map((name) => {
              const bit = PERMISSIONS[name];
              const info = PERMISSION_TEXT.get(name)!;
              const have = owner || isAdmin || (mine & bit) !== 0;
              const current = stateOf(bit);
              return (
                <fieldset key={name} className="tri" disabled={busy || !editable || !have}>
                  <legend className="tri__label">
                    <span className="settings-switch__title">{info.label}</span>
                    <span className="choice__hint">{have ? info.hint : `${info.hint} Você não tem esta permissão aqui, então não pode mudá-la.`}</span>
                  </legend>
                  <div className="tri__options">
                    {(["deny", "inherit", "allow"] as const).map((value) => (
                      <label key={value} className={`tri__option tri__option--${value}`}>
                        <input type="radio" name={`tri-${name}`} checked={current === value} onChange={() => setTri(bit, value)} />
                        <span>{TRI_LABEL[value]}</span>
                      </label>
                    ))}
                  </div>
                </fieldset>
              );
            })}
            {targetKey(selected) !== everyoneKey && !pending && editable && (
              <div>
                <button
                  type="button"
                  className="button button--secondary button--small"
                  disabled={busy}
                  onClick={() => {
                    const removed = selected;
                    setSelectedKey(everyoneKey);
                    void save({ ...removed, allow: 0, deny: 0 }, `${nameOf(removed)} volta a seguir o servidor neste canal.`);
                  }}
                >
                  Remover regras de {nameOf(selected)}
                </button>
              </div>
            )}
          </div>
        </div>
      </SettingsGroup>
    </>
  );
}

/* ---------------- convites, banimentos e auditoria (carregados ao abrir) ---------------- */

function useLoad<T>(load: () => Promise<T>) {
  const [data, setData] = useState<T | null>(null);
  const [error, setError] = useState<string | null>(null);
  const reload = useCallback(() => {
    setError(null);
    load()
      .then(setData)
      .catch((e: unknown) => setError(errorText(e, "Não foi possível carregar. Confira a conexão e tente de novo.")));
  }, [load]);
  useEffect(reload, [reload]);
  return { data, error, reload };
}

function InvitesSection({ guild, api }: GuildSettingsProps) {
  const load = useCallback(() => api.listInvites(guild.id), [api, guild.id]);
  const { data, error, reload } = useLoad<InviteDetails[]>(load);
  const [status, setStatus] = useState<Status>(null);
  const revoke = async (code: string) => {
    setStatus(null);
    try {
      await api.deleteInvite(code);
      setStatus({ kind: "ok", text: `Convite ${code} revogado. Quem tiver o código não entra mais.` });
      reload();
    } catch (e) {
      setStatus({ kind: "error", text: errorText(e) });
    }
  };
  return (
    <SettingsGroup title="Convites ativos" description="Revogar um convite não tira ninguém do servidor; só impede gente nova de entrar por ele.">
      <FormStatus status={error ? { kind: "error", text: error } : status} />
      {data && data.length === 0 && <p className="field__hint">Nenhum convite ativo.</p>}
      <ul className="settings-list">
        {data?.map((invite) => (
          <li key={invite.code} className="settings-list__row">
            <div className="member-row__text">
              <code className="mono-code">{invite.code}</code>
              <span className="member-row__sub">
                {invite.createdBy ? `criado por ${invite.createdBy.displayName}` : "criador removido"} · {invite.uses === 1 ? "1 uso" : `${invite.uses} usos`} · {when(invite.createdAt)}
              </span>
            </div>
            <div className="settings-list__actions">
              <button type="button" className="button button--secondary button--small" onClick={() => void revoke(invite.code)}>
                Revogar
              </button>
            </div>
          </li>
        ))}
      </ul>
    </SettingsGroup>
  );
}

function BansSection({ guild, api }: GuildSettingsProps) {
  const load = useCallback(() => api.listBans(guild.id), [api, guild.id]);
  const { data, error, reload } = useLoad<Ban[]>(load);
  const [status, setStatus] = useState<Status>(null);
  const unban = async (user: User) => {
    setStatus(null);
    try {
      await api.unbanMember(guild.id, user.id);
      setStatus({ kind: "ok", text: `${user.displayName} pode voltar com um convite.` });
      reload();
    } catch (e) {
      setStatus({ kind: "error", text: errorText(e) });
    }
  };
  return (
    <SettingsGroup title="Banidos" description="Quem está aqui não entra no servidor, nem com convite.">
      <FormStatus status={error ? { kind: "error", text: error } : status} />
      {data && data.length === 0 && <p className="field__hint">Ninguém banido.</p>}
      <ul className="settings-list">
        {data?.map((ban) => (
          <li key={ban.user.id} className="settings-list__row member-row">
            <Avatar user={ban.user} />
            <div className="member-row__text">
              <span className="member-row__name">{ban.user.displayName}</span>
              <span className="member-row__sub">
                {ban.reason ? `Motivo: ${ban.reason}` : "Sem motivo informado"} · {ban.bannedBy ? `por ${ban.bannedBy.displayName}` : ""} · {when(ban.createdAt)}
              </span>
            </div>
            <div className="settings-list__actions">
              <button type="button" className="button button--secondary button--small" onClick={() => void unban(ban.user)}>
                Desfazer banimento
              </button>
            </div>
          </li>
        ))}
      </ul>
    </SettingsGroup>
  );
}

function AuditSection({ guild, api }: GuildSettingsProps) {
  const [entries, setEntries] = useState<AuditLogEntry[]>([]);
  const [done, setDone] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  const loadMore = useCallback(
    async (before?: Id) => {
      setBusy(true);
      setError(null);
      try {
        const page = await api.auditLog(guild.id, before);
        setEntries((current) => (before ? [...current, ...page] : page));
        setDone(page.length < LIMITS.auditPageSize);
      } catch (e) {
        setError(errorText(e, "Não foi possível carregar o registro. Confira a conexão e tente de novo."));
      } finally {
        setBusy(false);
      }
    },
    [api, guild.id],
  );
  useEffect(() => void loadMore(), [loadMore]);
  return (
    <SettingsGroup title="Quem mudou o quê" description="Mudanças de servidor, canais, cargos, convites e moderação, da mais nova para a mais antiga.">
      <FormStatus status={error ? { kind: "error", text: error } : null} />
      {!busy && entries.length === 0 && !error && <p className="field__hint">Nada registrado ainda.</p>}
      <ul className="settings-list">
        {entries.map((entry) => {
          const detail = auditDetail(entry);
          return (
            <li key={entry.id} className="settings-list__row member-row">
              {entry.actor ? <Avatar user={entry.actor} size="sm" /> : <span className="avatar avatar--sm" aria-hidden="true" />}
              <div className="member-row__text">
                <span className="member-row__name">{auditSentence(entry)}</span>
                <span className="member-row__sub">
                  {detail ? `${detail} · ` : ""}
                  {when(entry.createdAt)}
                </span>
              </div>
            </li>
          );
        })}
      </ul>
      {!done && entries.length > 0 && (
        <div>
          <button type="button" className="button button--secondary button--small" disabled={busy} onClick={() => void loadMore(entries[entries.length - 1]!.id)}>
            {busy ? "Carregando…" : "Carregar mais"}
          </button>
        </div>
      )}
    </SettingsGroup>
  );
}
