import { createReadStream, existsSync, readFileSync, statSync } from "node:fs";
import { resolve, sep } from "node:path";
import type { FastifyInstance } from "fastify";

/**
 * Atualizações do app desktop (formato "servidor dinâmico" do Tauri updater).
 * O script `scripts/release.ps1` publica em `<releasesDir>/latest.json` + `<releasesDir>/<versão>/<instalador>`.
 * O app só instala o pacote se a assinatura bater com a chave pública embutida nele.
 */
export interface ReleaseManifest {
  version: string;
  notes?: string;
  pub_date?: string;
  platforms: Record<string, { file: string; signature: string }>;
}

const VERSION = /^\d+\.\d+\.\d+$/;
const WINDOWS = "windows-x86_64";
/** Linux: o app diz como foi instalado (`?bundle=appimage|deb`), e cada um recebe o seu pacote. */
const LINUX_APPIMAGE = "linux-x86_64-appimage";
const LINUX_DEB = "linux-x86_64-deb";
const BUNDLE = /^[a-z]{2,10}$/;
const FILE = /^[A-Za-z0-9._-]+$/;

export function compareVersions(a: string, b: string): number {
  const pa = a.split(".").map(Number);
  const pb = b.split(".").map(Number);
  for (let i = 0; i < 3; i++) {
    const diff = (pa[i] ?? 0) - (pb[i] ?? 0);
    if (diff !== 0) return Math.sign(diff);
  }
  return 0;
}

function readManifest(releasesDir: string): ReleaseManifest | null {
  const path = resolve(releasesDir, "latest.json");
  if (!existsSync(path)) return null;
  try {
    const manifest = JSON.parse(readFileSync(path, "utf8")) as ReleaseManifest;
    return VERSION.test(manifest.version) && manifest.platforms ? manifest : null;
  } catch {
    return null;
  }
}

export function registerUpdateRoutes(app: FastifyInstance, releasesDir: string): void {
  const root = resolve(releasesDir);

  app.get<{ Params: { target: string; arch: string; current: string }; Querystring: { bundle?: string } }>("/api/updates/:target/:arch/:current", async (request, reply) => {
    const { target, arch, current } = request.params;
    const bundle = typeof request.query.bundle === "string" && BUNDLE.test(request.query.bundle) ? request.query.bundle : null;
    const manifest = readManifest(root);
    // o pacote do tipo de instalação (AppImage troca o arquivo; .deb instala pelo dpkg); sem tipo, o padrão
    const platform = (bundle ? manifest?.platforms[`${target}-${arch}-${bundle}`] : undefined) ?? manifest?.platforms[`${target}-${arch}`];
    if (!manifest || !platform || !VERSION.test(current) || compareVersions(manifest.version, current) <= 0) {
      return reply.status(204).send(); // já está na versão mais nova
    }
    const origin = `${request.protocol}://${request.host}`;
    return {
      version: manifest.version,
      notes: manifest.notes ?? "",
      pub_date: manifest.pub_date,
      url: `${origin}/api/updates/download/${manifest.version}/${encodeURIComponent(platform.file)}`,
      signature: platform.signature,
    };
  });

  /** Tamanho do pacote publicado (null se não existe). */
  const sizeOf = (manifest: ReleaseManifest, key: string): number | null => {
    const platform = manifest.platforms[key];
    const path = platform && FILE.test(platform.file) ? resolve(root, manifest.version, platform.file) : null;
    return path && existsSync(path) ? statSync(path).size : null;
  };

  /** Para o site: versão e tamanho de cada download (o botão "Baixar" mostra os dois). */
  app.get("/api/releases/latest", async (_request, reply) => {
    const manifest = readManifest(root);
    const size = manifest ? sizeOf(manifest, WINDOWS) : null;
    if (!manifest || size === null) {
      return reply.status(404).send({ error: { code: "not_found", message: "Ainda não há versão publicada." } });
    }
    const appImage = sizeOf(manifest, LINUX_APPIMAGE);
    const deb = sizeOf(manifest, LINUX_DEB);
    return {
      version: manifest.version,
      notes: manifest.notes ?? "",
      pubDate: manifest.pub_date ?? null,
      size,
      download: "/download/windows",
      linux:
        appImage === null && deb === null
          ? null
          : {
              appImage: appImage === null ? null : { size: appImage, download: "/download/linux" },
              deb: deb === null ? null : { size: deb, download: "/download/linux-deb" },
            },
    };
  });

  /** Links fixos do site: sempre o pacote mais novo. */
  for (const [path, key] of [
    ["/download/windows", WINDOWS],
    ["/download/linux", LINUX_APPIMAGE],
    ["/download/linux-deb", LINUX_DEB],
  ] as const) {
    app.get(path, async (_request, reply) => {
      const manifest = readManifest(root);
      const platform = manifest?.platforms[key];
      if (!manifest || !platform) return reply.status(404).send({ error: { code: "not_found", message: "Ainda não há versão publicada." } });
      return reply.header("Cache-Control", "no-cache").redirect(`/api/updates/download/${manifest.version}/${encodeURIComponent(platform.file)}`, 302);
    });
  }

  app.get<{ Params: { version: string; file: string } }>("/api/updates/download/:version/:file", async (request, reply) => {
    const { version, file } = request.params;
    const path = VERSION.test(version) && FILE.test(file) ? resolve(root, version, file) : null;
    if (!path || !path.startsWith(root + sep) || !existsSync(path) || !statSync(path).isFile()) {
      return reply.status(404).send({ error: { code: "not_found", message: "Arquivo de atualização não encontrado." } });
    }
    return reply
      .header("Content-Type", "application/octet-stream")
      .header("Content-Length", statSync(path).size)
      .header("Content-Disposition", `attachment; filename="${file}"`)
      .send(createReadStream(path));
  });
}
