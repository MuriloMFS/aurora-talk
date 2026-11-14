# ADR-001 — Runtime do app desktop (desktop-first, sem Electron)

- **Status:** **Aceita e definitiva** — em 2026-11-12 o dono confirmou Tauri sem condições e **cancelou o spike S2–S6** (os gates G1–G3 e os orçamentos de RAM da §7 deixam de bloquear; ficam como referência). Proposta em 2026-11-08.
- **Decide:** em que base técnica o app instalável (`.exe`/instalador) é construído.
- **Relacionados:** [ADR-002 — porta de mídia](ADR-002-porta-de-midia.md) · `docs/03-arquitetura.md` · `docs/04-roadmap.md`

## 1. Contexto e requisitos
O produto passa a ser **desktop-first**: o primeiro entregável é um **instalador** que instala, abre, atualiza sozinho e conversa com o backend. O dono pediu **mais eficiência que Electron**.

**Restrições declaradas pelo dono:** não usar Electron · eficiência é requisito, não "bônus" · app instalável (tipo `.exe`).
**Requisitos do produto (do inventário, doc 02):**
1. Voz/vídeo/**compartilhar tela com áudio**, PTT **global** (inclusive botões do mouse), supressão de ruído — com LiveKit (SFU).
2. UI rica: lista virtualizada de 50 mil+ mensagens, Markdown, emoji, embeds, grade de mídia, i18n, **acessibilidade** (leitor de tela).
3. SO: bandeja (mutar/ensurdecer), badge, notificações, autostart, instância única, *deep link*, **atualização automática assinada**.
4. Windows primeiro; mac/Linux e mobile depois. **Linux:** decidido em 2026-11-14 no [ADR-003](ADR-003-linux-nativo.md) (app nativo com motor de mídia nativo).
5. Time e ferramentas atuais em **TypeScript**; o guia visual já define tokens em CSS.

## 2. Fatos (verificados) e premissas (não verificadas)
**Verificado nesta máquina** (Windows 11, Ryzen 7 5700X, 15,9 GB): Node 22 e Python 3.12 presentes; **não há** Rust, Go, Flutter, .NET utilizável nem Visual Studio Build Tools; **WebView2 Runtime 157.0.4341.42 já instalado**. A instalação do Discord (Electron) ocupa **471 MB** em disco (`Discord.exe` 224 MB). Verificado em 2026-11-12: **Docker 29.6.2 + Compose v5.3.1** e WSL presentes; winget 1.29; recurso VBScript instalado (necessário para MSI).
**Verificado em fontes:**
- WebRTC em **WebKitGTK (Linux)** historicamente exigiu build customizado e X11 — [tauri#2600](https://github.com/tauri-apps/tauri/issues/2600), [discussão #8426](https://github.com/tauri-apps/tauri/discussions/8426). `getDisplayMedia` é o ponto mais incerto.
- **WKWebView (macOS)**: `getDisplayMedia` com problemas de permissão/seletor — [wry#1196](https://github.com/tauri-apps/wry/pull/1196), [WebKit 271688](https://bugs.webkit.org/show_bug.cgi?id=271688).
- **WebView2 (Windows)** é Chromium e expõe o evento [`ScreenCaptureStarting`](https://learn.microsoft.com/es-es/dotnet/api/microsoft.web.webview2.core.corewebview2.screencapturestarting) para o app interceptar `getDisplayMedia` (seletor próprio).
- **Tauri + CEF** existe só como runtime **alpha** ligado ao Tauri 3 — [tauri-runtime-cef](https://github.com/SableClient/tauri-runtime-cef). Não serve para produção hoje.
- **LiveKit Flutter** suporta Android, iOS, Web, macOS, Windows e Linux, com compartilhamento de tela — [pub.dev](https://pub.dev/documentation/livekit_client). **LiveKit Rust** lista Windows/macOS/Linux/iOS/Android e acesso a quadros de vídeo, mas **captura de tela e dispositivos de áudio não constam no README** — [rust-sdks](https://github.com/livekit/rust-sdks).
- **Tauri 2**: atalho global entrega `Pressed` e `Released` (serve para PTT por teclado); **botões de mouse e tecla-modificadora isolada não estão documentados** — [plugin](https://v2.tauri.app/plugin/global-shortcut/). O instalador oferece WebView2 via bootstrapper (+0 a 1,8 MB), offline (+127 MB) ou versão fixa (+180 MB); Win10 (abr/2018+) e Win11 já trazem o runtime — [docs](https://v2.tauri.app/distribute/windows-installer/).
- **Benchmarks Tauri×Electron**: blogs com números **conflitantes** (ex.: 409 MB × 172 MB em 6 janelas, ou 30–50 × 200–300 MB ocioso) e sem teste independente rigoroso no Windows. **Não usar como base.** O ganho **consistente** é disco/instalador e processo principal; o renderer no Windows é Chromium nos dois casos.
- **Flutter no Windows**: acessibilidade via UI Automation (Narrator/NVDA) documentada — [anúncio](https://flutter.dev/blog/announcing-flutter-for-windows); sem benchmark rigoroso de RAM de app de chat.
**Evidência do REA:** o próprio Discord é **UI web + módulos nativos** (`discord_voice` ~22 MB, `discord_utils` com captura global de input, Krisp, overlay) — o padrão "UI web + núcleo nativo de mídia/entrada" é comprovado em escala (doc 01).
**Premissas:** pontuações abaixo são **julgamento de arquiteto** informado pelos fatos; **nenhum número de RAM/CPU** foi medido ainda (será no spike S2).

## 3. Opções
| | Opção | Resumo |
|---|---|---|
| A | Electron | referência (excluída pela restrição do dono) |
| B | **Tauri 2 + WebView do SO** | shell Rust, UI React; WebRTC do próprio WebView |
| C | Tauri 2 + núcleo de mídia nativo | B + motor de mídia em Rust (LiveKit Rust SDK) |
| D | Flutter (Dart) | UI nativa compilada; desktop + mobile; `livekit_client` |
| E | UI nativa Rust (Slint/egui/iced) | máxima eficiência, UI e mídia a construir |
| F | Tauri + CEF | Chromium embutido com shell Rust (alpha) |
Descartadas sem teste: .NET/WinUI/Avalonia/MAUI (WinUI é só Windows; sem SDK LiveKit .NET verificado), Wails v3 (mesmas limitações de WebView do Tauri, ecossistema menor), Electrobun/Neutralino (imaturos).

## 4. Critérios e pontuação (1–5; peso em %)
Pesos do cenário base: **Voz 25 · Eficiência 20 · Velocidade/skills TS 15 · UI rica+a11y 15 · Multiplataforma 10 · Integração SO 10 · Maturidade 5**.
| Opção | Voz | Efic. | Dev | UI | Multi | SO | Matur. | **Base** | Linux/mac tier-1* | Eficiência máx.** |
|---|---|---|---|---|---|---|---|---|---|---|
| A Electron | 5 | 2 | 5 | 5 | 4 | 4 | 5 | **4,20** | 4,45 | 3,75 |
| **B Tauri 2 + WebView** | 4 | 4 | 4 | 5 | 3 | 4 | 4 | **4,05** | 3,10 | **4,00** |
| C Tauri 2 + mídia nativa | 4 | 4 | 2 | 5 | 4 | 5 | 3 | 3,90 | 3,95 | 3,95 |
| D Flutter | 4 | 4 | 2 | 4 | 5 | 3 | 4 | 3,70 | 3,95 | 3,80 |
| F Tauri + CEF (alpha) | 5 | 3 | 3 | 5 | 4 | 4 | 1 | 3,90 | 3,95 | 3,70 |
| E Rust nativo | 3 | 5 | 1 | 2 | 3 | 4 | 2 | 3,00 | 3,05 | 3,45 |
\* pesos Multi 25 / Voz 25 / Efic. 15 / Dev 10 / UI 10 / SO 10 / Matur. 5 e notas de voz/multi ajustadas por plataforma (A: multi 5; B: voz 2, multi 2; C: voz 4, multi 4). \*\* Efic. 35 / Voz 20 / demais menores.

**Leitura honesta:** sem a restrição "não usar Electron", o Electron **empata ou vence** no cenário base (diferença de 0,15 está dentro do erro de uma nota subjetiva). Com a restrição do dono, **B é a melhor opção no cenário base e no de eficiência**. Se **Linux/macOS forem tier-1 desde o dia 1**, B cai e passam a valer **C** ou **D** (e F quando estável).

## 5. Decisão
**Adotar B — Tauri 2 (Rust + WebView2 no Windows) com UI em React/TypeScript — protegida por uma porta de mídia (ADR-002).**
Motivos (arquiteto):
1. **Reversibilidade barata.** UI em tecnologia web + camada fina de plataforma ⇒ trocar Tauri por Electron (ou por CEF quando estável) **não reescreve a UI**. Flutter/Rust nativo seriam portas de mão única (reescrita).
2. **O risco real (WebRTC fora do Windows) fica isolado** atrás de `MediaEngine`: no Windows usamos o WebRTC do WebView2 (Chromium); onde falhar, trocamos só essa implementação (núcleo Rust/LiveKit ou CEF).
3. **Atende ao pedido de eficiência onde o ganho é comprovado** (instalador e processo principal) e deixa claro **onde não é**: o renderer continua Chromium no Windows — o ganho grande de RAM virá de **como construímos** a UI (virtualização, pipeline de imagens, nada de re-render global) e de mídia nativa, medidos no spike.
4. Reaproveita TypeScript, o guia visual (tokens CSS) e o plano atual.
5. Windows primeiro é coerente com a máquina/uso do dono e com o WebView2 já presente.

**Runner-up (D, Flutter)** — escolher se, depois do spike, (a) eficiência de RAM em regime for decisiva e B não bater o orçamento, ou (b) mobile + Linux/mac forem tier-1 e se aceitar Dart/reescrita da UI.

## 6. Consequências
- **Rust entra na stack**, mas **só como cola nativa** (`apps/desktop/src-tauri`): janela, tray, atalhos/input global, notificações, updater, instância única, *deep link*, captura nativa (se necessária). Meta: manter pequeno e testado.
- **Segurança:** permissões/capabilities do Tauri em modo *deny by default*, CSP estrita, comandos IPC por lista permitida, atualizador com assinatura, **certificado de assinatura de código** para o instalador (SmartScreen). A chave do atualizador (`tauri signer generate`) fica **fora do repositório** e nunca é commitada; sem certificado, builds de teste mostram aviso do SmartScreen.
- **PTT global com mouse** exige gancho de baixo nível em Rust (o plugin só documenta teclado).
- **Instalador:** NSIS (`-setup.exe`) e MSI; WebView2 por `downloadBootstrapper` (padrão, 0 MB) com opção offline.
- **Web vira alvo de desenvolvimento/teste** (Vite + Playwright), não produto, até decisão contrária; a UI nunca chama Tauri direto — usa a porta `PlatformPort` (`tauri` | `browser`).
- **mac/Linux:** não prometer paridade antes de testes de WebRTC/captura de tela por plataforma (S3/S4 repetidos).

## 7. Orçamentos de performance (propostos — calibrar no spike S2)
| Métrica | Orçamento proposto | Referência |
|---|---|---|
| Instalador (NSIS, bootstrapper) | ≤ 25 MB | Discord instalado: 471 MB (medido) |
| Instalado (sem runtime do SO) | ≤ 60 MB | idem |
| Início a frio até janela interativa | ≤ 1,5 s | medir também a build de controle em Electron |
| RAM ociosa (família de processos: app + `msedgewebview2`), 1 servidor/50 canais | ≤ 200 MB (working set) | calibrar com controle |
| RAM em chamada só de áudio | ≤ 280 MB | calibrar |
| CPU ocioso (média 60 s) | ≤ 1 % | |
| Rolagem em lista de 50 mil mensagens | p95 de quadro ≤ 16,7 ms | |
| Vazamento em soak de 4 h | ≤ 20 MB/h | |
Medir **somando todos os processos filhos** (working set e memória privada), sempre cold e warm separados.

> **Medição S1 (2026-11-12, esqueleto vazio):** instalador 1,45 MB e instalado 3,40 MB ✅. RAM ociosa **395–413 MB de working set / ~210 MB privada** ❌ acima do orçamento de 200 MB. Quase tudo vem dos processos do WebView2; o `aurora.exe` usa 28 MB. Os orçamentos de RAM acima foram propostos sem medição e **serão recalibrados no S2** contra a build de controle em Electron, antes de decidir o gate G2. Detalhes: [S1](../spikes/S1-esqueleto-instalavel.md).

## 8. Critérios de falha (kill criteria) e gates
- **G1 (S3/S4 no WebView2 falham):** se não houver áudio/vídeo estável ou compartilhamento de tela com seletor próprio → avaliar **C** (mídia nativa) ou **F** (CEF, quando estável); fallback temporário **A** exige decisão explícita do dono (viola o requisito de eficiência).
- **G2 (S2 estoura ≥ 30 % os orçamentos mesmo otimizado):** reabrir D (Flutter) com spike equivalente.
- **G3 (S5):** se PTT global por mouse tiver latência > 30 ms ou falhar com jogo em primeiro plano → módulo nativo dedicado (Rust, hook de baixo nível) antes de seguir.
- **Revisitar** este ADR se: Tauri CEF sair do alpha, WebKitGTK/WKWebView resolverem WebRTC/captura, o dono priorizar Linux/mac, ou surgir benchmark independente que contradiga os orçamentos.

## 9. Plano do spike (3–5 dias, esqueleto "de verdade")
| # | Experimento | Aprovado se |
|---|---|---|
| S1 | **Esqueleto instalável**: Tauri 2 + React/Vite; gerar NSIS e MSI; instalar, abrir, atualizar (updater assinado), desinstalar | instala sem erros em Windows limpo; tamanho dentro do orçamento |
| S2 | **Eficiência**: lista virtualizada de 50 mil mensagens + 300 avatares; mesmo UI numa build **Electron de controle**; medir arranque, RAM (família de processos), CPU, quadros | dentro dos orçamentos §7; relatório com os números lado a lado |
| S3 | **Voz**: sala LiveKit (via Docker, já instalado) com 2 clientes; seleção de dispositivos, eco/AGC, RNNoise (WASM) | áudio estável 30 min, sem estouro de CPU |
| S4 | **Tela**: `getDisplayMedia` no WebView2 com `ScreenCaptureStarting` + seletor próprio; **áudio do sistema/aplicativo** | 1080p30 estável; áudio capturado; fallback nativo (WASAPI por processo) mapeado |
| S5 | **PTT global**: teclado (plugin) + botões do mouse (hook Rust), com jogo em primeiro plano | acionamento ≤ 30 ms, sem perder `release` |
| S6 | **Integração SO**: tray (mutar/ensurdecer), ícone de overlay/badge na barra de tarefas, notificações, autostart, instância única, `aurora://`, assinatura do instalador | todos funcionam em Windows 10 e 11 |

Cada experimento registra números brutos, conclusão e situação do gate em `docs/spikes/S<n>-<tema>.md`.

## 10. Pré-requisitos de instalação (autorizados em 2026-11-12)
| # | Item | Comando | Notas |
|---|---|---|---|
| 1 | **VS 2022 Build Tools** + carga C++ (`VCTools`, com Windows SDK) | `winget install --id Microsoft.VisualStudio.2022.BuildTools -e --override "--quiet --wait --norestart --add Microsoft.VisualStudio.Workload.VCTools --includeRecommended"` | 2022 (17.x) por ser a combinação mais testada com Rust; a 2026 (18.x) também existe no winget. Licença: uso individual ok; se virar empresa, verificar a licença do Visual Studio |
| 2 | **Rust** (rustup, toolchain MSVC) | `winget install --id Rustlang.Rustup -e` e depois `rustup default stable-msvc` | reiniciar o terminal para atualizar o PATH |
| 3 | **pnpm** | `corepack enable pnpm` | ✅ feito: pnpm 12.18.0 |
| 4 | NSIS/WiX | baixados pelo empacotador do Tauri na 1ª build | MSI exige VBScript (✅ presente) |
| 5 | LiveKit (S3) | Docker Compose | ✅ Docker 29.6.2 presente |
WebView2 **já está** instalado (157.0.4341.42). Requisitos conforme a [página oficial](https://v2.tauri.app/start/prerequisites/).
