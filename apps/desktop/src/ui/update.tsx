import { useCallback, useEffect, useRef, useState } from "react";
import { Download } from "lucide-react";
import { createPlatform, type PlatformPort, type UpdateInfo } from "@aurora/platform";

const STARTUP_TIMEOUT_MS = 8_000;
const PERIODIC_CHECK_MS = 15 * 60 * 1000;
const FOCUS_CHECK_MIN_GAP_MS = 5 * 60 * 1000;

export type UpdatePhase =
  | { kind: "idle" }
  | { kind: "available"; update: UpdateInfo }
  | { kind: "installing"; update: UpdateInfo; percent: number | null }
  | { kind: "failed"; message: string };

const withTimeout = <T,>(promise: Promise<T>, ms: number) =>
  Promise.race([promise, new Promise<never>((_, reject) => setTimeout(() => reject(new Error("timeout")), ms))]);

/**
 * Atualização automática:
 * - ao abrir o app: se houver versão nova, instala sozinho (o app fecha e volta atualizado);
 * - com o app aberto: verifica a cada 15 min e ao voltar para a janela; se houver versão nova,
 *   o botão de download aparece no topo e a atualização começa no clique.
 * Falhas de rede são silenciosas: o app segue na versão atual.
 */
export function useAppUpdate(serverUrl: string) {
  const [phase, setPhase] = useState<UpdatePhase>({ kind: "idle" });
  const platformRef = useRef<PlatformPort | null>(null);
  const phaseRef = useRef(phase);
  phaseRef.current = phase;

  const install = useCallback(async (update: UpdateInfo) => {
    const platform = platformRef.current;
    if (!platform) return;
    setPhase({ kind: "installing", update, percent: null });
    try {
      await platform.installUpdate(({ downloaded, total }) =>
        setPhase({ kind: "installing", update, percent: total ? Math.min(100, Math.round((downloaded / total) * 100)) : null }),
      );
    } catch (error) {
      setPhase({ kind: "failed", message: error instanceof Error ? error.message : String(error) });
    }
  }, []);

  useEffect(() => {
    let alive = true;
    let lastCheck = 0;
    let timer: ReturnType<typeof setInterval> | undefined;

    const checkInBackground = async () => {
      const platform = platformRef.current;
      if (!platform || phaseRef.current.kind === "installing") return;
      lastCheck = Date.now();
      try {
        const update = await platform.checkForUpdate(serverUrl);
        if (alive && update) setPhase((current) => (current.kind === "installing" ? current : { kind: "available", update }));
      } catch {
        // tenta de novo no próximo ciclo
      }
    };
    const onFocus = () => {
      if (Date.now() - lastCheck > FOCUS_CHECK_MIN_GAP_MS) void checkInBackground();
    };

    (async () => {
      const platform = await createPlatform();
      if (!alive || platform.kind !== "tauri") return;
      platformRef.current = platform;
      lastCheck = Date.now();
      try {
        const update = await withTimeout(platform.checkForUpdate(serverUrl), STARTUP_TIMEOUT_MS);
        if (alive && update) {
          void install(update); // ao abrir: instala direto, sem perguntar
          return;
        }
      } catch {
        // servidor fora do ar ou sem versões publicadas: segue normalmente
      }
      timer = setInterval(checkInBackground, PERIODIC_CHECK_MS);
      window.addEventListener("focus", onFocus);
    })();

    return () => {
      alive = false;
      clearInterval(timer);
      window.removeEventListener("focus", onFocus);
    };
  }, [serverUrl, install]);

  /** "Procurar atualizações" das configurações: responde na hora o que encontrou. */
  const checkNow = useCallback(async (): Promise<"available" | "current" | "unsupported" | "error"> => {
    const platform = platformRef.current;
    if (!platform) return "unsupported";
    try {
      const update = await platform.checkForUpdate(serverUrl);
      if (!update) return "current";
      setPhase((current) => (current.kind === "installing" ? current : { kind: "available", update }));
      return "available";
    } catch {
      return "error";
    }
  }, [serverUrl]);

  return {
    phase,
    checkNow,
    available: phase.kind === "available" ? phase.update : null,
    install: () => phase.kind === "available" && void install(phase.update),
    dismissError: () => setPhase({ kind: "idle" }),
  };
}

/** Botão de download da barra do topo (aparece só quando há versão nova). */
export function UpdateButton({ update, onInstall, floating = false }: { update: UpdateInfo; onInstall: () => void; floating?: boolean }) {
  const label = `Atualização disponível: versão ${update.version}. Clique para atualizar`;
  return (
    <button type="button" className={floating ? "icon-button update-button update-button--floating" : "icon-button update-button"} aria-label={label} title={label} onClick={onInstall}>
      <Download size={20} strokeWidth={1.75} aria-hidden />
    </button>
  );
}

/** Tela de "atualizando" e aviso de falha. */
export function UpdateStatus({ phase, onDismissError }: { phase: UpdatePhase; onDismissError: () => void }) {
  if (phase.kind === "installing") {
    return (
      <div className="update-overlay" role="status" aria-live="polite">
        <span className="auth__logo" aria-hidden="true" />
        <h2 className="center-state__title">Atualizando o Aurora para a versão {phase.update.version}</h2>
        <p className="center-state__text">{phase.percent === null ? "Preparando…" : `Baixando… ${phase.percent}%`} O app vai fechar e abrir de novo sozinho.</p>
        <progress className="update-progress" max={100} value={phase.percent ?? undefined} />
      </div>
    );
  }
  if (phase.kind === "failed") {
    return (
      <div className="update-banner update-banner--error" role="alert">
        <span>Não foi possível atualizar: {phase.message}</span>
        <button type="button" className="button button--secondary button--small" onClick={onDismissError}>
          Fechar
        </button>
      </div>
    );
  }
  return null;
}
