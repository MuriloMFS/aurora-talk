# 13 — Aurora no Linux (app nativo)

Decisão em [ADR-003](adr/ADR-003-linux-nativo.md): app Tauri nativo com voz, câmera e tela pelo `NativeMediaEngine` em Rust (LiveKit Rust SDK + PipeWire), como o Discord faz no Linux. Não é versão web.

## Fases
Cada fase termina com testes, medição registrada em `docs/spikes/` e uma versão publicada.

### L0 — Base no Linux
- **Ambiente de build e teste:** decisão pendente (abaixo). Sem ele, nenhuma fase anda.
- **O app Tauri compilando no Linux:**
  - com chat, busca, notificações, bandeja, iniciar com o sistema e ausente pelo tempo parado (DBus);
  - o motor de mídia avisa "voz em preparação no Linux", em vez de falhar calado.
- **Implementações no `PlatformPort` (tauri):** `getIdleSeconds`, `setBadge` e `requestAttention` no Linux.
- **Pacotes:**
  - `.AppImage` e `.deb` assinados;
  - o servidor passa a servir as atualizações para `linux-x86_64`;
  - o site ganha "Baixar para Linux";
  - o `release` ganha o passo de Linux.
- **CI:** build e testes no Linux a cada commit.

### L1 — Voz nativa
- **`NativeMediaEngine` com o LiveKit Rust SDK:**
  - entrar, sair e reconectar;
  - mudo e ensurdecer;
  - indicador de quem fala;
  - permissões e moderação, que já vêm na credencial do servidor.
- **Áudio do sistema:**
  - microfone e fone pelo `cpal` (PipeWire/Pulse/ALSA), com escolha de dispositivo e troca no meio da chamada;
  - volume do microfone e de quem fala;
  - eco, ruído e ganho pelo processamento do WebRTC, com os mesmos perfis do Windows.
- **Ponte com a interface:** comandos Tauri e eventos (`speaking`, `state`, `participants`), na mesma interface `MediaEngine` em TypeScript. A seleção do motor é por capacidade, como no ADR-002.
- **Testes:**
  - contrato do `MediaEngine` contra as duas implementações;
  - roteiro numa sala real com o LiveKit local;
  - medição de atraso de áudio e de CPU.

### L2 — Apertar para falar global
- Wayland: portal `GlobalShortcuts`, com o sistema perguntando a tecla.
- X11: consulta só da tecla (`XQueryKeymap`).
- Medição com o mesmo gate do Windows: ≤ 30 ms, sem perder o "soltar".

### L3 — Assistir às transmissões
- **Spike:** transporte dos quadros decodificados do Rust para a interface (canal binário do Tauri + WebGL ou WebCodecs). Medir CPU, atraso e quadros por segundo em 720p30, 1080p30 e 1080p60, e escolher com números.
- Depois, o palco de transmissões igual ao do Windows.

### L4 — Compartilhar tela
- Portal `ScreenCast` + PipeWire (Wayland e X11), com as mesmas qualidades (720p30, 1080p30, 1080p60).
- Som do computador pela fonte "monitor" do PipeWire, sem o som do próprio Aurora.

### L5 — Acabamento
- Câmera, quando a fase C do [doc 11](11-voz-e-video.md) existir. O mesmo motor serve.
- Testes em Ubuntu LTS, Fedora e Arch, com GNOME e KDE, no Wayland e no X11.
- Revisão de tamanho e consumo contra o orçamento do ADR-001.

## Decisões que precisam de você
1. ~~Onde compilar e testar no Linux~~: a máquina Linux do servidor (escolhida em 2026-11-14). O teste de voz e de tela precisa de um Linux com área de trabalho e microfone. Opções:
   - um PC ou notebook com Linux, de preferência Ubuntu 24.04 ou mais novo;
   - WSL2 neste PC, mais o build automático no GitHub. O WSL serve para compilar, mas é fraco para testar áudio e tela;
   - o servidor Linux de produção, só para compilar. Não é recomendado: ele roda o Aurora no ar.
2. **Distribuições-alvo da primeira versão:** proposta: Ubuntu 24.04+ e Fedora 40+, com AppImage para as demais.

## Situação
Decidido e planejado em 2026-11-14.

**Máquina Linux de build e teste:** a mesma do servidor (`mfs@192.168.50.107`), por escolha do dono, acessada por SSH com chave.
- Linux Mint 22.3 (base Ubuntu 24.04), Cinnamon com sessão gráfica (Wayland e X11), PipeWire, 2 entradas de áudio.
- 4 núcleos, 14 GB de RAM.
- Builds rodam com `nice -n 19`, para não pesar no Aurora que está no ar.
- Rust 1.100 instalado no usuário (rustup).
- Faltam os pacotes do sistema (precisam de `sudo`, o dono roda).
- **Desde a voz nativa (1.16.0):** o WebRTC do LiveKit exige **clang 21 ou mais novo** para compilar, e o Ubuntu 24.04 traz o 18. Na máquina do servidor, o `apt.llvm.org` não entregava nada (0 bytes/s); por isso, o clang 21.1.8 oficial do LLVM foi instalado do GitHub em `~/dev/llvm-21`, sem `sudo`, com o SHA-256 conferido. O `build-linux.ps1` usa essa pasta ou um `clang-21+` do sistema, e para com uma mensagem clara se não houver nenhum.
- **Processador antigo (AMD A10-7700K, sem AVX2):** o TypeScript 7 e o Vite (compiladores nativos) quebram com "Illegal instruction". Nessa máquina, a interface é gerada no Windows e só a parte nativa é compilada lá.

**Segunda máquina de teste (Kali):** `mfs@192.168.50.112`, notebook Dell G15.
- Kali Rolling (Debian testing), Xfce com X11 (e Wayland), PipeWire, microfone e alto-falante do notebook.
- Core i5-11400H com AVX2, 12 núcleos lógicos, 31 GB: compila tudo direto.
- Rust 1.100 e Node 22 instalados no usuário. Os pacotes do sistema precisam de `sudo`.

## Progresso
**L0 — parte 1 (2026-11-14):**
- **Build:** o app compila no Linux.
  - Kali: build completo em 2 min 05 s. Servidor (Mint): 6 min 38 s com `nice`, com a interface gerada no Windows.
  - Gera `Aurora_1.15.0_amd64.AppImage` (81 MB no Mint, 108 MB no Kali, porque leva o WebKitGTK junto) e `.deb` (3,7 MB).
- **Correções para o Linux:**
  - selo de menções pelo contador do lançador (`set_badge_count`); o Windows continua com a imagem sobre o ícone;
  - "ausente" pelo tempo parado: Cinnamon (Muffin), GNOME (Mutter), KDE (ScreenSaver) ou extensão do X11, em `src-tauri/src/linux_idle.rs`;
  - motor de voz escolhido por capacidade: sem WebRTC no WebKitGTK, a voz avisa "chega com o motor de voz nativo" em vez de falhar calada (`UnavailableMediaEngine`).
- **Testado no Kali (Xfce/X11), com o AppImage e um servidor Aurora de teste local:**
  - login e conexão em tempo real (online);
  - mensagem com acento e emoji;
  - enviar mensagem;
  - busca sem acento;
  - clicar na sala de voz mostra o aviso;
  - 252 testes e 6 testes Rust passam no Linux.
- **Confirmado na prática:** o WebKitGTK 2.52 do Kali não tem `RTCPeerConnection` (ADR-003).
- **Não verificado:**
  - o valor real do tempo parado no Xfce (o teste só confere que ele é plausível);
  - a bandeja e as notificações;
  - o `.deb` instalado.

**L0 — fechada na 1.15.1 (2026-11-14):**
- **Atualização automática assinada:** o build é no Linux e a assinatura no PC ([doc 06](06-atualizacoes.md)). O servidor manda o pacote pelo tipo de instalação (`?bundle=appimage|deb`).
- **Site:** "Baixar para Linux". No Linux, o botão principal vira o AppImage, com o `.deb` ao lado. As perguntas frequentes dizem que a voz ainda não chegou.
- **CI** (`.github/workflows/linux.yml`): tipos, testes TypeScript e Rust, e o `.deb` gerado no Ubuntu 24.04 a cada envio.
- **Testado:** atualização real de 1.15.0 para 1.15.1 no Kali, com o app compilado no Mint, que abriu no Kali.
- **Ainda não verificado:**
  - a bandeja e as notificações no Linux;
  - instalar e atualizar pelo `.deb`;
  - a CI rodando no GitHub (só roda depois do commit e do push).

**L1 — voz nativa, entregue na 1.16.0 (2026-11-14):**
- **Motor:** `src-tauri/src/native_media.rs` (LiveKit Rust 0.11 + `PlatformAudio`, o módulo de áudio do WebRTC sobre PulseAudio/PipeWire) e `packages/platform/src/native-media.ts` (`NativeMediaEngine`). O motor é escolhido pela plataforma (`PlatformInfo.media`).
- **Funciona:** entrar e sair, reconexão, mudo, ensurdecer, indicador de fala, TURN, escolha de microfone e de saída (inclusive no meio da chamada), eco, ruído e ganho.
- **Teste de microfone:** lido direto do PulseAudio (`src-tauri/src/mic_test.rs`), porque o WebRTC só captura numa chamada.
- **Teste real no Kali** (app de verdade, com uma pessoa no Windows na mesma sala):
  - a pessoa no Windows viu "Ana falando" em 28 leituras enquanto o dono falava no Kali;
  - o Kali mostrou o indicador de fala de quem estava no Windows;
  - mudo e ensurdecer apareceram do outro lado;
  - sair da voz fechou todos os fluxos de áudio;
  - a saída escolhida (HDMI) foi respeitada.
- **Corrigido no caminho:**
  - a saída escolhida voltava para a padrão quando chegava o primeiro áudio (agora é reaplicada);
  - o apertar para falar nunca abria no Linux (agora funciona com a janela em foco).
- **Lacunas registradas:**
  - volume do microfone e de quem fala (a API nativa não tem; precisa de mixagem própria, que fica junto da fase B do [doc 11](11-voz-e-video.md));
  - "Ouvir minha voz" no teste de microfone.
- **Tamanho:** o AppImage passou de 108 para 120 MB (Kali) por causa do WebRTC embutido.

**Próxima: L2 — apertar para falar global.**

