import { useId, useState, type FormEvent, type ReactNode } from "react";
import { LIMITS } from "@aurora/schema";
import { detectPlatformKind } from "@aurora/platform";
import { ApiClient, ApiError } from "../net/api";
import { IS_HOSTED, normalizeServerUrl, type Session } from "../net/session";

type Mode = "login" | "register" | "recover";

/** Como este aparelho aparece em Minha conta → Aparelhos conectados (no navegador, o servidor adivinha). */
const deviceLabel = () => (detectPlatformKind() === "tauri" ? "Aurora para Windows" : undefined);

/** Campo com rótulo e dica ligados explicitamente (nome acessível = rótulo; dica = descrição). */
function Field({ label, hint, children }: { label: string; hint?: string; children: (ids: { id: string; describedBy?: string }) => ReactNode }) {
  const id = useId();
  const hintId = useId();
  return (
    <div className="field">
      <label className="field__label" htmlFor={id}>
        {label}
      </label>
      {children({ id, describedBy: hint ? hintId : undefined })}
      {hint && (
        <span id={hintId} className="field__hint">
          {hint}
        </span>
      )}
    </div>
  );
}

export function AuthScreen({ initialServerUrl, notice, onAuthenticated }: { initialServerUrl: string; notice: string | null; onAuthenticated: (session: Session) => void }) {
  const [mode, setMode] = useState<Mode>("login");
  const [serverUrl, setServerUrl] = useState(initialServerUrl);
  // versão oficial: o servidor já vem certo (como no Discord); outro servidor fica em "Opções avançadas"
  const [showServer, setShowServer] = useState(!IS_HOSTED);
  const [username, setUsername] = useState("");
  const [displayName, setDisplayName] = useState("");
  const [password, setPassword] = useState("");
  /** Verificação em duas etapas: o servidor pediu o código depois da senha certa. */
  const [needCode, setNeedCode] = useState(false);
  const [code, setCode] = useState("");
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  const errorId = useId();

  const submit = async (event: FormEvent) => {
    event.preventDefault();
    setBusy(true);
    setError(null);
    const url = normalizeServerUrl(serverUrl);
    const api = new ApiClient(url);
    try {
      const device = deviceLabel();
      const result =
        mode === "login"
          ? await api.login(username, password, needCode ? code.trim() : undefined, device)
          : mode === "recover"
            ? await api.recover(username, code.trim(), password, device)
            : await api.register(username, password, displayName.trim() || undefined, device);
      onAuthenticated({ serverUrl: url, token: result.token, user: result.user });
    } catch (caught) {
      if (caught instanceof ApiError && caught.code === "mfa_required") {
        setNeedCode(true); // senha certa: agora o código do app autenticador
        setError(null);
      } else {
        setError(caught instanceof ApiError ? caught.message : "Algo deu errado. Tente de novo.");
      }
      setBusy(false);
    }
  };
  const switchMode = (next: Mode) => {
    setMode(next);
    setError(null);
    setNeedCode(false);
    setCode("");
    setPassword("");
  };

  const isRegister = mode === "register";
  const isRecover = mode === "recover";
  return (
    <main className="auth">
      <div className="auth__card">
        <div className="auth__brand">
          <span className="auth__logo" aria-hidden="true" />
          <h1 className="auth__title">Aurora</h1>
        </div>
        <div className="auth__tabs" role="tablist" aria-label="Entrar ou criar conta">
          {(["login", "register"] as const).map((value) => (
            <button
              key={value}
              type="button"
              role="tab"
              aria-selected={mode === value || (value === "login" && isRecover)}
              className="auth__tab"
              onClick={() => switchMode(value)}
            >
              {value === "login" ? "Entrar" : "Criar conta"}
            </button>
          ))}
        </div>

        {notice && (
          <p className="notice" role="status">
            {notice}
          </p>
        )}

        <form className="form" onSubmit={submit} aria-describedby={error ? errorId : undefined}>
          {showServer ? (
            <Field label="Servidor" hint={IS_HOSTED ? "Só mude se alguém te passou o endereço de outro servidor do Aurora." : "No mesmo PC: http://localhost:3000 · na rede: http://IP-do-PC:3000"}>
              {({ id, describedBy }) => (
                <input id={id} aria-describedby={describedBy} className="input" value={serverUrl} onChange={(e) => setServerUrl(e.target.value)} autoComplete="url" spellCheck={false} required />
              )}
            </Field>
          ) : null}
          <Field label="Usuário" hint={isRegister ? "Letras minúsculas, números, ponto e sublinhado." : undefined}>
            {({ id, describedBy }) => (
              <input
                id={id}
                aria-describedby={describedBy}
                className="input"
                value={username}
                onChange={(e) => setUsername(e.target.value)}
                autoComplete="username"
                spellCheck={false}
                minLength={isRegister ? LIMITS.usernameMin : 1}
                maxLength={LIMITS.usernameMax}
                required
              />
            )}
          </Field>
          {isRegister && (
            <Field label="Nome de exibição (opcional)">
              {({ id }) => <input id={id} className="input" value={displayName} onChange={(e) => setDisplayName(e.target.value)} maxLength={LIMITS.displayNameMax} autoComplete="nickname" />}
            </Field>
          )}
          {isRecover && (
            <Field label="Código de recuperação" hint="Um dos 10 códigos que você salvou ao ligar a verificação em duas etapas (cada um vale uma vez).">
              {({ id, describedBy }) => (
                <input id={id} aria-describedby={describedBy} className="input input--code" value={code} onChange={(e) => setCode(e.target.value)} autoComplete="one-time-code" spellCheck={false} placeholder="xxxxx-xxxxx" required />
              )}
            </Field>
          )}
          {needCode && !isRecover ? (
            <Field label="Código de verificação" hint="Os 6 dígitos que aparecem agora no seu app autenticador. Perdeu o celular? Use um código de recuperação.">
              {({ id, describedBy }) => (
                <input
                  id={id}
                  aria-describedby={describedBy}
                  className="input input--code"
                  value={code}
                  onChange={(e) => setCode(e.target.value)}
                  autoComplete="one-time-code"
                  inputMode="text"
                  spellCheck={false}
                  maxLength={20}
                  autoFocus
                  required
                />
              )}
            </Field>
          ) : (
          <Field label={isRecover ? "Senha nova" : "Senha"} hint={isRegister || isRecover ? `Pelo menos ${LIMITS.passwordMin} caracteres.` : undefined}>
            {({ id, describedBy }) => (
              <input
                id={id}
                aria-describedby={describedBy}
                className="input"
                type="password"
                value={password}
                onChange={(e) => setPassword(e.target.value)}
                autoComplete={isRegister || isRecover ? "new-password" : "current-password"}
                minLength={isRegister || isRecover ? LIMITS.passwordMin : 1}
                maxLength={LIMITS.passwordMax}
                required
              />
            )}
          </Field>
          )}

          {error && (
            <p id={errorId} className="form-error" role="alert">
              {error}
            </p>
          )}
          <button type="submit" className="button button--primary button--block" disabled={busy}>
            {busy ? "Aguarde…" : isRegister ? "Criar conta" : isRecover ? "Trocar senha e entrar" : needCode ? "Confirmar" : "Entrar"}
          </button>
        </form>
        {mode === "login" && !needCode && (
          <button type="button" className="button button--ghost button--small auth__advanced" onClick={() => switchMode("recover")}>
            Esqueci a senha
          </button>
        )}
        {(isRecover || needCode) && (
          <button type="button" className="button button--ghost button--small auth__advanced" onClick={() => switchMode("login")}>
            Voltar
          </button>
        )}
        {isRecover && <p className="auth__help">Sem código de recuperação não dá para recuperar a conta: o Aurora não guarda seu e-mail.</p>}
        {!showServer && (
          <button type="button" className="button button--ghost button--small auth__advanced" onClick={() => setShowServer(true)}>
            Usar outro servidor
          </button>
        )}
      </div>
    </main>
  );
}
