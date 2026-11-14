import { isWebUrl, type PlatformPort } from "./index";
import { watchFocusedPushToTalk } from "./push-to-talk";

/** Último uso do teclado/mouse dentro da página (o navegador não vê o resto do computador). */
let lastActivity = Date.now();
let tracking = false;
function trackActivity(): void {
  if (tracking || typeof document === "undefined") return;
  tracking = true;
  const mark = () => (lastActivity = Date.now());
  for (const type of ["pointermove", "pointerdown", "keydown", "wheel", "touchstart"]) document.addEventListener(type, mark, { passive: true, capture: true });
}

/** Implementação para desenvolvimento e testes no navegador (sem APIs nativas). */
export function createBrowserPlatform(): PlatformPort {
  trackActivity();
  return {
    kind: "browser",
    async getInfo() {
      return { kind: "browser", appVersion: "dev", systemAudio: "picker", pushToTalk: "focused", media: "web" };
    },
    async checkForUpdate() {
      return null; // o navegador sempre roda a versão atual do código
    },
    async installUpdate() {
      throw new Error("Atualização automática só existe no app instalado.");
    },
    async captureSystemAudio() {
      throw new Error("No navegador, o som do computador vem da opção de áudio do seletor de tela.");
    },
    async openExternal(url) {
      if (isWebUrl(url)) globalThis.open?.(url, "_blank", "noopener,noreferrer");
    },
    async notify({ title, body }) {
      if (typeof Notification === "undefined") return;
      if (Notification.permission === "default") await Notification.requestPermission();
      if (Notification.permission === "granted") new Notification(title, { body });
    },
    async setBadge(count) {
      const nav = globalThis.navigator as Navigator & { setAppBadge?: (n?: number) => Promise<void>; clearAppBadge?: () => Promise<void> };
      await (count > 0 ? nav?.setAppBadge?.(count) : nav?.clearAppBadge?.())?.catch(() => undefined);
    },
    async requestAttention() {
      // o navegador não tem como piscar a barra de tarefas
    },
    async getDesktopSettings() {
      return null; // bandeja e início com o sistema só existem no app instalado
    },
    async setDesktopSettings() {
      throw new Error("Essas opções só existem no app instalado.");
    },
    async getIdleSeconds() {
      return Math.floor((Date.now() - lastActivity) / 1000);
    },
    // O navegador só vê teclas com a página em foco; perder o foco conta como soltar.
    async watchPushToTalk(code, onChange) {
      return watchFocusedPushToTalk(code, onChange);
    },
  };
}
