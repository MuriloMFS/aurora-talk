import { useId, useState, type FormEvent } from "react";
import { AppWindow, Monitor, Volume2, VolumeX } from "lucide-react";
import {
  DEFAULT_SCREEN_SHARE_OPTIONS,
  SCREEN_SHARE_PROFILES,
  canExcludeOwnAudio,
  classifyScreenShareError,
  type PlatformInfo,
  type ScreenShareOptions,
  type ScreenShareQuality,
  type ScreenShareResult,
  type ScreenShareSurface,
} from "@aurora/platform";
import { Modal } from "./Modal";

const STORAGE_KEY = "aurora.screenShare";

const SURFACES: { value: ScreenShareSurface; title: string; hint: string; Icon: typeof Monitor }[] = [
  { value: "monitor", title: "Tela inteira", hint: "Tudo o que aparece no seu monitor", Icon: Monitor },
  { value: "window", title: "Uma janela", hint: "Só um app, como um jogo ou o navegador", Icon: AppWindow },
];

const QUALITIES: { value: ScreenShareQuality; title: string; hint: string }[] = [
  { value: "light", title: "Leve", hint: "Para internet mais fraca" },
  { value: "standard", title: "Padrão", hint: "Texto nítido. Recomendado" },
  { value: "smooth", title: "Fluida", hint: "Jogos e vídeos. Usa mais rede" },
];

const spec = (quality: ScreenShareQuality) => {
  const profile = SCREEN_SHARE_PROFILES[quality];
  return `${profile.height}p · ${profile.frameRate} fps`;
};

/** Última escolha da pessoa (só conveniência local; falhar aqui não pode quebrar nada). */
export function loadScreenShareOptions(): ScreenShareOptions {
  try {
    const saved = JSON.parse(localStorage.getItem(STORAGE_KEY) ?? "null") as Partial<ScreenShareOptions> | null;
    const surface = SURFACES.some((s) => s.value === saved?.surface) ? saved!.surface! : DEFAULT_SCREEN_SHARE_OPTIONS.surface;
    const quality = QUALITIES.some((q) => q.value === saved?.quality) ? saved!.quality! : DEFAULT_SCREEN_SHARE_OPTIONS.quality;
    const systemAudio = typeof saved?.systemAudio === "boolean" ? saved.systemAudio : DEFAULT_SCREEN_SHARE_OPTIONS.systemAudio;
    return { surface, quality, systemAudio };
  } catch {
    return DEFAULT_SCREEN_SHARE_OPTIONS;
  }
}

function saveScreenShareOptions(options: ScreenShareOptions): void {
  try {
    localStorage.setItem(STORAGE_KEY, JSON.stringify(options));
  } catch {
    // armazenamento indisponível: só não lembra a escolha
  }
}

/** O que houve e o que fazer, em linguagem de gente. `null` = a pessoa só fechou o seletor. */
export function screenShareErrorMessage(error: unknown): string | null {
  const name = (error as { name?: unknown } | null)?.name;
  switch (classifyScreenShareError(error)) {
    case "cancelled":
      return null;
    case "audio":
      return "Não foi possível capturar o som do computador. Tente de novo com “Transmitir o som do computador” desligado.";
    case "busy":
      return "O Windows não conseguiu capturar essa tela agora. Tente de novo ou escolha uma janela.";
    case "blocked":
      return "O sistema bloqueou a captura de tela. Confira as permissões de captura do Windows e tente de novo.";
    case "unsupported":
      return "Este computador não permite compartilhar a tela pelo Aurora.";
    default:
      return `Não foi possível compartilhar a tela${typeof name === "string" && name !== "Error" ? ` (${name})` : ""}. Tente de novo.`;
  }
}

/** Explica o que acontece com o som, conforme a escolha e o que este app consegue fazer. */
export function audioHint(enabled: boolean, mode: PlatformInfo["systemAudio"], excludesOwnAudio: boolean): string {
  if (!enabled) return "Só a imagem. Ninguém ouve o som do seu computador.";
  if (mode === "native") return "Jogos, vídeos e música vão junto. As vozes da sala ficam de fora, sem eco.";
  return excludesOwnAudio
    ? "Ligue também o áudio do sistema na próxima etapa. As vozes da sala ficam de fora, sem eco."
    : "Ligue também o áudio do sistema na próxima etapa. Atenção: as vozes da sala vão junto e quem está nela ouve o próprio eco.";
}

export function ScreenShareDialog({
  systemAudioMode,
  onStart,
  onStarted,
  onClose,
}: {
  /** "native": o app instalado captura o som sozinho; "picker": depende do seletor do sistema. */
  systemAudioMode: PlatformInfo["systemAudio"];
  onStart: (options: ScreenShareOptions) => Promise<ScreenShareResult>;
  onStarted: (result: ScreenShareResult) => void;
  onClose: () => void;
}) {
  const [options, setOptions] = useState(loadScreenShareOptions);
  const [excludesOwnAudio] = useState(canExcludeOwnAudio);
  const audioHintId = useId();
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const submit = async (event: FormEvent) => {
    event.preventDefault();
    if (busy) return;
    setBusy(true);
    setError(null);
    saveScreenShareOptions(options);
    try {
      // Nada de await antes daqui: o seletor do sistema exige o clique "fresco" da pessoa.
      const result = await onStart(options);
      onStarted(result);
      onClose();
    } catch (caught) {
      const message = screenShareErrorMessage(caught);
      if (message) console.error("[aurora] compartilhar tela falhou", caught);
      setError(message);
      setBusy(false);
    }
  };

  return (
    <Modal
      size="md"
      title="Transmitir sua tela"
      description="Escolha o que mostrar e a qualidade. Depois, o Windows pede para você confirmar a tela ou a janela."
      onClose={onClose}
    >
      <form className="form" onSubmit={submit}>
        <fieldset className="choice-group">
          <legend className="field__label">O que mostrar</legend>
          <div className="share-surfaces">
            {SURFACES.map(({ value, title, hint, Icon }) => (
              <label key={value} className="share-surface">
                <input
                  type="radio"
                  name="share-surface"
                  className="sr-only"
                  value={value}
                  checked={options.surface === value}
                  onChange={() => setOptions((prev) => ({ ...prev, surface: value }))}
                />
                {/* ilustração geométrica: o contorno marca o que vai aparecer (as miniaturas reais vêm do sistema) */}
                <span className={`share-surface__preview share-surface__preview--${value}`} aria-hidden="true">
                  <span className="share-surface__frame">
                    <Icon size={24} strokeWidth={1.75} />
                  </span>
                </span>
                <span className="choice__title">{title}</span>
                <span className="choice__hint">{hint}</span>
              </label>
            ))}
          </div>
        </fieldset>

        <fieldset className="choice-group">
          <legend className="field__label">Qualidade</legend>
          <div className="share-qualities">
            {QUALITIES.map(({ value, title, hint }) => (
              <label key={value} className="choice share-quality">
                <input
                  type="radio"
                  name="share-quality"
                  value={value}
                  checked={options.quality === value}
                  onChange={() => setOptions((prev) => ({ ...prev, quality: value }))}
                />
                <span className="choice__text">
                  <span className="choice__title">
                    {title} <span className="share-quality__spec">{spec(value)}</span>
                  </span>
                  <span className="choice__hint">{hint}</span>
                </span>
              </label>
            ))}
          </div>
        </fieldset>

        <label className="switch-row">
          <span className="switch-row__icon" aria-hidden="true">
            {options.systemAudio ? <Volume2 size={20} strokeWidth={1.75} /> : <VolumeX size={20} strokeWidth={1.75} />}
          </span>
          <span className="choice__text">
            <span className="choice__title">Transmitir o som do computador</span>
            <span id={audioHintId} className="choice__hint">
              {audioHint(options.systemAudio, systemAudioMode, excludesOwnAudio)}
            </span>
          </span>
          <input
            type="checkbox"
            role="switch"
            className="switch"
            aria-describedby={audioHintId}
            checked={options.systemAudio}
            onChange={(event) => setOptions((prev) => ({ ...prev, systemAudio: event.target.checked }))}
          />
        </label>

        {error && (
          <p className="form-error" role="alert">
            {error}
          </p>
        )}
        <p className="sr-only" role="status">
          {busy ? "Aguardando você escolher na janela do Windows." : ""}
        </p>

        <div className="modal__actions">
          <button type="button" className="button button--secondary" onClick={onClose}>
            Cancelar
          </button>
          <button type="submit" className="button button--primary" disabled={busy}>
            {busy ? "Aguardando sua escolha…" : "Escolher e transmitir"}
          </button>
        </div>
      </form>
    </Modal>
  );
}
