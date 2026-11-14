import { useCallback, useEffect, useRef, useState, type KeyboardEvent as ReactKeyboardEvent, type ReactNode } from "react";
import {
  ArrowRightLeft,
  ChevronDown,
  Home,
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
  LogOut,
  MessageCircle,
  Settings,
  Settings2,
  UserPlus,
  Volume2,
} from "lucide-react";
import { isPrivateChannel, type Channel, type ChannelType, type CustomStatus, type Id, type Member, type PresenceStatus, type Role, type User, type UserStatus, type VoiceState } from "@aurora/schema";
import { PRESENCE_LABEL, StatusMenu, customStatusText } from "./status";
import { anchorOf } from "./anchor";
import type { GuildEntry } from "../state/chat-store";
import { avatarIndex, initials } from "../messages";
import { fileUrl } from "../avatar-image";
import { memberColor, memberGroups, type MemberGrouping } from "../roles";

export const ICON = { size: 20, strokeWidth: 1.75, "aria-hidden": true } as const;
export const ICON_SM = { size: 16, strokeWidth: 1.75, "aria-hidden": true } as const;

export function Avatar({
  user,
  size = "md",
  online,
  status,
  speaking,
}: {
  user: User;
  size?: "sm" | "md" | "lg" | "xl";
  online?: boolean;
  /** 1.10: online, ausente, não perturbe ou offline (tem prioridade sobre `online`). */
  status?: PresenceStatus;
  speaking?: boolean;
}) {
  const presence: PresenceStatus | undefined = status ?? (online === undefined ? undefined : online ? "online" : "offline");
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
      {presence !== undefined && <span className={`presence presence--${presence}`} role="img" aria-label={PRESENCE_LABEL[presence]} />}
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
                {guild.icon ? <GuildIconImage icon={guild.icon} name={guild.name} /> : <span aria-hidden="true">{initials(guild.name)}</span>}
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

/** Imagem do servidor; se não carregar, volta para as iniciais. */
function GuildIconImage({ icon, name }: { icon: string; name: string }) {
  const [failed, setFailed] = useState(false);
  if (failed) return <span aria-hidden="true">{initials(name)}</span>;
  return <img className="tile__img" src={fileUrl(icon)} alt="" draggable={false} onError={() => setFailed(true)} />;
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
  /** Apertar para falar ligado: nome da tecla e se o microfone está aberto agora. */
  pushToTalk?: { label: string; open: boolean } | null;
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
  /** Ícones que aparecem no canal ao passar o mouse. */
  onOpenChannelChat?: (channelId: Id) => void;
  onEditChannel?: (channelId: Id) => void;
  /** Sou o dono (o dono não sai: exclui, nas configurações). */
  isOwner?: boolean;
  onLeaveGuild?: () => void;
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
  /** Meu status (menu no avatar do painel do usuário). */
  statusControl?: StatusControl;
}

export interface StatusControl {
  status: UserStatus;
  customStatus: CustomStatus | null;
  /** Como os outros me veem agora (inclui o ausente automático). */
  presence: PresenceStatus;
  onStatus: (status: UserStatus) => void;
  onEditCustom: () => void;
  onClearCustom: () => void;
}

export function Sidebar(props: SidebarProps) {
  const { guild, textChannels, voiceChannels, activeChannelId, unread, mentions, canManageChannels, onSelectChannel } = props;
  const participantsOf = (channelId: Id) => Object.values(props.voiceStates).filter((v) => v.channelId === channelId);
  const [collapsed, toggleCategory] = useCollapsedCategories(guild.id);

  return (
    <aside className="sidebar" aria-label={`Canais de ${guild.name}`}>
      {guild.banner && (
        <div className="sidebar__banner" aria-hidden="true">
          <img src={fileUrl(guild.banner)} alt="" />
        </div>
      )}
      <header className="sidebar__header">
        <GuildMenu {...props} />
        {props.canInvite && (
          <button type="button" className="icon-button" aria-label="Convidar pessoas" title="Convidar pessoas" onClick={props.onInvite}>
            <UserPlus {...ICON} />
          </button>
        )}
      </header>
      <nav className="sidebar__nav" aria-label="Canais">
        <CategoryHeader
          label="Canais de texto"
          expanded={!collapsed.text}
          onToggle={() => toggleCategory("text")}
          canCreate={canManageChannels}
          onCreate={() => props.onCreateChannel("text")}
          createLabel="Criar canal de texto"
        />
        <ul className="channel-list">
          {/* recolhida: só fica o canal aberto e os com menção */}
          {textChannels.filter((c) => !collapsed.text || c.id === activeChannelId || (mentions[c.id] ?? 0) > 0).map((channel) => {
            const selected = channel.id === activeChannelId;
            const isUnread = unread.has(channel.id) && !selected;
            // aparece até no canal aberto enquanto a janela está sem foco (bate com o selo do servidor e da barra de tarefas)
            const mentionCount = mentions[channel.id] ?? 0;
            const label = [channel.name, mentionCount > 0 && mentionLabel(mentionCount), isUnread && "não lido"].filter(Boolean).join(", ");
            return (
              <li key={channel.id} className="channel-row">
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
                <ChannelTools
                  name={`#${channel.name}`}
                  onInvite={props.canInvite ? props.onInvite : undefined}
                  onEdit={canManageChannels && props.onEditChannel ? () => props.onEditChannel!(channel.id) : undefined}
                />
              </li>
            );
          })}
        </ul>

        {(voiceChannels.length > 0 || canManageChannels) && (
          <CategoryHeader
            label="Canais de voz"
            expanded={!collapsed.voice}
            onToggle={() => toggleCategory("voice")}
            canCreate={canManageChannels}
            onCreate={() => props.onCreateChannel("voice")}
            createLabel="Criar canal de voz"
          />
        )}
        <ul className="channel-list">
          {/* recolhida: só fica a sala em que estou */}
          {voiceChannels.filter((c) => !collapsed.voice || props.myVoice?.channelId === c.id).map((channel) => {
            const participants = participantsOf(channel.id);
            const joined = props.myVoice?.channelId === channel.id;
            const allowed = joined || props.canConnect(channel.id);
            const action = joined ? ", você está aqui" : allowed ? ", entrar" : ", você não tem permissão para entrar";
            return (
              <li key={channel.id}>
                <div className="channel-row">
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
                  {(mentions[channel.id] ?? 0) > 0 ? (
                    <span className="badge badge--mention" aria-hidden="true">
                      {badgeCount(mentions[channel.id] ?? 0)}
                    </span>
                  ) : (
                    unread.has(channel.id) && channel.id !== activeChannelId && <span className="channel__unread-dot" aria-hidden="true" />
                  )}
                </button>
                <ChannelTools
                  name={channel.name}
                  chatOpen={channel.id === activeChannelId}
                  onChat={props.onOpenChannelChat ? () => props.onOpenChannelChat!(channel.id) : undefined}
                  onEdit={canManageChannels && props.onEditChannel ? () => props.onEditChannel!(channel.id) : undefined}
                />
                </div>
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
      <UserPanel me={props.me} online={props.online} statusText={props.statusText} onOpenSettings={props.onOpenSettings} statusControl={props.statusControl} />
    </aside>
  );
}

/** Ícones do canal (aparecem ao passar o mouse ou com o foco): chat da voz, convidar e editar. */
function ChannelTools({ name, chatOpen, onChat, onInvite, onEdit }: { name: string; chatOpen?: boolean; onChat?: () => void; onInvite?: () => void; onEdit?: () => void }) {
  if (!onChat && !onInvite && !onEdit) return null;
  return (
    <span className={chatOpen ? "channel-tools channel-tools--pinned" : "channel-tools"}>
      {onChat && (
        <button type="button" className="icon-button icon-button--small" aria-label={`Abrir o chat de ${name}`} aria-pressed={chatOpen} title="Abrir chat" onClick={onChat}>
          <MessageCircle {...ICON_SM} />
        </button>
      )}
      {onInvite && (
        <button type="button" className="icon-button icon-button--small" aria-label={`Convidar para ${name}`} title="Convidar pessoas" onClick={onInvite}>
          <UserPlus {...ICON_SM} />
        </button>
      )}
      {onEdit && (
        <button type="button" className="icon-button icon-button--small" aria-label={`Editar ${name}`} title="Editar canal" onClick={onEdit}>
          <Settings {...ICON_SM} />
        </button>
      )}
    </span>
  );
}

/** Nome do servidor que abre o menu: convidar, configurações, criar canal e sair. */
function GuildMenu(props: SidebarProps) {
  const { guild } = props;
  const [open, setOpen] = useState(false);
  const rootRef = useRef<HTMLDivElement>(null);
  const triggerRef = useRef<HTMLButtonElement>(null);
  useEffect(() => {
    if (!open) return;
    rootRef.current?.querySelector<HTMLButtonElement>('[role="menuitem"]')?.focus();
    const onPointer = (event: PointerEvent) => {
      if (!rootRef.current?.contains(event.target as Node)) setOpen(false);
    };
    document.addEventListener("pointerdown", onPointer);
    return () => document.removeEventListener("pointerdown", onPointer);
  }, [open]);
  const choose = (action: () => void) => {
    setOpen(false);
    action();
  };
  const onKeyDown = (event: ReactKeyboardEvent) => {
    const list = [...(rootRef.current?.querySelectorAll<HTMLButtonElement>('[role="menuitem"]') ?? [])];
    const index = list.indexOf(document.activeElement as HTMLButtonElement);
    if (event.key === "Escape") {
      event.preventDefault();
      event.stopPropagation();
      setOpen(false);
      triggerRef.current?.focus();
    } else if (event.key === "ArrowDown" || event.key === "ArrowUp") {
      event.preventDefault();
      list[(index + (event.key === "ArrowDown" ? 1 : -1) + list.length) % list.length]?.focus();
    } else if (event.key === "Tab") setOpen(false);
  };
  return (
    <div className="guild-menu" ref={rootRef}>
      <button ref={triggerRef} type="button" className="guild-menu__trigger" aria-haspopup="menu" aria-expanded={open} title={guild.name} onClick={() => setOpen((v) => !v)}>
        <h1 className="sidebar__title">{guild.name}</h1>
        <ChevronDown {...ICON_SM} className={open ? "guild-menu__chevron guild-menu__chevron--open" : "guild-menu__chevron"} />
      </button>
      {open && (
        <div className="guild-menu__list" role="menu" aria-label={`Menu de ${guild.name}`} onKeyDown={onKeyDown}>
          {props.canInvite && (
            <button type="button" role="menuitem" className="user-menu__item" onClick={() => choose(props.onInvite)}>
              <UserPlus {...ICON_SM} />
              <span className="user-menu__label">Convidar para o servidor</span>
            </button>
          )}
          <button type="button" role="menuitem" className="user-menu__item" onClick={() => choose(props.onOpenGuildSettings)}>
            <Settings2 {...ICON_SM} />
            <span className="user-menu__label">Configurações do servidor</span>
          </button>
          {props.canManageChannels && (
            <>
              <button type="button" role="menuitem" className="user-menu__item" onClick={() => choose(() => props.onCreateChannel("text"))}>
                <Hash {...ICON_SM} />
                <span className="user-menu__label">Criar canal de texto</span>
              </button>
              <button type="button" role="menuitem" className="user-menu__item" onClick={() => choose(() => props.onCreateChannel("voice"))}>
                <Volume2 {...ICON_SM} />
                <span className="user-menu__label">Criar canal de voz</span>
              </button>
            </>
          )}
          {!props.isOwner && props.onLeaveGuild && (
            <>
              <div className="user-menu__divider" role="separator" />
              <button type="button" role="menuitem" className="user-menu__item user-menu__item--danger" onClick={() => choose(props.onLeaveGuild!)}>
                <LogOut {...ICON_SM} />
                <span className="user-menu__label">Sair do servidor</span>
              </button>
            </>
          )}
        </div>
      )}
    </div>
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

type CategoryKind = "text" | "voice";

/** Categorias recolhidas, lembradas por servidor neste aparelho (sem armazenamento, tudo aberto). */
function useCollapsedCategories(guildId: Id): [Partial<Record<CategoryKind, boolean>>, (kind: CategoryKind) => void] {
  const key = `aurora.collapsed.${guildId}`;
  const read = () => {
    try {
      const value: unknown = JSON.parse(localStorage.getItem(key) ?? "{}");
      return value && typeof value === "object" ? (value as Partial<Record<CategoryKind, boolean>>) : {};
    } catch {
      return {};
    }
  };
  const [state, setState] = useState(read);
  const [forGuild, setForGuild] = useState(guildId);
  if (forGuild !== guildId) {
    setForGuild(guildId);
    setState(read());
  }
  const toggle = (kind: CategoryKind) =>
    setState((current) => {
      const next = { ...current, [kind]: !current[kind] };
      try {
        localStorage.setItem(key, JSON.stringify(next));
      } catch {
        // sem armazenamento: vale só até fechar o app
      }
      return next;
    });
  return [state, toggle];
}

function CategoryHeader({
  label,
  expanded,
  onToggle,
  canCreate,
  onCreate,
  createLabel,
}: {
  label: string;
  expanded: boolean;
  onToggle: () => void;
  canCreate: boolean;
  onCreate: () => void;
  createLabel: string;
}) {
  return (
    <div className="category">
      <button type="button" className="category__toggle" aria-expanded={expanded} onClick={onToggle}>
        <ChevronDown {...ICON_SM} className="category__chevron" />
        <span className="category__label">{label}</span>
      </button>
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
  pushToTalk,
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
      <button type="button" className="icon-button icon-button--hangup" aria-label="Sair da voz" title="Sair da voz" onClick={onLeaveVoice}>
        <PhoneOff {...ICON} />
      </button>
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
      </div>
      {pushToTalk && !myVoice.muted && (
        <p className={pushToTalk.open ? "voice-panel__ptt voice-panel__ptt--open" : "voice-panel__ptt"}>
          {pushToTalk.open ? "Microfone aberto" : `Aperte ${pushToTalk.label} para falar`}
        </p>
      )}
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

export function UserPanel({ me, online, statusText, onOpenSettings, statusControl }: Pick<SidebarProps, "me" | "online" | "statusText" | "onOpenSettings" | "statusControl">) {
  const [menuOpen, setMenuOpen] = useState(false);
  const closeMenu = useCallback(() => setMenuOpen(false), []);
  const custom = statusControl ? customStatusText(statusControl.customStatus) : null;
  const presence: PresenceStatus = !online ? "offline" : (statusControl?.presence ?? "online");
  const line = !online ? statusText : custom ?? (statusControl ? (statusControl.status === "invisible" ? "Invisível" : PRESENCE_LABEL[presence]) : statusText);
  const identity = (
    <>
      <Avatar user={me} status={presence} />
      <span className="userpanel__text">
        <span className="userpanel__name">{me.displayName}</span>
        <span className="userpanel__status">{line}</span>
      </span>
    </>
  );
  return (
    <footer className="userpanel">
      {statusControl ? (
        <div className="userpanel__who">
          <button
            type="button"
            className="userpanel__identity"
            aria-haspopup="menu"
            aria-expanded={menuOpen}
            aria-label={`${me.displayName}, ${line}. Mudar status`}
            title={`${me.displayName} (@${me.username}) · ${statusText}`}
            onClick={() => setMenuOpen((open) => !open)}
          >
            {identity}
          </button>
          {menuOpen && (
            <StatusMenu
              status={statusControl.status}
              customStatus={statusControl.customStatus}
              onStatus={statusControl.onStatus}
              onEditCustom={statusControl.onEditCustom}
              onClearCustom={statusControl.onClearCustom}
              onClose={closeMenu}
            />
          )}
        </div>
      ) : (
        <div className="userpanel__identity" title={`${me.displayName} (@${me.username})`}>
          {identity}
        </div>
      )}
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
  onOpenUser,
}: {
  members: Member[];
  ownerId: Id;
  roles: readonly Role[];
  meId?: Id;
  /** Clique numa pessoa: menu com perfil, mensagem, amizade, cargos e moderação. */
  onOpenUser?: (user: User, at: { x: number; y: number }) => void;
}) {
  const [grouping, setGrouping] = useMemberGrouping();
  const groups = memberGroups(members, roles, grouping);

  return (
    <aside className="members" aria-label="Membros">
      <div className="members__grouping" role="radiogroup" aria-label="Agrupar membros por">
        {(["role", "status"] as const).map((value) => (
          <button key={value} type="button" role="radio" aria-checked={grouping === value} className="members__grouping-option" onClick={() => setGrouping(value)}>
            {value === "role" ? "Cargo" : "Status"}
          </button>
        ))}
      </div>
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
                <button
                  type="button"
                  className="member__open"
                  aria-label={`${member.user.displayName}${member.user.id === meId ? " (você)" : ""}: ver ações`}
                  disabled={!onOpenUser}
                  onClick={(e) => onOpenUser?.(member.user, anchorOf(e))}
                  onContextMenu={(e) => {
                    if (!onOpenUser) return;
                    e.preventDefault();
                    onOpenUser(member.user, { x: e.clientX, y: e.clientY });
                  }}
                >
                <Avatar user={member.user} online={member.online} status={member.status} />
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
                  <span className="member__activity">{(member.online && customStatusText(member.customStatus)) || `@${member.user.username}`}</span>
                </div>
                </button>
              </li>
              );
            })}
          </ul>
        </section>
      ))}
    </aside>
  );
}

/** Agrupar a lista de membros por cargo ou por status (lembrado neste aparelho). */
function useMemberGrouping(): [MemberGrouping, (value: MemberGrouping) => void] {
  const KEY = "aurora.memberGrouping";
  const [value, setValue] = useState<MemberGrouping>(() => {
    try {
      return localStorage.getItem(KEY) === "status" ? "status" : "role";
    } catch {
      return "role";
    }
  });
  return [
    value,
    (next) => {
      setValue(next);
      try {
        localStorage.setItem(KEY, next);
      } catch {
        // sem armazenamento: vale até fechar o app
      }
    },
  ];
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
