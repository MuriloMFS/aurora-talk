import { Hash, Paperclip, Volume2, X } from "lucide-react";
import type { Channel, Id, Message } from "@aurora/schema";
import { highlightParts } from "../search-query";
import { Avatar, ICON, ICON_SM } from "./shell";

export interface SearchView {
  /** O que a pessoa digitou (com os filtros). */
  query: string;
  /** Só o texto livre (para destacar). */
  text: string;
  problems: string[];
  loading: boolean;
  error: string | null;
  total: number;
  messages: Message[];
}

const dateFormat = new Intl.DateTimeFormat("pt-BR", { day: "2-digit", month: "2-digit", year: "numeric", hour: "2-digit", minute: "2-digit" });
const EXCERPT_MAX = 280;

/** Resultados da busca de mensagens (no lugar da lista de membros). Clicar leva até a mensagem. */
export function SearchPanel({
  view,
  channelsById,
  showChannel,
  onJump,
  onMore,
  onClose,
}: {
  view: SearchView;
  channelsById: Readonly<Record<Id, Channel>>;
  /** Mostrar o canal de cada resultado (busca no servidor inteiro). */
  showChannel: boolean;
  onJump: (message: Message) => void;
  onMore: () => void;
  onClose: () => void;
}) {
  const count =
    view.loading && view.messages.length === 0
      ? "Buscando…"
      : view.total === 0
        ? "Nenhum resultado"
        : view.total >= 1000
          ? "Mais de 1.000 resultados"
          : view.total === 1
            ? "1 resultado"
            : `${view.total.toLocaleString("pt-BR")} resultados`;
  return (
    <aside className="members search-panel" aria-label="Resultados da busca">
      <header className="search-panel__header">
        <div className="search-panel__heading">
          <h2 className="search-panel__title" aria-live="polite">
            {count}
          </h2>
          <p className="search-panel__query">{view.query}</p>
        </div>
        <button type="button" className="icon-button" aria-label="Fechar a busca" title="Fechar a busca" onClick={onClose}>
          <X {...ICON} />
        </button>
      </header>

      {view.problems.length > 0 && (
        <ul className="search-panel__problems" role="alert">
          {view.problems.map((p) => (
            <li key={p}>{p}</li>
          ))}
        </ul>
      )}
      {view.error && (
        <p className="form-error" role="alert">
          {view.error}
        </p>
      )}
      {!view.loading && !view.error && view.total === 0 && view.problems.length === 0 && (
        <p className="search-panel__empty">Nada encontrado. Tente outra palavra ou tire um filtro.</p>
      )}

      <ol className="search-panel__list">
        {view.messages.map((message) => {
          const channel = channelsById[message.channelId];
          const files = message.attachments ?? [];
          const content = message.content.length > EXCERPT_MAX ? `${message.content.slice(0, EXCERPT_MAX - 1)}…` : message.content;
          return (
            <li key={message.id}>
              <button type="button" className="search-result" onClick={() => onJump(message)} aria-label={`Ir até a mensagem de ${message.author.displayName}`}>
                {showChannel && channel && (
                  <span className="search-result__channel">
                    {channel.type === "voice" ? <Volume2 {...ICON_SM} /> : <Hash {...ICON_SM} />}
                    {channel.name}
                  </span>
                )}
                <span className="search-result__head">
                  <Avatar user={message.author} size="sm" />
                  <span className="search-result__author">{message.author.displayName}</span>
                  <time className="search-result__time" dateTime={new Date(message.createdAt).toISOString()}>
                    {dateFormat.format(message.createdAt)}
                  </time>
                </span>
                {content && (
                  <span className="search-result__content">
                    {highlightParts(content, view.text).map((part, i) => (part.hit ? <mark key={i}>{part.text}</mark> : <span key={i}>{part.text}</span>))}
                  </span>
                )}
                {files.length > 0 && (
                  <span className="search-result__files">
                    <Paperclip {...ICON_SM} />
                    {files.length === 1 ? files[0]!.filename : `${files.length} anexos`}
                  </span>
                )}
              </button>
            </li>
          );
        })}
      </ol>
      {view.messages.length > 0 && view.messages.length < Math.min(view.total, 1000) && (
        <button type="button" className="button button--secondary button--block" onClick={onMore} disabled={view.loading}>
          {view.loading ? "Carregando…" : "Mais resultados"}
        </button>
      )}
    </aside>
  );
}
