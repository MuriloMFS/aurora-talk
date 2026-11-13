import "@fontsource-variable/inter";
import "@aurora/ui/tokens.css";
import "./site.css";
import { applyTheme, nextPreference, readPreference, savePreference, watchSystemTheme } from "@aurora/ui/theme";

/* ---------- versão publicada (botão de download) ---------- */
interface LatestRelease {
  version: string;
  size: number;
  pubDate: string | null;
  download: string;
}

const meta = document.getElementById("release-meta");
const footerVersion = document.getElementById("footer-version");
const downloadButton = document.getElementById("download-button");

export const formatSize = (bytes: number): string => `${(bytes / 1024 / 1024).toLocaleString("pt-BR", { maximumFractionDigits: 1 })} MB`;

fetch("/api/releases/latest")
  .then((response) => (response.ok ? (response.json() as Promise<LatestRelease>) : null))
  .then((release) => {
    if (!release) {
      if (meta) meta.textContent = "O download ainda não está disponível. Volte em alguns minutos.";
      downloadButton?.setAttribute("aria-disabled", "true");
      return;
    }
    if (meta) meta.textContent = `Versão ${release.version} · ${formatSize(release.size)} · Windows 10 e 11 (64 bits) · grátis`;
    if (footerVersion) footerVersion.textContent = `Versão ${release.version}`;
  })
  .catch(() => undefined); // sem rede: fica o texto padrão, o link continua funcionando

/* ---------- só Windows por enquanto ---------- */
if (!/Windows/i.test(navigator.userAgent)) document.getElementById("platform-note")?.removeAttribute("hidden");

/* ---------- tema (mesma preferência do app: escuro, claro ou do sistema) ---------- */
const toggle = document.getElementById("theme-toggle");
const label = { dark: "Tema escuro", light: "Tema claro", system: "Tema do sistema" } as const;
let preference = readPreference();
const render = () => {
  applyTheme(preference);
  toggle?.setAttribute("aria-label", `${label[preference]}. Clique para trocar.`);
  toggle?.setAttribute("title", label[preference]);
};
render();
toggle?.addEventListener("click", () => {
  preference = nextPreference(preference);
  savePreference(preference);
  render();
});
watchSystemTheme(() => preference, () => render());
