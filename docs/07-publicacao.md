# 07 — Publicação (site de download + servidor na rede de casa)

## Como fica
```
Usuário (internet)
  ├─ https://aurora.<domínio>  ─┐   Cloudflare Tunnel (cloudflared, já instalado no MFS-SERVER)
  └─ wss://voz.<domínio>     ──┤
                               ▼
MFS-SERVER (Linux Mint 22.3, 192.168.50.107) — usuário mfs, sem sudo
  ├─ aurora-server  127.0.0.1:3300  site de download + API + gateway (WebSocket) + atualizações
  └─ aurora-livekit 127.0.0.1:7880  sinalização da voz/tela
                    *:7881/tcp, *:7882/udp  mídia: direto na rede local; de fora, pelo retransmissor
                                            TURN da Cloudflare (nenhuma porta aberta no roteador)
```
- O site (`apps/site`) é servido pelo próprio servidor: o mesmo endereço abre a página no navegador e é a API do app.
- `GET /download/windows` sempre entrega o instalador mais novo (`releases/latest.json`).
- Atrás do tunnel, o servidor usa o IP real do cabeçalho `CF-Connecting-IP` (limite de tentativas de login). Isso só vale com o servidor escutando em 127.0.0.1 (`AURORA_TRUST_CLOUDFLARE=1`).
- A porta 3000 do servidor é da API do MoneyTrack (Docker): o Aurora usa a **3300**.

## Site de download (`apps/site`)
- Página única, só com telas **reais** do app (`apps/site/screens`, nos temas escuro e claro), sem ilustrações genéricas nem depoimentos. Versão e tamanho do instalador vêm de `GET /api/releases/latest`.
- As imagens passam pelo Vite: o nome leva um código do conteúdo (`assets/app-dark-<hash>.webp`), então foto nova nunca fica presa no cache da Cloudflare, que guarda arquivos por 4 h. Nada vai embutido como `data:`, porque a CSP do servidor só aceita fontes e imagens do próprio site.
- Para refazer as fotos depois de mudar a interface:
  1. Em outros terminais, rode `pnpm dev:web` e `pnpm voice`.
  2. Rode `pnpm site:screens`. Ele sobe um servidor próprio com banco vazio na porta 3000, monta uma conversa de exemplo e fotografa num Edge sem janela.
  3. Rode `pnpm deploy:server`.
- A Cloudflare tenta injetar o script do Web Analytics (`static.cloudflareinsights.com`) e a CSP bloqueia. É de propósito: o site não carrega script de terceiros. Para não ver o aviso no console, desligue o Web Analytics desse hostname no painel da Cloudflare.

## Comandos (no PC de desenvolvimento)
| O quê | Comando |
|---|---|
| Autorizar a chave SSH deste PC (uma vez) | `powershell -File scripts/autorizar-ssh.ps1` |
| Gerar o app com o servidor oficial embutido | `pnpm release -- -Notes "…" -ServerUrl https://aurora.<domínio>` |
| Publicar servidor + site + instalador | `pnpm deploy:server -- -LiveKitUrl wss://voz.<domínio>` |

O `deploy:server` empacota o servidor num arquivo só (`apps/server/dist/aurora-server.mjs`), envia por SSH e roda `deploy/linux/install.sh` no servidor. O instalador:
- baixa o Node 22 e o LiveKit (versões fixas, conferidas por SHA-256);
- gera as chaves da voz na primeira vez (`~/aurora/aurora.env`, chmod 600);
- faz backup do banco antes de atualizar (guarda os 10 últimos);
- reinicia os serviços do systemd do usuário. O *linger* está ligado, então eles sobem com o PC.

No servidor: `systemctl --user status aurora-server aurora-livekit` · `journalctl --user -u aurora-server -f`.

## Cloudflare Tunnel (painel Zero Trust → Networks → Tunnels → o tunnel do MFS-SERVER → Public Hostname)
| Hostname | Serviço |
|---|---|
| `aurora.muriloferreira.dev` | `HTTP` → `localhost:3300` |
| `voz.muriloferreira.dev` | `HTTP` → `localhost:7880` |

No ar desde 2026-11-12. Teste pela internet: 13/13 — site, download do 1.3.1, atualização em https (http → 301), cadastro, convite, mensagem com menção ao vivo por wss e credencial de voz aceita pelo LiveKit.

## Voz e tela pela internet (sem abrir portas)
O tunnel leva a sinalização (WebSocket), mas **não a mídia** (UDP/TCP do WebRTC). Abrir 7881/tcp e 7882/udp no roteador resolveria, mas a decisão foi **não abrir nada**: quem está fora da rede chega à mídia pelo **retransmissor TURN da Cloudflare** (Realtime → TURN Server).

Como funciona:
- O app recebe, junto com o token da voz (`POST /api/channels/:id/voice`), credenciais TURN **temporárias (24 h)** geradas pelo servidor na hora (`apps/server/src/turn.ts`). A chave TURN de longo prazo fica só no `~/aurora/aurora.env`.
- O WebRTC testa os caminhos em paralelo e fica com o melhor: quem está em casa vai direto ao servidor; quem está fora, pela Cloudflare.
- O LiveKit só faz conexões **de saída** até a Cloudflare. A resposta volta pela mesma conexão, então o roteador e o `ufw` continuam fechados.
- O retransmissor só aceita pacotes do **IP público anunciado** pelo LiveKit. Por isso o `aurora-ipwatch.timer` continua importante: confere o IP a cada 5 minutos, pela Cloudflare, e reinicia a voz se ele mudar.
- Se a Cloudflare não responder, a entrada na voz segue sem retransmissor (só quem está em casa conecta) e o servidor registra um aviso no log.

Ligar, trocar ou desligar a chave (no PC de desenvolvimento):
```bash
ssh -t mfs@192.168.50.107 bash ~/aurora/bin/configurar-turn.sh
ssh mfs@192.168.50.107 bash ~/aurora/bin/configurar-turn.sh --desligar
```
O script pede o *Turn Token ID* e o *API Token*, confere com a Cloudflare e reinicia o servidor. `GET /api/health` mostra `"voiceRelay": true` quando está ligado.

Custos e limites (Cloudflare, conferido em 2026-11-12): os primeiros 1.000 GB por mês de saída da Cloudflare para os clientes são grátis; depois, US$ 0,05/GB. Cada cliente aguenta de 50 a 100 Mbps. A credencial dura no máximo 48 h: uma chamada mais longa que as 24 h configuradas pode cair e reconectar.

**Medido em 2026-11-12** (detalhes em `docs/spikes/medicao-voz-retransmissor.md`): forçando tudo pelo retransmissor, a tela em 1080p (cerca de 4,5 Mbps) e a voz passaram **sem perda de pacotes**, com ida e volta de **7 a 10 ms**. A medição foi feita de dentro da rede de casa; para quem está fora, some o trajeto da pessoa até a Cloudflare. Com o app 1.3.2, quem está em casa continua indo direto ao servidor, com 0 a 1 ms.

Outros cuidados:
- **Recomendado:** reservar o IP 192.168.50.107 para o servidor no DHCP do roteador.
- O LiveKit anuncia o IP da rede local (`advertise_internal_ip`, para quem está em casa) e o IP público. As redes do Docker não entram como candidatos.
