import { useEffect, useId, useRef, useState, type FormEvent } from "react";
import { prepareAvatar } from "../../avatar-image";
import { SecuritySection } from "./SecuritySection";
import { LIMITS, type User } from "@aurora/schema";
import { ApiError, type ApiClient } from "../../net/api";
import { Avatar } from "../shell";
import { FormStatus, SettingsGroup } from "./controls";

type Status = { kind: "ok" | "error"; text: string } | null;
const errorText = (error: unknown, fallback: string) => (error instanceof ApiError ? error.message : fallback);

export function AccountSection({ me, api, onUserUpdated, onLogout }: { me: User; api: ApiClient; onUserUpdated: (user: User) => void; onLogout: () => void }) {
  return (
    <>
      <div className="settings-profile">
        <Avatar user={me} size="xl" />
        <div className="settings-profile__text">
          <span className="settings-profile__name">{me.displayName}</span>
          <span className="settings-profile__username">@{me.username}</span>
        </div>
      </div>
      <AvatarForm me={me} api={api} onUserUpdated={onUserUpdated} />
      <DisplayNameForm me={me} api={api} onUserUpdated={onUserUpdated} />
      <PasswordForm api={api} />
      <SecuritySection api={api} onSignedOut={onLogout} />
      <SettingsGroup title="Sair" description="Encerra a sessão neste aparelho. Suas mensagens e servidores continuam na conta.">
        <div>
          <button type="button" className="button button--danger" onClick={onLogout}>
            Sair da conta
          </button>
        </div>
      </SettingsGroup>
    </>
  );
}

/** Escolher, pré-visualizar e salvar a foto (recorte quadrado central, reduzida para 256 px no próprio app). */
function AvatarForm({ me, api, onUserUpdated }: { me: User; api: ApiClient; onUserUpdated: (user: User) => void }) {
  const inputRef = useRef<HTMLInputElement>(null);
  const [preview, setPreview] = useState<{ blob: Blob; url: string } | null>(null);
  const [busy, setBusy] = useState(false);
  const [status, setStatus] = useState<Status>(null);
  useEffect(() => () => void (preview && URL.revokeObjectURL(preview.url)), [preview]);

  const choose = async (file: File | undefined) => {
    if (!file) return;
    setStatus(null);
    try {
      const blob = await prepareAvatar(file);
      setPreview({ blob, url: URL.createObjectURL(blob) });
    } catch (error) {
      setStatus({ kind: "error", text: error instanceof Error ? error.message : "Não deu para abrir essa imagem." });
    } finally {
      if (inputRef.current) inputRef.current.value = "";
    }
  };
  const save = async (work: () => Promise<User>, ok: string) => {
    setBusy(true);
    setStatus(null);
    try {
      onUserUpdated(await work());
      setPreview(null);
      setStatus({ kind: "ok", text: ok });
    } catch (error) {
      setStatus({ kind: "error", text: errorText(error, "Não foi possível salvar a foto. Confira a conexão e tente de novo.") });
    } finally {
      setBusy(false);
    }
  };

  return (
    <SettingsGroup title="Foto de perfil" description="Aparece nas conversas, na voz e na lista de membros. A imagem é cortada em quadrado pelo centro.">
      <input ref={inputRef} type="file" accept="image/png,image/jpeg,image/webp,image/gif" className="sr-only" tabIndex={-1} aria-hidden="true" onChange={(event) => void choose(event.target.files?.[0])} />
      {preview ? (
        <div className="avatar-preview">
          <img className="avatar-preview__img" src={preview.url} alt="Prévia da nova foto" />
          <div className="settings-inline-form">
            <button type="button" className="button button--primary" disabled={busy} onClick={() => void save(() => api.uploadAvatar(preview.blob), "Foto salva. Quem está nos seus servidores já vê a nova.")}>
              {busy ? "Salvando…" : "Salvar foto"}
            </button>
            <button type="button" className="button button--secondary" disabled={busy} onClick={() => setPreview(null)}>
              Cancelar
            </button>
          </div>
        </div>
      ) : (
        <div className="settings-inline-form">
          <button type="button" className="button button--secondary" disabled={busy} onClick={() => inputRef.current?.click()}>
            {me.avatar ? "Trocar foto" : "Escolher foto"}
          </button>
          {me.avatar && (
            <button type="button" className="button button--ghost" disabled={busy} onClick={() => void save(() => api.removeAvatar(), "Foto removida. Voltou o avatar com as suas iniciais.")}>
              Remover foto
            </button>
          )}
        </div>
      )}
      <FormStatus status={status} />
    </SettingsGroup>
  );
}

function DisplayNameForm({ me, api, onUserUpdated }: { me: User; api: ApiClient; onUserUpdated: (user: User) => void }) {
  const id = useId();
  const [name, setName] = useState(me.displayName);
  const [busy, setBusy] = useState(false);
  const [status, setStatus] = useState<Status>(null);
  const trimmed = name.trim();
  const unchanged = trimmed === me.displayName;

  const submit = async (event: FormEvent) => {
    event.preventDefault();
    if (!trimmed || unchanged) return;
    setBusy(true);
    setStatus(null);
    try {
      const user = await api.updateProfile(trimmed);
      onUserUpdated(user);
      setName(user.displayName);
      setStatus({ kind: "ok", text: "Nome salvo. Quem está nos seus servidores já vê o nome novo." });
    } catch (error) {
      setStatus({ kind: "error", text: errorText(error, "Não foi possível salvar o nome. Confira a conexão e tente de novo.") });
    } finally {
      setBusy(false);
    }
  };

  return (
    <SettingsGroup title="Nome de exibição" description="É como as pessoas veem você nas conversas e na voz. Seu nome de usuário (@) não muda.">
      <form className="settings-inline-form" onSubmit={submit}>
        <label htmlFor={id} className="sr-only">
          Nome de exibição
        </label>
        <input id={id} className="input" value={name} maxLength={LIMITS.displayNameMax} autoComplete="nickname" onChange={(event) => setName(event.target.value)} />
        <button type="submit" className="button button--primary" disabled={busy || !trimmed || unchanged}>
          {busy ? "Salvando…" : "Salvar"}
        </button>
      </form>
      <FormStatus status={status} />
    </SettingsGroup>
  );
}

function PasswordForm({ api }: { api: ApiClient }) {
  const currentId = useId();
  const nextId = useId();
  const confirmId = useId();
  const [current, setCurrent] = useState("");
  const [next, setNext] = useState("");
  const [confirm, setConfirm] = useState("");
  const [busy, setBusy] = useState(false);
  const [status, setStatus] = useState<Status>(null);

  const submit = async (event: FormEvent) => {
    event.preventDefault();
    if (next.length < LIMITS.passwordMin) {
      setStatus({ kind: "error", text: `A senha nova precisa ter pelo menos ${LIMITS.passwordMin} caracteres.` });
      return;
    }
    if (next !== confirm) {
      setStatus({ kind: "error", text: "A confirmação não é igual à senha nova. Digite as duas de novo." });
      return;
    }
    setBusy(true);
    setStatus(null);
    try {
      await api.changePassword(current, next);
      setCurrent("");
      setNext("");
      setConfirm("");
      setStatus({ kind: "ok", text: "Senha alterada. Os outros aparelhos foram desconectados; este continua conectado." });
    } catch (error) {
      setStatus({ kind: "error", text: errorText(error, "Não foi possível alterar a senha. Confira a conexão e tente de novo.") });
    } finally {
      setBusy(false);
    }
  };

  return (
    <SettingsGroup title="Senha" description="Ao trocar, os outros aparelhos conectados à sua conta saem e precisam entrar com a senha nova.">
      <form className="form settings-password" onSubmit={submit}>
        <div className="field">
          <label htmlFor={currentId} className="field__label">
            Senha atual
          </label>
          <input id={currentId} className="input" type="password" autoComplete="current-password" value={current} onChange={(event) => setCurrent(event.target.value)} required />
        </div>
        <div className="field">
          <label htmlFor={nextId} className="field__label">
            Senha nova
          </label>
          <input id={nextId} className="input" type="password" autoComplete="new-password" maxLength={LIMITS.passwordMax} value={next} onChange={(event) => setNext(event.target.value)} required />
          <span className="field__hint">Pelo menos {LIMITS.passwordMin} caracteres.</span>
        </div>
        <div className="field">
          <label htmlFor={confirmId} className="field__label">
            Confirme a senha nova
          </label>
          <input id={confirmId} className="input" type="password" autoComplete="new-password" maxLength={LIMITS.passwordMax} value={confirm} onChange={(event) => setConfirm(event.target.value)} required />
        </div>
        <div>
          <button type="submit" className="button button--primary" disabled={busy || !current || !next || !confirm}>
            {busy ? "Alterando…" : "Alterar senha"}
          </button>
        </div>
        <FormStatus status={status} />
      </form>
    </SettingsGroup>
  );
}
