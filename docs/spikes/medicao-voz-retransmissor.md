# Medição — voz e tela pelo retransmissor TURN (2026-11-12)

Pergunta: dá para ter voz e tela pela internet **sem abrir portas no roteador**, e quanto isso custa em latência?
Resposta: dá. Forçando tudo pelo retransmissor da Cloudflare, a tela em 1080p e a voz passaram sem perda de pacotes, com ida e volta de 7 a 10 ms (medida feita de dentro da rede de casa).

## Rede do servidor (MFS-SERVER)
| Medição | Resultado | Como |
|---|---|---|
| Até a Cloudflare em São Paulo (GRU) | 6,6 ms ida e volta, 0% de perda | `ping -c 10 turn.cloudflare.com` (`colo=GRU` no `cdn-cgi/trace`) |
| Até o roteador | 0,6 ms | `ping -c 10 192.168.50.1` |
| Placa de rede | cabo, 1 Gbps (`enp1s0`) | `/sys/class/net/*/speed` |
| Upload da internet | de 39 a 131 Mbps, variando bastante | 5 envios de 25–40 MB para `speed.cloudflare.com/__up` (2 leituras de 478 e 620 Mbps descartadas: duraram menos de 0,7 s) |

## Teste da voz (Edge sem janela, áudio mudo, 2 participantes na mesma página)
Feito do PC de desenvolvimento, na mesma rede do servidor. Sinalização pelo endereço público (`wss://voz.muriloferreira.dev`, pelo tunnel). Um participante publica um tom de 18 kHz e uma "tela" 1080p desenhada em canvas, com até 5 Mbps; o outro recebe. Os números vêm do `getStats()` do WebRTC.

| Caminho | Conectou em | Ida e volta | Tela recebida | Perda | Voz |
|---|---|---|---|---|---|
| **Só retransmissor** (`iceTransportPolicy: "relay"`, como alguém de fora sem portas abertas) | 1,3–1,8 s | 7–10 ms | 1920×1080, 23–28 fps, 4,5–4,7 Mbps | 0 pacotes | 99 kbps, jitter 1 ms, 0 perda |
| **Como o app 1.3.2** (retransmissor disponível, escolha livre) | 0,43–0,49 s | 0–1 ms | 1920×1080, 27–29 fps, 3,7–4,4 Mbps | 0 pacotes | 99 kbps, jitter 0–1 ms, 0 perda |

- Pelo retransmissor, o par escolhido foi `relay` (TURN em UDP 3478) no app e o IP público anunciado pelo LiveKit (177.36.170.142:7882) no servidor. Nenhuma porta foi aberta no roteador nem no `ufw`.
- Com o retransmissor disponível, quem está na rede de casa continua indo direto (`host` 192.168.50.107:7882).
- Sem permissão de microfone, o navegador esconde o IP local (mDNS) e a conexão direta falhou. No app isso não acontece, porque o microfone é liberado pelo próprio app.

## Limites desta medição
- Medida **de dentro da rede de casa**: o caminho pelo retransmissor foi PC → Cloudflare (GRU) → servidor. Para quem está fora, some o trajeto da pessoa até o datacenter da Cloudflare mais próximo. Falta medir com alguém de fora de verdade.
- O vídeo foi codificado por software (Edge sem janela e sem placa de vídeo): os quadros por segundo refletem a CPU do teste, não a rede.
- Upload de casa: cada pessoa assistindo a uma tela recebe uma cópia vinda do servidor (5 Mbps no "Padrão", 8 Mbps no "Fluido"). No pior valor medido (39 Mbps), dá umas 7 pessoas no "Padrão".
