import { useEffect, useRef, useState, type KeyboardEvent as ReactKeyboardEvent, type ReactNode } from "react";
import {
  ArrowRightLeft,
  Home,
  MessageCircle,
  Compass,
  Crown,
  Ellipsis,
  Hash,
  HeadphoneOff,
  Headphones,
  Lock,
  Mic,
  MicOff,
  PhoneOff,
  Plus,
  ScreenShare,
  ScreenShareOff,
  Settings,
  Settings2,
  UserPlus,
  Volume2,
} from "lucide-react";
import { isPrivateChannel, type Channel, type ChannelType, type Id, type Member, type Role, type User, type VoiceState } from "@aurora/schema";
import type { GuildEntry } from "../state/chat-store";
import { avatarIndex, initials } from "../messages";
import { fileUrl } from "../avatar-image";
import { memberColor, memberGroups } from "../roles";

export const ICON = { size: 20, strokeWidth: 1.75, "aria-hidden": true } as const;
export const ICON_SM = { size: 16, strokeWidth: 1.75, "aria-hidden": true } as const;

export function Avatar({ user, size = "md", online, speaking }: { user: User; size?: "sm" | "md" | "lg" | "xl"; online?: boolean; speaking?: boolean }) {
  // foto que não carregou (servidor fora, arquivo apagado): volta para as iniciais
  const [failed, setFailed] = useState<string | null>(null);
  const photo = user.avatar && user.avatar !== failed ? user.avatar : null;
  return (
    <span className={`avatar avatar--${size}${speaking ? " avatar--speaking" : ""}`} data-avatar={avatarIndex(user.id)}>
      {photo ? (
        <img className="avatar__img" src={fileUrl(photo)} alt="" draggable={false} onError={() => setFailed(photo)} />
      ) : (
        <span aria-hidden="true">{initials(user.displayName)}</span>
      )}
      {online !== undefined && (
        <span className={`presence presence--${online ? "online" : "offline"}`} role="img" aria-label={online ? "Online" : "Offline"} />
      )}
    </span>
  );
}

/* ---------------- rail de servidores ---------------- */

interface RailProps {
  guilds: GuildEntry[];
  activeGuildId: Id | null;
  /** Botão Início (amigos e conversas diretas). */
  homeActive: boolean;
  homeMentions: number;
  onHome: () => void;
  unreadGuildIds: ReadonlySet<Id>;
  /** Menções não lidas por servidor. */
  guildMentions: Readonly<Record<Id, number>>;
  onSelect: (id: Id) => void;
  onCreate: () => void;
  onJoin: () => void;
}

/** Contagem para selo (guia visual §6.1): até 99, depois "99+". */
export const badgeCount = (n: number) => (n > 99 ? "99+" : String(n));
const mentionLabel = (n: number) => (n === 1 ? "1 menção" : `${n} menções`);

export function Rail({ guilds, activeGuildId, homeActive, homeMentions, onHome, unreadGuildIds, guildMentions, onSelect, onCreate, onJoin }: RailProps) {
  return (
    <nav className="rail" aria-label="Servidores">
      <ul className="rail__list">
        <li>
          <button
            type="button"
            className="tile tile--home"
            aria-label={["Início: amigos e mensagens diretas", homeMentions > 0 && mentionLabel(homeMentions)].filter(Boolean).join(", ")}
            aria-current={homeActive ? "page" : undefined}
            title="Início"
            onClick={onHome}
          >
            <Home {...ICON} />
            {homeMentions > 0 && (
              <span className="badge badge--mention tile__badge" aria-hidden="true">
                {badgeCount(homeMentions)}
              </span>
            )}
          </button>
        </li>
        <li className="rail__separator" aria-hidden="true" />
        {guilds.map((guild) => {
          const active = guild.id === activeGuildId && !homeActive;
          const unread = unreadGuildIds.has(guild.id) && !active;
          const mentions = guildMentions[guild.id] ?? 0;
          const label = [guild.name, mentions > 0 && mentionLabel(mentions), unread && "mensagens não lidas"].filter(Boolean).join(", ");
          return (
            <li key={guild.id}>
              <button
                type="button"
                className="tile"
                aria-label={label}
                aria-current={active ? "page" : undefined}
                title={guild.name}
                onClick={() => onSelect(guild.id)}
              >
                <span aria-hidden="true">{initials(guild.name)}</span>
                {unread && <span className="tile__unread" aria-hidden="true" />}
                {mentions > 0 && (
                  <span className="badge badge--mention tile__badge" aria-hidden="true">
                    {badgeCount(mentions)}
                  </span>
                )}
              </button>
            </li>
          );
        })}
        {guilds.length > 0 && <li className="rail__separator" aria-hidden="true" />}
        <li>
          <button type="button" className="tile tile--ghost" aria-label="Criar servidor" title="Criar servidor" onClick={onCreate}>
            <Plus {...ICON} />
          </button>
        </li>
        <li>
          <button type="button" className="tile tile--ghost" aria-label="Entrar com convite" title="Entrar com convite" onClick={onJoin}>
            <Compass {...ICON} />
          </button>
        </li>
      </ul>
    </nav>
  );
}

/* ---------------- canais, voz e painel do usuário ---------------- */

export interface MyVoice {
  channelId: Id;
  status: "connecting" | "connected" | "reconnecting";
  muted: boolean;
  deafened: boolean;
  streaming: boolean;
}

interface SidebarProps {
  guild: GuildEntry;
  textChannels: Channel[];
  voiceChannels: Channel[];
  activeChannelId: Id | null;
  unread: ReadonlySet<Id>;
  /** Menções não lidas por canal. */
  mentions: Readonly<Record<Id, number>>;
  /** Permissões neste servidor (o servidor confere de novo). */
  canManageChannels: boolean;
  canInvite: boolean;
  /** Na sala em que estou: falar e transmitir. */
  canSpeak: boolean;
  canStream: boolean;
  /** Um moderador me silenciou (o microfone fica bloqueado até tirarem). */
  serverMuted: boolean;
  /** Posso entrar nesta sala de voz? */
  canConnect: (channelId: Id) => boolean;
  /** O que posso fazer com quem está na voz (silenciar; mover e desconectar). */
  voiceModeration: (userId: Id, channelId: Id) => { canMute: boolean; canMove: boolean };
  onModerateVoice: (userId: Id, action: { muted?: boolean; channelId?: Id | null }) => void;
  me: User;
  online: boolean;
  statusText: string;
  membersById: Readonly<Record<Id, Member>>;
  voiceStates: Readonly<Record<Id, VoiceState>>;
  speaking: ReadonlySet<Id>;
  myVoice: MyVoice | null;
  voiceError: string | null;
  onSelectChannel: (id: Id) => void;
  onCreateChannel: (type: ChannelType) => void;
  onInvite: () => void;
  onOpenSettings: () => void;
  onOpenGuildSettings: () => void;
  onJoinVoice: (channelId: Id) => void;
  onLeaveVoice: () => void;
  onToggleMute: () => void;
  onToggleDeafen: () => void;
  onDismissVoiceError: () => void;
  /** Quantas telas estão sendo compartilhadas na minha sala (inclui a minha). */
  screenShareCount: number;
  stageOpen: boolean;
  onToggleScreenShare: () => void;
  /** Aviso discreto sobre a minha transmissão (ex.: foi sem o áudio do sistema). */
  shareNotice: string | null;
  onToggleStage: () => void;
}

export function Sidebar(props: SidebarProps) {
  const { guild, textChannels, voiceChannels, activeChannelId, unread, mentions, canManageChannels, onSelectChannel } = props;
  const participantsOf = (channelId: Id) => Object.values(props.voiceStates).filter((v) => v.channelId === channelId);

  return (
    <aside className="sidebar" aria-label={`Canais de ${guild.name}`}>
      <header className="sidebar__header">
        <h1 className="sidebar__title" title={guild.name}>
          {guild.name}
        </h1>
        {props.canInvite && (
          <button type="button" className="icon-button" aria-label="Convidar pessoas" title="Convidar pessoas" onClick={props.onInvite}>
            <UserPlus {...ICON} />
          </button>
        )}
        <button type="button" className="icon-button" aria-label="Configurações do servidor" title="Configurações do servidor" onClick={props.onOpenGuildSettings}>
          <Settings2 {...ICON} />
        </button>
      </header>
      <nav className="sidebar__nav" aria-label="Canais">
        <CategoryHeader label="Canais de texto" canCreate={canManageChannels} onCreate={() => props.onCreateChannel("text")} createLabel="Criar canal de texto" />
        <ul className="channel-list">
          {textChannels.map((channel) => {
            const selected = channel.id === activeChannelId;
            const isUnread = unread.has(channel.id) && !selected;
            // aparece até no canal aberto enquanto a janela está sem foco (bate com o selo do servidor e da barra de tarefas)
            const mentionCount = mentions[channel.id] ?? 0;
            const label = [channel.name, mentionCount > 0 && mentionLabel(mentionCount), isUnread && "não lido"].filter(Boolean).join(", ");
            return (
              <li key={channel.id}>
                <button
                  type="button"
                  className={isUnread || mentionCount > 0 ? "channel channel--unread" : "channel"}
                  aria-current={selected ? "page" : undefined}
                  aria-label={label}
                  onClick={() => onSelectChannel(channel.id)}
                >
                  <Hash {...ICON} />
                  <span className="channel__name">{channel.name}</span>
                  {isPrivateChannel(guild.id, channel.overwrites) && <PrivateMark />}
                  {mentionCount > 0 ? (
                    <span className="badge badge--mention" aria-hidden="true">
                      {badgeCount(mentionCount)}
                    </span>
                  ) : (
                    isUnread && <span className="channel__unread-dot" aria-hidden="true" />
                  )}
                </button>
              </li>
            );
          })}
        </ul>

        {(voiceChannels.length > 0 || canManageChannels) && (
          <CategoryHeader label="Canais de voz" canCreate={canManageChannels} onCreate={() => props.onCreateChannel("voice")} createLabel="Criar canal de voz" />
        )}
        <ul className="channel-list">
          {voiceChannels.map((channel) => {
            const participants = participantsOf(channel.id);
            const joined = props.myVoice?.channelId === channel.id;
            const allowed = joined || props.canConnect(channel.id);
            const action = joined ? ", você está aqui" : allowed ? ", entrar" : ", você não tem permissão para entrar";
            return (
              <li key={channel.id}>
                <button
                  type="button"
                  className={joined ? "channel channel--voice-active" : allowed ? "channel" : "channel channel--locked"}
                  aria-label={`${channel.name}, canal de voz${participants.length ? `, ${participants.length} na sala` : ""}${action}`}
                  aria-disabled={allowed ? undefined : true}
                  title={allowed ? undefined : "Você não tem permissão para entrar nesta sala"}
                  onClick={() => !joined && allowed && props.onJoinVoice(channel.id)}
                >
                  <Volume2 {...ICON} />
                  <span className="channel__name">{channel.name}</span>
                  {isPrivateChannel(guild.id, channel.overwrites) && <PrivateMark />}
                </button>
                {participants.length > 0 && (
                  <ul className="voice-users" aria-label={`Na sala ${channel.name}`}>
                    {participants.map((state) => {
                      const user = props.membersById[state.userId]?.user;
                      if (!user) return null;
                      const speaking = joined && props.speaking.has(state.userId) && !state.muted;
                      const moderation = state.userId === props.me.id ? null : props.voiceModeration(state.userId, channel.id);
                      return (
                        <li key={state.userId} className="voice-user">
                          <Avatar user={user} size="sm" speaking={speaking} />
                          <span className={speaking ? "voice-user__name voice-user__name--speaking" : "voice-user__name"}>{user.displayName}</span>
                          {speaking && <span className="sr-only">(falando)</span>}
                          {state.streaming &&
                            (joined ? (
                              <button type="button" className="live-pill live-pill--button" title={`Assistir a tela de ${user.displayName}`} onClick={props.onToggleStage}>
                                AO VIVO
                              </button>
                            ) : (
                              <span className="live-pill" title={`${user.displayName} está transmitindo a tela`}>
                                AO VIVO
                              </span>
                            ))}
                          {state.serverMuted ? (
                            <span className="voice-user__flag voice-user__flag--server" title="Silenciado por um moderador">
                              <MicOff {...ICON_SM} />
                              <span className="sr-only">(silenciado por um moderador)</span>
                            </span>
                          ) : state.deafened ? (
                            <span className="voice-user__flag" title="Ensurdecido">
                              <HeadphoneOff {...ICON_SM} />
                              <span className="sr-only">(ensurdecido)</span>
                            </span>
                          ) : state.muted ? (
                            <span className="voice-user__flag" title="Microfone desligado">
                              <MicOff {...ICON_SM} />
                              <span className="sr-only">(microfone desligado)</span>
                            </span>
                          ) : null}
                          {moderation && (moderation.canMute || moderation.canMove) && (
                            <VoiceUserMenu
                              name={user.displayName}
                              serverMuted={Boolean(state.serverMuted)}
                              canMute={moderation.canMute}
                              canMove={moderation.canMove}
                              destinations={voiceChannels.filter((c) => c.id !== channel.id && props.canConnect(c.id))}
                              onAction={(action) => props.onModerateVoice(state.userId, action)}
                            />
                          )}
                        </li>
                      );
                    })}
                  </ul>
                )}
              </li>
            );
          })}
        </ul>
      </nav>
      <VoicePanel {...props} />
      <UserPanel {...props} />
    </aside>
  );
}

function PrivateMark() {
  return (
    <span className="channel__private" title="Canal privado">
      <Lock {...ICON_SM} />
      <span className="sr-only">(privado)</span>
    </span>
  );
}

/** Menu de moderação de quem está na voz: silenciar para todos, mover para outra sala, desconectar. */
function VoiceUserMenu({
  name,
  serverMuted,
  canMute,
  canMove,
  destinations,
  onAction,
}: {
  name: string;
  serverMuted: boolean;
  canMute: boolean;
  canMove: boolean;
  destinations: Channel[];
  onAction: (action: { muted?: boolean; channelId?: Id | null }) => void;
}) {
  const [open, setOpen] = useState(false);
  const rootRef = useRef<HTMLDivElement>(null);
  const triggerRef = useRef<HTMLButtonElement>(null);
  const menuRef = useRef<HTMLDivElement>(null);
  const items = () => [...(menuRef.current?.querySelectorAll<HTMLButtonElement>('[role="menuitem"]') ?? [])];

  useEffect(() => {
    if (!open) return;
    items()[0]?.focus();
    const onPointer = (event: PointerEvent) => {
      if (!rootRef.current?.contains(event.target as Node)) setOpen(false);
    };
    document.addEventListener("pointerdown", onPointer);
    return () => document.removeEventListener("pointerdown", onPointer);
  }, [open]);

  const close = () => {
    setOpen(false);
    triggerRef.current?.focus();
  };
  const choose = (action: { muted?: boolean; channelId?: Id | null }) => {
    close();
    onAction(action);
  };
  const onKeyDown = (event: ReactKeyboardEvent) => {
    const list = items();
    const index = list.indexOf(document.activeElement as HTMLButtonElement);
    if (event.key === "Escape") {
      event.preventDefault();
      event.stopPropagation();
      close();
    } else if (event.key === "ArrowDown" || event.key === "ArrowUp") {
      event.preventDefault();
      const step = event.key === "ArrowDown" ? 1 : -1;
      list[(index + step + list.length) % list.length]?.focus();
    } else if (event.key === "Tab") {
      setOpen(false);
    }
  };

  return (
    <div className="voice-user__actions" ref={rootRef}>
      <button
        ref={triggerRef}
        type="button"
        className="icon-button icon-button--small voice-user__more"
        aria-label={`Moderar ${name} na voz`}
        title={`Moderar ${name}`}
        aria-haspopup="menu"
        aria-expanded={open}
        onClick={() => setOpen((v) => !v)}
      >
        <Ellipsis {...ICON_SM} />
      </button>
      {open && (
        <div className="voice-menu" role="menu" aria-label={`Moderar ${name}`} ref={menuRef} onKeyDown={onKeyDown}>
          {canMute && (
            <button type="button" role="menuitem" className="voice-menu__item" onClick={() => choose({ muted: !serverMuted })}>
              {serverMuted ? <Mic {...ICON_SM} /> : <MicOff {...ICON_SM} />}
              {serverMuted ? "Tirar o silêncio" : "Silenciar para todos"}
            </button>
          )}
          {canMove && destinations.length > 0 && (
            <>
              <span className="voice-menu__label" aria-hidden="true">
                Mover para
              </span>
              {destinations.map((destination) => (
                <button
                  key={destination.id}
                  type="button"
                  role="menuitem"
                  className="voice-menu__item"
                  aria-label={`Mover para ${destination.name}`}
                  onClick={() => choose({ channelId: destination.id })}
                >
                  <ArrowRightLeft {...ICON_SM} />
                  {destination.name}
                </button>
              ))}
            </>
          )}
          {canMove && (
            <button type="button" role="menuitem" className="voice-menu__item voice-menu__item--danger" onClick={() => choose({ channelId: null })}>
              <PhoneOff {...ICON_SM} />
              Desconectar da voz
            </button>
          )}
        </div>
      )}
    </div>
  );
}

function CategoryHeader({ label, canCreate, onCreate, createLabel }: { label: string; canCreate: boolean; onCreate: () => void; createLabel: string }) {
  return (
    <div className="category">
      <span className="category__label">{label}</span>
      {canCreate && (
        <button type="button" className="icon-button icon-button--small" aria-label={createLabel} title={createLabel} onClick={onCreate}>
          <Plus {...ICON_SM} />
        </button>
      )}
    </div>
  );
}

const VOICE_STATUS: Record<MyVoice["status"], string> = {
  connecting: "Conectando à voz…",
  connected: "Voz conectada",
  reconnecting: "Reconectando à voz…",
};

function VoicePanel({
  myVoice,
  voiceChannels,
  voiceError,
  onLeaveVoice,
  onToggleMute,
  onToggleDeafen,
  onDismissVoiceError,
  screenShareCount,
  stageOpen,
  onToggleScreenShare,
  onToggleStage,
  shareNotice,
  canSpeak,
  canStream,
  serverMuted,
}: SidebarProps) {
  if (voiceError) {
    return (
      <div className="voice-panel voice-panel--error" role="alert">
        <p className="voice-panel__error">{voiceError}</p>
        <button type="button" className="button button--secondary button--small" onClick={onDismissVoiceError}>
          Fechar
        </button>
      </div>
    );
  }
  if (!myVoice) return null;
  const channel = voiceChannels.find((c) => c.id === myVoice.channelId);
  return (
    <section className="voice-panel" aria-label="Voz">
      <div className="voice-panel__row">
      <div className="voice-panel__info" role="status">
        <span className={`voice-panel__status voice-panel__status--${myVoice.status}`}>{VOICE_STATUS[myVoice.status]}</span>
        <span className="voice-panel__channel">
          {channel?.name ?? "Canal de voz"}
          {myVoice.streaming && " · transmitindo sua tela"}
        </span>
      </div>
      <div className="voice-panel__actions">
        <button
          type="button"
          className="icon-button icon-button--alert"
          aria-pressed={myVoice.muted}
          aria-label={
            serverMuted
              ? "Microfone bloqueado: um moderador silenciou você"
              : !canSpeak
                ? "Microfone bloqueado: você não tem permissão para falar aqui"
                : myVoice.muted
                  ? "Ligar microfone"
                  : "Desligar microfone"
          }
          title={serverMuted ? "Um moderador silenciou você nesta voz" : !canSpeak ? "Você não tem permissão para falar nesta sala" : myVoice.muted ? "Ligar microfone" : "Desligar microfone"}
          disabled={!canSpeak || serverMuted}
          onClick={onToggleMute}
        >
          {myVoice.muted ? <MicOff {...ICON} /> : <Mic {...ICON} />}
        </button>
        <button
          type="button"
          className="icon-button icon-button--alert"
          aria-pressed={myVoice.deafened}
          aria-label={myVoice.deafened ? "Voltar a ouvir" : "Ensurdecer"}
          title={myVoice.deafened ? "Voltar a ouvir" : "Ensurdecer"}
          onClick={onToggleDeafen}
        >
          {myVoice.deafened ? <HeadphoneOff {...ICON} /> : <Headphones {...ICON} />}
        </button>
        <button
          type="button"
          className="icon-button icon-button--live"
          aria-pressed={myVoice.streaming}
          aria-label={myVoice.streaming ? "Parar de compartilhar a tela" : canStream ? "Compartilhar tela" : "Compartilhar tela: você não tem permissão para transmitir aqui"}
          title={myVoice.streaming ? "Parar de compartilhar a tela" : canStream ? "Compartilhar tela" : "Você não tem permissão para transmitir nesta sala"}
          onClick={onToggleScreenShare}
          disabled={(myVoice.status !== "connected" || !canStream) && !myVoice.streaming}
        >
          {myVoice.streaming ? <ScreenShareOff {...ICON} /> : <ScreenShare {...ICON} />}
        </button>
        <button type="button" className="icon-button icon-button--hangup" aria-label="Sair da voz" title="Sair da voz" onClick={onLeaveVoice}>
          <PhoneOff {...ICON} />
        </button>
      </div>
      </div>
      {shareNotice && myVoice.streaming && (
        <p className="voice-panel__notice" role="status">
          {shareNotice}
        </p>
      )}
      {(screenShareCount > 0 || stageOpen) && (
        <button type="button" className="button button--secondary button--small button--block" onClick={onToggleStage}>
          {stageOpen ? "Voltar ao chat" : screenShareCount === 1 ? "Assistir transmissão" : `Assistir transmissões (${screenShareCount})`}
        </button>
      )}
    </section>
  );
}

export function UserPanel({ me, online, statusText, onOpenSettings }: Pick<SidebarProps, "me" | "online" | "statusText" | "onOpenSettings">) {
  return (
    <footer className="userpanel">
      <Avatar user={me} online={online} />
      <div className="userpanel__text">
        <span className="userpanel__name" title={`${me.displayName} (@${me.username})`}>
          {me.displayName}
        </span>
        <span className="userpanel__status">{statusText}</span>
      </div>
      <div className="userpanel__actions">
        <button type="button" className="icon-button" aria-label="Configurações (Ctrl+,)" title="Configurações" onClick={onOpenSettings}>
          <Settings {...ICON} />
        </button>
      </div>
    </footer>
  );
}

/* ---------------- membros ---------------- */

/** Membros agrupados pelos cargos "mostrar separado"; a cor do cargo vai num ponto ao lado do nome (guia §6.5). */
export function MemberList({
  members,
  ownerId,
  roles,
  meId,
  canAddFriend,
  onMessage,
  onAddFriend,
}: {
  members: Member[];
  ownerId: Id;
  roles: readonly Role[];
  meId?: Id;
  /** Ainda não somos amigos nem há pedido/bloqueio. */
  canAddFriend?: (userId: Id) => boolean;
  onMessage?: (user: User) => void;
  onAddFriend?: (user: User) => void;
}) {
  const groups = memberGroups(members, roles);

  return (
    <aside className="members" aria-label="Membros">
      {groups.map((group) => (
        <section key={group.key}>
          <h3 className="members__role">
            {group.label} — {group.members.length}
          </h3>
          <ul>
            {group.members.map((member) => {
              const color = memberColor(roles, member);
              return (
              <li key={member.user.id} className={member.online ? "member" : "member member--offline"}>
                <Avatar user={member.user} online={member.online} />
                <div className="member__text">
                  <span className="member__name">
                    {color !== null && <span className="role-dot" data-color={color} aria-hidden="true" />}
                    {member.user.displayName}
                    {member.user.id === ownerId && (
                      <span className="member__owner" title="Dono do servidor">
                        <Crown {...ICON_SM} />
                        <span className="sr-only">(dono)</span>
                      </span>
                    )}
                  </span>
                  <span className="member__activity">@{member.user.username}</span>
                </div>
                {member.user.id !== meId && (onMessage || onAddFriend) && (
                  <span className="member__actions">
                    {onMessage && (
                      <button type="button" className="icon-button icon-button--small" aria-label={`Mandar mensagem para ${member.user.displayName}`} title="Mensagem" onClick={() => onMessage(member.user)}>
                        <MessageCircle {...ICON_SM} />
                      </button>
                    )}
                    {onAddFriend && canAddFriend?.(member.user.id) && (
                      <button type="button" className="icon-button icon-button--small" aria-label={`Pedir amizade a ${member.user.displayName}`} title="Pedir amizade" onClick={() => onAddFriend(member.user)}>
                        <UserPlus {...ICON_SM} />
                      </button>
                    )}
                  </span>
                )}
              </li>
              );
            })}
          </ul>
        </section>
      ))}
    </aside>
  );
}

/* ---------------- estados vazios ---------------- */

export function CenterState({ title, text, children }: { title: string; text: string; children?: ReactNode }) {
  return (
    <div className="center-state">
      <span className="auth__logo" aria-hidden="true" />
      <h2 className="center-state__title">{title}</h2>
      <p className="center-state__text">{text}</p>
      {children && <div className="center-state__actions">{children}</div>}
    </div>
  );
}
