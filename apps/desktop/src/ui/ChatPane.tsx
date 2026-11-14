import { useCallback, useEffect, useId, useLayoutEffect, useMemo, useRef, useState, type FormEvent, type KeyboardEvent, type ReactNode, type RefObject } from "react";
import { ArrowDown, ListChecks, AtSign, Volume2, CornerUpRight, EyeOff, FaceSlightlySmilingPlus, Hash, Menu, Pencil, Plus, Reply, SendHorizontal, Trash, Upload, Users, WifiOff, X } from "lucide-react";
import { LIMITS, type Channel, type Id, type Member, type Message, type PollCreate, type User } from "@aurora/schema";
import { ApiError } from "../net/api";
import type { ConnectionStatus } from "../net/gateway";
import type { ChannelMessages } from "../state/chat-store";
import { formatTime, groupMessages, typingText } from "../messages";
import { plainText } from "../markdown";
import { decodeMentions, encodeMentions, filterMembers, mentionQueryAt } from "../mentions";
import { EmojiPicker } from "./EmojiPicker";
import { MessageContent } from "./MessageContent";
import { Avatar, ICON, ICON_SM } from "./shell";
import { MessageAttachments, UploadQueue, useUploads, type UploadFn } from "./Attachments";
import { MENTION_EVENT } from "./UserMenu";
import { TopSearch } from "./TopSearch";
import { CreatePollDialog, PollCard } from "./Polls";
import { anchorOf } from "./anchor";

const errorText = (error: unknown) => (error instanceof ApiError ? error.message : "Algo deu errado. Tente de novo.");
const BOTTOM_THRESHOLD_PX = 64;
const FLASH_MS = 1600;

interface ChatPaneProps {
  channel: Channel;
  bucket: ChannelMessages | undefined;
  historyError: string | null;
  me: User;
  /** Permissões neste servidor (o servidor confere de novo; aqui só escondem o que não pode). */
  canSend: boolean;
  canReact: boolean;
  /** Apagar mensagens de outras pessoas. */
  canManageMessages: boolean;
  /** Por que não dá para escrever (ex.: castigo); sem isto, o aviso padrão de falta de permissão. */
  blockedReason?: string | null;
  typingNames: string[];
  status: ConnectionStatus;
  membersOpen: boolean;
  /** Membros do servidor: nomes das menções e sugestões do "@". */
  membersById: Readonly<Record<Id, Member>>;
  onToggleMembers: () => void;
  onOpenDrawer: () => void;
  onRetryHistory: () => void;
  onLoadOlder: () => Promise<void>;
  /** `content` já com as menções em `<@id>`; `attachmentIds` = anexos já enviados. */
  onSend: (content: string, replyToId: Id | null, attachmentIds: Id[]) => Promise<void>;
  onUpload: UploadFn;
  onEdit: (id: Id, content: string) => Promise<void>;
  onDelete: (id: Id) => Promise<void>;
  /** Liga/desliga a minha reação com `emoji`. */
  onReact: (message: Message, emoji: string) => void;
  onOpenLink: (url: string) => void;
  onTyping: () => void;
  /** Aviso rápido sobre uma ação que não deu certo (ex.: reação recusada). */
  notice: string | null;
  onDismissNotice: () => void;
  /** Ações extras na barra do topo (ex.: botão de atualização). */
  headerExtra?: ReactNode;
  /** Conversa direta: título (pessoa ou grupo) em vez de "#canal". */
  dm?: { title: string; group: boolean };
  /** Mensagens de quem eu bloqueei ficam recolhidas. */
  isBlocked?: (userId: Id) => boolean;
  /** Clique no nome ou na foto de quem escreveu: menu da pessoa. */
  onOpenUser?: (user: User, at: { x: number; y: number }) => void;
  /** Pode criar enquete neste canal (menu "+"). */
  canCreatePoll?: boolean;
  onSendPoll?: (poll: PollCreate) => Promise<void>;
  onVotePoll?: (message: Message, answerId: number, add: boolean) => Promise<void>;
  onEndPoll?: (message: Message) => Promise<void>;
  /** Onde a busca do topo procura ("Turma do sábado", "o grupo"); sem isto, sem busca. */
  searchPlace?: string;
  /** Busca de pessoas (servidor e grupo); sem isto, só mensagens. */
  canSearchPeople?: boolean;
  onSearch?: (text: string) => void;
  /** O que está aberto no painel de resultados (null = fechado). */
  activeSearch?: string | null;
  /** Ir até esta mensagem (resultado da busca); `"latest"` = descer até o fim. `nonce` muda a cada pedido. */
  jumpTarget?: { id: Id | "latest"; nonce: number } | null;
  /** A mensagem não está carregada (resposta antiga): carrega a janela em volta dela. */
  onJumpToMessage?: (messageId: Id) => void;
  /** Janela antiga: carregar as mais novas / voltar ao presente. */
  onLoadNewer?: () => Promise<void>;
  onJumpToPresent?: () => void;
}

/** O que as mensagens precisam saber sobre pessoas e ações (evita repassar 10 props). */
interface MessageContext {
  me: User;
  canSend: boolean;
  canReact: boolean;
  canManageMessages: boolean;
  users: User[];
  usersById: Readonly<Record<Id, User>>;
  nameOf: (userId: Id) => string | null;
  onEdit: (id: Id, content: string) => Promise<void>;
  onDelete: (id: Id) => Promise<void>;
  onReact: (message: Message, emoji: string) => void;
  onReply: (message: Message) => void;
  onJumpTo: (messageId: Id) => void;
  onOpenLink: (url: string) => void;
  onVotePoll?: (message: Message, answerId: number, add: boolean) => Promise<void>;
  onEndPoll?: (message: Message) => Promise<void>;
  isBlocked: (userId: Id) => boolean;
  onOpenUser?: (user: User, at: { x: number; y: number }) => void;
}

export function ChatPane(props: ChatPaneProps) {
  const { channel, bucket, me, membersById } = props;
  const listRef = useRef<HTMLDivElement>(null);
  const composerRef = useRef<HTMLTextAreaElement>(null);
  const atBottomRef = useRef(true);
  const restoreFromBottom = useRef<number | null>(null);
  const [showJump, setShowJump] = useState(false);
  const [loadingOlder, setLoadingOlder] = useState(false);
  const [olderError, setOlderError] = useState<string | null>(null);
  const [replyingTo, setReplyingTo] = useState<Message | null>(null);
  const [flashId, setFlashId] = useState<Id | null>(null);
  const [pollOpen, setPollOpen] = useState(false);
  // arrastar arquivos para o chat: o compositor recebe
  const addFilesRef = useRef<((files: File[]) => void) | null>(null);
  const [dragging, setDragging] = useState(false);
  const dragDepth = useRef(0);
  const hasFiles = (event: React.DragEvent) => event.dataTransfer.types.includes("Files");

  const items = bucket?.items ?? [];
  const rows = groupMessages(items);
  const last = items.at(-1);

  const members = useMemo(() => Object.values(membersById), [membersById]);
  const users = useMemo(() => members.map((m) => m.user), [members]);
  const usersById = useMemo(() => Object.fromEntries(users.map((u) => [u.id, u])), [users]);
  const nameOf = useCallback((userId: Id) => membersById[userId]?.user.displayName ?? null, [membersById]);

  /** Centraliza e destaca a mensagem; false se ela não está carregada. */
  const focusMessage = (messageId: Id): boolean => {
    const element = document.getElementById(`message-${messageId}`);
    if (!element) return false;
    element.scrollIntoView({ block: "center" });
    atBottomRef.current = false;
    setFlashId(messageId);
    window.setTimeout(() => setFlashId((current) => (current === messageId ? null : current)), FLASH_MS);
    return true;
  };

  // Pedido de "ir até" (busca): espera a mensagem estar na tela e vai uma vez por pedido.
  const handledJump = useRef<number | null>(null);
  const jump = props.jumpTarget;
  useEffect(() => {
    if (!jump || handledJump.current === jump.nonce || !bucket?.loaded) return;
    if (jump.id === "latest") {
      handledJump.current = jump.nonce;
      scrollToBottom();
      return;
    }
    if (focusMessage(jump.id)) handledJump.current = jump.nonce;
  }, [jump?.nonce, jump?.id, bucket?.loaded, items.length]);

  const [loadingNewer, setLoadingNewer] = useState(false);
  const loadNewer = async () => {
    if (!props.onLoadNewer) return;
    setLoadingNewer(true);
    setOlderError(null);
    try {
      await props.onLoadNewer();
    } catch (error) {
      setOlderError(errorText(error));
    } finally {
      setLoadingNewer(false);
    }
  };

  const scrollToBottom = () => {
    const list = listRef.current;
    if (list) list.scrollTop = list.scrollHeight;
    atBottomRef.current = true;
    setShowJump(false);
  };

  // Ao abrir um canal (ou quando o histórico chega), começa no fim.
  useLayoutEffect(scrollToBottom, [channel.id, bucket?.loaded]);

  // Mensagens antigas entraram em cima: mantém o que o usuário estava vendo.
  useLayoutEffect(() => {
    const list = listRef.current;
    if (list && restoreFromBottom.current !== null) {
      list.scrollTop = list.scrollHeight - restoreFromBottom.current;
      restoreFromBottom.current = null;
    }
  }, [items.length]);

  // Mensagem nova no fim: acompanha se o usuário estava no fim ou se foi ele que enviou.
  useLayoutEffect(() => {
    if (!last) return;
    if (atBottomRef.current || last.author.id === me.id) scrollToBottom();
    else setShowJump(true);
  }, [last?.id]); // de propósito: só reage quando muda a última mensagem

  // A mensagem que eu ia responder foi apagada: some a barra de resposta.
  useEffect(() => {
    if (replyingTo && bucket?.loaded && !items.some((m) => m.id === replyingTo.id)) setReplyingTo(null);
  }, [items, replyingTo, bucket?.loaded]);

  const onScroll = () => {
    const list = listRef.current;
    if (!list) return;
    atBottomRef.current = list.scrollHeight - list.scrollTop - list.clientHeight < BOTTOM_THRESHOLD_PX;
    if (atBottomRef.current) setShowJump(false);
  };

  const loadOlder = async () => {
    const list = listRef.current;
    if (!list) return;
    restoreFromBottom.current = list.scrollHeight - list.scrollTop;
    setLoadingOlder(true);
    setOlderError(null);
    try {
      await props.onLoadOlder();
    } catch (error) {
      restoreFromBottom.current = null;
      setOlderError(errorText(error));
    } finally {
      setLoadingOlder(false);
    }
  };

  const context: MessageContext = {
    me,
    canSend: props.canSend,
    canReact: props.canReact,
    canManageMessages: props.canManageMessages,
    users,
    usersById,
    nameOf,
    onEdit: props.onEdit,
    onDelete: props.onDelete,
    onReact: props.onReact,
    onOpenLink: props.onOpenLink,
    onVotePoll: props.onVotePoll,
    onEndPoll: props.onEndPoll,
    isBlocked: props.isBlocked ?? (() => false),
    onOpenUser: props.onOpenUser,
    onReply: (message) => {
      setReplyingTo(message);
      composerRef.current?.focus();
    },
    // Vai até a mensagem original e a destaca por um instante; se for antiga (não carregada), carrega em volta.
    onJumpTo: (messageId) => {
      if (!focusMessage(messageId)) props.onJumpToMessage?.(messageId);
    },
  };

  return (
    <main
      className="chat"
      aria-labelledby="chat-title"
      onDragEnter={(event) => {
        if (!props.canSend || !hasFiles(event)) return;
        dragDepth.current += 1;
        setDragging(true);
      }}
      onDragOver={(event) => {
        if (props.canSend && hasFiles(event)) event.preventDefault();
      }}
      onDragLeave={() => {
        dragDepth.current = Math.max(0, dragDepth.current - 1);
        if (dragDepth.current === 0) setDragging(false);
      }}
      onDrop={(event) => {
        if (!props.canSend || !hasFiles(event)) return;
        event.preventDefault();
        dragDepth.current = 0;
        setDragging(false);
        addFilesRef.current?.([...event.dataTransfer.files]);
      }}
    >
      {dragging && (
        <div className="drop-overlay" aria-hidden="true">
          <Upload size={32} strokeWidth={1.75} />
          <span>Solte para enviar {props.dm ? `para ${props.dm.title}` : `em #${channel.name}`}</span>
        </div>
      )}
      <header className="chat__header">
        <button type="button" className="icon-button chat__menu" aria-label="Abrir canais" onClick={props.onOpenDrawer}>
          <Menu {...ICON} />
        </button>
        {props.dm ? (props.dm.group ? <Users {...ICON} className="chat__icon" /> : <AtSign {...ICON} className="chat__icon" />) : channel.type === "voice" ? <Volume2 {...ICON} className="chat__icon" /> : <Hash {...ICON} className="chat__icon" />}
        <h2 id="chat-title" className="chat__title">
          {props.dm ? props.dm.title : channel.name}
        </h2>
        <div className="chat__tools">
          {props.headerExtra}
          {props.searchPlace && props.onSearch && (
            <TopSearch
              members={members}
              placeName={props.searchPlace}
              onPickUser={props.canSearchPeople ? props.onOpenUser : undefined}
              onSearch={props.onSearch}
              activeQuery={props.activeSearch ?? null}
            />
          )}
          <button
            type="button"
            className="icon-button"
            aria-pressed={props.membersOpen}
            aria-label="Lista de membros"
            title="Lista de membros"
            onClick={props.onToggleMembers}
          >
            <Users {...ICON} />
          </button>
        </div>
      </header>

      {props.status === "reconnecting" && (
        <div className="banner" role="status">
          <WifiOff {...ICON_SM} />
          Sem conexão com o servidor. Tentando reconectar…
        </div>
      )}
      {props.notice && (
        <div className="banner banner--error" role="alert">
          <span className="banner__text">{props.notice}</span>
          <button type="button" className="icon-button icon-button--small" aria-label="Fechar aviso" onClick={props.onDismissNotice}>
            <X {...ICON_SM} />
          </button>
        </div>
      )}

      <div
        ref={listRef}
        className="messages"
        role="log"
        aria-live="polite"
        aria-relevant="additions"
        aria-label={`Mensagens em ${channel.name}`}
        tabIndex={0}
        onScroll={onScroll}
      >
        {props.historyError ? (
          <div className="center-state">
            <p className="form-error" role="alert">
              {props.historyError}
            </p>
            <button type="button" className="button button--secondary" onClick={props.onRetryHistory}>
              Tentar de novo
            </button>
          </div>
        ) : !bucket?.loaded ? (
          <p className="messages__loading">Carregando mensagens…</p>
        ) : (
          <>
            {bucket.hasMore ? (
              <div className="load-older">
                <button type="button" className="button button--secondary" onClick={loadOlder} disabled={loadingOlder}>
                  {loadingOlder ? "Carregando…" : "Carregar mensagens anteriores"}
                </button>
                {olderError && (
                  <p className="form-error" role="alert">
                    {olderError}
                  </p>
                )}
              </div>
            ) : (
              <div className="empty">
                <div className="empty__art" aria-hidden="true">
                  {props.dm ? props.dm.group ? <Users size={32} strokeWidth={1.75} /> : <AtSign size={32} strokeWidth={1.75} /> : channel.type === "voice" ? <Volume2 size={32} strokeWidth={1.75} /> : <Hash size={32} strokeWidth={1.75} />}
                </div>
                <h3 className="empty__title">{props.dm ? (props.dm.group ? `Este é o começo do grupo ${props.dm.title}` : `Este é o começo da conversa com ${props.dm.title}`) : channel.type === "voice" ? `Este é o começo do chat de ${channel.name}` : `Este é o começo de #${channel.name}`}</h3>
                <p className="empty__text">{items.length === 0 ? "Ainda não há mensagens aqui. Escreva a primeira." : "Não há mensagens mais antigas."}</p>
              </div>
            )}
            {rows.map(({ message, startsGroup }) => (
              <MessageItem key={message.id} message={message} startsGroup={startsGroup} flash={flashId === message.id} ctx={context} />
            ))}
            {bucket.hasNewer && (
              <div className="load-older load-newer">
                <button type="button" className="button button--secondary" onClick={() => void loadNewer()} disabled={loadingNewer}>
                  {loadingNewer ? "Carregando…" : "Carregar mensagens mais novas"}
                </button>
              </div>
            )}
          </>
        )}
      </div>

      {bucket?.hasNewer ? (
        <div className="jump-latest jump-latest--past" role="status">
          <span>Você está vendo mensagens antigas</span>
          <button type="button" className="jump-latest__action" onClick={props.onJumpToPresent}>
            <ArrowDown {...ICON_SM} />
            Ir para o presente
          </button>
        </div>
      ) : (
        showJump && (
          <button type="button" className="jump-latest" onClick={scrollToBottom}>
            <ArrowDown {...ICON_SM} />
            Ir para as mensagens novas
          </button>
        )
      )}

      {props.canSend ? (
        <Composer
          inputRef={composerRef}
          channelName={channel.name}
          placeTitle={props.dm ? props.dm.title : channel.type === "voice" ? `chat de ${channel.name}` : `#${channel.name}`}
          members={members}
          users={users}
          replyingTo={replyingTo}
          onCancelReply={() => setReplyingTo(null)}
          onSend={props.onSend}
          onUpload={props.onUpload}
          addFilesRef={addFilesRef}
          onTyping={props.onTyping}
          onCreatePoll={props.canCreatePoll && props.onSendPoll ? () => setPollOpen(true) : undefined}
        />
      ) : (
        <p className="composer-blocked" role="note">
          {props.blockedReason ?? "Você não tem permissão para enviar mensagens neste canal. Peça a quem administra."}
        </p>
      )}
      <div className="typing" aria-live="polite">
        {typingText(props.typingNames)}
      </div>
      {pollOpen && props.onSendPoll && <CreatePollDialog onSubmit={props.onSendPoll} onClose={() => setPollOpen(false)} />}
    </main>
  );
}

/* ---------------- mensagem ---------------- */

function MessageItem({ message, startsGroup, flash, ctx }: { message: Message; startsGroup: boolean; flash: boolean; ctx: MessageContext }) {
  const mine = message.author.id === ctx.me.id;
  const canDelete = mine || ctx.canManageMessages;
  const mentionsMe = !mine && message.mentions.includes(ctx.me.id);
  const [editing, setEditing] = useState(false);
  const [revealed, setRevealed] = useState(false);
  const [draft, setDraft] = useState("");
  const [confirming, setConfirming] = useState(false);
  const [picking, setPicking] = useState(false);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const reactButtonRef = useRef<HTMLButtonElement>(null);

  const startEdit = () => {
    setDraft(decodeMentions(message.content, ctx.usersById));
    setError(null);
    setEditing(true);
  };

  const save = async () => {
    const content = encodeMentions(draft.trim(), ctx.users);
    if (!content || content === message.content) {
      setEditing(false);
      return;
    }
    setBusy(true);
    try {
      await ctx.onEdit(message.id, content);
      setEditing(false);
      setError(null);
    } catch (caught) {
      setError(errorText(caught));
    } finally {
      setBusy(false);
    }
  };

  const remove = async () => {
    setBusy(true);
    try {
      await ctx.onDelete(message.id);
    } catch (caught) {
      setError(errorText(caught));
      setBusy(false);
      setConfirming(false);
    }
  };

  const onEditKey = (event: KeyboardEvent<HTMLTextAreaElement>) => {
    if (event.key === "Escape") {
      event.preventDefault();
      setEditing(false);
    } else if (event.key === "Enter" && !event.shiftKey && !event.nativeEvent.isComposing) {
      event.preventDefault();
      void save();
    }
  };

  const closePicker = useCallback(() => {
    setPicking(false);
    reactButtonRef.current?.focus();
  }, []);

  const time = formatTime(message.createdAt);
  const reply = message.replyTo;
  if (!mine && !revealed && ctx.isBlocked(message.author.id)) {
    return (
      <article id={`message-${message.id}`} className="message message--blocked" aria-label="Mensagem de alguém que você bloqueou">
        <span className="message__gutter" aria-hidden="true">
          <EyeOff {...ICON_SM} />
        </span>
        <p className="message__blocked">
          Mensagem de alguém que você bloqueou.{" "}
          <button type="button" className="link-button" onClick={() => setRevealed(true)}>
            Mostrar
          </button>
        </p>
      </article>
    );
  }
  const className = ["message", startsGroup && "message--group-start", mentionsMe && "message--mention", flash && "message--flash"].filter(Boolean).join(" ");
  return (
    <article id={`message-${message.id}`} className={className} aria-label={startsGroup ? undefined : `${message.author.displayName}, ${time}`}>
      {reply && (
        <button
          type="button"
          className="message__reply"
          disabled={!reply.author}
          onClick={() => ctx.onJumpTo(reply.id)}
          aria-label={reply.author ? `Respondendo a ${reply.author.displayName}. Ir para a mensagem original` : "Respondendo a uma mensagem apagada"}
        >
          <CornerUpRight {...ICON_SM} aria-hidden />
          {reply.author ? (
            <>
              <span className="message__reply-author">@{reply.author.displayName}</span>
              <span className="message__reply-text">{reply.content ? plainText(reply.content, (id) => ctx.nameOf(id) ?? "alguém") : "Anexo"}</span>
            </>
          ) : (
            <span className="message__reply-text message__reply-text--deleted">Mensagem original apagada</span>
          )}
        </button>
      )}
      <span className="message__gutter">
        {startsGroup ? (
          ctx.onOpenUser ? (
            <button type="button" className="message__avatar-button" aria-label={`Ações para ${message.author.displayName}`} onClick={(e) => ctx.onOpenUser!(message.author, anchorOf(e))}>
              <Avatar user={message.author} size="lg" />
            </button>
          ) : (
            <Avatar user={message.author} size="lg" />
          )
        ) : (
          <time className="message__hover-time">{time}</time>
        )}
      </span>
      <div className="message__body">
        {startsGroup && (
          <header className="message__header">
            {ctx.onOpenUser ? (
              <button type="button" className="message__author message__author--button" onClick={(e) => ctx.onOpenUser!(message.author, anchorOf(e))}>
                {message.author.displayName}
              </button>
            ) : (
              <span className="message__author">{message.author.displayName}</span>
            )}
            <time className="message__time">{time}</time>
          </header>
        )}
        {editing ? (
          <div className="message__edit">
            <textarea
              className="input message__edit-input"
              value={draft}
              maxLength={LIMITS.messageMax}
              onChange={(e) => setDraft(e.target.value)}
              onKeyDown={onEditKey}
              aria-label="Editar mensagem"
              autoFocus
              rows={2}
            />
            <p className="message__edit-hint">
              Enter salva · Esc cancela {busy && "· salvando…"}
            </p>
          </div>
        ) : (message.content || message.editedAt) ? (
          <MessageContent
            content={message.content}
            nameOf={ctx.nameOf}
            meId={ctx.me.id}
            onOpenLink={ctx.onOpenLink}
            trailing={
              message.editedAt ? (
                <span className="message__edited" title={`Editada em ${formatTime(message.editedAt)}`}>
                  (editada)
                </span>
              ) : null
            }
          />
        ) : null}
        {message.attachments && message.attachments.length > 0 && <MessageAttachments attachments={message.attachments} onOpenLink={ctx.onOpenLink} />}
        {message.poll && (
          <PollCard
            message={message as Message & { poll: NonNullable<Message["poll"]> }}
            me={ctx.me}
            canVote={ctx.canReact && Boolean(ctx.onVotePoll)}
            canEnd={(message.author.id === ctx.me.id || ctx.canManageMessages) && Boolean(ctx.onEndPoll)}
            usersById={ctx.usersById}
            onVote={(answerId, add) => ctx.onVotePoll!(message, answerId, add)}
            onEnd={() => ctx.onEndPoll!(message)}
          />
        )}
        {message.reactions.length > 0 && (
          <div className="reactions" role="group" aria-label="Reações">
            {message.reactions.map((reaction) => {
              const reacted = reaction.userIds.includes(ctx.me.id);
              const names = reaction.userIds.map((id) => (id === ctx.me.id ? "você" : (ctx.nameOf(id) ?? "alguém"))).join(", ");
              const count = reaction.userIds.length;
              return (
                <button
                  key={reaction.emoji}
                  type="button"
                  className="reaction"
                  aria-pressed={reacted}
                  title={`${names} reagiu com ${reaction.emoji}`}
                  aria-label={`${reaction.emoji}: ${count} ${count === 1 ? "reação" : "reações"} (${names})${reacted ? ". Clique para tirar a sua" : ctx.canReact ? ". Clique para reagir também" : ""}`}
                  disabled={!reacted && !ctx.canReact}
                  onClick={() => ctx.onReact(message, reaction.emoji)}
                >
                  <span className="reaction__emoji" aria-hidden="true">
                    {reaction.emoji}
                  </span>
                  <span className="reaction__count" aria-hidden="true">
                    {count}
                  </span>
                </button>
              );
            })}
          </div>
        )}
        {confirming && (
          <div className="confirm-inline" role="alertdialog" aria-label="Confirmar exclusão">
            <span>Apagar esta mensagem? Não dá para desfazer.</span>
            <button type="button" className="button button--danger button--small" onClick={remove} disabled={busy}>
              Apagar
            </button>
            <button type="button" className="button button--secondary button--small" onClick={() => setConfirming(false)} disabled={busy}>
              Cancelar
            </button>
          </div>
        )}
        {error && (
          <p className="form-error" role="alert">
            {error}
          </p>
        )}
      </div>
      {!editing && !confirming && (
        <div className={picking ? "message__actions message__actions--open" : "message__actions"}>
          {ctx.canReact && (
            <button
              ref={reactButtonRef}
              type="button"
              className="icon-button icon-button--small"
              aria-label="Adicionar reação"
              aria-expanded={picking}
              title="Reagir"
              onClick={() => setPicking((open) => !open)}
            >
              <FaceSlightlySmilingPlus {...ICON_SM} />
            </button>
          )}
          {ctx.canSend && (
            <button type="button" className="icon-button icon-button--small" aria-label="Responder" title="Responder" onClick={() => ctx.onReply(message)}>
              <Reply {...ICON_SM} />
            </button>
          )}
          {mine && (
            <button type="button" className="icon-button icon-button--small" aria-label="Editar mensagem" title="Editar" onClick={startEdit}>
              <Pencil {...ICON_SM} />
            </button>
          )}
          {canDelete && (
            <button type="button" className="icon-button icon-button--small" aria-label="Apagar mensagem" title="Apagar" onClick={() => setConfirming(true)}>
              <Trash {...ICON_SM} />
            </button>
          )}
          {picking && (
            <EmojiPicker
              onClose={closePicker}
              onPick={(emoji) => {
                ctx.onReact(message, emoji);
                closePicker();
              }}
            />
          )}
        </div>
      )}
    </article>
  );
}

/* ---------------- compositor ---------------- */

function Composer({
  inputRef,
  channelName,
  placeTitle,
  members,
  users,
  replyingTo,
  onCancelReply,
  onSend,
  onUpload,
  addFilesRef,
  onTyping,
  onCreatePoll,
}: {
  inputRef: RefObject<HTMLTextAreaElement | null>;
  channelName: string;
  /** "#canal" ou o nome da pessoa/grupo (conversa direta). */
  placeTitle: string;
  members: Member[];
  users: User[];
  replyingTo: Message | null;
  onCancelReply: () => void;
  onSend: (content: string, replyToId: Id | null, attachmentIds: Id[]) => Promise<void>;
  onUpload: UploadFn;
  addFilesRef: RefObject<((files: File[]) => void) | null>;
  onTyping: () => void;
  /** "Criar enquete" no menu "+" (só para quem pode). */
  onCreatePoll?: () => void;
}) {
  const [text, setText] = useState("");
  const uploads = useUploads(onUpload);
  useEffect(() => {
    const onMention = (event: Event) => {
      const username = (event as CustomEvent<string>).detail;
      setText((current) => `${current}${current && !current.endsWith(" ") ? " " : ""}@${username} `);
      requestAnimationFrame(() => {
        const input = inputRef.current;
        if (!input) return;
        input.focus();
        input.setSelectionRange(input.value.length, input.value.length);
      });
    };
    window.addEventListener(MENTION_EVENT, onMention);
    return () => window.removeEventListener(MENTION_EVENT, onMention);
  }, [inputRef]);
  const fileInputRef = useRef<HTMLInputElement>(null);
  addFilesRef.current = uploads.add;
  const [caret, setCaret] = useState(0);
  const [sending, setSending] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [activeIndex, setActiveIndex] = useState(0);
  const [dismissed, setDismissed] = useState<string | null>(null);
  const listId = useId();
  const remaining = LIMITS.messageMax - text.length;

  // Sugestões do "@": somem com Esc até o que foi digitado mudar.
  const query = mentionQueryAt(text, caret);
  const queryKey = query ? `${query.start}:${query.query}` : null;
  const suggestions = query && queryKey !== dismissed ? filterMembers(members, query.query) : [];
  const open = suggestions.length > 0;
  const active = Math.min(activeIndex, Math.max(suggestions.length - 1, 0));
  useEffect(() => setActiveIndex(0), [queryKey]);

  useEffect(() => {
    const input = inputRef.current;
    if (!input) return;
    input.style.height = "auto";
    input.style.height = `${input.scrollHeight}px`;
  }, [text, inputRef]);

  const insertMention = (member: Member) => {
    if (!query) return;
    const before = `${text.slice(0, query.start)}@${member.user.username} `;
    const next = before + text.slice(caret);
    setText(next);
    setCaret(before.length);
    requestAnimationFrame(() => {
      inputRef.current?.focus();
      inputRef.current?.setSelectionRange(before.length, before.length);
    });
  };

  const submit = async (event?: FormEvent) => {
    event?.preventDefault();
    const typed = text.trim();
    if ((!typed && uploads.readyIds.length === 0) || sending) return;
    if (uploads.uploading) {
      setError("Espere os arquivos terminarem de subir.");
      return;
    }
    if (uploads.failed) {
      setError("Tire da fila os arquivos com erro antes de enviar.");
      return;
    }
    setSending(true);
    setError(null);
    setText("");
    try {
      await onSend(typed ? encodeMentions(typed, users) : "", replyingTo?.id ?? null, uploads.readyIds);
      uploads.clear();
      onCancelReply();
    } catch (caught) {
      setText(typed); // devolve o texto para não perder o que foi escrito
      setError(errorText(caught));
    } finally {
      setSending(false);
      inputRef.current?.focus();
    }
  };

  const onKeyDown = (event: KeyboardEvent<HTMLTextAreaElement>) => {
    if (open) {
      if (event.key === "ArrowDown" || event.key === "ArrowUp") {
        event.preventDefault();
        const step = event.key === "ArrowDown" ? 1 : -1;
        setActiveIndex((active + step + suggestions.length) % suggestions.length);
        return;
      }
      if ((event.key === "Enter" || event.key === "Tab") && !event.shiftKey) {
        event.preventDefault();
        insertMention(suggestions[active]!);
        return;
      }
      if (event.key === "Escape") {
        event.preventDefault();
        setDismissed(queryKey);
        return;
      }
    }
    if (event.key === "Escape" && replyingTo) {
      event.preventDefault();
      onCancelReply();
      return;
    }
    if (event.key === "Enter" && !event.shiftKey && !event.nativeEvent.isComposing) {
      event.preventDefault();
      void submit();
    }
  };

  const trackCaret = (target: HTMLTextAreaElement) => setCaret(target.selectionStart ?? target.value.length);

  return (
    <form className="composer" onSubmit={submit}>
      {error && (
        <p className="form-error composer__error" role="alert">
          {error}
        </p>
      )}
      {open && (
        <ul id={listId} className="mention-suggestions" role="listbox" aria-label="Mencionar alguém">
          {suggestions.map((member, index) => (
            <li
              key={member.user.id}
              id={`${listId}-${member.user.id}`}
              role="option"
              aria-selected={index === active}
              className="mention-suggestions__item"
              // mousedown: escolhe sem tirar o foco do campo
              onMouseDown={(event) => {
                event.preventDefault();
                insertMention(member);
              }}
            >
              <Avatar user={member.user} size="sm" />
              <span className="mention-suggestions__name">{member.user.displayName}</span>
              <span className="mention-suggestions__username">@{member.user.username}</span>
            </li>
          ))}
        </ul>
      )}
      {replyingTo && (
        <div className="composer__reply">
          <span className="composer__reply-text">
            Respondendo a <strong>{replyingTo.author.displayName}</strong>
          </span>
          <button type="button" className="icon-button icon-button--small" aria-label="Cancelar resposta (Esc)" title="Cancelar resposta" onClick={onCancelReply}>
            <X {...ICON_SM} />
          </button>
        </div>
      )}
      <UploadQueue items={uploads.items} notice={uploads.notice} onRemove={uploads.remove} />
      <div className={replyingTo ? "composer__box composer__box--replying" : "composer__box"}>
        <input
          ref={fileInputRef}
          type="file"
          multiple
          className="sr-only"
          tabIndex={-1}
          aria-hidden="true"
          onChange={(event) => {
            uploads.add([...(event.target.files ?? [])]);
            event.target.value = "";
          }}
        />
        <ComposerMenu onAttach={() => fileInputRef.current?.click()} onCreatePoll={onCreatePoll} />
        <textarea
          id="composer-input"
          ref={inputRef}
          className="composer__input"
          rows={1}
          value={text}
          maxLength={LIMITS.messageMax}
          placeholder={replyingTo ? `Responder a ${replyingTo.author.displayName}` : placeTitle.startsWith("#") ? `Conversar em ${placeTitle}` : placeTitle.startsWith("chat de ") ? `Conversar no ${placeTitle}` : `Mensagem para ${placeTitle}`}
          aria-label={replyingTo ? `Resposta a ${replyingTo.author.displayName} em ${channelName}` : `Mensagem em ${channelName}`}
          aria-autocomplete="list"
          aria-expanded={open}
          aria-controls={open ? listId : undefined}
          aria-activedescendant={open ? `${listId}-${suggestions[active]!.user.id}` : undefined}
          onChange={(event) => {
            setText(event.target.value);
            trackCaret(event.target);
            if (event.target.value.trim()) onTyping();
          }}
          onSelect={(event) => trackCaret(event.currentTarget)}
          onKeyDown={onKeyDown}
          onPaste={(event) => {
            // print ou arquivo copiado: vai para a fila (texto colado continua normal)
            const files = [...event.clipboardData.files];
            if (files.length === 0) return;
            event.preventDefault();
            uploads.add(files);
          }}
        />
        {remaining <= 200 && (
          <span className="composer__counter" aria-live="polite">
            {remaining}
          </span>
        )}
        <button type="submit" className="icon-button send-button" aria-label="Enviar mensagem" disabled={sending || uploads.uploading || (text.trim().length === 0 && uploads.readyIds.length === 0)}>
          <SendHorizontal {...ICON} />
        </button>
      </div>
    </form>
  );
}

/**
 * Menu do "+" do campo de mensagem: só o que funciona de verdade (docs/14-menu-mais.md).
 * Arrastar e Ctrl+V continuam enviando arquivos sem abrir o menu.
 */
function ComposerMenu({ onAttach, onCreatePoll }: { onAttach: () => void; onCreatePoll?: () => void }) {
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
  const onKeyDown = (event: KeyboardEvent<HTMLDivElement>) => {
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
    <div className="composer-menu composer__attach" ref={rootRef}>
      <button
        ref={triggerRef}
        type="button"
        className="icon-button"
        aria-label="Mais opções: enviar arquivo e outras"
        title="Enviar arquivo e mais (arrastar e Ctrl+V também enviam arquivos)"
        aria-haspopup="menu"
        aria-expanded={open}
        onClick={() => setOpen((v) => !v)}
      >
        <Plus {...ICON} />
      </button>
      {open && (
        <div className="composer-menu__list" role="menu" aria-label="Mais opções" onKeyDown={onKeyDown}>
          <button type="button" role="menuitem" className="user-menu__item" onClick={() => choose(onAttach)}>
            <Upload {...ICON_SM} />
            <span className="user-menu__label">Enviar um arquivo</span>
          </button>
          {onCreatePoll && (
            <button type="button" role="menuitem" className="user-menu__item" onClick={() => choose(onCreatePoll)}>
              <ListChecks {...ICON_SM} />
              <span className="user-menu__label">Criar enquete</span>
            </button>
          )}
        </div>
      )}
    </div>
  );
}
