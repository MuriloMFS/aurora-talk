import { createReadStream, existsSync, statSync } from "node:fs";
import { extname, resolve, sep } from "node:path";
import type { FastifyInstance, FastifyReply } from "fastify";

/**
 * Site público (página de download), servido pelo próprio servidor do Aurora: o mesmo endereço
 * abre o site no navegador e é a API do app. Arquivos de `apps/site/dist` (gerados pelo Vite).
 */
const TYPES: Record<string, string> = {
  ".html": "text/html; charset=utf-8",
  ".css": "text/css; charset=utf-8",
  ".js": "text/javascript; charset=utf-8",
  ".svg": "image/svg+xml",
  ".png": "image/png",
  ".ico": "image/x-icon",
  ".webp": "image/webp",
  ".woff2": "font/woff2",
  ".woff": "font/woff",
  ".txt": "text/plain; charset=utf-8",
  ".webmanifest": "application/manifest+json",
};

/** Só nomes simples (sem "..", barras invertidas, nulos): o caminho resolvido tem de ficar dentro da pasta. */
const SAFE_PATH = /^[A-Za-z0-9._\-/]+$/;

/** Cabeçalhos de segurança do site (o app desktop tem a própria CSP no Tauri). */
const SECURITY_HEADERS: Record<string, string> = {
  "Content-Security-Policy":
    "default-src 'self'; script-src 'self'; style-src 'self'; img-src 'self' data:; font-src 'self'; connect-src 'self'; object-src 'none'; base-uri 'self'; form-action 'self'; frame-ancestors 'none'",
  "X-Content-Type-Options": "nosniff",
  "Referrer-Policy": "strict-origin-when-cross-origin",
  "Permissions-Policy": "camera=(), microphone=(), geolocation=()",
};

export function registerSiteRoutes(app: FastifyInstance, siteDir: string): void {
  const root = resolve(siteDir);
  if (!existsSync(resolve(root, "index.html"))) {
    app.log.warn(`site não encontrado em ${root}: a página de download fica desligada`);
    return;
  }

  const send = (reply: FastifyReply, path: string) => {
    const type = TYPES[extname(path).toLowerCase()];
    if (!type) return reply.status(404).send({ error: { code: "not_found", message: "Página não encontrada." } });
    // arquivos com hash no nome (assets/) nunca mudam; o HTML sempre é revalidado
    const cache = path.includes(`${sep}assets${sep}`) ? "public, max-age=31536000, immutable" : "no-cache";
    for (const [name, value] of Object.entries(SECURITY_HEADERS)) reply.header(name, value);
    return reply.header("Content-Type", type).header("Content-Length", statSync(path).size).header("Cache-Control", cache).send(createReadStream(path));
  };

  app.get("/", async (_request, reply) => send(reply, resolve(root, "index.html")));

  app.get<{ Params: { "*": string } }>("/*", async (request, reply) => {
    const wanted = request.params["*"];
    if (wanted.startsWith("api/") || wanted === "gateway") return reply.callNotFound();
    const path = SAFE_PATH.test(wanted) && !wanted.includes("..") ? resolve(root, wanted) : null;
    if (path && path.startsWith(root + sep) && existsSync(path) && statSync(path).isFile()) return send(reply, path);
    return reply.callNotFound();
  });
}
