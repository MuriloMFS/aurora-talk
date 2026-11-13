import "@fontsource-variable/inter";
import "@fontsource/jetbrains-mono/latin-400.css"; // só o alfabeto latino (cobre o português)
import "@aurora/ui/tokens.css";
import "./site.css";
import { applyTheme, nextPreference, readPreference, savePreference, watchSystemTheme } from "@aurora/ui/theme";

/* ---------- versão publicada: tamanho e número reais, vindos do servidor ---------- */
interface LatestRelease {
  version: string;
  size: number;
  pubDate: string | null;
  download: string;
}

export const formatSize = (bytes: number): string => `${(bytes / 1024 / 1024).toLocaleString("pt-BR", { maximumFractionDigits: 1 })} MB`;

const fill = (selector: string, text: string) => {
  for (const element of document.querySelectorAll(selector)) element.textContent = text;
};

fetch("/api/releases/latest")
  .then((response) => (response.ok ? (response.json() as Promise<LatestRelease>) : null))
  .then((release) => {
    if (!release) {
      fill("[data-release-meta]", "O download ainda não está disponível. Volte em alguns minutos.");
      for (const link of document.querySelectorAll("[data-download]")) link.setAttribute("aria-disabled", "true");
      return;
    }
    const size = formatSize(release.size);
    fill("[data-release-line]", `Versão ${release.version} para Windows 10 e 11`);
    fill("[data-release-meta]", `${size} · Grátis · 64 bits`);
    fill("[data-release-size]", size);
    fill("[data-release-version]", release.version);
    fill("[data-release-version-label]", `Versão ${release.version}`);
  })
  .catch(() => undefined); // sem rede: ficam os textos padrão, e os links de download continuam funcionando

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
