import { useEffect, useId, useState, type FormEvent } from "react";
import { Check, Copy } from "lucide-react";
import { LIMITS, normalizeChannelName, normalizeVoiceChannelName, type Channel, type ChannelType, type Guild, type Id } from "@aurora/schema";
import { ApiError, type ApiClient } from "../net/api";
import { Modal } from "./Modal";
import { SwitchRow } from "./settings/controls";

const message = (error: unknown) => (error instanceof ApiError ? error.message : "Algo deu errado. Tente de novo.");

/** Formulário de um campo usado pelos diálogos de criar/entrar. */
function SingleFieldDialog(props: {
  title: string;
  description: string;
  label: string;
  submitLabel: string;
  maxLength: number;
  preview?: (value: string) => string | null;
  onSubmit: (value: string) => Promise<void>;
  onClose: () => void;
}) {
  const [value, setValue] = useState("");
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  const inputId = useId();
  const previewId = useId();
  const preview = props.preview?.(value);

  const submit = async (event: FormEvent) => {
    event.preventDefault();
    setBusy(true);
    setError(null);
    try {
      await props.onSubmit(value);
      props.onClose();
    } catch (caught) {
      setError(message(caught));
      setBusy(false);
    }
  };

  return (
    <Modal title={props.title} description={props.description} onClose={props.onClose}>
      <form className="form" onSubmit={submit}>
        <div className="field">
          <label className="field__label" htmlFor={inputId}>
            {props.label}
          </label>
          <input
            id={inputId}
            aria-describedby={preview ? previewId : undefined}
            className="input"
            value={value}
            onChange={(e) => setValue(e.target.value)}
            maxLength={props.maxLength}
            required
          />
          {preview && (
            <span id={previewId} className="field__hint">
              Vai ficar assim: {preview}
            </span>
          )}
        </div>
        {error && (
          <p className="form-error" role="alert">
            {error}
          </p>
        )}
        <div className="modal__actions">
          <button type="button" className="button button--secondary" onClick={props.onClose}>
            Cancelar
          </button>
          <button type="submit" className="button button--primary" disabled={busy || value.trim().length === 0}>
            {busy ? "Aguarde…" : props.submitLabel}
          </button>
        </div>
      </form>
    </Modal>
  );
}

export function CreateGuildDialog({ api, onCreated, onClose }: { api: ApiClient; onCreated: (guild: Guild) => void; onClose: () => void }) {
  return (
    <SingleFieldDialog
      title="Criar servidor"
      description="Um servidor é onde você e seus amigos conversam. Ele já vem com o canal #geral."
      label="Nome do servidor"
      submitLabel="Criar"
      maxLength={LIMITS.guildNameMax}
      onSubmit={async (name) => onCreated(await api.createGuild(name))}
      onClose={onClose}
    />
  );
}

export function JoinGuildDialog({ api, onJoined, onClose }: { api: ApiClient; onJoined: (guild: Guild) => void; onClose: () => void }) {
  return (
    <SingleFieldDialog
      title="Entrar em um servidor"
      description="Cole o código de convite que você recebeu."
      label="Código de convite"
      submitLabel="Entrar"
      maxLength={32}
      onSubmit={async (code) => onJoined(await api.joinInvite(code.trim()))}
      onClose={onClose}
    />
  );
}

export function CreateChannelDialog({
  api,
  guildId,
  initialType,
  onCreated,
  onClose,
}: {
  api: ApiClient;
  guildId: Id;
  initialType: ChannelType;
  onCreated: (channel: Channel) => void;
  onClose: () => void;
}) {
  const [type, setType] = useState<ChannelType>(initialType);
  const [isPrivate, setPrivate] = useState(false);
  const [name, setName] = useState("");
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  const nameId = useId();
  const hintId = useId();
  const normalized = type === "voice" ? normalizeVoiceChannelName(name) : normalizeChannelName(name);
  const preview = type === "text" && normalized && normalized !== name ? `Vai ficar assim: #${normalized}` : null;

  const submit = async (event: FormEvent) => {
    event.preventDefault();
    setBusy(true);
    setError(null);
    try {
      onCreated(await api.createChannel(guildId, name, type, isPrivate));
      onClose();
    } catch (caught) {
      setError(message(caught));
      setBusy(false);
    }
  };

  return (
    <Modal
      title="Criar canal"
      description={isPrivate ? "Só você vai ver o canal. Depois, em Configurações do servidor → Canais, libere quem mais pode ver." : "Todos os membros do servidor vão ver o novo canal."}
      onClose={onClose}
    >
      <form className="form" onSubmit={submit}>
        <fieldset className="choice-group">
          <legend className="field__label">Tipo de canal</legend>
          {(["text", "voice"] as const).map((value) => (
            <label key={value} className="choice">
              <input type="radio" name="channel-type" value={value} checked={type === value} onChange={() => setType(value)} />
              <span className="choice__text">
                <span className="choice__title">{value === "text" ? "Texto" : "Voz"}</span>
                <span className="choice__hint">{value === "text" ? "Mensagens, conversas e avisos" : "Conversar por voz em tempo real"}</span>
              </span>
            </label>
          ))}
        </fieldset>
        <div className="field">
          <label className="field__label" htmlFor={nameId}>
            Nome do canal
          </label>
          <input
            id={nameId}
            aria-describedby={preview ? hintId : undefined}
            className="input"
            value={name}
            onChange={(e) => setName(e.target.value)}
            maxLength={LIMITS.channelNameMax}
            placeholder={type === "voice" ? "Sala de estar" : "novo-canal"}
            required
          />
          {preview && (
            <span id={hintId} className="field__hint">
              {preview}
            </span>
          )}
        </div>
        <SwitchRow
          label="Canal privado"
          hint="Só quem você liberar vê o canal (quem administra vê tudo)."
          checked={isPrivate}
          onChange={setPrivate}
        />
        {error && (
          <p className="form-error" role="alert">
            {error}
          </p>
        )}
        <div className="modal__actions">
          <button type="button" className="button button--secondary" onClick={onClose}>
            Cancelar
          </button>
          <button type="submit" className="button button--primary" disabled={busy || normalized.length === 0}>
            {busy ? "Aguarde…" : "Criar canal"}
          </button>
        </div>
      </form>
    </Modal>
  );
}

export function InviteDialog({ api, guild, onClose }: { api: ApiClient; guild: { id: Id; name: string }; onClose: () => void }) {
  const [code, setCode] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [copied, setCopied] = useState(false);

  useEffect(() => {
    let alive = true;
    api
      .createInvite(guild.id)
      .then((invite) => alive && setCode(invite.code))
      .catch((caught: unknown) => alive && setError(message(caught)));
    return () => {
      alive = false;
    };
  }, [api, guild.id]);

  const copy = async () => {
    if (!code) return;
    try {
      await navigator.clipboard.writeText(code);
      setCopied(true);
    } catch {
      setError("Não foi possível copiar. Selecione o código e copie manualmente.");
    }
  };

  return (
    <Modal title={`Convidar para ${guild.name}`} description="Envie este código para a pessoa. Ela entra pelo botão “Entrar com convite”, no fim da barra de servidores." onClose={onClose}>
      <div className="invite">
        <output className="invite__code" aria-live="polite">
          {code ?? (error ? "—" : "Gerando…")}
        </output>
        <button type="button" className="button button--secondary" onClick={copy} disabled={!code}>
          {copied ? <Check size={16} strokeWidth={1.75} aria-hidden /> : <Copy size={16} strokeWidth={1.75} aria-hidden />}
          {copied ? "Copiado" : "Copiar"}
        </button>
      </div>
      {error && (
        <p className="form-error" role="alert">
          {error}
        </p>
      )}
      <div className="modal__actions">
        <button type="button" className="button button--primary" onClick={onClose}>
          Pronto
        </button>
      </div>
    </Modal>
  );
}
