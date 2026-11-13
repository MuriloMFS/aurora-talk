import type { MediaCredentials } from "./index";

/**
 * Configuração do WebRTC para a sala de voz. Com retransmissor (TURN), o WebRTC testa todos os
 * caminhos em paralelo e fica com o melhor: direto ao servidor quando dá (mesma rede), pelo
 * retransmissor quando não dá (internet, sem portas abertas no roteador do servidor).
 * Sem retransmissor, `undefined`: vale o que o próprio LiveKit anunciar.
 */
export function rtcConfigFor(credentials: Pick<MediaCredentials, "iceServers">): RTCConfiguration | undefined {
  const iceServers = credentials.iceServers
    ?.filter((server) => server.urls.length > 0)
    .map((server) => ({ ...server, urls: [...server.urls] }));
  if (!iceServers?.length) return undefined;
  return { iceServers };
}
