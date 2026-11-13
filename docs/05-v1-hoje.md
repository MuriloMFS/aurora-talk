# 05 — Versão 1.0 (entrega do dia 2026-11-12)

> Decisão do dono (2026-11-12): **Tauri é definitivo** e o spike de medição (S2–S6) foi **cancelado**. Objetivo: uma **1.0 usável hoje**. Este documento troca o escopo do M1/M2 do roadmap por um **MVP de chat de texto em tempo real** que funciona de ponta a ponta.

## O que a 1.0 faz
| Área | Incluído |
|---|---|
| Conta | cadastro e login (usuário + senha), sessão persistente, sair |
| Servidores | criar servidor (já vem com `#geral`), gerar convite, entrar por código de convite |
| Canais | canais de texto; o dono cria canais |
| Mensagens | enviar, editar e apagar as próprias (o dono também apaga as dos outros); histórico com "carregar anteriores"; até 2000 caracteres |
| Tempo real | mensagens, canais, membros novos, presença online/offline e "digitando…" chegam por WebSocket; reconexão automática com aviso na tela |
| Membros | lista por **online/offline** |
| App | instalador Windows (NSIS/MSI), tema escuro/claro/sistema, indicador de canal não lido |

## Entregue depois da 1.0 (mesmo dia)
- **1.0.1 — atualização automática assinada** ([docs/06](06-atualizacoes.md)).
- **1.1.0 — canais de voz**: entrar/sair, mutar, ensurdecer, ver quem está na sala e quem está falando; reentra sozinho se a conexão cair. Servidor de mídia **LiveKit** local (`pnpm voice`), atrás da porta `MediaEngine` (ADR-002). Testado com áudio real entre o app Tauri e um segundo cliente (21/21 passos). Ainda sem escolha de microfone na interface (usa o padrão do Windows) e sem compartilhar tela.
- **1.1.1** — microfone/câmera liberados **sem a caixa de permissão** do WebView2, como no Discord: o app concede a permissão só às próprias telas (`tauri.localhost`; `localhost:1420` em desenvolvimento), e qualquer outra origem continua perguntando. Atualização com o app aberto vira um **botão de download no topo**.

**Voz na rede local:** o LiveKit precisa das portas **7880 (TCP)**, **7881 (TCP)** e **7882 (UDP)** liberadas no firewall do PC que roda `pnpm voice` (o Windows pergunta na primeira vez — permita em redes privadas). Para testar sozinho com duas instâncias no mesmo PC, use fone de ouvido (com caixa de som vira microfonia).

- **1.2.0** — **compartilhar tela**: o seletor nativo do WebView2 ("janela" ou "tela inteira", com opção de **áudio do sistema**); selo **AO VIVO** para todos do servidor; palco "Assistir transmissão" com tela cheia; parar pela barra do sistema também avisa todos. Testado entre dois clientes (vídeo 1920×1080 recebido). O seletor ainda aparece em inglês (idioma padrão do WebView2).

- **1.2.1** — tela **"Transmitir sua tela"** no padrão do Aurora antes do seletor do sistema:
  - **o que mostrar:** tela inteira ou uma janela, abrindo o seletor já na aba certa; "uma janela" esconde a aba de telas;
  - **qualidade:** leve 720p 30 fps · padrão 1080p 30 fps · fluida 1080p 60 fps;
  - a última escolha fica lembrada.

  Outras mudanças:
  - **Seletor do sistema e menus do WebView2 em português** (`--lang=pt-BR` em `additionalBrowserArgs`, mantendo os argumentos padrão do Tauri).
  - **Vídeo e áudio publicados separados:** se o áudio do sistema falhar, a tela continua no ar e o painel de voz avisa.
  - **Erros explicados no próprio diálogo**, sem esconder o painel de voz.
  - **Verificação:** 15/15 no WebView2 real, com a janela fora da tela.
    - A seleção automática "Tela inteira" só casa com o seletor em pt-BR.
    - A tela chegou ao palco em 1920×1080.
    - Erro de áudio e cancelamento foram tratados.

  **Limite:** a janela de escolha (miniaturas de janelas e telas) é do WebView2 e não pode ser redesenhada nem dispensada:
  - escolher a fonte por código (`chromeMediaSourceId`, o caminho do Electron) falha no WebView2;
  - o evento `ScreenCaptureStarting` só permite cancelar.

  Um seletor 100% próprio exigiria captura nativa (Windows.Graphics.Capture) entregue ao WebRTC.

- **1.2.2** — **som do computador na transmissão, sem eco**, capturado nativamente (Rust, `src-tauri/src/system_audio.rs`).

  Por que nativo — medido nesta máquina (WebView2 / Edge 157, headset Logitech PRO X em 7.1, 8 canais a 44,1 kHz):
  - O áudio do sistema via `getDisplayMedia` **falha** com `NotReadableError: Could not start audio source`. Era o erro relatado na tela inteira com "áudio do sistema" ligado, ligado a saídas multicanal.
  - O modo `restrictOwnAudio` **entrega só zeros**.
  - O loopback WASAPI nativo funciona.

  Como funciona:
  - Usa o **loopback por processo** do Windows (10 2004+), excluindo o **processo navegador do WebView2** (`BrowserProcessId`).
  - **Medido:** o Windows exclui só o processo-alvo e os **filhos diretos**.
    - Excluir o aurora.exe deixava passar o serviço de áudio, que é neto dele.
    - Excluir o navegador do WebView2 tira as vozes da sala.
  - O áudio sai em PCM float 48 kHz estéreo, em blocos de 20 ms, por um `Channel` do Tauri. Vira trilha WebRTC via `MediaStreamTrackGenerator` (`PlatformPort.captureSystemAudio`).
  - É publicado como `ScreenShareAudio` em estéreo.
  - No navegador (dev), continua o áudio do seletor, com `restrictOwnAudio` quando houver.

  Na interface:
  - Nova chave **"Transmitir o som do computador"** no diálogo, ligada por padrão.
  - O seletor do sistema deixa de oferecer áudio.

  **Verificado no WebView2 real (11/11):**
  - Tom de 19,5 kHz de outro programa entra na trilha (−63 dB).
  - Tom de 18 kHz tocado pelo próprio app fica de fora (−160 dB; antes da correção do alvo, −68 dB = eco).
  - Trilha enviada ao servidor de voz (~65 KB em 2 s).
  - Parar encerra a captura; com a chave desligada, só imagem.

- **1.3.0** — **conversa completa**:
  - **Responder:** a linha "respondendo a…" leva à original, a original apagada aparece marcada, e quem é respondido é mencionado.
  - **Reações:** emoji Unicode, até 20 diferentes por mensagem, ao vivo, otimistas no app; o seletor guarda os recentes.
  - **@menções:** sugestões no compositor (setas, Enter/Tab, Esc). O texto guarda `<@id>`, e o servidor só aceita membros. A mensagem que menciona você fica destacada.
  - **Markdown próprio**, montado como árvore e nunca como HTML: negrito, itálico, sublinhado, riscado, spoiler, código, bloco de código, citação, links e escape com `\`.
    - Os links abrem no navegador padrão, só `http(s)`.
  - **Não lidas e menções guardadas no servidor** (`read_states`, `POST /api/channels/:id/ack`):
    - valem em todos os aparelhos;
    - quem entra num servidor não vê o histórico antigo como não lido;
    - o que você envia já conta como lido;
    - o canal aberto só conta como lido com a janela em foco.
  - **Integração com o Windows:**
    - notificação quando mencionarem você fora de vista;
    - o ícone pisca;
    - selo com o total de menções sobre o ícone da barra de tarefas;
    - instância única, em que abrir de novo ou clicar na notificação traz a janela aberta.
    - Plugins oficiais `notification`, `opener` e `single-instance`, com permissões mínimas em `capabilities/default.json`.
  - **Compatibilidade:** o gateway agora tem versão de protocolo (`identify.v = 2`). Apps 1.2.x não recebem os eventos novos, que quebrariam o reducer antigo, e o reducer novo ignora eventos desconhecidos.
- **1.3.1** — publicação: site de download e servidor oficial no ar pelo Cloudflare Tunnel (`docs/07-publicacao.md`); o app já vem apontando para ele.
- **1.3.2** — **voz e tela pela internet sem abrir portas**:
  - O servidor gera credenciais temporárias (24 h) do retransmissor TURN da Cloudflare a cada entrada na voz (`apps/server/src/turn.ts`) e as manda junto com o token. A chave fica só no servidor (`deploy/linux/configurar-turn.sh`).
  - O app passa os servidores ao LiveKit (`packages/platform/src/ice.ts`). O WebRTC escolhe sozinho: direto na rede de casa, pelo retransmissor de fora.
  - Se a Cloudflare falhar, a voz segue só com conexão direta. `GET /api/health` mostra `voiceRelay`.
  - Medido só pelo retransmissor: tela 1080p e voz sem perda, ida e volta de 7 a 10 ms (`docs/spikes/medicao-voz-retransmissor.md`).
- **1.4.0** — **configurações e sons de feedback** (detalhes em `docs/08-configuracoes.md`):
  - Tela de configurações em tela cheia (engrenagem no painel do usuário ou Ctrl+,): Minha conta, Voz e vídeo, Sons, Notificações, Aparência, Acessibilidade, Atalhos de teclado, Idioma, Windows e Avançado.
  - Sons próprios (sintetizados, sem arquivos) ao entrar e sair da voz, quando alguém entra ou sai da sala, ao mutar, ensurdecer, transmitir e ao ser mencionado.
  - Bandeja do Windows, fechar para a bandeja, abrir com o Windows e iniciar minimizado.
  - Servidor: mudar o nome de exibição (ao vivo, `USER_UPDATE`) e trocar a senha.

- **1.4.1** — mesma 1.4.0, recompilada: o instalador 1.4.0 foi acusado pelo Defender (falso positivo `Bearfoos.A!ml`). O `pnpm release` agora só publica instalador aprovado pelo Defender ([06](06-atualizacoes.md)).

## O que fica para depois (ordem sugerida)
escolha de microfone/fone · DMs e amigos · anexos e prévia de links · cargos e permissões (pacote `permissions` do doc 03) · lista virtualizada para canais grandes · servidor hospedado (VPS) com HTTPS · depois, o restante do roadmap.

## Desvios conscientes da arquitetura alvo (dívida registrada)
| Alvo (doc 03) | Na 1.0 | Por quê / como migrar |
|---|---|---|
| PostgreSQL + Redis + NATS | **SQLite embutido do Node** (`node:sqlite`), fan-out em memória, 1 processo | zero instalação e zero serviços; trocar o módulo `db` por Postgres e o fan-out por NATS quando houver mais de 1 servidor |
| Argon2id | **scrypt** (`node:crypto`) | sem dependência nativa; scrypt é aceito pela OWASP; migrar com *rehash* no login |
| Snowflake 64 bits | ID ordenado no tempo **de 53 bits** (ms desde 2026 × 1024 + sequência), exposto como **string** | cabe em `number`; a API já usa string, então a troca para 64 bits não muda o cliente |
| RESUME com replay | reconexão refaz o `READY` | simples e correto para poucos usuários |
| Cargos e 52 permissões | **dono × membro** | o pacote de permissões entra na 1.2 |
| Token no cofre do SO | token em `localStorage` do WebView | trocar por keychain/Stronghold na 1.6 |
| Lista virtualizada | lista comum + paginação de 50 | suficiente até alguns milhares de mensagens por canal |
| Servidor hospedado | servidor na máquina do dono | amigos na mesma rede usam `http://<IP-do-PC>:3000`; internet exige VPS ou túnel (1.6) |

## Arquitetura da 1.0
```
apps/desktop (Tauri + React) ──REST /api/*──►  apps/server (Fastify, Node 22)
            ▲                 ──WS   /gateway──►     ├─ node:sqlite  → data/aurora.db
            └──── eventos (DISPATCH) ◄──────────────┘  └─ fan-out em memória por servidor
packages/schema — tipos compartilhados (objetos da API e eventos do gateway)
```

## Como rodar
```bash
pnpm install
pnpm server            # API + gateway em http://localhost:3000 (dados em apps/server/data)
pnpm dev               # app desktop em modo desenvolvimento
pnpm build:desktop     # instalador 1.0.0
```
Para amigos na mesma rede: libere a porta 3000 no firewall do Windows e, na tela de login, use `http://<IP-do-PC>:3000`.

## Pronto quando (verificado em 2026-11-12)
- [x] Dois usuários conversam em tempo real (mensagem, edição, exclusão, digitando, presença) — UI + segundo usuário via API
- [x] Convite funciona entre contas diferentes
- [x] Reconexão automática após reiniciar o servidor — teste automático `reconnect.test.ts`
- [x] Teste de integração do servidor (REST + WebSocket) passando — `server.test.ts`
- [x] Typecheck e testes verdes — **43 testes** em 5 pacotes; servidor repetido 3× sem instabilidade
- [x] Instalador 1.0.0 gerado (NSIS **1,45 MB**, MSI 1,93 MB), instala e desinstala; o app real conecta ao servidor (CSP e CORS ok)

## Testes realizados
| Camada | Como | Resultado |
|---|---|---|
| Servidor | Vitest: integração REST + WebSocket com 3 usuários (cadastro, login, convite, mensagens, permissões, digitando, presença, paginação, logout), unidades (IDs, scrypt, limitador), reconexão do cliente do app | 21/21 |
| App | Vitest: reducer do estado (não lidas, ordem, deduplicação, edição/exclusão, digitando, reconexão), agrupamento de mensagens, tema, plataforma, contrato | 22/22 |
| Ponta a ponta (navegador) | interface com a "Ana" + script Node como "Bruno" | digitando, mensagem, edição e presença ao vivo nos dois sentidos |
| Ponta a ponta (app Tauri real) | WebView2 dirigido por CDP numa build só de teste (mesmo código e CSP; só liga a porta de depuração) | **15/15**: CSP/CORS, WebSocket, cadastro, convite, enviar, editar, apagar com confirmação, diálogo, membros, tema, sair |

Bugs achados e corrigidos durante os testes: diálogo ficava atrás do fundo escurecido (cliques fechavam o modal); botões de editar/apagar não recebiam clique sem hover prévio; corrida no desligamento do servidor (gateway consultava o banco já fechado); campos do login sem rótulo explícito; texto do convite apontava para um botão com outro nome.

## Começar a usar (passo a passo)
1. **Apague os dados de teste:** pare o servidor de teste e apague a pasta `apps/server/data` (só tem contas fictícias criadas durante os testes).
2. **Ligue o servidor e a voz:** `pnpm server` e, em outro terminal, `pnpm voice` (deixe as duas janelas abertas; na primeira vez, o Windows pergunta sobre o firewall — permita em **redes privadas** para amigos na mesma rede).
3. **Instale o app:** `apps/desktop/src-tauri/target/release/bundle/nsis/Aurora_1.0.0_x64-setup.exe`. Sem certificado de código, o SmartScreen mostra um aviso ("Mais informações" → "Executar assim mesmo").
4. **Crie sua conta** (servidor `http://localhost:3000`), crie um servidor e use **Convidar pessoas** para gerar um código.
5. **Amigos na mesma rede:** instalam o mesmo `.exe` e, no login, usam `http://<IP-do-seu-PC>:3000` (o servidor mostra esse endereço ao ligar).
