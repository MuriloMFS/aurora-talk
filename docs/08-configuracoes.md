# 08 — Configurações e sons de feedback (1.4.0)

## De onde veio a lista (REA, 2026-11-13)
Mesmo método do [01](01-descobertas-rea.md): análise estática, só para inventário; nada de código, texto, ícone ou som foi copiado.

| Alvo | Comando REA | O que deu |
|---|---|---|
| Discord Desktop **1.0.9268**, `discord_desktop_core/core.asar` | `analyze-javascript-application` (evidence `ev_6a59dbf3…`) | Opções do app no Windows: `TOGGLE_OPEN_ON_STARTUP`, `TOGGLE_START_MINIMIZED`, `TOGGLE_MINIMIZE_TO_TRAY`, `GPU_SETTINGS_SET_ENABLE_HWACCEL`, zoom, ortografia, notificações, selo e bandeja (`SYSTEM_TRAY_SET_*`) |
| Módulo `discord_voice` (`index.js`) | leitura do wrapper JS | Ajustes de voz: dispositivos, volume local por pessoa, mudo/ensurdecer, PTT (`setPTTActive`), opções de transporte |
| Cliente web público (`discord.com/login`, sem login) | `inspect-web-page --include-script-sources` + `export-web-scripts` (728 scripts) | Enum das seções de configurações (129 entradas) e o catálogo de sons de feedback |

**Seções das configurações do usuário** (as que interessam a um app de comunidade; as de Nitro, loja, testes de design etc. ficaram de fora): Minha conta, Perfil, Privacidade e segurança, Dados e privacidade, Apps autorizados, Dispositivos/sessões, Conexões, Pedidos de amizade, Clipes, Texto e imagens, Voz e vídeo, Notificações, **Sons**, Atividade de jogo, Atalhos de teclado, Aparência (tema), Acessibilidade, Sobreposição (overlay), Idioma, Modo streamer, **Windows**, Avançado.

**Sons de feedback** encontrados: mutar/desmutar, ensurdecer/voltar a ouvir, desconectar, reconectar, apertar para falar (início/fim), alguém entrou/saiu/foi movido, câmera ligada/desligada, transmissão começou/terminou, alguém entrou/saiu da transmissão, chamada (tocando/chamando), atividade, clipe salvo/erro, mensagem.

## O que entrou no Aurora
| Seção | No Aurora | Detalhe |
|---|---|---|
| Minha conta | ✅ | Cartão do perfil, **mudar o nome de exibição** (vale na hora para todos: evento `USER_UPDATE`), **trocar a senha** (confere a atual e desconecta os outros aparelhos), sair |
| Voz e vídeo | ✅ | Microfone e alto-falante, volume do microfone (0–200%, ganho antes de enviar), volume de quem fala, **teste do microfone** com medidor e "ouvir minha voz", perfil de entrada (isolar a voz / som puro / escolher cada ajuste: eco, ruído, ganho automático), padrão da transmissão de tela. Tudo vale no meio da chamada |
| Sons | ✅ | Volume dos sons e liga/desliga de cada um, com botão "Ouvir" |
| Notificações | ✅ | Notificação do Windows (com teste), som de menção, piscar o ícone, número de menções no ícone |
| Aparência | ✅ | Tema (escuro, claro, seguir o Windows), mensagens confortáveis ou compactas, tamanho do texto (12–24 px) |
| Acessibilidade | ✅ | Reduzir movimento (seguir o Windows ou sempre), contornos reforçados |
| Atalhos de teclado | ✅ (na janela) | Ctrl+Shift+M (microfone), Ctrl+Shift+D (ensurdecer), Ctrl+, (configurações), Esc, Enter, Shift+Enter |
| Idioma | ✅ (só pt-BR) | Outros idiomas exigem externalizar os textos (i18n) |
| Windows | ✅ | Abrir ao iniciar o Windows, iniciar minimizado, **fechar para a bandeja** (ícone ao lado do relógio com "Abrir" e "Sair") |
| Avançado | ✅ | Versão, servidor, procurar atualizações, restaurar o padrão |
| Perfil (avatar, banner, bio) | depois | Precisa de upload de arquivos |
| Privacidade, DMs, amizades, bloqueios | depois | Dependem de DMs e amigos |
| Dispositivos/sessões | depois | O servidor já guarda as sessões; falta listar e encerrar uma a uma |
| Apertar para falar e atalhos globais | depois | Precisa de captura de teclado fora da janela (Rust); `RegisterHotKey` "engole" a tecla, então PTT pede outro mecanismo |
| Sensibilidade de entrada (limiar de voz) | depois | Precisa de um *gate* no áudio (AudioWorklet) que não dependa de timers |
| Câmera, clipes, overlay, modo streamer, atividade de jogo, conexões | fora por enquanto | Recursos que o Aurora ainda não tem |

## Onde fica cada coisa
- **Preferências deste aparelho** (`apps/desktop/src/state/settings.ts`): `localStorage` (`aurora.settings`), validadas ao ler (valor estranho volta ao padrão). O tema continua em `aurora.theme` (lido antes do 1º paint).
- **Opções do Windows** (`apps/desktop/src-tauri/src/desktop_settings.rs`): arquivo `desktop-settings.json` na pasta de configuração do app + início automático pelo plugin oficial `autostart` (registro do Windows). A janela nasce escondida e o Rust a mostra, a menos que o app tenha aberto com o Windows e "iniciar minimizado" esteja ligado.
- **Sons** (`apps/desktop/src/sounds.ts`): sintetizados com Web Audio (notas com envelope), **sem arquivos**: identidade sonora própria. Tocam no alto-falante escolhido.
- **Voz** (`packages/platform/src/audio.ts`, `gain-processor.ts`, `livekit-media.ts`): `MediaEngine.applyVoiceSettings` troca dispositivo (`restartTrack`/`switchActiveDevice`), volume e tratamento durante a chamada.
- **Conta** (servidor): `PATCH /api/users/@me`, `POST /api/users/@me/password`.

## Verificação (2026-11-13)
- 141 testes (Vitest) + 5 testes Rust; typecheck limpo.
- Ponta a ponta com dois participantes reais (Edge sem janela, servidor, interface e LiveKit locais): **14/14** — sons de entrar, sair, alguém entrou e alguém saiu, mutar e ensurdecer pelos atalhos, perfil e volume trocados no meio da chamada sem erro, som desligado fica mudo.
- App de teste (identificador separado, janela fora da tela): **5/5** — a janela aparece ao abrir, as opções do Windows salvam, o X esconde para a bandeja com o app vivo, aberto com o Windows em modo minimizado fica escondido e sem esse modo aparece.
- Telas conferidas nos temas escuro e claro, em 1280, 800 e 390 px de largura. Contraste das cores novas ≥ 4,5:1 (`scripts/contrast.mjs`).
