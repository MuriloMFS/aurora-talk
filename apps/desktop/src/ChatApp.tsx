import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { LIMITS, type Channel, type ChannelType, type DispatchEvent, type Id, type Message } from "@aurora/schema";
import type { ThemePreference } from "@aurora/ui/theme";
import {
  createMediaEngine,
  createPlatform,
  type MediaEngine,
  type PlatformInfo,
  type PlatformPort,
  type ScreenShare,
  type ScreenShareOptions,
  type ScreenShareResult,
  type UpdateInfo,
} from "@aurora/platform";
import { ApiClient, ApiError } from "./net/api";
import { GatewayClient } from "./net/gateway";
import type { Session } from "./net/session";
import { createChatStore, isUnread, mentionCountOf, useChatState, type ChatState } from "./state/chat-store";
import { plainText } from "./markdown";
import { ChatPane } from "./ui/ChatPane";
import { CreateChannelDialog, CreateGuildDialog, InviteDialog, JoinGuildDialog } from "./ui/dialogs";
import { CenterState, MemberList, Rail, Sidebar, type MyVoice } from "./ui/shell";
import { ScreenShareDialog } from "./ui/ScreenShareDialog";
import { StreamStage } from "./ui/StreamStage";
import { UpdateButton } from "./ui/update";

type Dialog = "createGuild" | "joinGuild" | "createChannel" | "invite" | "screenShare" | null;

const WIDE_LAYOUT = "(min-width: 1200px)";
const TYPING_THROTTLE_MS = 2_500;
const ACK_DELAY_MS = 1_000;
const NOTIFICATION_BODY_MAX = 140;

/**
 * Menção a mim fora de vista (outro canal, ou app em segundo plano): notificação do Windows e o
 * ícone pisca. Quem já está olhando o canal não é interrompido.
 */
function notifyIfMentioned(state: ChatState, event: DispatchEvent, port: PlatformPort | null): void {
  if (event.t !== "MESSAGE_CREATE" || !port || !state.me) return;
  const message = event.d;
  if (message.author.id === state.me.id || !message.mentions.includes(state.me.id)) return;
  if (state.focused && state.activeChannelId === message.channelId) return;
  const channel = state.channels[message.channelId];
  const guild = channel ? state.guilds[channel.guildId] : undefined;
  const members = channel ? (state.members[channel.guildId] ?? {}) : {};
  const text = plainText(message.content, (id) => members[id]?.user.displayName ?? "alguém");
  const body = text.length > NOTIFICATION_BODY_MAX ? `${text.slice(0, NOTIFICATION_BODY_MAX - 1)}…` : text;
  const where = channel ? ` em #${channel.name}${guild ? ` (${guild.name})` : ""}` : "";
  port.notify({ title: `${message.author.displayName}${where}`, body: body || "Mencionou você." }).catch(() => undefined);
  port.requestAttention().catch(() => undefined);
}
const NO_SPEAKERS: ReadonlySet<Id> = new Set();

interface VoiceSession extends MyVoice {
  guildId: Id;
}

/** Mensagem de erro de voz em linguagem do usuário (o que houve + o que fazer). */
function voiceErrorMessage(error: unknown): string {
  if (error instanceof ApiError) return error.message;
  const name = (error as { name?: string } | null)?.name;
  if (name === "NotAllowedError") return "O Aurora não tem permissão para usar o microfone. Libere o acesso e tente de novo.";
  if (name === "NotFoundError") return "Nenhum microfone encontrado. Conecte um e tente de novo.";
  return "Não foi possível conectar à voz. Confira se o servidor de voz está ligado (pnpm voice).";
}

/** Aviso discreto no painel de voz depois de começar a transmitir (ou nenhum). */
function shareNoticeFor(result: ScreenShareResult): string | null {
  if (result.audio === "failed") return "Sua tela está no ar, mas sem o som do computador. Para tentar de novo, pare e transmita outra vez.";
  if (result.audio === "shared" && !result.ownAudioExcluded) return "As vozes da sala também estão indo na transmissão (eco). Para evitar, transmita sem o som do computador.";
  return null;
}

interface ChatAppProps {
  session: Session;
  themePreference: ThemePreference;
  onCycleTheme: () => void;
  onLogout: (notice: string | null) => void;
  /** Versão nova encontrada com o app aberto: vira o botão de download no topo. */
  availableUpdate: UpdateInfo | null;
  onInstallUpdate: () => void;
}

export function ChatApp({ session, themePreference, onCycleTheme, onLogout, availableUpdate, onInstallUpdate }: ChatAppProps) {
  const api = useMemo(() => new ApiClient(session.serverUrl, session.token), [session]);
  const store = useMemo(() => createChatStore(), []);
  const state = useChatState(store);
  const gatewayRef = useRef<GatewayClient | null>(null);
  const lastTypingRef = useRef(0);

  // ---- voz ----
  const [voice, setVoice] = useState<VoiceSession | null>(null);
  const voiceRef = useRef<VoiceSession | null>(null);
  voiceRef.current = voice;
  const engineRef = useRef<MediaEngine | null>(null);
  const [speaking, setSpeaking] = useState<ReadonlySet<Id>>(NO_SPEAKERS);
  const [voiceError, setVoiceError] = useState<string | null>(null);
  const [screenShares, setScreenShares] = useState<ScreenShare[]>([]);
  const [stageOpen, setStageOpen] = useState(false);

  // ---- plataforma (notificações, selo, links) ----
  const portRef = useRef<PlatformPort | null>(null);
  const [platform, setPlatform] = useState<PlatformInfo | null>(null);
  useEffect(() => {
    let alive = true;
    createPlatform()
      .then(async (port) => {
        portRef.current = port;
        const info = await port.getInfo();
        if (alive) setPlatform(info);
      })
      .catch(() => undefined);
    return () => {
      alive = false;
    };
  }, []);

  // Último "lido até" que o servidor já conhece, por canal (para não mandar ack repetido).
  const ackedRef = useRef(new Map<Id, Id>());

  // ---- conexão em tempo real ----
  useEffect(() => {
    const gateway = new GatewayClient(session.serverUrl, session.token, {
      onStatus: (status) => store.dispatch({ type: "status", status }),
      onReady: (user, guilds, readStates) => {
        for (const read of readStates ?? []) ackedRef.current.set(read.channelId, read.lastReadId);
        store.dispatch({ type: "ready", user, guilds, readStates });
        // Reconectou com a voz ligada: o servidor perdeu o estado junto com a conexão antiga.
        const current = voiceRef.current;
        if (current) {
          gateway.sendVoiceJoin(current.channelId, current.muted, current.deafened);
          if (current.streaming) gateway.sendVoiceState(current.muted, current.deafened, true);
        }
      },
      onDispatch: (event) => {
        store.dispatch({ type: "dispatch", event, now: Date.now() });
        if (event.t === "READ_STATE_UPDATE") ackedRef.current.set(event.d.channelId, event.d.lastReadId);
        notifyIfMentioned(store.getState(), event, portRef.current);
      },
      onInvalidSession: () => onLogout("Sua sessão expirou. Entre novamente."),
    });
    gatewayRef.current = gateway;
    gateway.start();
    return () => {
      gateway.stop();
      gatewayRef.current = null;
    };
  }, [session, store, onLogout]);

  // Saiu da conta / fechou: desliga a voz.
  useEffect(() => () => void engineRef.current?.leave(), []);

  useEffect(() => {
    const timer = setInterval(() => store.dispatch({ type: "typingExpire", now: Date.now() }), 1_000);
    return () => clearInterval(timer);
  }, [store]);

  // ---- foco da janela: só lê o canal aberto quem está olhando ----
  useEffect(() => {
    const update = () => store.dispatch({ type: "windowFocus", focused: document.hasFocus() && document.visibilityState === "visible" });
    update();
    window.addEventListener("focus", update);
    window.addEventListener("blur", update);
    document.addEventListener("visibilitychange", update);
    return () => {
      window.removeEventListener("focus", update);
      window.removeEventListener("blur", update);
      document.removeEventListener("visibilitychange", update);
    };
  }, [store]);

  // ---- avisa o servidor do que foi lido (1 s depois, para não mandar um ack por mensagem) ----
  useEffect(() => {
    const timers = new Map<Id, number>();
    const flush = () => {
      for (const [readChannelId, read] of Object.entries(store.getState().reads)) {
        const acked = ackedRef.current.get(readChannelId);
        if (Number(read.lastReadId) <= Number(acked ?? 0) || timers.has(readChannelId)) continue;
        timers.set(
          readChannelId,
          window.setTimeout(() => {
            timers.delete(readChannelId);
            const latest = store.getState().reads[readChannelId]?.lastReadId;
            if (!latest || Number(latest) <= Number(ackedRef.current.get(readChannelId) ?? 0)) return;
            ackedRef.current.set(readChannelId, latest);
            api.ack(readChannelId, latest).catch(() => ackedRef.current.set(readChannelId, acked ?? "0"));
          }, ACK_DELAY_MS),
        );
      }
    };
    const unsubscribe = store.subscribe(flush);
    return () => {
      unsubscribe();
      for (const timer of timers.values()) clearTimeout(timer);
    };
  }, [api, store]);

  // ---- selo de menções na barra de tarefas ----
  const totalMentions = Object.keys(state.reads).reduce((sum, id) => sum + mentionCountOf(state, id), 0);
  useEffect(() => {
    portRef.current?.setBadge(totalMentions).catch(() => undefined);
  }, [totalMentions, platform]);

  // ---- avisos rápidos do chat (ex.: reação recusada) ----
  const [chatNotice, setChatNotice] = useState<string | null>(null);

  /** Reagir/tirar reação: aparece na hora; se o servidor recusar, desfaz e explica. */
  const toggleReaction = (message: Message, emoji: string) => {
    const me = store.getState().me;
    if (!me) return;
    const reacted = message.reactions.some((r) => r.emoji === emoji && r.userIds.includes(me.id));
    const event = (t: "MESSAGE_REACTION_ADD" | "MESSAGE_REACTION_REMOVE"): DispatchEvent => ({
      t,
      d: { channelId: message.channelId, messageId: message.id, userId: me.id, emoji },
    });
    store.dispatch({ type: "dispatch", event: event(reacted ? "MESSAGE_REACTION_REMOVE" : "MESSAGE_REACTION_ADD"), now: Date.now() });
    const request = reacted ? api.removeReaction(message.channelId, message.id, emoji) : api.addReaction(message.channelId, message.id, emoji);
    request.catch((error: unknown) => {
      store.dispatch({ type: "dispatch", event: event(reacted ? "MESSAGE_REACTION_ADD" : "MESSAGE_REACTION_REMOVE"), now: Date.now() });
      setChatNotice(error instanceof ApiError ? error.message : "Não foi possível reagir. Tente de novo.");
    });
  };

  const openLink = (url: string) => {
    portRef.current?.openExternal(url).catch(() => setChatNotice("Não foi possível abrir o link. Copie e cole no navegador."));
  };

  // ---- seleção de servidor e canal de texto ----
  const [selectedGuildId, setSelectedGuildId] = useState<Id | null>(null);
  const [channelByGuild, setChannelByGuild] = useState<Record<Id, Id>>({});
  const guildId = selectedGuildId && state.guilds[selectedGuildId] ? selectedGuildId : (state.guildOrder[0] ?? null);
  const guild = guildId ? state.guilds[guildId] : undefined;
  const textChannelIds = guild ? guild.channelIds.filter((id) => state.channels[id]?.type === "text") : [];
  const remembered = guild ? channelByGuild[guild.id] : undefined;
  const channelId = remembered && textChannelIds.includes(remembered) ? remembered : (textChannelIds[0] ?? null);
  const channel = channelId ? state.channels[channelId] : undefined;
  const bucket = channelId ? state.messages[channelId] : undefined;

  useEffect(() => store.dispatch({ type: "focusChannel", channelId }), [channelId, store]);

  // ---- histórico do canal aberto ----
  const [historyError, setHistoryError] = useState<Record<Id, string>>({});
  const [historyAttempt, setHistoryAttempt] = useState(0);
  useEffect(() => {
    if (!channelId || state.status !== "ready" || bucket?.loaded) return;
    let alive = true;
    api
      .listMessages(channelId)
      .then((messages) => {
        if (!alive) return;
        store.dispatch({ type: "history", channelId, messages, mode: "latest", pageSize: LIMITS.pageSize });
        setHistoryError(({ [channelId]: _removed, ...rest }) => rest);
      })
      .catch((error: unknown) => {
        if (alive) setHistoryError((prev) => ({ ...prev, [channelId]: error instanceof ApiError ? error.message : "Não foi possível carregar as mensagens." }));
      });
    return () => {
      alive = false;
    };
  }, [api, store, channelId, state.status, bucket?.loaded, historyAttempt]);

  // ---- ações de voz ----
  const leaveVoice = useCallback(async () => {
    const engine = engineRef.current;
    setVoice(null);
    setSpeaking(NO_SPEAKERS);
    setScreenShares([]);
    setStageOpen(false);
    gatewayRef.current?.sendVoiceLeave();
    await engine?.leave();
  }, []);

  const joinVoice = useCallback(
    async (voiceChannelId: Id, voiceGuildId: Id) => {
      if (voiceRef.current?.channelId === voiceChannelId) return;
      if (voiceRef.current) await leaveVoice();
      setVoiceError(null);
      const session: VoiceSession = { channelId: voiceChannelId, guildId: voiceGuildId, status: "connecting", muted: false, deafened: false, streaming: false };
      setVoice(session);
      voiceRef.current = session;
      try {
        const credentials = await api.voiceToken(voiceChannelId);
        const engine = engineRef.current ?? (await createMediaEngine());
        engineRef.current = engine;
        await engine.join(
          credentials,
          {
            onStateChange: (status) => {
              if (status === "disconnected") return;
              setVoice((current) => (current && current.channelId === voiceChannelId ? { ...current, status } : current));
            },
            onSpeakingChange: setSpeaking,
            onScreenSharesChange: setScreenShares,
          },
          { muted: false, deafened: false },
        );
        if (voiceRef.current?.channelId !== voiceChannelId) return; // saiu enquanto conectava
        gatewayRef.current?.sendVoiceJoin(voiceChannelId, false, false);
        setVoice((current) => (current && current.channelId === voiceChannelId ? { ...current, status: "connected" } : current));
      } catch (error) {
        await engineRef.current?.leave();
        setVoice(null);
        setVoiceError(voiceErrorMessage(error));
      }
    },
    [api, leaveVoice],
  );

  const updateVoiceFlags = async (muted: boolean, deafened: boolean) => {
    const current = voiceRef.current;
    if (!current) return;
    setVoice({ ...current, muted, deafened });
    engineRef.current?.setDeafened(deafened);
    gatewayRef.current?.sendVoiceState(muted, deafened, current.streaming);
    try {
      await engineRef.current?.setMuted(muted);
    } catch (error) {
      setVoiceError(voiceErrorMessage(error));
    }
  };
  // "Transmitindo" vem do motor de mídia: cobre também o "Parar de compartilhar" do próprio sistema.
  const localSharing = screenShares.some((share) => share.local);
  useEffect(() => {
    const current = voiceRef.current;
    if (!current || current.streaming === localSharing) return;
    const next = { ...current, streaming: localSharing };
    voiceRef.current = next;
    setVoice(next);
    gatewayRef.current?.sendVoiceState(next.muted, next.deafened, localSharing);
  }, [localSharing]);

  // Compartilhar abre o nosso diálogo (o que mostrar + qualidade); parar é direto.
  const [shareNotice, setShareNotice] = useState<string | null>(null);
  useEffect(() => {
    if (!localSharing) setShareNotice(null);
  }, [localSharing]);
  const toggleScreenShare = async () => {
    const current = voiceRef.current;
    const engine = engineRef.current;
    if (!current || !engine) return;
    if (!current.streaming) {
      setDialog("screenShare");
      return;
    }
    try {
      await engine.stopScreenShare();
    } catch (error) {
      console.error("[aurora] parar a transmissão falhou", error);
      setVoiceError("Não foi possível parar a transmissão. Saia da voz para encerrar.");
    }
  };
  // Sem await antes de chamar o motor: o seletor do sistema exige o clique recente da pessoa.
  const startScreenShare = (options: ScreenShareOptions): Promise<ScreenShareResult> => {
    const engine = engineRef.current;
    if (!engine || !voiceRef.current) return Promise.reject(new Error("Entre num canal de voz para compartilhar a tela."));
    return engine.startScreenShare(options);
  };

  // Ensurdecer também desliga o microfone; ligar o microfone tira o ensurdecer.
  const toggleMute = () => voiceRef.current && void updateVoiceFlags(!voiceRef.current.muted, voiceRef.current.muted ? false : voiceRef.current.deafened);
  const toggleDeafen = () => voiceRef.current && void updateVoiceFlags(!voiceRef.current.deafened, !voiceRef.current.deafened);

  // ---- layout ----
  const [membersOpen, setMembersOpen] = useState(() => globalThis.matchMedia?.(WIDE_LAYOUT).matches ?? true);
  const [drawerOpen, setDrawerOpen] = useState(false);
  const [dialog, setDialog] = useState<Dialog>(null);
  const [newChannelType, setNewChannelType] = useState<ChannelType>("text");
  const closeDialog = useCallback(() => setDialog(null), []);

  useEffect(() => {
    if (!drawerOpen) return;
    const onKey = (event: KeyboardEvent) => event.key === "Escape" && setDrawerOpen(false);
    document.addEventListener("keydown", onKey);
    return () => document.removeEventListener("keydown", onKey);
  }, [drawerOpen]);

  const selectChannel = (id: Id) => {
    if (guild) setChannelByGuild((prev) => ({ ...prev, [guild.id]: id }));
    setDrawerOpen(false);
  };

  const logout = async () => {
    await leaveVoice();
    try {
      await api.logout();
    } catch {
      // mesmo sem resposta do servidor, a sessão local é encerrada
    }
    onLogout(null);
  };

  const me = state.me ?? session.user;

  // ---- primeira conexão ----
  if (!state.me) {
    return (
      <main className="app-loading">
        <CenterState
          title={state.status === "reconnecting" ? "Não foi possível conectar" : "Conectando…"}
          text={
            state.status === "reconnecting"
              ? `O servidor ${session.serverUrl} não respondeu. Confira se ele está ligado; vamos continuar tentando.`
              : `Entrando em ${session.serverUrl}`
          }
        >
          <button type="button" className="button button--secondary" onClick={() => onLogout(null)}>
            Trocar de servidor ou conta
          </button>
        </CenterState>
      </main>
    );
  }

  const guilds = state.guildOrder.map((id) => state.guilds[id]).filter((g) => g !== undefined);
  const unreadChannels = new Set(Object.keys(state.reads).filter((id) => isUnread(state, id)));
  const channelMentions = Object.fromEntries(Object.keys(state.reads).map((id) => [id, mentionCountOf(state, id)]));
  const unreadGuildIds = new Set(guilds.filter((g) => g.channelIds.some((id) => unreadChannels.has(id))).map((g) => g.id));
  const guildMentions = Object.fromEntries(guilds.map((g) => [g.id, g.channelIds.reduce((sum, id) => sum + (channelMentions[id] ?? 0), 0)]));
  const membersById = guild ? (state.members[guild.id] ?? {}) : {};
  const members = Object.values(membersById);
  const typingNames = channelId
    ? Object.keys(state.typing[channelId] ?? {})
        .map((userId) => membersById[userId]?.user.displayName)
        .filter((name): name is string => Boolean(name))
    : [];
  const statusText = state.status === "ready" ? `Online · ${platform?.kind === "tauri" ? `v${platform.appVersion}` : "web"}` : "Reconectando…";
  const channelsOf = (type: ChannelType) =>
    guild ? guild.channelIds.map((id) => state.channels[id]).filter((c): c is Channel => c !== undefined && c.type === type) : [];

  return (
    <div className="app" data-members={membersOpen && guild ? "open" : "closed"} data-drawer={drawerOpen ? "open" : "closed"} data-has-guild={guild ? "yes" : "no"}>
      <a className="skip-link" href="#composer-input">
        Pular para o campo de mensagem
      </a>
      <Rail
        guilds={guilds}
        activeGuildId={guild?.id ?? null}
        unreadGuildIds={unreadGuildIds}
        guildMentions={guildMentions}
        onSelect={(id) => setSelectedGuildId(id)}
        onCreate={() => setDialog("createGuild")}
        onJoin={() => setDialog("joinGuild")}
      />

      {guild && channel ? (
        <>
          <Sidebar
            guild={guild}
            textChannels={channelsOf("text")}
            voiceChannels={channelsOf("voice")}
            activeChannelId={channel.id}
            unread={unreadChannels}
            mentions={channelMentions}
            isOwner={guild.ownerId === me.id}
            me={me}
            online={state.status === "ready"}
            statusText={statusText}
            themePreference={themePreference}
            membersById={membersById}
            voiceStates={state.voice[guild.id] ?? {}}
            speaking={speaking}
            myVoice={voice && voice.guildId === guild.id ? voice : null}
            voiceError={voiceError}
            onSelectChannel={selectChannel}
            onCreateChannel={(type) => {
              setNewChannelType(type);
              setDialog("createChannel");
            }}
            onInvite={() => setDialog("invite")}
            onCycleTheme={onCycleTheme}
            onLogout={logout}
            onJoinVoice={(id) => void joinVoice(id, guild.id)}
            onLeaveVoice={() => void leaveVoice()}
            onToggleMute={toggleMute}
            onToggleDeafen={toggleDeafen}
            onDismissVoiceError={() => setVoiceError(null)}
            screenShareCount={voice && voice.guildId === guild.id ? screenShares.length : 0}
            shareNotice={shareNotice}
            stageOpen={stageOpen}
            onToggleScreenShare={() => void toggleScreenShare()}
            onToggleStage={() => setStageOpen((open) => !open)}
          />
          {stageOpen && voice ? (
            <StreamStage
              channelName={state.channels[voice.channelId]?.name ?? "Canal de voz"}
              shares={screenShares}
              membersById={state.members[voice.guildId] ?? {}}
              onBack={() => setStageOpen(false)}
            />
          ) : (
          <ChatPane
            key={channel.id}
            channel={channel}
            bucket={bucket}
            historyError={historyError[channel.id] ?? null}
            me={me}
            isOwner={guild.ownerId === me.id}
            typingNames={typingNames}
            status={state.status}
            membersOpen={membersOpen}
            membersById={membersById}
            notice={chatNotice}
            onDismissNotice={() => setChatNotice(null)}
            onReact={toggleReaction}
            onOpenLink={openLink}
            onToggleMembers={() => setMembersOpen((open) => !open)}
            onOpenDrawer={() => setDrawerOpen(true)}
            headerExtra={availableUpdate ? <UpdateButton update={availableUpdate} onInstall={onInstallUpdate} /> : null}
            onRetryHistory={() => {
              setHistoryError(({ [channel.id]: _removed, ...rest }) => rest);
              setHistoryAttempt((n) => n + 1);
            }}
            onLoadOlder={async () => {
              const first = bucket?.items[0];
              if (!first) return;
              const messages = await api.listMessages(channel.id, first.id);
              store.dispatch({ type: "history", channelId: channel.id, messages, mode: "older", pageSize: LIMITS.pageSize });
            }}
            onSend={async (content, replyToId) => {
              const message = await api.sendMessage(channel.id, content, crypto.randomUUID(), replyToId ?? undefined);
              ackedRef.current.set(channel.id, message.id); // o servidor marca o que eu envio como lido
              store.dispatch({ type: "messageUpsert", message });
            }}
            onEdit={async (id, content) => {
              const message = await api.editMessage(id, content);
              store.dispatch({ type: "dispatch", event: { t: "MESSAGE_UPDATE", d: message }, now: Date.now() });
            }}
            onDelete={async (id) => {
              await api.deleteMessage(id);
              store.dispatch({ type: "dispatch", event: { t: "MESSAGE_DELETE", d: { id, channelId: channel.id } }, now: Date.now() });
            }}
            onTyping={() => {
              const now = Date.now();
              if (now - lastTypingRef.current < TYPING_THROTTLE_MS) return;
              lastTypingRef.current = now;
              gatewayRef.current?.sendTyping(channel.id);
            }}
          />
          )}
          {membersOpen && !stageOpen && <MemberList members={members} ownerId={guild.ownerId} />}
        </>
      ) : (
        <main className="chat chat--empty">
          {availableUpdate && <UpdateButton update={availableUpdate} onInstall={onInstallUpdate} floating />}
          <CenterState title={`Bem-vindo, ${me.displayName}!`} text="Você ainda não está em nenhum servidor. Crie o seu ou entre com um código de convite.">
            <button type="button" className="button button--primary" onClick={() => setDialog("createGuild")}>
              Criar servidor
            </button>
            <button type="button" className="button button--secondary" onClick={() => setDialog("joinGuild")}>
              Entrar com convite
            </button>
            <button type="button" className="button button--ghost" onClick={logout}>
              Sair da conta
            </button>
          </CenterState>
        </main>
      )}

      {drawerOpen && <div className="scrim" aria-hidden="true" onClick={() => setDrawerOpen(false)} />}

      {dialog === "createGuild" && (
        <CreateGuildDialog
          api={api}
          onClose={closeDialog}
          onCreated={(created) => {
            store.dispatch({ type: "guildUpsert", guild: created });
            setSelectedGuildId(created.id);
          }}
        />
      )}
      {dialog === "joinGuild" && (
        <JoinGuildDialog
          api={api}
          onClose={closeDialog}
          onJoined={(joined) => {
            store.dispatch({ type: "guildUpsert", guild: joined });
            setSelectedGuildId(joined.id);
          }}
        />
      )}
      {dialog === "createChannel" && guild && (
        <CreateChannelDialog
          api={api}
          guildId={guild.id}
          initialType={newChannelType}
          onClose={closeDialog}
          onCreated={(created) => {
            store.dispatch({ type: "channelUpsert", channel: created });
            if (created.type === "text") setChannelByGuild((prev) => ({ ...prev, [created.guildId]: created.id }));
          }}
        />
      )}
      {dialog === "invite" && guild && <InviteDialog api={api} guild={guild} onClose={closeDialog} />}
      {dialog === "screenShare" && voice && (
        <ScreenShareDialog
          systemAudioMode={platform?.systemAudio ?? "picker"}
          onStart={startScreenShare}
          onStarted={(result) => setShareNotice(shareNoticeFor(result))}
          onClose={closeDialog}
        />
      )}
    </div>
  );
}
