import { useEffect, useRef, useState } from "react";
import { ImagePlus } from "lucide-react";
import { prepareAvatar, prepareBanner } from "../avatar-image";
import { initials } from "../messages";
import { ICON_SM } from "./shell";

/**
 * Escolher a imagem do servidor: corta o quadrado do centro e reduz para 256 px no próprio app.
 * `current` = endereço da imagem atual (ou nada); `onPick` recebe a imagem pronta (ou `null` = tirar).
 */
export function GuildIconPicker({
  name,
  current,
  disabled,
  onPick,
}: {
  name: string;
  current: string | null;
  disabled?: boolean;
  onPick: (image: Blob | null) => void | Promise<void>;
}) {
  const inputRef = useRef<HTMLInputElement>(null);
  const [preview, setPreview] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);
  useEffect(() => () => void (preview && URL.revokeObjectURL(preview)), [preview]);
  const shown = preview ?? current;
  return (
    <div className="guild-icon-picker">
      <button
        type="button"
        className="guild-icon-picker__tile"
        aria-label={shown ? "Trocar a imagem do servidor" : "Escolher uma imagem para o servidor"}
        disabled={disabled}
        onClick={() => inputRef.current?.click()}
      >
        {shown ? <img src={shown} alt="" /> : <span aria-hidden="true">{initials(name || "?")}</span>}
        <span className="guild-icon-picker__badge" aria-hidden="true">
          <ImagePlus {...ICON_SM} />
        </span>
      </button>
      <div className="guild-icon-picker__text">
        <span className="guild-icon-picker__hint">PNG, JPEG, WebP ou GIF. Fica quadrada, cortada pelo centro.</span>
        {shown && !disabled && (
          <button
            type="button"
            className="link-button"
            onClick={() => {
              setPreview(null);
              void onPick(null);
            }}
          >
            Tirar imagem
          </button>
        )}
        {error && (
          <span className="form-error" role="alert">
            {error}
          </span>
        )}
      </div>
      <input
        ref={inputRef}
        type="file"
        accept="image/png,image/jpeg,image/webp,image/gif"
        className="sr-only"
        tabIndex={-1}
        aria-hidden="true"
        onChange={async (event) => {
          const file = event.target.files?.[0];
          event.target.value = "";
          if (!file) return;
          setError(null);
          try {
            const blob = await prepareAvatar(file);
            setPreview(URL.createObjectURL(blob));
            await onPick(blob);
          } catch (caught) {
            setPreview(null);
            setError(caught instanceof Error ? caught.message : "Não deu para usar essa imagem.");
          }
        }}
      />
    </div>
  );
}

/** Escolher a capa do servidor (16:9). */
export function GuildBannerPicker({ current, disabled, onPick }: { current: string | null; disabled?: boolean; onPick: (image: Blob | null) => Promise<void> }) {
  const inputRef = useRef<HTMLInputElement>(null);
  const [preview, setPreview] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);
  useEffect(() => () => void (preview && URL.revokeObjectURL(preview)), [preview]);
  const shown = preview ?? current;
  return (
    <div className="guild-banner-picker">
      <button
        type="button"
        className="guild-banner-picker__frame"
        aria-label={shown ? "Trocar a capa do servidor" : "Escolher uma capa para o servidor"}
        disabled={disabled}
        onClick={() => inputRef.current?.click()}
      >
        {shown ? <img src={shown} alt="" /> : <span className="guild-banner-picker__empty">Sem capa</span>}
        {!disabled && (
          <span className="guild-banner-picker__cta">
            <ImagePlus {...ICON_SM} />
            {shown ? "Trocar capa" : "Escolher capa"}
          </span>
        )}
      </button>
      <span className="guild-icon-picker__hint">Fica no formato 16:9 (cortada pelo centro). Boa medida: 960 × 540.</span>
      {shown && !disabled && (
        <button
          type="button"
          className="link-button"
          onClick={() => {
            setPreview(null);
            void onPick(null);
          }}
        >
          Tirar capa
        </button>
      )}
      {error && (
        <span className="form-error" role="alert">
          {error}
        </span>
      )}
      <input
        ref={inputRef}
        type="file"
        accept="image/png,image/jpeg,image/webp,image/gif"
        className="sr-only"
        tabIndex={-1}
        aria-hidden="true"
        onChange={async (event) => {
          const file = event.target.files?.[0];
          event.target.value = "";
          if (!file) return;
          setError(null);
          try {
            const blob = await prepareBanner(file);
            setPreview(URL.createObjectURL(blob));
            await onPick(blob);
          } catch (caught) {
            setPreview(null);
            setError(caught instanceof Error ? caught.message : "Não deu para usar essa imagem.");
          }
        }}
      />
    </div>
  );
}
