import { describe, expect, it } from "vitest";
import { rtcConfigFor } from "./ice";

describe("retransmissor da voz (TURN)", () => {
  it("sem retransmissor, deixa o LiveKit decidir (conexão direta)", () => {
    expect(rtcConfigFor({})).toBeUndefined();
    expect(rtcConfigFor({ iceServers: [] })).toBeUndefined();
    expect(rtcConfigFor({ iceServers: [{ urls: [] }] })).toBeUndefined();
  });

  it("com retransmissor, passa os servidores e mantém o caminho direto liberado", () => {
    const iceServers = [
      { urls: ["stun:stun.cloudflare.com:3478"] },
      { urls: ["turn:turn.cloudflare.com:3478?transport=udp", "turns:turn.cloudflare.com:443?transport=tcp"], username: "u", credential: "c" },
    ];
    const config = rtcConfigFor({ iceServers });
    expect(config).toEqual({ iceServers });
    expect(config?.iceTransportPolicy).toBeUndefined(); // "all": quem está na mesma rede segue direto
    expect(config?.iceServers?.[1]?.urls).not.toBe(iceServers[1]!.urls); // cópia: o LiveKit pode mexer
  });
});
