import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { LIMITS, hasPermission, outranks, type DmChannel, type Member, type Channel, type ChannelType, type DispatchEvent, type Id, type Message, type User } from "@aurora/schema";
import type { ThemePreference } from "@aurora/ui/theme";
import {
  createMediaEngine,
  createPlatform,
  PushToTalkGate,
  pttKeyLabel,
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
import {
  createChatStore,
  dmList,
  dmMentionTotal,
  dmName,
  isBlocked,
  isUnread,
  mentionCountOf,
  myChannelPermissions,
  myPermissions,
  myTimeout,
  presenceOf,
  useChatState,
  type ChatState,
} from "./state/chat-store";
import { DmHeaderActions, FriendsView, HomeSidebar, PickFriendsDialog, RenameGroupDialog } from "./ui/home";
import { CustomStatusDialog } from "./ui/status";
import { UserMenu, type UserMenuTarget } from "./ui/UserMenu";
import { Modal } from "./ui/Modal";
import type { StatusControl } from "./ui/shell";
import { untilText } from "./roles";
import { setMediaBase } from "./avatar-image";
import { plainText } from "./markdown";
import { ChatPane } from "./ui/ChatPane";
import { CreateChannelDialog, CreateGuildDialog, InviteDialog, JoinGuildDialog } from "./ui/dialogs";
import { CenterState, MemberList, Rail, Sidebar, UserPanel, type MyVoice } from "./ui/shell";
import { ScreenShareDialog } from "./ui/ScreenShareDialog";
import { StreamStage } from "./ui/StreamStage";
import { UpdateButton } from "./ui/update";
import { SettingsScreen, type SettingsSectionId } from "./ui/settings/SettingsScreen";
import { GuildSettingsScreen } from "./ui/settings/GuildSettingsScreen";
import { SoundPlayer, voiceEventSound, type SoundId } from "./sounds";
import { settingsStore, useSettings, type AppSettings } from "./state/settings";
import { pushToTalkOn, voiceSettingsOf } from "./voice-settings";

type Dialog = "createGuild" | "joinGuild" | "createChannel" | "invite" | "screenShare" | null;

const WIDE_LAYOUT = "(min-width: 1200px)";
const TYPING_THROTTLE_MS = 2_500;
const ACK_DELAY_MS = 1_000;
const NOTIFICATION_BODY_MAX = 140;

/**
 * Menção a mim fora de vista (outro canal, ou app em segundo plano): notificação do Windows, som e o
 * ícone pisca — cada um conforme as configurações. Quem já está olhando o canal não é interrompido.
 */
function notifyIfMentioned(state: ChatState, event: DispatchEvent, port: PlatformPort | null, settings: AppSettings, play: (id: SoundId) => void): void {
  if (event.t !== "MESSAGE_CREATE" || !state.me) return;
  const message = event.d;
  const dm = state.dms[message.channelId];
  if (message.author.id === state.me.id || (!dm && !message.mentions.includes(state.me.id))) return;
  if (state.focused && state.activeChannelId === message.channelId) return;
  if (state.relationships[message.author.id]?.type === "blocked") return;
  if (state.settings.status === "dnd") return; // não perturbe: só o selo continua
  play("mention");
  if (!port) return;
  if (settings.notifications.flash) port.requestAttention().catch(() => undefined);
  if (!settings.notifications.desktop) return;
  const channel = state.channels[message.channelId];
  const guild = channel ? state.guilds[channel.guildId] : undefined;
  const members = channel ? (state.members[channel.guildId] ?? {}) : {};
  const text = plainText(message.content, (id) => members[id]?.user.displayName ?? "alguém");
  const body = text.length > NOTIFICATION_BODY_MAX ? `${text.slice(0, NOTIFICATION_BODY_MAX - 1)}…` : text;
  const where = channel ? ` em #${channel.name}${guild ? ` (${guild.name})` : ""}` : dm?.type === "group_dm" ? ` em ${dmName(dm)}` : "";
  const fallback = message.attachments?.length ? "Enviou um arquivo." : dm ? "Mandou uma mensagem." : "Mencionou você.";
  port.notify({ title: `${message.author.displayName}${where}`, body: body || fallback }).catch(() => undefined);
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
  onThemeChange: (theme: ThemePreference) => void;
  onLogout: (notice: string | null) => void;
  /** Versão nova encontrada com o app aberto: vira o botão de download no topo. */
  availableUpdate: UpdateInfo | null;
  onCheckUpdate: () => Promise<"available" | "current" | "unsupported" | "error">;
  onInstallUpdate: () => void;
}

export function ChatApp({ session, themePreference, onThemeChange, onLogout, availableUpdate, onCheckUpdate, onInstallUpdate }: ChatAppProps) {
  const api = useMemo(() => new ApiClient(session.serverUrl, session.token), [session]);
  setMediaBase(session.serverUrl); // fotos de perfil vêm do mesmo servidor
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

  // ---- configurações e sons de feedback ----
  const settings = useSettings();
  const sounds = useMemo(() => new SoundPlayer(), []);
  useEffect(() => sounds.setVolume(settings.sounds.volume / 100), [sounds, settings.sounds.volume]);
  useEffect(() => void sounds.setOutputDevice(settings.voice.outputDeviceId), [sounds, settings.voice.outputDeviceId]);
  /** Toca se a pessoa deixou esse som ligado (lê na hora: serve dentro de callbacks antigos). */
  const playSound = useCallback((id: SoundId) => settingsStore.get().sounds.enabled[id] && sounds.play(id), [sounds]);
  const [settingsOpen, setSettingsOpen] = useState<SettingsSectionId | null>(null);
  const closeSettings = useCallback(() => setSettingsOpen(null), []);
  const [guildSettingsOpen, setGuildSettingsOpen] = useState<Id | null>(null);
  /** Abrir as configurações já numa seção/canal (ícone de engrenagem do canal). */
  const [guildSettingsStart, setGuildSettingsStart] = useState<{ section: "channels"; channelId: Id } | null>(null);
  const [leaveConfirm, setLeaveConfirm] = useState<Id | null>(null);
  const closeGuildSettings = useCallback(() => setGuildSettingsOpen(null), []);
  /** Servidores que EU estou saindo/excluindo (o GUILD_DELETE deles não vira aviso de "você foi removido"). */
  const leavingRef = useRef(new Set<Id>());
  const leaveVoiceRef = useRef<() => Promise<void>>(async () => {});
  /** Um moderador me levou para outra sala: troca sem avisar "saí" (o servidor já me pôs lá). */
  const moveVoiceRef = useRef<(channelId: Id, guildId: Id) => Promise<void>>(async () => {});
  const [chatNotice, setChatNotice] = useState<string | null>(null);

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
      onReady: (user, guilds, readStates, extra) => {
        for (const read of readStates ?? []) ackedRef.current.set(read.channelId, read.lastReadId);
        store.dispatch({ type: "ready", user, guilds, readStates, ...extra });
        idleRef.current = false; // conexão nova começa "em uso"; o relógio abaixo corrige em segundos
        // Reconectou com a voz ligada: o servidor perdeu o estado junto com a conexão antiga.
        const current = voiceRef.current;
        if (current) {
          gateway.sendVoiceJoin(current.channelId, current.muted, current.deafened);
          if (current.streaming) gateway.sendVoiceState(current.muted, current.deafened, true);
        }
      },
      onDispatch: (event) => {
        const before = store.getState();
        store.dispatch({ type: "dispatch", event, now: Date.now() });
        if (event.t === "READ_STATE_UPDATE") ackedRef.current.set(event.d.channelId, event.d.lastReadId);
        // alguém entrou/saiu da minha sala ou começou/parou de transmitir
        const mine = voiceRef.current;
        if (event.t === "VOICE_STATE_UPDATE" && mine && mine.status !== "connecting" && before.me) {
          const previous = before.voice[event.d.guildId]?.[event.d.userId];
          const sound = voiceEventSound(previous, event.d, before.me.id, mine.guildId === event.d.guildId ? mine.channelId : null);
          if (sound) playSound(sound);
        }
        notifyIfMentioned(store.getState(), event, portRef.current, settingsStore.get(), playSound);
        if (event.t === "VOICE_MOVE" && voiceRef.current?.guildId === event.d.guildId) {
          if (event.d.channelId === null) {
            void leaveVoiceRef.current();
            setVoiceError("Um moderador tirou você da voz. Para voltar, entre de novo na sala.");
          } else if (event.d.channelId !== voiceRef.current.channelId) {
            void moveVoiceRef.current(event.d.channelId, event.d.guildId);
          }
        }
        // saí do servidor, ele foi excluído, ou fui expulso/banido
        const gone = event.t === "GUILD_DELETE" ? event.d.id : event.t === "MEMBER_REMOVE" && event.d.userId === before.me?.id ? event.d.guildId : null;
        if (gone && before.guilds[gone]) {
          if (voiceRef.current?.guildId === gone) void leaveVoiceRef.current();
          setGuildSettingsOpen((open) => (open === gone ? null : open));
          if (!leavingRef.current.delete(gone)) setChatNotice(`Você não está mais em “${before.guilds[gone]!.name}”: o servidor foi excluído ou você foi removido.`);
        }
      },
      onInvalidSession: () => onLogout("Sua sessão expirou. Entre novamente."),
    });
    gatewayRef.current = gateway;
    gateway.start();
    return () => {
      gateway.stop();
      gatewayRef.current = null;
    };
  }, [session, store, onLogout, playSound]);

  // ---- ausente automático: sem mexer no computador por X minutos ----
  const idleRef = useRef(false);
  useEffect(() => {
    const check = async () => {
      const port = portRef.current;
      const minutes = settingsStore.get().presence.idleMinutes;
      if (!port) return;
      const seconds = await port.getIdleSeconds().catch(() => 0);
      const idle = minutes > 0 && seconds >= minutes * 60;
      if (idle === idleRef.current) return;
      idleRef.current = idle;
      gatewayRef.current?.sendIdle(idle);
    };
    const timer = window.setInterval(() => void check(), 15_000);
    return () => clearInterval(timer);
  }, []);

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
  const badgeOn = settings.notifications.badge;
  useEffect(() => {
    portRef.current?.setBadge(badgeOn ? totalMentions : 0).catch(() => undefined);
  }, [totalMentions, platform, badgeOn]);

  // ---- avisos rápidos do chat (ex.: reação recusada): `chatNotice`, declarado lá em cima ----

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
  // o aberto pode ser um canal de texto ou o chat de uma sala de voz
  const channelId = remembered && guild?.channelIds.includes(remembered) && state.channels[remembered] ? remembered : (textChannelIds[0] ?? null);
  const channel = channelId ? state.channels[channelId] : undefined;
  // Início: amigos e conversas diretas (o botão do topo da barra de servidores)
  const [homeChosen, setHomeChosen] = useState(false);
  const [activeDmId, setActiveDmId] = useState<Id | null>(null);
  // sem servidor: Início se já há amigos ou conversas; senão, a tela de boas-vindas
  const home = homeChosen || (!guild && (Object.keys(state.dms).length > 0 || Object.keys(state.relationships).length > 0));
  const activeDm = home && activeDmId ? state.dms[activeDmId] : undefined;
  /** O que está aberto no meio da tela: a conversa direta (no Início) ou o canal de texto do servidor. */
  const chatId = home ? (activeDm?.id ?? null) : channelId;
  const bucket = chatId ? state.messages[chatId] : undefined;

  useEffect(() => store.dispatch({ type: "focusChannel", channelId: chatId }), [chatId, store]);

  // ---- histórico do canal aberto ----
  const [historyError, setHistoryError] = useState<Record<Id, string>>({});
  const [historyAttempt, setHistoryAttempt] = useState(0);
  useEffect(() => {
    if (!chatId || state.status !== "ready" || bucket?.loaded) return;
    let alive = true;
    api
      .listMessages(chatId)
      .then((messages) => {
        if (!alive) return;
        store.dispatch({ type: "history", channelId: chatId, messages, mode: "latest", pageSize: LIMITS.pageSize });
        setHistoryError(({ [chatId]: _removed, ...rest }) => rest);
      })
      .catch((error: unknown) => {
        if (alive) setHistoryError((prev) => ({ ...prev, [chatId]: error instanceof ApiError ? error.message : "Não foi possível carregar as mensagens." }));
      });
    return () => {
      alive = false;
    };
  }, [api, store, chatId, state.status, bucket?.loaded, historyAttempt]);

  // ---- conversas diretas e amigos ----
  const [homeDialog, setHomeDialog] = useState<"newGroup" | "addPeople" | "rename" | null>(null);
  const [customStatusOpen, setCustomStatusOpen] = useState(false);
  const [userMenu, setUserMenu] = useState<UserMenuTarget | null>(null);
  const closeUserMenu = useCallback(() => setUserMenu(null), []);
  /** Abre (ou cria) a conversa com essa pessoa e vai para ela. */
  const openDmWith = async (userIds: Id[], name?: string) => {
    try {
      const dm = await api.openDm(userIds, name);
      store.dispatch({ type: "dispatch", event: { t: "DM_CHANNEL_CREATE", d: dm }, now: Date.now() });
      setHomeChosen(true);
      setActiveDmId(dm.id);
      setDrawerOpen(false);
    } catch (error) {
      setChatNotice(error instanceof ApiError ? error.message : "Não foi possível abrir a conversa. Tente de novo.");
      throw error;
    }
  };
  const closeDm = async (dm: DmChannel) => {
    try {
      await api.closeDm(dm.id);
      store.dispatch({ type: "dispatch", event: { t: "DM_CHANNEL_DELETE", d: { id: dm.id } }, now: Date.now() });
      if (activeDmId === dm.id) setActiveDmId(null);
    } catch (error) {
      setChatNotice(error instanceof ApiError ? error.message : "Não foi possível fechar a conversa. Tente de novo.");
    }
  };
  const friendAction = (work: Promise<unknown>) =>
    work.catch((error: unknown) => setChatNotice(error instanceof ApiError ? error.message : "Não deu certo. Confira a conexão e tente de novo."));

  // ---- ações de voz ----
  const leaveVoice = useCallback(
    async (options: { moved?: boolean } = {}) => {
      const engine = engineRef.current;
      if (voiceRef.current && !options.moved) playSound("voiceDisconnect");
      setVoice(null);
      setSpeaking(NO_SPEAKERS);
      setScreenShares([]);
      setStageOpen(false);
      if (!options.moved) gatewayRef.current?.sendVoiceLeave();
      await engine?.leave();
    },
    [playSound],
  );
  leaveVoiceRef.current = () => leaveVoice();

  const joinVoice = useCallback(
    async (voiceChannelId: Id, voiceGuildId: Id, options: { moved?: boolean } = {}) => {
      if (voiceRef.current?.channelId === voiceChannelId) return;
      if (voiceRef.current) await leaveVoice(options);
      setVoiceError(null);
      // sem "Falar" nesta sala, entra mutado (e o botão do microfone fica bloqueado)
      const muted = !hasPermission(myChannelPermissions(store.getState(), voiceChannelId), "SPEAK");
      const session: VoiceSession = { channelId: voiceChannelId, guildId: voiceGuildId, status: "connecting", muted, deafened: false, streaming: false };
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
          { muted, deafened: false, voice: voiceSettingsOf(settingsStore.get().voice), pushToTalk: pushToTalkOn(settingsStore.get().voice) ? false : null },
        );
        if (voiceRef.current?.channelId !== voiceChannelId) return; // saiu enquanto conectava
        gatewayRef.current?.sendVoiceJoin(voiceChannelId, muted, false);
        playSound("voiceConnect");
        setVoice((current) => (current && current.channelId === voiceChannelId ? { ...current, status: "connected" } : current));
      } catch (error) {
        await engineRef.current?.leave();
        setVoice(null);
        setVoiceError(voiceErrorMessage(error));
      }
    },
    [api, leaveVoice, playSound, store],
  );
  moveVoiceRef.current = (channelId, guildId) => joinVoice(channelId, guildId, { moved: true });

  // Microfone, alto-falante, volumes e tratamento mudados nas configurações valem na hora, na chamada.
  const voiceSettingsKey = JSON.stringify(voiceSettingsOf(settings.voice));
  useEffect(() => {
    if (!voiceRef.current || !engineRef.current) return;
    engineRef.current.applyVoiceSettings(voiceSettingsOf(settingsStore.get().voice)).catch((error: unknown) => {
      console.error("[aurora] trocar o áudio falhou", error);
      setVoiceError("Não foi possível usar o dispositivo de áudio escolhido. Confira se ele está conectado ou escolha outro nas configurações.");
    });
  }, [voiceSettingsKey]);

  const updateVoiceFlags = async (muted: boolean, deafened: boolean) => {
    const current = voiceRef.current;
    if (!current) return;
    if (deafened !== current.deafened) playSound(deafened ? "deafen" : "undeafen");
    else if (muted !== current.muted) playSound(muted ? "mute" : "unmute");
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
    playSound(localSharing ? "streamStart" : "streamStop");
    const next = { ...current, streaming: localSharing };
    voiceRef.current = next;
    setVoice(next);
    gatewayRef.current?.sendVoiceState(next.muted, next.deafened, localSharing);
  }, [localSharing, playSound]);

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
  const voicePermissions = voice ? myChannelPermissions(state, voice.channelId) : 0;
  const serverMuted = Boolean(voice && state.me && state.voice[voice.guildId]?.[state.me.id]?.serverMuted);
  const toggleMute = () => {
    const current = voiceRef.current;
    if (!current) return;
    if (current.muted && (!hasPermission(voicePermissions, "SPEAK") || serverMuted)) return; // sem "Falar" ou silenciado, o microfone fica desligado
    void updateVoiceFlags(!current.muted, current.muted ? false : current.deafened);
  };
  // Perdeu uma permissão de voz no meio da chamada (cargo mudou): aplica na hora.
  const canConnect = hasPermission(voicePermissions, "CONNECT");
  const canSpeakNow = hasPermission(voicePermissions, "SPEAK");
  const canStreamNow = hasPermission(voicePermissions, "STREAM");
  useEffect(() => {
    const current = voiceRef.current;
    if (!current || current.status === "connecting") return;
    if (!canConnect) {
      void leaveVoice();
      const until = myTimeout(store.getState(), current.guildId);
      setVoiceError(until ? `Você está de castigo ${untilText(until)} e saiu da voz. Até lá, dá para ler, mas não falar.` : "Você não tem mais permissão para usar esta sala de voz.");
      return;
    }
    if ((!canSpeakNow || serverMuted) && !current.muted) void updateVoiceFlags(true, current.deafened);
    if (!canStreamNow && current.streaming) void engineRef.current?.stopScreenShare();
  }, [canConnect, canSpeakNow, canStreamNow, serverMuted]); // reage só quando a permissão muda

  // Castigo acaba sozinho: redesenha na hora em que termina (o servidor já libera pelo relógio dele).
  const [, setClockTick] = useState(0);
  const nextTimeoutEnd = Math.min(...Object.keys(state.guilds).map((id) => myTimeout(state, id) ?? Number.POSITIVE_INFINITY));
  useEffect(() => {
    if (!Number.isFinite(nextTimeoutEnd)) return;
    const timer = window.setTimeout(() => setClockTick((n) => n + 1), Math.min(nextTimeoutEnd - Date.now() + 50, 2 ** 31 - 1));
    return () => clearTimeout(timer);
  }, [nextTimeoutEnd]);
  const toggleDeafen = () => voiceRef.current && void updateVoiceFlags(!voiceRef.current.deafened, !voiceRef.current.deafened);

  // ---- apertar para falar (Configurações → Voz) ----
  const pttOn = pushToTalkOn(settings.voice);
  const pttKey = pttOn ? settings.voice.pttKey : null;
  const [pttOpen, setPttOpen] = useState(false);
  const gateRef = useRef<PushToTalkGate | null>(null);
  const voiceConnected = voice?.status === "connected";
  const voiceChannelNow = voice?.channelId ?? null;
  useEffect(() => {
    const engine = engineRef.current;
    if (!voiceChannelNow || !voiceConnected || !engine) return;
    if (!pttKey) {
      void engine.setPushToTalk(null).catch(() => undefined);
      return;
    }
    const port = portRef.current;
    if (!port) return;
    let active = true;
    let stopWatching: (() => void) | null = null;
    const gate = new PushToTalkGate(settingsStore.get().voice.pttReleaseMs, (open) => {
      setPttOpen(open);
      engine.setPushToTalk(open).catch((error: unknown) => setVoiceError(voiceErrorMessage(error)));
      const current = voiceRef.current;
      if (active && current && !current.muted && !current.deafened) playSound(open ? "pttOn" : "pttOff");
    });
    gateRef.current = gate;
    void engine.setPushToTalk(false).catch(() => undefined);
    port
      .watchPushToTalk(pttKey, (pressed) => gate.set(pressed))
      .then((stop) => {
        if (active) stopWatching = stop;
        else stop();
      })
      .catch((error: unknown) => setVoiceError(error instanceof Error ? error.message : "Não foi possível usar a tecla de apertar para falar."));
    return () => {
      active = false;
      stopWatching?.();
      gate.dispose();
      gateRef.current = null;
      setPttOpen(false);
    };
  }, [voiceChannelNow, voiceConnected, pttKey, platform, playSound]); // platform: a porta nativa fica pronta junto com ele
  useEffect(() => {
    gateRef.current?.setReleaseDelay(settings.voice.pttReleaseMs);
  }, [settings.voice.pttReleaseMs]);

  // ---- atalhos de teclado (Configurações → Atalhos de teclado) ----
  const shortcutsRef = useRef({ toggleMute, toggleDeafen });
  shortcutsRef.current = { toggleMute, toggleDeafen };
  useEffect(() => {
    const onKey = (event: KeyboardEvent) => {
      if (!(event.ctrlKey || event.metaKey) || event.altKey) return;
      if (event.key === "," && !event.shiftKey) {
        event.preventDefault();
        setSettingsOpen((open) => open ?? "account");
        return;
      }
      if (!event.shiftKey) return;
      const key = event.key.toLowerCase();
      if (key === "m") {
        event.preventDefault();
        shortcutsRef.current.toggleMute();
      } else if (key === "d") {
        event.preventDefault();
        shortcutsRef.current.toggleDeafen();
      }
    };
    document.addEventListener("keydown", onKey);
    return () => document.removeEventListener("keydown", onKey);
  }, []);

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
  const guildPermissions = guild ? myPermissions(state, guild.id) : 0;
  const channelPermissions = channel ? myChannelPermissions(state, channel.id) : 0;
  const timeoutUntil = guild ? myTimeout(state, guild.id) : null;
  const guildCtx = guild ? { guildId: guild.id, ownerId: guild.ownerId, roles: guild.roles } : null;
  const voiceModeration = (userId: Id, voiceChannelId: Id) => {
    const target = guild ? state.members[guild.id]?.[userId] : undefined;
    const mine = state.me && guild ? state.members[guild.id]?.[state.me.id] : undefined;
    if (!guildCtx || !target || !state.me) return { canMute: false, canMove: false };
    const above = outranks(guildCtx, { userId: state.me.id, roleIds: mine?.roles ?? [] }, { userId, roleIds: target.roles });
    const perms = myChannelPermissions(state, voiceChannelId);
    return { canMute: above && hasPermission(perms, "MUTE_MEMBERS"), canMove: above && hasPermission(perms, "MOVE_MEMBERS") };
  };
  const members = Object.values(membersById);
  // pessoas de uma conversa direta, no formato de membro (nomes, menções e lista do grupo)
  const dmMembers: Record<Id, Member> = activeDm
    ? Object.fromEntries(
        [state.me!, ...activeDm.recipients].map((user) => [
          user.id,
          { user, joinedAt: 0, online: user.id === state.me!.id ? state.status === "ready" : (state.relationships[user.id]?.online ?? Object.values(state.members).some((g) => g[user.id]?.online)), roles: [] },
        ]),
      )
    : {};
  const chatMembers = home ? dmMembers : membersById;
  const typingNames = chatId
    ? Object.keys(state.typing[chatId] ?? {})
        .map((userId) => chatMembers[userId]?.user.displayName)
        .filter((name): name is string => Boolean(name))
    : [];
  const relationships = Object.values(state.relationships);
  const friends = relationships.filter((r) => r.type === "friend").map((r) => r.user);
  const otherBlocked = activeDm?.type === "dm" && activeDm.recipients[0] ? isBlocked(state, activeDm.recipients[0].id) : false;

  /** O painel de conversa, para canal de servidor ou conversa direta. */
  const renderChat = (target: Channel, options: { canSend: boolean; canReact: boolean; canManageMessages: boolean; blockedReason: string | null; dm?: DmChannel }) => (
    <ChatPane
      key={target.id}
      channel={target}
      bucket={bucket}
      historyError={historyError[target.id] ?? null}
      me={me}
      canSend={options.canSend}
      canReact={options.canReact}
      canManageMessages={options.canManageMessages}
      blockedReason={options.blockedReason}
      dm={options.dm ? { title: dmName(options.dm), group: options.dm.type === "group_dm" } : undefined}
      isBlocked={(userId) => isBlocked(state, userId)}
      onOpenUser={(user, at) => setUserMenu({ user, guildId: options.dm ? null : (guild?.id ?? null), ...at })}
      searchPlaceholder={options.dm ? (options.dm.type === "group_dm" ? "Buscar no grupo" : undefined) : guild ? `Buscar em ${guild.name}` : undefined}
      typingNames={typingNames}
      status={state.status}
      membersOpen={membersOpen}
      membersById={chatMembers}
      notice={chatNotice}
      onDismissNotice={() => setChatNotice(null)}
      onReact={toggleReaction}
      onOpenLink={openLink}
      onToggleMembers={() => setMembersOpen((open) => !open)}
      onOpenDrawer={() => setDrawerOpen(true)}
      headerExtra={
        <>
          {options.dm && (
            <DmHeaderActions
              dm={options.dm}
              blocked={otherBlocked}
              onRename={() => setHomeDialog("rename")}
              onAddPeople={() => setHomeDialog("addPeople")}
              onLeave={() => void closeDm(options.dm!)}
              onToggleBlock={() => {
                const other = options.dm!.recipients[0];
                if (other) void friendAction(otherBlocked ? api.removeRelationship(other.id) : api.blockUser(other.id));
              }}
            />
          )}
          {availableUpdate ? <UpdateButton update={availableUpdate} onInstall={onInstallUpdate} /> : null}
        </>
      }
      onRetryHistory={() => {
        setHistoryError(({ [target.id]: _removed, ...rest }) => rest);
        setHistoryAttempt((n) => n + 1);
      }}
      onLoadOlder={async () => {
        const first = bucket?.items[0];
        if (!first) return;
        const messages = await api.listMessages(target.id, first.id);
        store.dispatch({ type: "history", channelId: target.id, messages, mode: "older", pageSize: LIMITS.pageSize });
      }}
      onUpload={(file, meta, onProgress) => api.uploadAttachment(target.id, file, meta, onProgress)}
      onSend={async (content, replyToId, attachmentIds) => {
        const message = await api.sendMessage(target.id, content, crypto.randomUUID(), replyToId ?? undefined, attachmentIds);
        ackedRef.current.set(target.id, message.id); // o servidor marca o que eu envio como lido
        store.dispatch({ type: "messageUpsert", message });
      }}
      onEdit={async (id, content) => {
        const message = await api.editMessage(id, content);
        store.dispatch({ type: "dispatch", event: { t: "MESSAGE_UPDATE", d: message }, now: Date.now() });
      }}
      onDelete={async (id) => {
        await api.deleteMessage(id);
        store.dispatch({ type: "dispatch", event: { t: "MESSAGE_DELETE", d: { id, channelId: target.id } }, now: Date.now() });
      }}
      onTyping={() => {
        const now = Date.now();
        if (now - lastTypingRef.current < TYPING_THROTTLE_MS) return;
        lastTypingRef.current = now;
        gatewayRef.current?.sendTyping(target.id);
      }}
    />
  );
  const statusText = state.status === "ready" ? (platform?.kind === "tauri" ? `Conectado · v${platform.appVersion}` : "Conectado") : "Reconectando…";
  const myStatus = state.settings.status ?? "online";
  const saveSettings = (changes: Parameters<typeof api.updateUserSettings>[0]) =>
    api.updateUserSettings(changes).then((settings) => store.dispatch({ type: "settings", settings: { ...state.settings, ...settings } }));
  const statusControl: StatusControl = {
    status: myStatus,
    customStatus: state.settings.customStatus ?? null,
    // como os outros me veem (o servidor me manda a minha própria presença); invisível = offline
    presence: myStatus === "invisible" ? "offline" : presenceOf(state, me.id).status === "offline" ? (myStatus === "idle" ? "idle" : myStatus === "dnd" ? "dnd" : "online") : presenceOf(state, me.id).status,
    onStatus: (status) => void saveSettings({ status }).catch(() => setChatNotice("Não foi possível mudar o status. Confira a conexão e tente de novo.")),
    onEditCustom: () => setCustomStatusOpen(true),
    onClearCustom: () => void saveSettings({ customStatus: null }).catch(() => setChatNotice("Não foi possível limpar o status. Tente de novo.")),
  };
  const channelsOf = (type: ChannelType) =>
    guild ? guild.channelIds.map((id) => state.channels[id]).filter((c): c is Channel => c !== undefined && c.type === type) : [];

  return (
    <div
      className="app"
      data-members={membersOpen && ((!home && guild) || activeDm?.type === "group_dm") ? "open" : "closed"}
      data-drawer={drawerOpen ? "open" : "closed"}
      data-has-guild={guild || home ? "yes" : "no"}
    >
      <a className="skip-link" href="#composer-input">
        Pular para o campo de mensagem
      </a>
      <Rail
        guilds={guilds}
        activeGuildId={guild?.id ?? null}
        homeActive={home}
        homeMentions={dmMentionTotal(state)}
        onHome={() => setHomeChosen(true)}
        unreadGuildIds={unreadGuildIds}
        guildMentions={guildMentions}
        onSelect={(id) => {
          setHomeChosen(false);
          setSelectedGuildId(id);
        }}
        onCreate={() => setDialog("createGuild")}
        onJoin={() => setDialog("joinGuild")}
      />

      {home ? (
        <>
          <HomeSidebar
            dms={dmList(state)}
            activeDmId={activeDm?.id ?? null}
            friendsActive={!activeDm}
            pendingCount={relationships.filter((r) => r.type === "incoming").length}
            mentions={channelMentions}
            unread={unreadChannels}
            presenceOf={(userId) => presenceOf(state, userId).status}
            onFriends={() => {
              setActiveDmId(null);
              setDrawerOpen(false);
            }}
            onOpenDm={(id) => {
              setActiveDmId(id);
              setDrawerOpen(false);
            }}
            onCloseDm={(dm) => void closeDm(dm)}
            onNewGroup={() => setHomeDialog("newGroup")}
            footer={<UserPanel me={me} online={state.status === "ready"} statusText={statusText} onOpenSettings={() => setSettingsOpen("account")} statusControl={statusControl} />}
          />
          {activeDm
            ? renderChat(
                { id: activeDm.id, guildId: "", type: "text", name: dmName(activeDm), position: 0, overwrites: [] },
                {
                  canSend: !otherBlocked,
                  canReact: !otherBlocked,
                  canManageMessages: false,
                  blockedReason: otherBlocked ? "Você bloqueou esta pessoa. Desbloqueie (no topo da conversa) para voltar a conversar." : null,
                  dm: activeDm,
                },
              )
            : <FriendsView relationships={relationships} api={api} onMessage={(user) => void openDmWith([user.id]).catch(() => undefined)} onOpenDrawer={() => setDrawerOpen(true)} />}
          {activeDm?.type === "group_dm" && membersOpen && (
            <MemberList members={Object.values(dmMembers)} ownerId={activeDm.ownerId ?? ""} roles={[]} meId={me.id} onOpenUser={(user, at) => setUserMenu({ user, guildId: null, ...at })} />
          )}
        </>
      ) : guild && channel ? (
        <>
          <Sidebar
            guild={guild}
            textChannels={channelsOf("text")}
            voiceChannels={channelsOf("voice")}
            activeChannelId={channel.id}
            unread={unreadChannels}
            mentions={channelMentions}
            canManageChannels={hasPermission(guildPermissions, "MANAGE_CHANNELS")}
            canInvite={hasPermission(guildPermissions, "CREATE_INVITE")}
            canSpeak={hasPermission(voicePermissions, "SPEAK")}
            canStream={hasPermission(voicePermissions, "STREAM")}
            serverMuted={serverMuted}
            pushToTalk={pttOn && voice ? { label: settings.voice.pttKeyLabel ?? pttKeyLabel(settings.voice.pttKey ?? ""), open: pttOpen } : null}
            canConnect={(id) => hasPermission(myChannelPermissions(state, id), "CONNECT")}
            voiceModeration={voiceModeration}
            onModerateVoice={(userId, action) => {
              api.moderateVoice(guild.id, userId, action).catch((error: unknown) => {
                setChatNotice(error instanceof ApiError ? error.message : "Não foi possível fazer isso na voz. Tente de novo.");
              });
            }}
            me={me}
            online={state.status === "ready"}
            statusText={statusText}
            statusControl={statusControl}
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
            onOpenSettings={() => setSettingsOpen("account")}
            onOpenGuildSettings={() => {
              setGuildSettingsStart(null);
              setGuildSettingsOpen(guild.id);
            }}
            onOpenChannelChat={(id) => selectChannel(id)}
            onEditChannel={(id) => {
              setGuildSettingsStart({ section: "channels", channelId: id });
              setGuildSettingsOpen(guild.id);
            }}
            isOwner={guild.ownerId === me.id}
            onLeaveGuild={() => setLeaveConfirm(guild.id)}
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
            renderChat(channel, {
              canSend: hasPermission(channelPermissions, "SEND_MESSAGES"),
              canReact: hasPermission(channelPermissions, "ADD_REACTIONS"),
              canManageMessages: hasPermission(channelPermissions, "MANAGE_MESSAGES"),
              blockedReason: timeoutUntil ? `Você está de castigo ${untilText(timeoutUntil)}. Até lá, dá para ler, mas não escrever nem reagir.` : null,
            })
          )}
          {membersOpen && !stageOpen && (
            <MemberList
              members={members}
              ownerId={guild.ownerId}
              roles={guild.roles}
              meId={me.id}
              onOpenUser={(user, at) => setUserMenu({ user, guildId: guild.id, ...at })}
            />
          )}
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
            <button type="button" className="button button--ghost" onClick={() => setSettingsOpen("account")}>
              Configurações
            </button>
          </CenterState>
        </main>
      )}
      {homeDialog === "newGroup" && (
        <PickFriendsDialog
          title="Nova conversa"
          description="Escolha 1 amigo para conversar a dois, ou mais para um grupo."
          friends={friends}
          max={LIMITS.groupDmMax - 1}
          withName
          confirmLabel="Começar conversa"
          onConfirm={(ids, name) => openDmWith(ids, name || undefined)}
          onClose={() => setHomeDialog(null)}
        />
      )}
      {homeDialog === "addPeople" && activeDm && (
        <PickFriendsDialog
          title={`Pôr pessoas em ${dmName(activeDm)}`}
          description={`O grupo pode ter até ${LIMITS.groupDmMax} pessoas, contando você.`}
          friends={friends}
          exclude={activeDm.recipients.map((r) => r.id)}
          max={LIMITS.groupDmMax - 1 - activeDm.recipients.length}
          confirmLabel="Pôr no grupo"
          onConfirm={async (ids) => {
            for (const id of ids) await api.addToGroupDm(activeDm.id, id);
          }}
          onClose={() => setHomeDialog(null)}
        />
      )}
      {leaveConfirm && state.guilds[leaveConfirm] && (
        <Modal
          title={`Sair de “${state.guilds[leaveConfirm]!.name}”?`}
          description="Você deixa de ver os canais e a conversa. Para voltar, vai precisar de um convite novo."
          onClose={() => setLeaveConfirm(null)}
        >
          <div className="modal__actions">
            <button type="button" className="button button--secondary" onClick={() => setLeaveConfirm(null)}>
              Cancelar
            </button>
            <button
              type="button"
              className="button button--danger"
              onClick={() => {
                const id = leaveConfirm;
                setLeaveConfirm(null);
                leavingRef.current.add(id);
                api.leaveGuild(id).catch((error: unknown) => {
                  leavingRef.current.delete(id);
                  setChatNotice(error instanceof ApiError ? error.message : "Não foi possível sair do servidor. Tente de novo.");
                });
              }}
            >
              Sair do servidor
            </button>
          </div>
        </Modal>
      )}
      {userMenu && state.me && (
        <UserMenu
          key={`${userMenu.user.id}:${userMenu.x}:${userMenu.y}`}
          target={userMenu}
          state={state}
          api={api}
          onClose={closeUserMenu}
          onMessage={(user) => void openDmWith([user.id]).catch(() => undefined)}
          onNotice={setChatNotice}
        />
      )}
      {customStatusOpen && (
        <CustomStatusDialog
          current={state.settings.customStatus ?? null}
          onSave={(customStatus) => saveSettings({ customStatus }).catch((error: unknown) => Promise.reject(new Error(error instanceof ApiError ? error.message : "Não foi possível salvar o status. Tente de novo.")))}
          onClose={() => setCustomStatusOpen(false)}
        />
      )}
      {homeDialog === "rename" && activeDm && <RenameGroupDialog dm={activeDm} onRename={(name) => api.renameGroupDm(activeDm.id, name).then(() => undefined)} onClose={() => setHomeDialog(null)} />}

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
      {guildSettingsOpen && state.guilds[guildSettingsOpen] && (
        <GuildSettingsScreen
          guild={state.guilds[guildSettingsOpen]!}
          members={state.members[guildSettingsOpen] ?? {}}
          channels={state.guilds[guildSettingsOpen]!.channelIds.map((id) => state.channels[id]).filter((c): c is Channel => c !== undefined)}
          me={me}
          permissions={myPermissions(state, guildSettingsOpen)}
          api={api}
          onLeaving={(id) => leavingRef.current.add(id)}
          onClose={closeGuildSettings}
          initialSection={guildSettingsStart?.section}
          initialChannelId={guildSettingsStart?.channelId ?? null}
        />
      )}
      {settingsOpen && (
        <SettingsScreen
          initialSection={settingsOpen}
          me={me}
          api={api}
          serverUrl={session.serverUrl}
          port={portRef.current}
          platform={platform}
          sounds={sounds}
          theme={themePreference}
          onThemeChange={onThemeChange}
          onUserUpdated={(user: User) => store.dispatch({ type: "dispatch", event: { t: "USER_UPDATE", d: user }, now: Date.now() })}
          dmPolicy={state.settings.dmPolicy}
          onDmPolicy={(dmPolicy) => store.dispatch({ type: "settings", settings: { dmPolicy } })}
          availableUpdate={availableUpdate}
          onCheckUpdate={onCheckUpdate}
          onInstallUpdate={onInstallUpdate}
          onLogout={() => {
            setSettingsOpen(null);
            void logout();
          }}
          onClose={closeSettings}
        />
      )}
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
