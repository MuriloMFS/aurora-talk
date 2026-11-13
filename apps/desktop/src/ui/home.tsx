import { useId, useState, type FormEvent } from "react";
import { Ban, Check, LogOut, MessageCircle, Pencil, Plus, UserMinus, UserPlus, Users, X } from "lucide-react";
import { LIMITS, type DmChannel, type DmPolicy, type Id, type Relationship, type User } from "@aurora/schema";
import { ApiError, type ApiClient } from "../net/api";
import { dmName } from "../state/chat-store";
import { Avatar, ICON, ICON_SM, badgeCount } from "./shell";
import { Modal } from "./Modal";
import { FormStatus, SettingsGroup, SwitchRow } from "./settings/controls";

const errorText = (error: unknown) => (error instanceof ApiError ? error.message : "Algo deu errado. Confira a conexão e tente de novo.");

/** Avatar da conversa: a pessoa (a dois) ou o ícone de grupo. */
export function DmAvatar({ dm, online }: { dm: DmChannel; online?: boolean }) {
  if (dm.type === "dm" && dm.recipients[0]) return <Avatar user={dm.recipients[0]} online={online} />;
  return (
    <span className="avatar avatar--md dm-group-avatar" aria-hidden="true">
      <Users {...ICON_SM} />
    </span>
  );
}

/* ---------------- barra lateral do Início ---------------- */

export function HomeSidebar({
  dms,
  activeDmId,
  friendsActive,
  pendingCount,
  mentions,
  unread,
  isOnline,
  onFriends,
  onOpenDm,
  onCloseDm,
  onNewGroup,
  footer,
}: {
  dms: DmChannel[];
  activeDmId: Id | null;
  friendsActive: boolean;
  pendingCount: number;
  mentions: Readonly<Record<Id, number>>;
  unread: ReadonlySet<Id>;
  isOnline: (userId: Id) => boolean;
  onFriends: () => void;
  onOpenDm: (id: Id) => void;
  onCloseDm: (dm: DmChannel) => void;
  onNewGroup: () => void;
  footer: React.ReactNode;
}) {
  return (
    <aside className="sidebar" aria-label="Início">
      <header className="sidebar__header">
        <h1 className="sidebar__title">Início</h1>
      </header>
      <nav className="sidebar__nav" aria-label="Amigos e conversas diretas">
        <ul className="channel-list">
          <li>
            <button type="button" className="channel" aria-current={friendsActive ? "page" : undefined} onClick={onFriends}>
              <Users {...ICON} />
              <span className="channel__name">Amigos</span>
              {pendingCount > 0 && (
                <span className="badge badge--mention" aria-label={`${pendingCount} pedidos de amizade`}>
                  {badgeCount(pendingCount)}
                </span>
              )}
            </button>
          </li>
        </ul>
        <div className="category">
          <span className="category__label">Mensagens diretas</span>
          <button type="button" className="icon-button icon-button--small" aria-label="Nova conversa em grupo" title="Nova conversa em grupo" onClick={onNewGroup}>
            <Plus {...ICON_SM} />
          </button>
        </div>
        {dms.length === 0 && <p className="dm-empty">Nenhuma conversa ainda. Abra uma pela lista de amigos ou de membros de um servidor.</p>}
        <ul className="channel-list">
          {dms.map((dm) => {
            const name = dmName(dm);
            const mentionCount = mentions[dm.id] ?? 0;
            const selected = dm.id === activeDmId;
            const isUnread = unread.has(dm.id) && !selected;
            const other = dm.type === "dm" ? dm.recipients[0] : undefined;
            return (
              <li key={dm.id} className="dm-row">
                <button
                  type="button"
                  className={isUnread || mentionCount > 0 ? "channel channel--dm channel--unread" : "channel channel--dm"}
                  aria-current={selected ? "page" : undefined}
                  aria-label={[name, mentionCount > 0 && `${mentionCount} não lidas`].filter(Boolean).join(", ")}
                  onClick={() => onOpenDm(dm.id)}
                >
                  <DmAvatar dm={dm} online={other ? isOnline(other.id) : undefined} />
                  <span className="dm-row__text">
                    <span className="channel__name">{name}</span>
                    {dm.type === "group_dm" && <span className="dm-row__sub">{dm.recipients.length + 1} pessoas</span>}
                  </span>
                  {mentionCount > 0 && (
                    <span className="badge badge--mention" aria-hidden="true">
                      {badgeCount(mentionCount)}
                    </span>
                  )}
                </button>
                <button
                  type="button"
                  className="icon-button icon-button--small dm-row__close"
                  aria-label={dm.type === "dm" ? `Fechar conversa com ${name}` : `Sair do grupo ${name}`}
                  title={dm.type === "dm" ? "Fechar conversa" : "Sair do grupo"}
                  onClick={() => onCloseDm(dm)}
                >
                  <X {...ICON_SM} />
                </button>
              </li>
            );
          })}
        </ul>
      </nav>
      {footer}
    </aside>
  );
}

/* ---------------- amigos ---------------- */

type FriendsTab = "online" | "all" | "pending" | "blocked" | "add";
const TABS: { id: FriendsTab; label: string }[] = [
  { id: "online", label: "Online" },
  { id: "all", label: "Todos" },
  { id: "pending", label: "Pendentes" },
  { id: "blocked", label: "Bloqueados" },
];

export function FriendsView({
  relationships,
  api,
  onMessage,
  onOpenDrawer,
}: {
  relationships: Relationship[];
  api: ApiClient;
  onMessage: (user: User) => void;
  onOpenDrawer: () => void;
}) {
  const [tab, setTab] = useState<FriendsTab>("online");
  const [status, setStatus] = useState<{ kind: "ok" | "error"; text: string } | null>(null);
  const [confirm, setConfirm] = useState<{ user: User; action: "remove" | "block" } | null>(null);
  const pending = relationships.filter((r) => r.type === "incoming" || r.type === "outgoing");
  const list =
    tab === "online"
      ? relationships.filter((r) => r.type === "friend" && r.online)
      : tab === "all"
        ? relationships.filter((r) => r.type === "friend")
        : tab === "pending"
          ? pending
          : relationships.filter((r) => r.type === "blocked");
  const run = async (work: () => Promise<unknown>, ok?: string) => {
    setStatus(null);
    try {
      await work();
      if (ok) setStatus({ kind: "ok", text: ok });
    } catch (error) {
      setStatus({ kind: "error", text: errorText(error) });
    }
  };
  const empty: Record<FriendsTab, string> = {
    online: "Nenhum amigo online agora.",
    all: "Você ainda não tem amigos aqui. Peça amizade pelo @usuário.",
    pending: "Nenhum pedido de amizade.",
    blocked: "Ninguém bloqueado.",
    add: "",
  };

  return (
    <main className="chat friends" aria-labelledby="friends-title">
      <header className="chat__header friends__header">
        <button type="button" className="icon-button chat__menu" aria-label="Abrir conversas" onClick={onOpenDrawer}>
          <MessageCircle {...ICON} />
        </button>
        <Users {...ICON} className="chat__icon" />
        <h2 id="friends-title" className="chat__title">
          Amigos
        </h2>
        <div className="friends__tabs" role="tablist" aria-label="Lista de amigos">
          {TABS.map(({ id, label }) => (
            <button key={id} type="button" role="tab" aria-selected={tab === id} className="friends__tab" onClick={() => setTab(id)}>
              {label}
              {id === "pending" && pending.some((r) => r.type === "incoming") && <span className="badge badge--mention">{pending.filter((r) => r.type === "incoming").length}</span>}
            </button>
          ))}
          <button type="button" role="tab" aria-selected={tab === "add"} className="friends__tab friends__tab--add" onClick={() => setTab("add")}>
            Adicionar amigo
          </button>
        </div>
      </header>
      <div className="friends__body">
        <FormStatus status={status} />
        {tab === "add" ? (
          <AddFriendForm api={api} />
        ) : (
          <>
            <h3 className="friends__count">
              {TABS.find((t) => t.id === tab)?.label} — {list.length}
            </h3>
            {list.length === 0 && <p className="friends__empty">{empty[tab]}</p>}
            <ul className="friends__list">
              {list.map((rel) => (
                <li key={rel.user.id} className="friend-row">
                  <Avatar user={rel.user} online={rel.type === "blocked" ? undefined : rel.online} />
                  <div className="friend-row__text">
                    <span className="friend-row__name">{rel.user.displayName}</span>
                    <span className="friend-row__sub">
                      @{rel.user.username}
                      {rel.type === "incoming" && " · quer ser seu amigo"}
                      {rel.type === "outgoing" && " · pedido enviado"}
                      {rel.type === "friend" && (rel.online ? " · online" : " · offline")}
                    </span>
                  </div>
                  <div className="friend-row__actions">
                    {rel.type === "friend" && (
                      <>
                        <button type="button" className="icon-button" aria-label={`Mandar mensagem para ${rel.user.displayName}`} title="Mensagem" onClick={() => onMessage(rel.user)}>
                          <MessageCircle {...ICON_SM} />
                        </button>
                        <button type="button" className="icon-button" aria-label={`Desfazer amizade com ${rel.user.displayName}`} title="Desfazer amizade" onClick={() => setConfirm({ user: rel.user, action: "remove" })}>
                          <UserMinus {...ICON_SM} />
                        </button>
                        <button type="button" className="icon-button" aria-label={`Bloquear ${rel.user.displayName}`} title="Bloquear" onClick={() => setConfirm({ user: rel.user, action: "block" })}>
                          <Ban {...ICON_SM} />
                        </button>
                      </>
                    )}
                    {rel.type === "incoming" && (
                      <>
                        <button type="button" className="button button--primary button--small" onClick={() => void run(() => api.acceptFriend(rel.user.id), `Agora você e ${rel.user.displayName} são amigos.`)}>
                          <Check {...ICON_SM} />
                          Aceitar
                        </button>
                        <button type="button" className="button button--secondary button--small" onClick={() => void run(() => api.removeRelationship(rel.user.id))}>
                          Recusar
                        </button>
                      </>
                    )}
                    {rel.type === "outgoing" && (
                      <button type="button" className="button button--secondary button--small" onClick={() => void run(() => api.removeRelationship(rel.user.id))}>
                        Cancelar pedido
                      </button>
                    )}
                    {rel.type === "blocked" && (
                      <button type="button" className="button button--secondary button--small" onClick={() => void run(() => api.removeRelationship(rel.user.id), `${rel.user.displayName} foi desbloqueado.`)}>
                        Desbloquear
                      </button>
                    )}
                  </div>
                </li>
              ))}
            </ul>
          </>
        )}
      </div>
      {confirm && (
        <Modal
          title={confirm.action === "remove" ? `Desfazer amizade com ${confirm.user.displayName}?` : `Bloquear ${confirm.user.displayName}?`}
          description={
            confirm.action === "remove"
              ? "Vocês deixam de ser amigos. As conversas continuam onde estão."
              : "A pessoa não consegue mais mandar mensagem direta nem pedir amizade, e as mensagens dela nos servidores ficam escondidas para você. Ela não é avisada."
          }
          onClose={() => setConfirm(null)}
        >
          <div className="modal__actions">
            <button type="button" className="button button--secondary" onClick={() => setConfirm(null)}>
              Cancelar
            </button>
            <button
              type="button"
              className="button button--danger"
              onClick={() => {
                const { user, action } = confirm;
                setConfirm(null);
                void run(() => (action === "remove" ? api.removeRelationship(user.id) : api.blockUser(user.id)), action === "remove" ? undefined : `${user.displayName} foi bloqueado.`);
              }}
            >
              {confirm.action === "remove" ? "Desfazer amizade" : "Bloquear"}
            </button>
          </div>
        </Modal>
      )}
    </main>
  );
}

function AddFriendForm({ api }: { api: ApiClient }) {
  const id = useId();
  const [username, setUsername] = useState("");
  const [busy, setBusy] = useState(false);
  const [status, setStatus] = useState<{ kind: "ok" | "error"; text: string } | null>(null);
  const submit = async (event: FormEvent) => {
    event.preventDefault();
    const name = username.trim();
    if (!name) return;
    setBusy(true);
    setStatus(null);
    try {
      const rel = await api.requestFriend(name);
      setStatus({ kind: "ok", text: rel.type === "friend" ? `Agora você e ${rel.user.displayName} são amigos.` : `Pedido enviado para ${rel.user.displayName}.` });
      setUsername("");
    } catch (error) {
      setStatus({ kind: "error", text: errorText(error) });
    } finally {
      setBusy(false);
    }
  };
  return (
    <form className="add-friend" onSubmit={submit}>
      <h3 className="add-friend__title">Adicionar amigo</h3>
      <p className="add-friend__hint">Digite o @usuário da pessoa (o nome que ela usa para entrar, não o de exibição).</p>
      <div className="settings-inline-form">
        <label htmlFor={id} className="sr-only">
          Usuário da pessoa
        </label>
        <input id={id} className="input" value={username} placeholder="@usuario" maxLength={LIMITS.usernameMax + 1} autoComplete="off" onChange={(e) => setUsername(e.target.value)} />
        <button type="submit" className="button button--primary" disabled={busy || !username.trim()}>
          <UserPlus {...ICON_SM} />
          {busy ? "Enviando…" : "Pedir amizade"}
        </button>
      </div>
      <FormStatus status={status} />
    </form>
  );
}

/* ---------------- grupo: criar, renomear, pôr gente ---------------- */

/** Escolher amigos para um grupo novo (ou para pôr num grupo existente). */
export function PickFriendsDialog({
  title,
  description,
  friends,
  exclude = [],
  max,
  withName,
  confirmLabel,
  onConfirm,
  onClose,
}: {
  title: string;
  description: string;
  friends: User[];
  exclude?: Id[];
  max: number;
  withName?: boolean;
  confirmLabel: string;
  onConfirm: (ids: Id[], name: string) => Promise<void>;
  onClose: () => void;
}) {
  const [picked, setPicked] = useState<Id[]>([]);
  const [name, setName] = useState("");
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const nameId = useId();
  const options = friends.filter((f) => !exclude.includes(f.id));
  const toggle = (id: Id) => setPicked((list) => (list.includes(id) ? list.filter((x) => x !== id) : list.length < max ? [...list, id] : list));
  const submit = async (event: FormEvent) => {
    event.preventDefault();
    setBusy(true);
    setError(null);
    try {
      await onConfirm(picked, name.trim());
      onClose();
    } catch (caught) {
      setError(errorText(caught));
      setBusy(false);
    }
  };
  return (
    <Modal title={title} description={description} onClose={onClose}>
      <form className="form" onSubmit={submit}>
        {options.length === 0 ? (
          <p className="field__hint">Nenhum amigo para escolher. Peça amizade em Início → Amigos.</p>
        ) : (
          <fieldset className="pick-list">
            <legend className="field__label">
              Amigos ({picked.length} de {max})
            </legend>
            {options.map((friend) => (
              <label key={friend.id} className="pick-list__item">
                <input type="checkbox" checked={picked.includes(friend.id)} disabled={!picked.includes(friend.id) && picked.length >= max} onChange={() => toggle(friend.id)} />
                <Avatar user={friend} size="sm" />
                <span>{friend.displayName}</span>
                <span className="pick-list__username">@{friend.username}</span>
              </label>
            ))}
          </fieldset>
        )}
        {withName && picked.length > 1 && (
          <div className="field">
            <label htmlFor={nameId} className="field__label">
              Nome do grupo (opcional)
            </label>
            <input id={nameId} className="input" value={name} maxLength={LIMITS.groupNameMax} onChange={(e) => setName(e.target.value)} />
          </div>
        )}
        {error && (
          <p className="form-error" role="alert">
            {error}
          </p>
        )}
        <div className="modal__actions">
          <button type="button" className="button button--secondary" onClick={onClose}>
            Cancelar
          </button>
          <button type="submit" className="button button--primary" disabled={busy || picked.length === 0}>
            {busy ? "Aguarde…" : confirmLabel}
          </button>
        </div>
      </form>
    </Modal>
  );
}

export function RenameGroupDialog({ dm, onRename, onClose }: { dm: DmChannel; onRename: (name: string) => Promise<void>; onClose: () => void }) {
  const [name, setName] = useState(dm.name ?? "");
  const [error, setError] = useState<string | null>(null);
  const id = useId();
  return (
    <Modal title="Renomear grupo" description="Vazio = o nome das pessoas do grupo." onClose={onClose}>
      <form
        className="form"
        onSubmit={async (event) => {
          event.preventDefault();
          try {
            await onRename(name.trim());
            onClose();
          } catch (caught) {
            setError(errorText(caught));
          }
        }}
      >
        <div className="field">
          <label htmlFor={id} className="field__label">
            Nome do grupo
          </label>
          <input id={id} className="input" value={name} maxLength={LIMITS.groupNameMax} onChange={(e) => setName(e.target.value)} autoFocus />
        </div>
        {error && (
          <p className="form-error" role="alert">
            {error}
          </p>
        )}
        <div className="modal__actions">
          <button type="button" className="button button--secondary" onClick={onClose}>
            Cancelar
          </button>
          <button type="submit" className="button button--primary">
            Salvar
          </button>
        </div>
      </form>
    </Modal>
  );
}

/** Ações no topo da conversa direta: grupo (renomear, pôr gente, sair) ou a dois (bloquear/desbloquear). */
export function DmHeaderActions({
  dm,
  blocked,
  onRename,
  onAddPeople,
  onLeave,
  onToggleBlock,
}: {
  dm: DmChannel;
  blocked: boolean;
  onRename: () => void;
  onAddPeople: () => void;
  onLeave: () => void;
  onToggleBlock: () => void;
}) {
  if (dm.type === "group_dm") {
    return (
      <>
        <button type="button" className="icon-button" aria-label="Renomear grupo" title="Renomear grupo" onClick={onRename}>
          <Pencil {...ICON} />
        </button>
        <button type="button" className="icon-button" aria-label="Pôr pessoas no grupo" title="Pôr pessoas" onClick={onAddPeople}>
          <UserPlus {...ICON} />
        </button>
        <button type="button" className="icon-button" aria-label="Sair do grupo" title="Sair do grupo" onClick={onLeave}>
          <LogOut {...ICON} />
        </button>
      </>
    );
  }
  const other = dm.recipients[0];
  if (!other) return null;
  return (
    <button
      type="button"
      className="icon-button"
      aria-label={blocked ? `Desbloquear ${other.displayName}` : `Bloquear ${other.displayName}`}
      title={blocked ? "Desbloquear" : "Bloquear"}
      aria-pressed={blocked}
      onClick={onToggleBlock}
    >
      <Ban {...ICON} />
    </button>
  );
}

/** Minha conta → quem pode me mandar mensagem direta. */
export function DmPrivacy({ dmPolicy, api, onChange }: { dmPolicy: DmPolicy; api: ApiClient; onChange: (policy: DmPolicy) => void }) {
  const [status, setStatus] = useState<{ kind: "ok" | "error"; text: string } | null>(null);
  return (
    <SettingsGroup title="Mensagens diretas" description="Amigos sempre podem mandar mensagem. Quem você bloqueou, nunca.">
      <SwitchRow
        label="Aceitar mensagens de quem divide servidor comigo"
        hint="Desligado, só amigos começam conversa com você."
        checked={dmPolicy === "servers"}
        onChange={(on) => {
          const next: DmPolicy = on ? "servers" : "friends";
          setStatus(null);
          api
            .updateUserSettings(next)
            .then(() => onChange(next))
            .catch((error: unknown) => setStatus({ kind: "error", text: errorText(error) }));
        }}
      />
      <FormStatus status={status} />
    </SettingsGroup>
  );
}
