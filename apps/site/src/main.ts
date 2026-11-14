import "@fontsource-variable/inter";
import "@fontsource/jetbrains-mono/latin-400.css"; // só o alfabeto latino (cobre o português)
import "@aurora/ui/tokens.css";
import "./site.css";

/* ---------- versão publicada: tamanho e número reais, vindos do servidor ---------- */
interface LinuxPackage {
  size: number;
  download: string;
}
interface LatestRelease {
  version: string;
  size: number;
  pubDate: string | null;
  download: string;
  linux?: { appImage: LinuxPackage | null; deb: LinuxPackage | null } | null;
}

const onLinux = /Linux/i.test(navigator.userAgent) && !/Android/i.test(navigator.userAgent);

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
    fill("[data-release-version-label]", `Versão ${release.version}`);
    const appImage = release.linux?.appImage ?? null;
    const deb = release.linux?.deb ?? null;
    if (onLinux && appImage) {
      // no Linux, o botão principal é o AppImage (roda em qualquer distribuição)
      for (const link of document.querySelectorAll("[data-download]")) link.setAttribute("href", appImage.download);
      fill("[data-download-label]", "Baixar para Linux");
      fill("[data-release-meta]", `Linux · AppImage · ${formatSize(appImage.size)}`);
      showOther(`Também em .deb (Ubuntu, Debian, Mint)${deb ? ` · ${formatSize(deb.size)}` : ""}`, deb?.download, "Windows 10 e 11", release.download);
    } else {
      fill("[data-release-meta]", `Windows 10 e 11 · ${formatSize(release.size)}`);
      if (appImage) showOther("Também para Linux: AppImage", appImage.download, deb ? ".deb" : null, deb?.download);
    }
  })
  .catch(() => undefined); // sem rede: ficam os textos padrão, e os links de download continuam funcionando

/** Linha "também para…" embaixo do botão: até dois links. */
function showOther(firstText: string, firstHref: string | undefined, secondText: string | null, secondHref: string | undefined): void {
  for (const line of document.querySelectorAll<HTMLElement>("[data-download-other]")) {
    line.replaceChildren();
    const add = (text: string, href: string | undefined) => {
      if (!href) return;
      if (line.childNodes.length) line.append(" · ");
      const a = document.createElement("a");
      a.href = href;
      a.textContent = text;
      line.append(a);
    };
    add(firstText, firstHref);
    if (secondText) add(secondText, secondHref);
    line.hidden = line.childNodes.length === 0;
  }
}

/* ---------- Windows e Linux por enquanto ---------- */
if (!/Windows/i.test(navigator.userAgent) && !onLinux) document.getElementById("platform-note")?.removeAttribute("hidden");
