import { useCallback, useEffect, useId, useLayoutEffect, useMemo, useRef, useState, type FormEvent, type KeyboardEvent, type ReactNode, type RefObject } from "react";
import { ArrowDown, CornerUpRight, FaceSlightlySmilingPlus, Hash, Menu, Pencil, Reply, SendHorizontal, Trash, Users, WifiOff, X } from "lucide-react";
import { LIMITS, type Channel, type Id, type Member, type Message, type User } from "@aurora/schema";
import { ApiError } from "../net/api";
import type { ConnectionStatus } from "../net/gateway";
import type { ChannelMessages } from "../state/chat-store";
import { formatTime, groupMessages, typingText } from "../messages";
import { plainText } from "../markdown";
import { decodeMentions, encodeMentions, filterMembers, mentionQueryAt } from "../mentions";
import { EmojiPicker } from "./EmojiPicker";
import { MessageContent } from "./MessageContent";
import { Avatar, ICON, ICON_SM } from "./shell";

const errorText = (error: unknown) => (error instanceof ApiError ? error.message : "Algo deu errado. Tente de novo.");
const BOTTOM_THRESHOLD_PX = 64;
const FLASH_MS = 1600;

interface ChatPaneProps {
  channel: Channel;
  bucket: ChannelMessages | undefined;
  historyError: string | null;
  me: User;
  isOwner: boolean;
  typingNames: string[];
  status: ConnectionStatus;
  membersOpen: boolean;
  /** Membros do servidor: nomes das menções e sugestões do "@". */
  membersById: Readonly<Record<Id, Member>>;
  onToggleMembers: () => void;
  onOpenDrawer: () => void;
  onRetryHistory: () => void;
  onLoadOlder: () => Promise<void>;
  /** `content` já com as menções em `<@id>`. */
  onSend: (content: string, replyToId: Id | null) => Promise<void>;
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
}

/** O que as mensagens precisam saber sobre pessoas e ações (evita repassar 10 props). */
interface MessageContext {
  me: User;
  isOwner: boolean;
  users: User[];
  usersById: Readonly<Record<Id, User>>;
  nameOf: (userId: Id) => string | null;
  onEdit: (id: Id, content: string) => Promise<void>;
  onDelete: (id: Id) => Promise<void>;
  onReact: (message: Message, emoji: string) => void;
  onReply: (message: Message) => void;
  onJumpTo: (messageId: Id) => void;
  onOpenLink: (url: string) => void;
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

  const items = bucket?.items ?? [];
  const rows = groupMessages(items);
  const last = items.at(-1);

  const members = useMemo(() => Object.values(membersById), [membersById]);
  const users = useMemo(() => members.map((m) => m.user), [members]);
  const usersById = useMemo(() => Object.fromEntries(users.map((u) => [u.id, u])), [users]);
  const nameOf = useCallback((userId: Id) => membersById[userId]?.user.displayName ?? null, [membersById]);

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
    isOwner: props.isOwner,
    users,
    usersById,
    nameOf,
    onEdit: props.onEdit,
    onDelete: props.onDelete,
    onReact: props.onReact,
    onOpenLink: props.onOpenLink,
    onReply: (message) => {
      setReplyingTo(message);
      composerRef.current?.focus();
    },
    // Vai até a mensagem original (se estiver carregada) e a destaca por um instante.
    onJumpTo: (messageId) => {
      const element = document.getElementById(`message-${messageId}`);
      if (!element) return;
      element.scrollIntoView({ block: "center" });
      setFlashId(messageId);
      window.setTimeout(() => setFlashId((current) => (current === messageId ? null : current)), FLASH_MS);
    },
  };

  return (
    <main className="chat" aria-labelledby="chat-title">
      <header className="chat__header">
        <button type="button" className="icon-button chat__menu" aria-label="Abrir canais" onClick={props.onOpenDrawer}>
          <Menu {...ICON} />
        </button>
        <Hash {...ICON} className="chat__icon" />
        <h2 id="chat-title" className="chat__title">
          {channel.name}
        </h2>
        <div className="chat__tools">
          {props.headerExtra}
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
                  <Hash size={32} strokeWidth={1.75} />
                </div>
                <h3 className="empty__title">Este é o começo de #{channel.name}</h3>
                <p className="empty__text">{items.length === 0 ? "Ainda não há mensagens aqui. Escreva a primeira." : "Não há mensagens mais antigas."}</p>
              </div>
            )}
            {rows.map(({ message, startsGroup }) => (
              <MessageItem key={message.id} message={message} startsGroup={startsGroup} flash={flashId === message.id} ctx={context} />
            ))}
          </>
        )}
      </div>

      {showJump && (
        <button type="button" className="jump-latest" onClick={scrollToBottom}>
          <ArrowDown {...ICON_SM} />
          Ir para as mensagens novas
        </button>
      )}

      <Composer
        inputRef={composerRef}
        channelName={channel.name}
        members={members}
        users={users}
        replyingTo={replyingTo}
        onCancelReply={() => setReplyingTo(null)}
        onSend={props.onSend}
        onTyping={props.onTyping}
      />
      <div className="typing" aria-live="polite">
        {typingText(props.typingNames)}
      </div>
    </main>
  );
}

/* ---------------- mensagem ---------------- */

function MessageItem({ message, startsGroup, flash, ctx }: { message: Message; startsGroup: boolean; flash: boolean; ctx: MessageContext }) {
  const mine = message.author.id === ctx.me.id;
  const canDelete = mine || ctx.isOwner;
  const mentionsMe = !mine && message.mentions.includes(ctx.me.id);
  const [editing, setEditing] = useState(false);
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
              <span className="message__reply-text">{plainText(reply.content ?? "", (id) => ctx.nameOf(id) ?? "alguém")}</span>
            </>
          ) : (
            <span className="message__reply-text message__reply-text--deleted">Mensagem original apagada</span>
          )}
        </button>
      )}
      <span className="message__gutter">
        {startsGroup ? <Avatar user={message.author} size="lg" /> : <time className="message__hover-time">{time}</time>}
      </span>
      <div className="message__body">
        {startsGroup && (
          <header className="message__header">
            <span className="message__author">{message.author.displayName}</span>
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
        ) : (
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
                  aria-label={`${reaction.emoji}: ${count} ${count === 1 ? "reação" : "reações"} (${names})${reacted ? ". Clique para tirar a sua" : ". Clique para reagir também"}`}
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
          <button type="button" className="icon-button icon-button--small" aria-label="Responder" title="Responder" onClick={() => ctx.onReply(message)}>
            <Reply {...ICON_SM} />
          </button>
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
  members,
  users,
  replyingTo,
  onCancelReply,
  onSend,
  onTyping,
}: {
  inputRef: RefObject<HTMLTextAreaElement | null>;
  channelName: string;
  members: Member[];
  users: User[];
  replyingTo: Message | null;
  onCancelReply: () => void;
  onSend: (content: string, replyToId: Id | null) => Promise<void>;
  onTyping: () => void;
}) {
  const [text, setText] = useState("");
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
    if (!typed || sending) return;
    setSending(true);
    setError(null);
    setText("");
    try {
      await onSend(encodeMentions(typed, users), replyingTo?.id ?? null);
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
      <div className={replyingTo ? "composer__box composer__box--replying" : "composer__box"}>
        <textarea
          id="composer-input"
          ref={inputRef}
          className="composer__input"
          rows={1}
          value={text}
          maxLength={LIMITS.messageMax}
          placeholder={replyingTo ? `Responder a ${replyingTo.author.displayName}` : `Conversar em #${channelName}`}
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
        />
        {remaining <= 200 && (
          <span className="composer__counter" aria-live="polite">
            {remaining}
          </span>
        )}
        <button type="submit" className="icon-button send-button" aria-label="Enviar mensagem" disabled={sending || text.trim().length === 0}>
          <SendHorizontal {...ICON} />
        </button>
      </div>
    </form>
  );
}
