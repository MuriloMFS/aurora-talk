# ADR-002 — Porta de mídia (`MediaEngine`) e porta de plataforma (`PlatformPort`)

- **Status:** **Aceita** em 2026-11-12 (proposta em 2026-11-08) · **Depende de:** [ADR-001](ADR-001-runtime-desktop.md)

## Contexto
O maior risco do ADR-001 é **WebRTC/captura de tela fora do Windows** (WebKitGTK e WKWebView). O Discord resolve isso com **módulos nativos de voz e entrada** sob uma UI web (evidência do REA, doc 01). Precisamos do mesmo grau de liberdade **sem pagar a complexidade agora**.

## Decisão
Definir duas interfaces em TypeScript (pacote `packages/platform`) e **nunca** chamar APIs do Tauri/WebRTC direto da UI:

### `PlatformPort` — o app e o SO
`window` (minimizar/fixar no topo/PiP), `tray` (estados, mutar/ensurdecer), `badge`, `notifications` (com ação), `idle` (tempo ocioso → status "ausente"), `autostart`, `deepLink`, `updater` (checar/baixar/aplicar), `clipboard` (imagem/arquivo), `shortcuts` (global; teclado **e** botões do mouse), `captureSources` (listar telas/janelas). Implementações: **`tauri`** (produto) e **`browser`** (dev/Playwright, com *stubs*).

### `MediaEngine` — voz, vídeo e tela
`join(room, token)`, `leave()`, `setMic/Deafen`, `selectDevices`, `setNoiseSuppression/Echo/AGC`, `setUserVolume/Pan`, `startScreenShare(source, {audio})`, `stopScreenShare()`, `setPtt(active)`, eventos (`speaking`, `connectionQuality`, `participants`, `error`). Implementações:
1. **`WebRtcMediaEngine`** *(v1, Windows)* — `livekit-client` rodando no WebView2 (Chromium).
2. **`NativeMediaEngine`** *(só se um gate do ADR-001 falhar, por plataforma)* — núcleo em Rust com LiveKit Rust SDK; captura de tela/áudio nativas (ex.: Windows.Graphics.Capture, WASAPI por processo) e quadros enviados à UI.
Seleção **por detecção de capacidade** na inicialização (existência/funcionamento de `getUserMedia`, `getDisplayMedia`, *insertable streams*), com *override* por configuração.

## Consequências
- **Positivas:** trocar o motor por plataforma sem tocar na UI; testes de UI com `browser` + `MediaEngine` falso; E2EE (SFrame/MLS) entra como detalhe do motor.
- **Negativas:** disciplina para não "vazar" APIs; as interfaces precisam ser pequenas e estáveis. Risco de *over-engineering* ⇒ **só implementar `NativeMediaEngine` se um gate falhar**.
- **Contrato testável:** suíte de testes de contrato executada contra todas as implementações.

## Alternativas rejeitadas
- UI chamando `livekit-client` e Tauri direto (acoplamento; troca vira reescrita).
- Construir o motor nativo já na v1 (custo alto sem evidência de necessidade no Windows).
