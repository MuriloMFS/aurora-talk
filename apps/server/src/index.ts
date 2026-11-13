import { networkInterfaces } from "node:os";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { Gateway } from "./gateway.ts";
import { SERVER_VERSION, buildApp } from "./http.ts";
import { Store } from "./store.ts";
import { cloudflareTurn } from "./turn.ts";

const port = Number(process.env.AURORA_PORT ?? 3000);
const host = process.env.AURORA_HOST ?? "0.0.0.0"; // 0.0.0.0 permite acesso pela rede local
const dbPath = process.env.AURORA_DB ?? fileURLToPath(new URL("../data/aurora.db", import.meta.url));
const releasesDir = process.env.AURORA_RELEASES ?? fileURLToPath(new URL("../releases", import.meta.url));
const siteDir = process.env.AURORA_SITE ?? fileURLToPath(new URL("../../site/dist", import.meta.url));
const trustCloudflare = process.env.AURORA_TRUST_CLOUDFLARE === "1";
if (trustCloudflare && host !== "127.0.0.1") {
  console.error("AURORA_TRUST_CLOUDFLARE=1 exige AURORA_HOST=127.0.0.1 (senão o IP real pode ser forjado). Saindo.");
  process.exit(1);
}

const store = new Store(dbPath);
const gateway = new Gateway(store);
// Voz: LiveKit local em modo dev usa a chave "devkey"/"secret". Em produção (deploy/linux) as
// chaves vêm do arquivo de ambiente do servidor, geradas na instalação.
const voice = {
  apiKey: process.env.LIVEKIT_API_KEY ?? "devkey",
  apiSecret: process.env.LIVEKIT_API_SECRET ?? "secret",
  url: process.env.AURORA_LIVEKIT_URL ?? "",
};
// Retransmissor TURN da Cloudflare (voz pela internet sem abrir portas): os dois valores vêm do
// painel da Cloudflare (Realtime → TURN Server) e ficam só no arquivo de ambiente do servidor.
const turnKeyId = process.env.CLOUDFLARE_TURN_KEY_ID?.trim();
const turnApiToken = process.env.CLOUDFLARE_TURN_API_TOKEN?.trim();
const turn = turnKeyId && turnApiToken ? cloudflareTurn({ keyId: turnKeyId, apiToken: turnApiToken }) : undefined;
const filesDir = join(dirname(dbPath), "files");
const app = await buildApp({ store, gateway, logger: true, releasesDir, voice, turn, siteDir, filesDir, trustCloudflare });

await app.listen({ port, host });

// só faz sentido mostrar endereços da rede quando o servidor escuta em todas as interfaces
const lan = host !== "0.0.0.0" ? [] : Object.values(networkInterfaces())
  .flat()
  .filter((net) => net && net.family === "IPv4" && !net.internal)
  .map((net) => `http://${net!.address}:${port}`);

console.log(`\nAurora servidor ${SERVER_VERSION}`);
console.log(`  Neste PC:        http://${host === "0.0.0.0" ? "localhost" : host}:${port}`);
for (const url of lan) console.log(`  Na rede local:   ${url}`);
console.log(`  Banco de dados:  ${dbPath}`);
console.log(`  Atualizações:    ${releasesDir}`);
console.log(`  Site:            ${siteDir}`);
console.log(`  Voz pela internet: ${turn ? "retransmissor TURN da Cloudflare ligado" : "sem retransmissor (só conexão direta à mídia)"}`);
console.log("  Ctrl+C para parar.\n");

const shutdown = async () => {
  await app.close();
  store.close();
  process.exit(0);
};
process.on("SIGINT", shutdown);
process.on("SIGTERM", shutdown);
