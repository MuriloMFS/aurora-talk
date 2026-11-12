# 01 — Descobertas do REA (engenharia reversa estática)

> Data da análise: 2026-11-08 · Alvo: Discord Desktop **1.0.9267** (canal stable, Windows x64) · Ferramenta: `rea-agents` 6.5.0 (`C:\Users\Administrador\Documents\rea`).

## 1. O que foi feito (e o que NÃO foi)

O REA é um CLI/MCP de engenharia reversa **local**. Aqui ele foi usado só para **descobrir recursos** (inventário), nunca para copiar código.

| # | Alvo | Comando REA | Resultado |
|---|------|-------------|-----------|
| A | `app.asar` (shell Electron) | `analyze-javascript-application` | 5 arquivos, 980 módulos, 0 falhas de parse. Evidence `ev_2e361bdef557561fa30f6de77fcb518595542fd043f6a4993d419390d592bf57` (sha256 do asar `279124b3…bf8f7`) |
| B | `discord_desktop_core/core.asar` | `analyze-javascript-application` + `extract-artifact` | 503 módulos, 2 preloads, `contextBridge` chave `DiscordNative`. sha256 `acde9b22…4257` |
| C | 17 módulos nativos (`modules/*`) | leitura dos `index.js`/manifests (JS legível; `.node` **não** decompilados) | mapa de capacidades de voz, overlay, RPC, jogos etc. |
| D | Cliente web público (`https://discord.com/login`, **sem login**) | `list-browser-targets` + `analyze-web-bundle` (Chrome headless descartável, só observação passiva) | 726 scripts, 4,81 M nós AST, 0 falhas, cobertura "complete". Evidence `ev_55dde0fef6a452e777d494ba747792740403091725a371ab1231c2ce1784bd38` |
| E | Documentação oficial de desenvolvedores (repositório `discord/discord-api-docs`) | download dos `.mdx` + script de extração de tabelas | enums e catálogos **oficiais** (fonte mais confiável deste inventário) |

**Não foi feito / limites honestos**
- Nada foi executado do Discord; não houve login, token, nem leitura de `%APPDATA%\discord` (dados do usuário).
- O REA **não conseguiu parear canais IPC** (os nomes são dinâmicos via `getDiscordIPCEvent`) e `DiscordNative` aparece com membros "desconhecidos". Para listar as capacidades do shell, extraí as **constantes `*_*` de eventos IPC por busca textual** nos arquivos extraídos — isso é inferência por texto, não grafo do REA.
- No bundle web, só o que carrega na tela de login foi observado (chunks lazy do app logado não). Os "endpoint candidates" são **de baixa confiança** (strings próximas de chamadas `get/post`), não um inventário de rotas.
- `.node`/DLLs nativos **não** foram analisados; as funções deles vêm dos wrappers JS e nomes de arquivo.
- Cópia extraída temporária do `core.asar` foi apagada; nada do código/assets do Discord foi guardado neste projeto.

## 2. Achados por camada

### 2.1 Shell desktop (observado)
- **Electron + webpack**; `main = bundle.js`; janela de *splash* com preload próprio.
- Telemetria/diagnóstico: Sentry + OpenTelemetry (baggage/traceparent), métricas de *time-to-interactive* ("Desktop TTI"), crash reporter, minidumps.
- **Atualizador em duas camadas** (host + módulos nativos baixados sob demanda): flags `UPDATE_ENDPOINT`, `NEW_UPDATE_ENDPOINT`, `SKIP_HOST_UPDATE`, `SKIP_MODULE_UPDATE`, `USE_PINNED_UPDATE_MANIFEST`, `ALWAYS_BOOTSTRAP_MODULES`, `USE_LOCAL_MODULE_VERSIONS`.
- Configurações do desktop: `START_MINIMIZED`, `MINIMIZE_TO_TRAY`, `enableHardwareAcceleration`, `chromiumSwitches`, `openH264Enabled`, `enableConferenceMode`, `MIN_WIDTH/MIN_HEIGHT`, `WINDOW_BOUNDS`, `IS_MAXIMIZED`.
- O desktop **carrega o app web remoto** (`WEBAPP_ENDPOINT`/`WEBAPP_PATH`) — o cliente "nativo" é basicamente o web app + a ponte `DiscordNative`. **Implicação:** a UI pode ser feita com tecnologia web mesmo num app nativo, desde que a ponte nativa seja bem definida. Este projeto aplica isso **desktop-first** com Tauri ([ADR-001](adr/ADR-001-runtime-desktop.md)).

### 2.2 Ponte `DiscordNative` — capacidades nativas (constantes IPC extraídas)
| Área | Capacidades vistas |
|------|--------------------|
| Janela | minimizar/maximizar/fullscreen, **always-on-top**, **PiP de documento** (`WINDOW_OPEN_DOCUMENT_PIP`), *content protection* (anti-captura), limitar frame-rate, background throttling, flash na barra, barra de progresso, semáforos macOS, `GET_MEDIA_SOURCE_ID` (seleção de janela p/ compartilhar) |
| Bandeja/Dock/Taskbar | ícone/estados/strings, **mutar/ensurdecer pela bandeja**, abrir config de voz, badge numérico, bounce do dock, botões na miniatura (Thumbar) |
| Notificações | enviar/limpar/remover, status de autorização, resposta a notificação, módulo nativo (macOS) / impl. JS (Windows) |
| Energia/sistema | tempo ocioso do sistema (status "ausente"), lock/unlock/suspend/resume, impedir sleep de tela (ex.: stream), CPU/GPU/sistema/métricas |
| Arquivos/Clipboard | diálogos abrir/salvar, mostrar na pasta, copiar/colar **imagem/arquivo/texto** |
| Ortografia | dicionários disponíveis, idiomas, palavras aprendidas, substituir erro |
| Auth moderna | **WebAuthn/Passkeys** (registrar/autenticar/sinalizar credenciais) |
| Voz | arquivos de gravação de **mensagem de voz** |
| Ciclo de vida | relaunch, abrir no login do SO, instalação/atualização de módulos nativos, histórico do updater |
| Acessibilidade/GPU | leitor de tela ativo?, hwaccel on/off, switches do Chromium |

### 2.3 Módulos nativos (17)
| Módulo | Papel (inferido pelo wrapper JS/nome) |
|--------|----------------------------------------|
| `discord_voice` | Motor de voz/vídeo **próprio** (~22 MB) + `mediapipe.dll` (⇒ provável **segmentação para fundo de vídeo/blur**, inferência pelo nome) |
| `discord_media` | Estatísticas/analytics de mídia e memória |
| `discord_krisp` | **Supressão de ruído** (modelos NC) + **VAD** (modelos) |
| `discord_hook`, `discord_overlay2`, `discord_desktop_overlay` | **Overlay dentro de jogos** (DLLs de hook x86/x64, host/preload de overlay com *feature flags*, backoff) |
| `discord_rpc` | **RPC local**: *named pipe* `discord-ipc` + **WebSocket** (lib `ws`) — bate com `topics/rpc` dos docs |
| `discord_dispatch` + `discord_cloudsync` | Instalar/atualizar jogos e **saves em nuvem** (`/applications/{id}/branches/{id}/storage`) |
| `discord_game_utils`, `discord_utils` | **Detecção de jogos** (callback de candidatos), polling de processos, **captura de input global/atalhos (keybinds)**, portal Wayland |
| `discord_notifications` | notificações nativas |
| `discord_spellcheck` | dicionários (manifest ~31 KB) |
| `discord_erlpack`, `discord_zstd` | **Gateway**: codificação ETF + compressão zstd |
| `discord_modules` | auxiliar (DLLs "aegis"; função **não determinada**) |

### 2.4 API do motor de voz (wrapper JS do `discord_voice`)
Funcionalidades visíveis pelos nomes dos métodos:
- **E2EE de áudio/vídeo com MLS** (`prepareSecureFramesTransition/Epoch`, `getMLSKeyPackage`, `processMLSWelcome/Proposals/Commit`, `getMLSPairwiseFingerprint`) — corresponde ao protocolo **DAVE** descrito nos docs oficiais.
- **Controle por usuário**: volume local, mute local, **pan estéreo**, **posição espacial** (`setUserPosition`), A/V sync, desabilitar vídeo de um usuário, prioridade de fala.
- **Go Live / compartilhamento de tela**: `setDesktopSource(WithOptions)`, `setGoLiveDevices`, **soundshare** (áudio da aplicação), callbacks de fim/falha, fallback de encoder/decoder de vídeo.
- **Replay/Clips**: `startReplay`, `setClipRecordUser`.
- **Soundboard / amostras locais**: `startSamplesLocalPlayback`, `stopAllSamplesLocalPlayback`.
- **PTT** (`setPTTActive`), detecção de "falando mudo" (`OnSpeakingWhileMuted`), mute/deafen nativos.
- **Resiliência**: reconexão UDP rápida, retries configuráveis, ping/stats, `getEncryptionModes`.

### 2.5 Cliente web (baixa confiança — pistas, não inventário)
726 scripts; vendor React. Chaves/identificadores que sugerem módulos de produto **além** dos docs: `shop_*` e `powerupId/powerupSkuId` (loja/"powerups"), `checkout*` (pagamentos), `clips_*`, `explicit_media_redaction_*` (filtro de mídia sensível), `private_channel_obfuscation` (≙ flag `CHANNEL_OBFUSCATED`), `idle_status_indicator`, `handoff_token` (login por handoff/QR), `UserSettingsStore/UserSettingsSync`, `OverlayStore` (versões até 6), `MediaEngineStore`, `RTCRegionStore`, `EmojiUsageHistory`, `PromotionsPersistedStore`, `ACTIVITIES_FORCE_PUBLIC` (Activities), parâmetros OAuth2 com PKCE (`code_challenge`), conexões `twitch`/`xbox`.

### 2.6 Catálogos oficiais (docs) — contagens extraídas por script
| Catálogo | Quantidade |
|----------|-----------|
| Tipos de canal | 13 (texto, DM, voz, grupo DM, categoria, anúncio, 3 tipos de thread, stage, diretório, fórum, mídia) |
| Permissões (bitfield) | **52** |
| Tipos de mensagem | 37 |
| Flags de mensagem | 13 (inclui voz, snapshot/forward, components v2) |
| Features de guild | 33 |
| Eventos de audit log | 71 |
| Triggers de AutoMod | 5 (keyword, spam, preset, mention spam, perfil) · 4 ações |
| Tipos de componente | 20 |
| Eventos do gateway | ~80 eventos recebidos + 7 comandos de envio (contagem por títulos dos docs) |
| Serviços de conexão de conta | 23 (Spotify, Steam, GitHub, YouTube, Twitch, Xbox, Bluesky …) |

Os detalhes viram a matriz do arquivo `02-inventario-de-recursos.md`.

## 3. Como reproduzir
```bash
cd C:\Users\Administrador\Documents\rea
node scripts/rea.mjs analyze-javascript-application "<...>\app-1.0.9267\resources\app.asar" --format json --integrity-policy record-and-continue
node scripts/rea.mjs extract-artifact "<...>\modules\discord_desktop_core-1\discord_desktop_core\core.asar" --format json
# web: abrir Chrome headless com --remote-debugging-port=9333 em https://discord.com/login
node scripts/rea.mjs list-browser-targets http://127.0.0.1:9333
node scripts/rea.mjs analyze-web-bundle http://127.0.0.1:9333 <targetId> --observation-ms 8000 --format json
```
Para ampliar (opcional, fase futura): usar `capture-browser-scenario` com conta **de teste sua** para mapear telas do app logado (somente observação, sem automatizar abuso) e `compare-application-versions` para acompanhar novidades entre versões.

## 4. Nota de uso responsável
Este material serve como **inventário de funcionalidades** para um produto **original**. Não copie código, strings de UI, assets, nome, logos ou marca do Discord (veja `docs/04-roadmap.md` §Legal). O DISCLAIMER do REA veda cópia de software proprietário e adulteração de serviços online; os Termos do Discord também restringem engenharia reversa do serviço — por isso esta etapa ficou limitada a análise estática de artefatos públicos e docs oficiais.
