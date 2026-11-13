import type { ReactNode } from "react";
import {
  Compass,
  Crown,
  Hash,
  HeadphoneOff,
  Headphones,
  Mic,
  MicOff,
  PhoneOff,
  Plus,
  ScreenShare,
  ScreenShareOff,
  Settings,
  UserPlus,
  Volume2,
} from "lucide-react";
import type { Channel, ChannelType, Id, Member, User, VoiceState } from "@aurora/schema";
import type { GuildEntry } from "../state/chat-store";
import { avatarIndex, initials } from "../messages";

export const ICON = { size: 20, strokeWidth: 1.75, "aria-hidden": true } as const;
export const ICON_SM = { size: 16, strokeWidth: 1.75, "aria-hidden": true } as const;

export function Avatar({ user, size = "md", online, speaking }: { user: User; size?: "sm" | "md" | "lg"; online?: boolean; speaking?: boolean }) {
  return (
    <span className={`avatar avatar--${size}${speaking ? " avatar--speaking" : ""}`} data-avatar={avatarIndex(user.id)}>
      <span aria-hidden="true">{initials(user.displayName)}</span>
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

export function Rail({ guilds, activeGuildId, unreadGuildIds, guildMentions, onSelect, onCreate, onJoin }: RailProps) {
  return (
    <nav className="rail" aria-label="Servidores">
      <ul className="rail__list">
        {guilds.map((guild) => {
          const active = guild.id === activeGuildId;
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
  isOwner: boolean;
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
  const { guild, textChannels, voiceChannels, activeChannelId, unread, mentions, isOwner, onSelectChannel } = props;
  const participantsOf = (channelId: Id) => Object.values(props.voiceStates).filter((v) => v.channelId === channelId);

  return (
    <aside className="sidebar" aria-label={`Canais de ${guild.name}`}>
      <header className="sidebar__header">
        <h1 className="sidebar__title" title={guild.name}>
          {guild.name}
        </h1>
        <button type="button" className="icon-button" aria-label="Convidar pessoas" title="Convidar pessoas" onClick={props.onInvite}>
          <UserPlus {...ICON} />
        </button>
      </header>
      <nav className="sidebar__nav" aria-label="Canais">
        <CategoryHeader label="Canais de texto" canCreate={isOwner} onCreate={() => props.onCreateChannel("text")} createLabel="Criar canal de texto" />
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

        {(voiceChannels.length > 0 || isOwner) && (
          <CategoryHeader label="Canais de voz" canCreate={isOwner} onCreate={() => props.onCreateChannel("voice")} createLabel="Criar canal de voz" />
        )}
        <ul className="channel-list">
          {voiceChannels.map((channel) => {
            const participants = participantsOf(channel.id);
            const joined = props.myVoice?.channelId === channel.id;
            return (
              <li key={channel.id}>
                <button
                  type="button"
                  className={joined ? "channel channel--voice-active" : "channel"}
                  aria-label={`${channel.name}, canal de voz${participants.length ? `, ${participants.length} na sala` : ""}${joined ? ", você está aqui" : ", entrar"}`}
                  onClick={() => !joined && props.onJoinVoice(channel.id)}
                >
                  <Volume2 {...ICON} />
                  <span className="channel__name">{channel.name}</span>
                </button>
                {participants.length > 0 && (
                  <ul className="voice-users" aria-label={`Na sala ${channel.name}`}>
                    {participants.map((state) => {
                      const user = props.membersById[state.userId]?.user;
                      if (!user) return null;
                      const speaking = joined && props.speaking.has(state.userId) && !state.muted;
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
                          {state.deafened ? (
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
          aria-label={myVoice.muted ? "Ligar microfone" : "Desligar microfone"}
          title={myVoice.muted ? "Ligar microfone" : "Desligar microfone"}
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
          aria-label={myVoice.streaming ? "Parar de compartilhar a tela" : "Compartilhar tela"}
          title={myVoice.streaming ? "Parar de compartilhar a tela" : "Compartilhar tela"}
          onClick={onToggleScreenShare}
          disabled={myVoice.status !== "connected" && !myVoice.streaming}
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

function UserPanel({ me, online, statusText, onOpenSettings }: SidebarProps) {
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

export function MemberList({ members, ownerId }: { members: Member[]; ownerId: Id }) {
  const byName = (a: Member, b: Member) => a.user.displayName.localeCompare(b.user.displayName, "pt-BR");
  const groups = [
    { label: "Online", items: members.filter((m) => m.online).sort(byName) },
    { label: "Offline", items: members.filter((m) => !m.online).sort(byName) },
  ].filter((group) => group.items.length > 0);

  return (
    <aside className="members" aria-label="Membros">
      {groups.map((group) => (
        <section key={group.label}>
          <h3 className="members__role">
            {group.label} — {group.items.length}
          </h3>
          <ul>
            {group.items.map((member) => (
              <li key={member.user.id} className={member.online ? "member" : "member member--offline"}>
                <Avatar user={member.user} online={member.online} />
                <div className="member__text">
                  <span className="member__name">
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
              </li>
            ))}
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
