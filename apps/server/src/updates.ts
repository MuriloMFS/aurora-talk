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

  app.get<{ Params: { target: string; arch: string; current: string } }>("/api/updates/:target/:arch/:current", async (request, reply) => {
    const { target, arch, current } = request.params;
    const manifest = readManifest(root);
    const platform = manifest?.platforms[`${target}-${arch}`];
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
