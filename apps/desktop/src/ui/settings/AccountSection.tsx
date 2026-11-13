import { useId, useState, type FormEvent } from "react";
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
        <Avatar user={me} size="lg" />
        <div className="settings-profile__text">
          <span className="settings-profile__name">{me.displayName}</span>
          <span className="settings-profile__username">@{me.username}</span>
        </div>
      </div>
      <DisplayNameForm me={me} api={api} onUserUpdated={onUserUpdated} />
      <PasswordForm api={api} />
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
