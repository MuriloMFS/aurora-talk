import { z } from "zod";
import type { IceServer } from "@aurora/schema";

/**
 * Retransmissor TURN da Cloudflare (Realtime). Quem está fora da rede do servidor chega à mídia da
 * voz por ele, sem portas abertas no roteador: o LiveKit só faz conexões de saída até a Cloudflare.
 * A chave TURN é um segredo de longo prazo e fica só no servidor; o app recebe credenciais
 * temporárias, geradas a cada entrada na voz.
 */
export interface CloudflareTurnConfig {
  keyId: string;
  apiToken: string;
  /** Validade de cada credencial, em segundos (a Cloudflare aceita até 48 h). */
  ttlSeconds?: number;
  /** Quanto esperar pela Cloudflare antes de desistir (a voz segue só com conexão direta). */
  timeoutMs?: number;
  fetch?: typeof fetch;
}

/** Gera servidores STUN/TURN para uma entrada na voz. Rejeita se o retransmissor não respondeu. */
export type IceServerSource = () => Promise<IceServer[]>;

/** Uma chamada longa não pode perder o retransmissor no meio; 24 h cobre quase todas. */
export const TURN_TTL_SECONDS = 24 * 60 * 60;
const API = "https://rtc.live.cloudflare.com/v1/turn/keys";

const iceServerShape = z.object({
  urls: z.union([z.string(), z.array(z.string())]),
  username: z.string().optional(),
  credential: z.string().optional(),
});
const responseShape = z.object({ iceServers: z.union([iceServerShape, z.array(iceServerShape)]) });

/** Endereços que o WebRTC do navegador consegue usar: STUN/TURN, fora a porta 53 (os navegadores bloqueiam). */
function usableUrl(url: string): boolean {
  if (!/^(stun|turns?):/.test(url)) return false;
  return !/:53(\?|$)/.test(url);
}

/** Normaliza a resposta da Cloudflare (`generate-ice-servers`) no formato do `RTCIceServer`. */
export function parseIceServers(body: unknown): IceServer[] {
  const parsed = responseShape.parse(body).iceServers;
  const servers: IceServer[] = [];
  for (const server of Array.isArray(parsed) ? parsed : [parsed]) {
    const urls = (Array.isArray(server.urls) ? server.urls : [server.urls]).filter(usableUrl);
    if (urls.length === 0) continue;
    const isTurn = urls.some((url) => url.startsWith("turn"));
    if (isTurn && (!server.username || !server.credential)) continue; // TURN sem credencial não serve
    servers.push({ urls, ...(server.username && { username: server.username }), ...(server.credential && { credential: server.credential }) });
  }
  if (!servers.some((server) => server.urls.some((url) => url.startsWith("turn")))) {
    throw new Error("a Cloudflare não devolveu nenhum servidor TURN utilizável");
  }
  return servers;
}

export function cloudflareTurn(config: CloudflareTurnConfig): IceServerSource {
  const doFetch = config.fetch ?? fetch;
  const url = `${API}/${encodeURIComponent(config.keyId)}/credentials/generate-ice-servers`;
  return async () => {
    const response = await doFetch(url, {
      method: "POST",
      headers: { Authorization: `Bearer ${config.apiToken}`, "Content-Type": "application/json" },
      body: JSON.stringify({ ttl: config.ttlSeconds ?? TURN_TTL_SECONDS }),
      signal: AbortSignal.timeout(config.timeoutMs ?? 3000),
    });
    if (!response.ok) {
      const hint = response.status === 401 || response.status === 403 || response.status === 404 ? " (confira o ID da chave TURN e o token da API)" : "";
      throw new Error(`a Cloudflare recusou gerar credenciais TURN: HTTP ${response.status}${hint}`);
    }
    return parseIceServers(await response.json());
  };
}
