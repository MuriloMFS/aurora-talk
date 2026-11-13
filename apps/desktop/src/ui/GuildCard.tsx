import type { Member } from "@aurora/schema";
import { fileUrl } from "../avatar-image";
import { initials } from "../messages";
import type { GuildEntry } from "../state/chat-store";

const since = (ms: number) => new Date(ms).toLocaleDateString("pt-BR", { month: "short", year: "numeric" }).replace(".", "");

/** Cartão do servidor: capa, imagem, nome, quantos online e membros, desde quando existe. */
export function GuildCard({ guild, members }: { guild: GuildEntry; members: readonly Member[] }) {
  const online = members.filter((m) => m.online).length;
  return (
    <div className="guild-card">
      <div className="guild-card__banner">{guild.banner && <img src={fileUrl(guild.banner)} alt="" />}</div>
      <div className="guild-card__body">
        <span className="guild-card__icon">{guild.icon ? <img src={fileUrl(guild.icon)} alt="" /> : <span aria-hidden="true">{initials(guild.name)}</span>}</span>
        <strong className="guild-card__name">{guild.name}</strong>
        <span className="guild-card__stats">
          <span className="guild-card__stat">
            <span className="presence presence--online guild-card__dot" aria-hidden="true" />
            {online === 1 ? "1 online" : `${online} online`}
          </span>
          <span className="guild-card__stat">
            <span className="presence presence--offline guild-card__dot" aria-hidden="true" />
            {members.length === 1 ? "1 membro" : `${members.length} membros`}
          </span>
        </span>
        {guild.createdAt && <span className="guild-card__since">Desde {since(guild.createdAt)}</span>}
      </div>
    </div>
  );
}
