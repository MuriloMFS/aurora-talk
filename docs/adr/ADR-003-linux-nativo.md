# ADR-003 — Linux: app nativo com motor de mídia nativo

- **Status:** **Aceita** em 2026-11-14, por decisão do dono · **Depende de:** [ADR-001](ADR-001-runtime-desktop.md), [ADR-002](ADR-002-porta-de-midia.md)

## Contexto
O dono pediu o Aurora no Linux "do jeito correto, igual ao Discord, e não o fácil": um app instalado, com voz, câmera, compartilhar tela e apertar para falar funcionando como no Windows.

O gate do ADR-001 para Linux falhou:
- **No WebKitGTK atual (2.54), o WebRTC está desligado.** O projeto está trocando o motor de WebRTC (de GStreamer para LibWebRTC). A versão nova está prevista para a série 2.56, por volta da primavera do hemisfério norte de 2027.
- **As distribuições compilam o WebKitGTK sem WebRTC.** Há relatos de `RTCPeerConnection` ausente no Arch em novembro de 2026.
- **O wry (o webview do Tauri) não liga `enable-webrtc` nem `enable-media-stream`.**
- **Consequência:** a implementação `WebRtcMediaEngine` (`livekit-client` dentro do webview) não roda no Linux.

O ADR-002 já previa essa saída: um `NativeMediaEngine` por plataforma quando um gate falhar.

A referência é o Discord no Linux: um app desktop com um módulo nativo de voz (`discord_voice`, visto no inventário do REA, doc 01) por baixo da interface web.

## Decisão
1. **App Linux nativo com Tauri**, com a mesma interface React e as mesmas regras (Rust mínimo, permissões *deny by default*, CSP estrita).
2. **Voz, vídeo e tela no Linux pelo `NativeMediaEngine` em Rust** (ADR-002):
   - **Sala:** LiveKit Rust SDK (`livekit`/`libwebrtc`), com o próprio WebRTC, sem depender do WebKitGTK.
   - **Microfone e fone:** pelo sistema de áudio do Linux (PipeWire, PulseAudio ou ALSA, via `cpal`). Escolha de dispositivo, volume, eco, supressão de ruído e ganho ficam no processamento de áudio do próprio WebRTC.
   - **Compartilhar tela:** portal `org.freedesktop.portal.ScreenCast` + PipeWire. Funciona no Wayland e no X11, com a janela padrão do sistema para escolher.
   - **Som do computador na transmissão:** fonte "monitor" do PipeWire, sem o som do próprio Aurora (sem eco das vozes da sala).
   - **Assistir às transmissões e câmeras dos outros:** os quadros decodificados chegam à interface pelo app nativo. O transporte (canal binário do Tauri + desenho em WebGL ou WebCodecs) precisa de spike com medição antes de ser escolhido.
3. **Apertar para falar global no Linux:**
   - **Wayland:** portal `org.freedesktop.portal.GlobalShortcuts`.
   - **X11:** consulta só da tecla escolhida (`XQueryKeymap`), como no Windows.
4. **Integração com o sistema:** ausente pelo tempo parado (DBus: `org.freedesktop.ScreenSaver`/`org.gnome.Mutter.IdleMonitor`), bandeja (StatusNotifierItem), notificações (`org.freedesktop.Notifications`), iniciar com o sistema (`~/.config/autostart`).
5. **Distribuição:**
   - **AppImage** com atualização automática pela mesma chave de assinatura do updater.
   - **.deb** para Debian e Ubuntu.
   - Flatpak fica para depois.
   - Toda medição de desempenho vai para `docs/spikes/`.
6. **O Windows continua com o `WebRtcMediaEngine`.** Migrar o Windows para o motor nativo só se houver ganho medido.

## Consequências
- **Positivas:**
  - paridade de funcionalidades com o Windows;
  - a interface não muda (tudo passa pelo `MediaEngine` e pelo `PlatformPort`);
  - o mesmo motor nativo serve, no futuro, ao macOS, que também tem WebRTC limitado no WKWebView.
- **Negativas:**
  - é o maior bloco de Rust do projeto, e o motor tem dois caminhos (web e nativo) para manter;
  - o binário fica maior (o `libwebrtc` pesa vários MB);
  - é preciso compilar e testar num Linux de verdade, com microfone, Wayland e X11;
  - "assistir à tela dos outros" depende do spike de transporte de quadros.
- **Contrato:** a suíte de testes de contrato do `MediaEngine` (ADR-002) passa a rodar contra as duas implementações.

## Alternativas rejeitadas
- **Versão web ou app instalável pelo navegador como substituto do app Linux:** é o caminho "fácil", recusado pelo dono. Pode existir à parte, mas não substitui o app.
- **App Linux sem voz até o WebKitGTK 2.56:** sem paridade e sem data garantida.
- **Electron no Linux:** fora, pela restrição do dono no ADR-001.
- **Embutir um WebKitGTK próprio com WebRTC:** na 2.54 o WebRTC está desligado no código, não só no build. Seria manter um fork de navegador.
- **Tauri com CEF (Chromium):** ainda experimental. Revisitar quando estiver estável, porque pode simplificar o passo 2.

## Revisitar quando
O WebKitGTK sair com o WebRTC novo ligado nas distribuições, ou o Tauri com CEF ficar estável. Nesse caso, avaliar se vale voltar ao `WebRtcMediaEngine` no Linux, comparando consumo e qualidade com medição.
