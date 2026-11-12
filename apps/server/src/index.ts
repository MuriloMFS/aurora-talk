import { networkInterfaces } from "node:os";
import { fileURLToPath } from "node:url";
import { Gateway } from "./gateway.ts";
import { SERVER_VERSION, buildApp } from "./http.ts";
import { Store } from "./store.ts";

const port = Number(process.env.AURORA_PORT ?? 3000);
const host = process.env.AURORA_HOST ?? "0.0.0.0"; // 0.0.0.0 permite acesso pela rede local
const dbPath = process.env.AURORA_DB ?? fileURLToPath(new URL("../data/aurora.db", import.meta.url));
const releasesDir = process.env.AURORA_RELEASES ?? fileURLToPath(new URL("../releases", import.meta.url));

const store = new Store(dbPath);
const gateway = new Gateway(store);
// Voz: LiveKit local em modo dev usa a chave "devkey"/"secret" (troque em produção).
const voice = {
  apiKey: process.env.LIVEKIT_API_KEY ?? "devkey",
  apiSecret: process.env.LIVEKIT_API_SECRET ?? "secret",
  url: process.env.AURORA_LIVEKIT_URL ?? "",
};
const app = await buildApp({ store, gateway, logger: true, releasesDir, voice });

await app.listen({ port, host });

const lan = Object.values(networkInterfaces())
  .flat()
  .filter((net) => net && net.family === "IPv4" && !net.internal)
  .map((net) => `http://${net!.address}:${port}`);

console.log(`\nAurora servidor ${SERVER_VERSION}`);
console.log(`  Neste PC:        http://localhost:${port}`);
for (const url of lan) console.log(`  Na rede local:   ${url}`);
console.log(`  Banco de dados:  ${dbPath}`);
console.log(`  Atualizações:    ${releasesDir}`);
console.log("  Ctrl+C para parar.\n");

const shutdown = async () => {
  await app.close();
  store.close();
  process.exit(0);
};
process.on("SIGINT", shutdown);
process.on("SIGTERM", shutdown);
