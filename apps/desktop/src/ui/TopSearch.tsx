import { useEffect, useId, useRef, useState, type KeyboardEvent } from "react";
import { MessageSquare, Search, Users, X } from "lucide-react";
import type { Member, User } from "@aurora/schema";
import { SEARCH_HINTS } from "../search-query";
import { MemberSearch } from "./MemberSearch";
import { ICON_SM } from "./shell";

type Mode = "messages" | "people";

/**
 * Busca da barra do topo: mensagens (abre o painel de resultados) ou pessoas (abre o menu da pessoa).
 * Sem `onPickUser` (conversa a dois), só mensagens.
 */
export function TopSearch({
  members,
  placeName,
  onPickUser,
  onSearch,
  activeQuery,
}: {
  members: Member[];
  /** "Turma do sábado", "o grupo", "a conversa". */
  placeName: string;
  onPickUser?: (user: User, at: { x: number; y: number }) => void;
  onSearch: (text: string) => void;
  /** Busca aberta no painel (o campo mostra o que foi buscado). */
  activeQuery: string | null;
}) {
  const [mode, setMode] = useState<Mode>("messages");
  const canPeople = Boolean(onPickUser);
  const current: Mode = canPeople ? mode : "messages";
  return (
    <div className="top-search">
      {canPeople && (
        <button
          type="button"
          className="top-search__mode"
          aria-label={current === "messages" ? "Buscando mensagens. Trocar para pessoas" : "Buscando pessoas. Trocar para mensagens"}
          title={current === "messages" ? "Buscar pessoas" : "Buscar mensagens"}
          onClick={() => setMode(current === "messages" ? "people" : "messages")}
        >
          {current === "messages" ? <MessageSquare {...ICON_SM} /> : <Users {...ICON_SM} />}
        </button>
      )}
      {current === "people" && onPickUser ? (
        <MemberSearch members={members} placeholder={`Buscar pessoas em ${placeName}`} onPick={onPickUser} />
      ) : (
        <MessageSearchField placeholder={`Buscar mensagens em ${placeName}`} onSearch={onSearch} activeQuery={activeQuery} />
      )}
    </div>
  );
}

function MessageSearchField({ placeholder, onSearch, activeQuery }: { placeholder: string; onSearch: (text: string) => void; activeQuery: string | null }) {
  const [text, setText] = useState(activeQuery ?? "");
  const [open, setOpen] = useState(false);
  const inputRef = useRef<HTMLInputElement>(null);
  const listId = useId();
  // o painel foi fechado: o campo esvazia
  useEffect(() => {
    if (activeQuery === null) setText("");
  }, [activeQuery]);

  const submit = () => {
    if (!text.trim()) return;
    setOpen(false);
    onSearch(text.trim());
  };
  const addFilter = (filter: string) => {
    const next = text && !text.endsWith(" ") ? `${text} ${filter}` : `${text}${filter}`;
    setText(next);
    inputRef.current?.focus();
  };
  const onKeyDown = (event: KeyboardEvent<HTMLInputElement>) => {
    if (event.key === "Enter") {
      event.preventDefault();
      submit();
    } else if (event.key === "Escape") {
      event.preventDefault();
      event.stopPropagation();
      setOpen(false);
    }
  };

  return (
    <div className="member-search">
      <Search {...ICON_SM} className="member-search__icon" />
      <input
        ref={inputRef}
        className="member-search__input"
        type="search"
        value={text}
        placeholder={placeholder}
        aria-label={placeholder}
        aria-describedby={listId}
        enterKeyHint="search"
        onChange={(e) => setText(e.target.value)}
        onFocus={() => setOpen(true)}
        onBlur={() => setTimeout(() => setOpen(false), 150)}
        onKeyDown={onKeyDown}
      />
      {text && (
        <button type="button" className="member-search__clear" aria-label="Limpar busca" onMouseDown={(e) => e.preventDefault()} onClick={() => setText("")}>
          <X {...ICON_SM} />
        </button>
      )}
      {open && (
        <div id={listId} className="member-search__results search-hints">
          <p className="search-hints__title">Filtros</p>
          <ul className="search-hints__list">
            {SEARCH_HINTS.map((hint) => (
              <li key={hint.filter}>
                <button type="button" className="search-hints__item" onMouseDown={(e) => e.preventDefault()} onClick={() => addFilter(hint.filter)}>
                  <code className="search-hints__filter">{hint.filter}</code>
                  <span>{hint.label}</span>
                </button>
              </li>
            ))}
          </ul>
          <p className="search-hints__tip">Enter busca. Ex.: mapa de:@ana tem:imagem</p>
        </div>
      )}
    </div>
  );
}
