import { useCallback, useEffect, useId, useMemo, useState, type FormEvent } from "react";
import { Check, Copy, Laptop, ShieldCheck } from "lucide-react";
import qrcode from "qrcode-generator";
import type { SecurityInfo } from "@aurora/schema";
import { ApiError, type ApiClient } from "../../net/api";
import { ICON_SM } from "../shell";
import { FormStatus, SettingsGroup } from "./controls";

type Status = { kind: "ok" | "error"; text: string } | null;
const errorText = (error: unknown) => (error instanceof ApiError ? error.message : "Não foi possível concluir. Confira a conexão e tente de novo.");
const when = (ms: number) => new Date(ms).toLocaleString("pt-BR", { dateStyle: "short", timeStyle: "short" });

/** QR code desenhado aqui mesmo (sem HTML injetado): escuro sobre claro nos dois temas. */
export function QrCode({ text, label }: { text: string; label: string }) {
  const cells = useMemo(() => {
    const qr = qrcode(0, "M");
    qr.addData(text);
    qr.make();
    const size = qr.getModuleCount();
    const dark: [number, number][] = [];
    for (let row = 0; row < size; row++) for (let col = 0; col < size; col++) if (qr.isDark(row, col)) dark.push([col, row]);
    return { size, dark };
  }, [text]);
  const margin = 4;
  const total = cells.size + margin * 2;
  return (
    <svg className="qr" viewBox={`0 0 ${total} ${total}`} role="img" aria-label={label} shapeRendering="crispEdges">
      <rect width={total} height={total} className="qr__light" />
      <path className="qr__dark" d={cells.dark.map(([x, y]) => `M${x + margin} ${y + margin}h1v1h-1z`).join("")} />
    </svg>
  );
}

/** Lista dos códigos, uma vez só, com copiar. */
function RecoveryCodes({ codes, onDone }: { codes: string[]; onDone: () => void }) {
  const [copied, setCopied] = useState(false);
  return (
    <div className="recovery-codes" role="region" aria-label="Códigos de recuperação">
      <p className="settings-note" role="note">
        Guarde estes códigos num lugar seguro (gerenciador de senhas, papel). Cada um vale uma vez e serve para entrar sem o celular ou trocar a senha se você esquecer.
        <strong> Eles não aparecem de novo.</strong>
      </p>
      <ul className="recovery-codes__list">
        {codes.map((code) => (
          <li key={code} className="mono-code">
            {code}
          </li>
        ))}
      </ul>
      <div className="settings-inline-form">
        <button
          type="button"
          className="button button--secondary"
          onClick={() =>
            void navigator.clipboard
              ?.writeText(codes.join("\n"))
              .then(() => setCopied(true))
              .catch(() => undefined)
          }
        >
          {copied ? <Check {...ICON_SM} /> : <Copy {...ICON_SM} />}
          {copied ? "Copiados" : "Copiar códigos"}
        </button>
        <button type="button" className="button button--primary" onClick={onDone}>
          Já guardei
        </button>
      </div>
    </div>
  );
}

function PasswordPrompt({ label, busy, onSubmit, onCancel, withCode }: { label: string; busy: boolean; onSubmit: (password: string, code: string) => void; onCancel: () => void; withCode?: boolean }) {
  const [password, setPassword] = useState("");
  const [code, setCode] = useState("");
  const passwordId = useId();
  const codeId = useId();
  return (
    <form
      className="form security-prompt"
      onSubmit={(event: FormEvent) => {
        event.preventDefault();
        onSubmit(password, code.trim());
      }}
    >
      <div className="field">
        <label htmlFor={passwordId} className="field__label">
          Sua senha
        </label>
        <input id={passwordId} className="input" type="password" value={password} autoComplete="current-password" onChange={(e) => setPassword(e.target.value)} autoFocus required />
      </div>
      {withCode && (
        <div className="field">
          <label htmlFor={codeId} className="field__label">
            Código do app autenticador (ou de recuperação)
          </label>
          <input id={codeId} className="input input--code" value={code} autoComplete="one-time-code" onChange={(e) => setCode(e.target.value)} required />
        </div>
      )}
      <div className="settings-inline-form">
        <button type="submit" className="button button--primary" disabled={busy || !password || (withCode && !code.trim())}>
          {busy ? "Aguarde…" : label}
        </button>
        <button type="button" className="button button--secondary" onClick={onCancel} disabled={busy}>
          Cancelar
        </button>
      </div>
    </form>
  );
}

type Step =
  | { kind: "idle" }
  | { kind: "password"; action: "enable" | "disable" | "codes" }
  | { kind: "scan"; secret: string; uri: string }
  | { kind: "codes"; codes: string[] };

export function SecuritySection({ api, onSignedOut }: { api: ApiClient; onSignedOut: () => void }) {
  const [info, setInfo] = useState<SecurityInfo | null>(null);
  const [step, setStep] = useState<Step>({ kind: "idle" });
  const [busy, setBusy] = useState(false);
  const [status, setStatus] = useState<Status>(null);
  const [code, setCode] = useState("");
  const codeId = useId();
  const reload = useCallback(() => {
    api
      .security()
      .then(setInfo)
      .catch((error: unknown) => setStatus({ kind: "error", text: errorText(error) }));
  }, [api]);
  useEffect(reload, [reload]);

  const run = async (work: () => Promise<void>, ok?: string) => {
    setBusy(true);
    setStatus(null);
    try {
      await work();
      if (ok) setStatus({ kind: "ok", text: ok });
      reload();
    } catch (error) {
      setStatus({ kind: "error", text: errorText(error) });
    } finally {
      setBusy(false);
    }
  };

  const onPassword = (password: string, typedCode: string) => {
    if (step.kind !== "password") return;
    if (step.action === "enable") void run(async () => setStep({ kind: "scan", ...(await api.totpSetup(password)) }));
    else if (step.action === "codes") void run(async () => setStep({ kind: "codes", codes: (await api.newRecoveryCodes(password)).recoveryCodes }));
    else
      void run(async () => {
        await api.totpDisable(password, typedCode);
        setStep({ kind: "idle" });
      }, "Verificação em duas etapas desligada. Agora basta a senha para entrar.");
  };

  if (!info) return <FormStatus status={status} />;
  const enabled = info.totpEnabled;
  return (
    <>
      <SettingsGroup
        title="Verificação em duas etapas"
        description="Além da senha, o login pede um código de 6 dígitos de um app autenticador no celular (Google Authenticator, Microsoft Authenticator, Authy…). Quem descobrir sua senha não entra sem o celular."
      >
        <p className={enabled ? "security-state security-state--on" : "security-state"}>
          <ShieldCheck {...ICON_SM} />
          {enabled ? "Ligada" : "Desligada"}
        </p>
        {step.kind === "idle" && (
          <div className="settings-inline-form">
            <button type="button" className={enabled ? "button button--secondary" : "button button--primary"} onClick={() => setStep({ kind: "password", action: enabled ? "disable" : "enable" })}>
              {enabled ? "Desligar" : "Ligar a verificação em duas etapas"}
            </button>
          </div>
        )}
        {step.kind === "password" && step.action !== "codes" && (
          <PasswordPrompt label={step.action === "enable" ? "Continuar" : "Desligar"} withCode={step.action === "disable"} busy={busy} onSubmit={onPassword} onCancel={() => setStep({ kind: "idle" })} />
        )}
        {step.kind === "scan" && (
          <div className="totp-setup">
            <ol className="totp-setup__steps">
              <li>Abra o app autenticador no celular e escolha adicionar conta (ler QR code).</li>
              <li>Aponte a câmera para o código abaixo. Sem câmera? Digite a chave à mão.</li>
              <li>Digite os 6 dígitos que o app mostrar.</li>
            </ol>
            <QrCode text={step.uri} label="QR code para o app autenticador" />
            <p className="totp-setup__key">
              Chave: <code className="mono-code">{step.secret.match(/.{1,4}/g)?.join(" ")}</code>
            </p>
            <form
              className="settings-inline-form"
              onSubmit={(event) => {
                event.preventDefault();
                void run(async () => {
                  const { recoveryCodes } = await api.totpEnable(code.trim());
                  setCode("");
                  setStep({ kind: "codes", codes: recoveryCodes });
                }, "Verificação em duas etapas ligada.");
              }}
            >
              <label htmlFor={codeId} className="sr-only">
                Código de 6 dígitos
              </label>
              <input id={codeId} className="input totp-setup__code" value={code} inputMode="numeric" autoComplete="one-time-code" maxLength={7} placeholder="123456" onChange={(e) => setCode(e.target.value)} autoFocus />
              <button type="submit" className="button button--primary" disabled={busy || code.replace(/\s/g, "").length !== 6}>
                {busy ? "Conferindo…" : "Confirmar e ligar"}
              </button>
              <button type="button" className="button button--secondary" onClick={() => setStep({ kind: "idle" })}>
                Cancelar
              </button>
            </form>
          </div>
        )}
        {step.kind === "codes" && <RecoveryCodes codes={step.codes} onDone={() => setStep({ kind: "idle" })} />}
        <FormStatus status={status} />
      </SettingsGroup>

      <SettingsGroup
        title="Códigos de recuperação"
        description="Servem para trocar a senha se você esquecer e para entrar sem o celular. O Aurora não guarda seu e-mail: sem estes códigos, uma senha esquecida não tem volta."
      >
        <p className="security-state">
          {info.recoveryCodesLeft === 0 ? "Nenhum código ativo." : info.recoveryCodesLeft === 1 ? "1 código sobrando." : `${info.recoveryCodesLeft} códigos sobrando.`}
        </p>
        {step.kind === "password" && step.action === "codes" ? (
          <PasswordPrompt label="Gerar códigos" busy={busy} onSubmit={onPassword} onCancel={() => setStep({ kind: "idle" })} />
        ) : (
          step.kind === "idle" && (
            <div className="settings-inline-form">
              <button type="button" className="button button--secondary" onClick={() => setStep({ kind: "password", action: "codes" })}>
                {info.recoveryCodesLeft > 0 ? "Gerar códigos novos (os atuais deixam de valer)" : "Gerar códigos de recuperação"}
              </button>
            </div>
          )
        )}
      </SettingsGroup>

      <SettingsGroup title="Aparelhos conectados" description="Onde sua conta está aberta. Não reconhece algum? Desconecte e troque a senha.">
        <ul className="settings-list">
          {info.sessions.map((session) => (
            <li key={session.id} className="settings-list__row member-row">
              <Laptop {...ICON_SM} />
              <div className="member-row__text">
                <span className="member-row__name">
                  {session.device}
                  {session.current && <span className="tag">Este aparelho</span>}
                </span>
                <span className="member-row__sub">
                  Entrou em {when(session.createdAt)}
                  {session.lastSeen && !session.current ? ` · usado em ${when(session.lastSeen)}` : ""}
                </span>
              </div>
              <div className="settings-list__actions">
                <button
                  type="button"
                  className="button button--secondary button--small"
                  onClick={() =>
                    void run(async () => {
                      await api.endSession(session.id);
                      if (session.current) onSignedOut();
                    }, `${session.device} foi desconectado.`)
                  }
                >
                  {session.current ? "Sair" : "Desconectar"}
                </button>
              </div>
            </li>
          ))}
        </ul>
        {info.sessions.length > 1 && (
          <div>
            <button type="button" className="button button--danger" disabled={busy} onClick={() => void run(() => api.endOtherSessions(), "Os outros aparelhos foram desconectados.")}>
              Desconectar todos os outros
            </button>
          </div>
        )}
      </SettingsGroup>
    </>
  );
}
