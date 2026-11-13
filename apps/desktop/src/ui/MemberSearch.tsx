import { useId, useRef, useState, type KeyboardEvent } from "react";
import { Search, X } from "lucide-react";
import type { Member, User } from "@aurora/schema";
import { filterMembers } from "../mentions";
import { Avatar, ICON_SM } from "./shell";

/**
 * Busca de pessoas na barra do topo: pelo nome ou pelo @usuário. Escolher abre o menu da pessoa
 * (perfil, mensagem, amizade, cargos, moderação).
 */
export function MemberSearch({ members, placeholder, onPick }: { members: Member[]; placeholder: string; onPick: (user: User, at: { x: number; y: number }) => void }) {
  const [query, setQuery] = useState("");
  const [active, setActive] = useState(0);
  const [open, setOpen] = useState(false);
  const inputRef = useRef<HTMLInputElement>(null);
  const listId = useId();
  const results = query.trim() ? filterMembers(members, query.trim().replace(/^@/, ""), 8) : [];
  const shown = open && query.trim().length > 0;
  const current = Math.min(active, Math.max(results.length - 1, 0));

  const pick = (member: Member) => {
    const r = inputRef.current?.getBoundingClientRect();
    onPick(member.user, { x: r ? r.left : 0, y: r ? r.bottom + 8 : 0 });
    setQuery("");
    setOpen(false);
  };
  const onKeyDown = (event: KeyboardEvent<HTMLInputElement>) => {
    if (event.key === "ArrowDown" || event.key === "ArrowUp") {
      event.preventDefault();
      if (results.length) setActive((current + (event.key === "ArrowDown" ? 1 : -1) + results.length) % results.length);
    } else if (event.key === "Enter" && results[current]) {
      event.preventDefault();
      pick(results[current]!);
    } else if (event.key === "Escape") {
      event.preventDefault();
      event.stopPropagation();
      setQuery("");
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
        value={query}
        placeholder={placeholder}
        aria-label={placeholder}
        role="combobox"
        aria-expanded={shown}
        aria-controls={listId}
        aria-autocomplete="list"
        aria-activedescendant={shown && results[current] ? `${listId}-${results[current]!.user.id}` : undefined}
        onChange={(e) => {
          setQuery(e.target.value);
          setActive(0);
          setOpen(true);
        }}
        onFocus={() => setOpen(true)}
        onBlur={() => setTimeout(() => setOpen(false), 120)}
        onKeyDown={onKeyDown}
      />
      {query && (
        <button type="button" className="member-search__clear" aria-label="Limpar busca" onMouseDown={(e) => e.preventDefault()} onClick={() => setQuery("")}>
          <X {...ICON_SM} />
        </button>
      )}
      {shown && (
        <ul id={listId} className="member-search__results" role="listbox" aria-label="Pessoas encontradas">
          {results.length === 0 ? (
            <li className="member-search__empty" role="option" aria-selected="false" aria-disabled="true">
              Ninguém com esse nome aqui.
            </li>
          ) : (
            results.map((member, index) => (
              <li
                key={member.user.id}
                id={`${listId}-${member.user.id}`}
                role="option"
                aria-selected={index === current}
                className="member-search__item"
                onMouseDown={(e) => {
                  e.preventDefault();
                  pick(member);
                }}
              >
                <Avatar user={member.user} size="sm" status={member.status} online={member.online} />
                <span className="member-search__name">{member.user.displayName}</span>
                <span className="member-search__username">@{member.user.username}</span>
              </li>
            ))
          )}
        </ul>
      )}
    </div>
  );
}
