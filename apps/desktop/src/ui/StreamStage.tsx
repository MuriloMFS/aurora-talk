import { useEffect, useRef } from "react";
import { ArrowLeft, Maximize, Tv } from "lucide-react";
import type { Id, Member } from "@aurora/schema";
import type { ScreenShare } from "@aurora/platform";
import { CenterState, ICON } from "./shell";

/** Palco de transmissões da sala de voz: substitui o chat enquanto a pessoa assiste. */
export function StreamStage({
  channelName,
  shares,
  membersById,
  onBack,
}: {
  channelName: string;
  shares: ScreenShare[];
  membersById: Readonly<Record<Id, Member>>;
  onBack: () => void;
}) {
  return (
    <main className="chat stage" aria-labelledby="stage-title">
      <header className="chat__header">
        <button type="button" className="icon-button" aria-label="Voltar ao chat" title="Voltar ao chat" onClick={onBack}>
          <ArrowLeft {...ICON} />
        </button>
        <Tv {...ICON} className="chat__icon" />
        <h2 id="stage-title" className="chat__title">
          Transmissões · {channelName}
        </h2>
      </header>
      {shares.length === 0 ? (
        <div className="stage__empty">
          <CenterState title="Ninguém está transmitindo agora" text="Quando alguém compartilhar a tela nesta sala, ela aparece aqui." />
        </div>
      ) : (
        <div className="stage__grid">
          {shares.map((share) => (
            <StreamTile key={`${share.identity}${share.local ? ":eu" : ""}`} share={share} name={membersById[share.identity]?.user.displayName ?? "Alguém"} />
          ))}
        </div>
      )}
    </main>
  );
}

function StreamTile({ share, name }: { share: ScreenShare; name: string }) {
  const videoRef = useRef<HTMLVideoElement>(null);
  useEffect(() => {
    const video = videoRef.current;
    return video ? share.attach(video) : undefined;
  }, [share]);

  const label = share.local ? `Sua tela (${name})` : `Tela de ${name}`;
  return (
    <figure className="stream-tile">
      {/* o som da transmissão toca pelos elementos de áudio da sala; o vídeo fica mudo */}
      <video ref={videoRef} className="stream-tile__video" autoPlay playsInline muted aria-label={label} />
      <figcaption className="stream-tile__caption">
        <span className="live-pill">AO VIVO</span>
        {label}
      </figcaption>
      <button
        type="button"
        className="icon-button stream-tile__fullscreen"
        aria-label={`Tela cheia: ${label}`}
        title="Tela cheia"
        onClick={() => void videoRef.current?.requestFullscreen()}
      >
        <Maximize {...ICON} />
      </button>
    </figure>
  );
}
