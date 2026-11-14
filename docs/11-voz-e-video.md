# 11 — Voz e vídeo (item 2)

O que falta na voz, comparando com o comportamento de outros apps de comunidade (nada de código, texto ou identidade deles).

## Como está hoje (1.13)
- Salas de voz nos servidores, sobre LiveKit (`MediaEngine` em `packages/platform/src/livekit-media.ts`):
  - mudo, ensurdecido e indicador de fala;
  - escolha de microfone e fone, volume geral, supressão de ruído, eco e ganho;
  - compartilhar tela com som do computador;
  - moderação: silenciar, mover e desconectar.
- O que a credencial do LiveKit libera vem das permissões: microfone com **Falar**, tela com **Transmitir** (`publishSources` em `apps/server/src/http.ts`).
- **Falta:**
  - apertar para falar;
  - volume de cada pessoa;
  - câmera;
  - chamadas em conversas diretas.
- O spike S5 (PTT global, ADR-001) nunca rodou.

| Falta | Por que importa |
|---|---|
| Apertar para falar (com o app em segundo plano, inclusive no jogo) | Sem isso, quem joga com fone aberto ou tem barulho em casa não usa a voz |
| Volume por pessoa e silenciar só para mim | Sempre tem alguém alto ou baixo demais |
| Câmera | Conversa de rosto e reuniões |
| Ligar numa conversa direta ou num grupo | Hoje a voz só existe dentro de servidor |

## Ordem e fases

### Fase A — Apertar para falar (1.14)
**Modo de entrada.** Em Configurações → Voz:
- "Detecção de voz" (como hoje) ou "Apertar para falar";
- tecla ou botão do mouse escolhido pela pessoa (inclusive os botões laterais);
- atraso ao soltar: 0–1000 ms, padrão 200 ms, para não cortar o fim da frase.

**Global no Windows.** O app precisa ver a tecla com o Aurora em segundo plano ou com um jogo em primeiro plano.
- Proposta: o Rust **consulta só a tecla escolhida** (`GetAsyncKeyState`) a cada ~10 ms. Isso só acontece enquanto a pessoa está numa sala **e** no modo apertar para falar.
- Não usar gancho global de teclado (`WH_KEYBOARD_LL`):
  - ele vê todas as teclas digitadas, o que é risco de privacidade;
  - é o padrão de comportamento que os antivírus marcam (já tivemos o falso positivo da 1.11).
- A consulta também cobre os botões do mouse, que o plugin de atalhos do Tauri não documenta.

**Porta e navegador:**
- `PlatformPort` ganha `watchPushToTalk(key, onChange)`, que avisa pressionou/soltou.
- No navegador (`dev:web`), funciona só com a janela em foco (keydown/keyup). A tela de configurações diz isso.

**Na sala:**
- o microfone só abre enquanto a tecla está apertada;
- o indicador mostra "Apertar para falar";
- som curto e original ao abrir e fechar, desligável;
- **Silenciado** continua vencendo a tecla, e o silêncio do moderador também.

**Medição (gate G3 do ADR-001):** atraso entre apertar e o microfone abrir ≤ 30 ms, sem perder o "soltar". Medir com um jogo em tela cheia e registrar em `docs/spikes/ptt.md`.

**Testes:**
- lógica pura com Vitest: atraso ao soltar, mudo vence, troca de modo no meio da sala;
- teste em Rust para a tradução tecla → código virtual.

### Fase B — Volume por pessoa (1.15)
- Clicar numa pessoa da sala abre:
  - volume dela de 0 a 200%;
  - "Silenciar para mim";
  - "Silenciar a tela" (o som da transmissão separado da voz).
- Fica salvo neste aparelho, por pessoa, e vale em todas as salas. O servidor não fica sabendo.
- `MediaEngine.setUserVolume(identity, volume)`. Acima de 100% usa `GainNode`, porque o `<audio>` não passa de 1.0.
- Indicador de qualidade da conexão na sala ("Conectado · 28 ms"), a partir das estatísticas do LiveKit.

### Fase C — Câmera (1.16)
**Permissão:** a câmera entra na permissão **Transmitir** (tela e câmera), sem permissão nova. O texto de ajuda da permissão é atualizado. O servidor passa a liberar `CAMERA` em `publishSources`.

**Estado:** `VoiceState` ganha `video: boolean`, que a lista da sala mostra com um ícone.

**App:**
- botão de câmera no painel de voz;
- escolha de câmera, com prévia, em Configurações → Voz;
- grade de vídeos na tela da sala (câmeras e telas juntas), com "foco": clicar em um deixa ele grande e os outros numa faixa.

**Qualidade:**
- padrão 720p a 30 fps, com simulcast (o LiveKit manda camadas menores para quem está com a janela pequena ou a rede ruim);
- o `adaptiveStream` que já está ligado só baixa o que aparece na tela.

**Tauri:** conferir que o WebView2 concede a câmera do mesmo jeito que já concede o microfone. Nada de permissão ampla nova.

**Medição:** banda e CPU com 2, 4 e 8 câmeras, direto e pelo retransmissor TURN, em `docs/spikes/medicao-voz-retransmissor.md`. Também serve para decidir um limite de câmeras por sala, se a banda pedir.

**Testes:**
- no servidor: quem não tem Transmitir não ganha `CAMERA` na credencial, e perder a permissão no meio da sala derruba a câmera;
- no app: estado da grade e do foco.

### Fase D — Chamadas em conversas diretas e grupos (1.17)
**Fluxo:**
- botão "Ligar" (voz) e "Ligar com vídeo" na conversa direta ou no grupo;
- os outros recebem o toque, um som original, com "Atender" e "Recusar";
- o toque para depois de 30 s sem resposta.

**Servidor:**
- sala do LiveKit por conversa (`aurora-call-<canal>`), com credencial só para quem está na conversa;
- quem bloqueou ou foi bloqueado não liga;
- eventos novos no gateway: `CALL_CREATE`, `CALL_UPDATE` e `CALL_DELETE`. Clientes antigos ignoram eventos que não conhecem.

**App:**
- a chamada aparece no topo da conversa, com os mesmos controles e a mesma grade da sala de voz;
- dá para estar em só uma voz por vez: sala de servidor ou chamada.

**Testes de propriedade:** ninguém fora da conversa recebe o toque nem a credencial, e o bloqueio impede a chamada.

## Situação
- Planejado em 2026-11-13.
- **Fase A entregue na 1.14.0** (2026-11-13):
  - consulta só da tecla escolhida, sem gancho de teclado;
  - teclas e botões do meio e laterais do mouse;
  - atraso ao soltar de 0 a 1000 ms (padrão 200);
  - sons de abrir e fechar, desligáveis;
  - mudo vence a tecla.
- **Testes da fase A:**
  - 6 de lógica (tradução de teclas, captura, portão com atraso);
  - 1 de preferências;
  - 1 em Rust (teclas aceitas);
  - medição em [spikes/ptt.md](spikes/ptt.md): detecção média de 4,6 ms e máxima de 9 ms, sem apertos perdidos;
  - roteiro de ponta a ponta com LiveKit local (entrar, apertar, soltar, mudo, trocar de modo, botão lateral do mouse);
  - conferência das telas nos dois temas.

## Decisões que precisam de você
1. ~~Apertar para falar~~: ficou a consulta só da tecla escolhida (1.14.0).
2. **Câmera:** usar a permissão **Transmitir** (proposta acima) ou criar uma permissão "Vídeo" separada.
3. **Chamadas em conversas diretas** (fase D): entram agora ou ficam para depois da câmera?

## Fora deste item
Supressão de ruído por IA própria, fundo desfocado/virtual na câmera, palco (stage), soundboard e overlay em jogo ficam para depois. Estão no roadmap (docs/04 §P2 e adiante).
