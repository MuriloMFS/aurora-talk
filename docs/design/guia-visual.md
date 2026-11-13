# Design visual — Aurora

Guia para manter **uma única linguagem visual** em desktop (Tauri 2 + WebView, desktop-first), web de dev/teste e mobile. Toda decisão de UI deve vir daqui; se faltar algo, **estenda este guia e `packages/ui/src/tokens.css`**, não improvise valores soltos.

## 0. Como usar este guia (fluxo obrigatório)
1. **Ler primeiro** `packages/ui/src/tokens.css` (fonte da verdade, se já existir). Se não existir, crie-o a partir do bloco da §3.
2. **Usar só tokens** (`var(--…)`). Proibido hex, `px` de espaçamento ou `z-index` avulsos em componentes.
3. **Construir todos os estados** (§6) antes de dar o componente por pronto — não só o "estado feliz".
4. **Verificar contraste** de qualquer cor nova: `node scripts/contrast.mjs "#fg" "#bg" 4.5`.
5. **Conferir em 2 temas × 3 larguras** (escuro/claro × 1280, 800, 390 px) e com `prefers-reduced-motion`.
6. **Entregar** com: hierarquia da tela, tokens usados, estados, comportamento responsivo, notas de a11y e o código.
7. Fechar com o **checklist da §11**.

## 1. Princípios
- **Chat primeiro:** o conteúdo da conversa é o herói; a interface recua. Densidade alta, mas respirável.
- **Calma por padrão:** tema escuro neutro-azulado, acentos usados com parcimônia (ação principal, foco, seleção, menções).
- **Legível acima de bonito:** contraste, tamanho e alvo de toque vêm antes de efeito.
- **Estado sempre visível:** conectado/reconectando, enviando/falhou, não lida, mutado, falando — nunca só por cor.
- **Consistência > novidade:** reutilize componentes; um padrão novo exige justificativa.
- **Original:** inspiração **funcional** (estrutura de 4 colunas é um padrão comum a Slack, Matrix/Element, Guilded, Revolt…), mas **linguagem visual própria** (§10).

## 2. Identidade (provisória — trocar quando a marca for definida)
| Elemento | Decisão | Licença/obs. |
|---|---|---|
| Acento de marca | **Aurora teal** (`#2dd4bf` no escuro / `#0f766e` no claro) | cores não têm licença |
| Gradiente de marca | `teal → violeta` **só** em momentos de marca (splash, onboarding, convite, cabeçalho de perfil) — nunca em UI funcional | — |
| Fonte UI | **Inter** (variável) | SIL OFL 1.1 |
| Fonte código | **JetBrains Mono** | SIL OFL 1.1 |
| Ícones | **Lucide** (traço 1.75, 20 px padrão) | ISC |
| Emoji | Noto Color Emoji ou Twemoji (verifique atribuição) | OFL / CC-BY 4.0 |
| Avatar padrão | gerado: iniciais + cor derivada do ID (paleta §3.3) | original |
| Mascote/ilustrações | **criar originais** (formas geométricas simples) | — |

## 3. Tokens (fonte da verdade inicial)
Contrastes abaixo foram **calculados (WCAG 2.x)** em 2026-11-08; ao mudar um valor, rode o script.

### 3.1 Cor — semântica (copiar para `tokens.css`)
```css
:root, :root[data-theme="dark"] {
  color-scheme: dark;
  /* superfícies (do mais fundo ao mais alto) */
  --bg-rail:#0f1117; --bg-sidebar:#151821; --bg-chat:#1b1f2a; --bg-elevated:#232836; --bg-hover:#2a3042;
  --bg-selected: var(--bg-hover);
  /* texto */
  --text-primary:#e8ebf3; --text-secondary:#b4bbcc; --text-muted:#959db1;
  /* bordas: divisor decorativo vs. contorno de controle (>=3:1) */
  --border:#2e3446; --border-strong:#6f7891;
  /* marca/ação */
  --accent:#2dd4bf; --accent-hover:#5eead4; --accent-active:#14b8a6; --on-accent:#04201c;
  --link:#5eead4; --focus-ring:#5eead4;
  /* feedback */
  --danger:#ff6b6b; --success:#3ecf8e; --warning:#f5b83d;
  --mention-bg:#ff6b6b; --mention-fg:#1a0505;
  /* presença (sempre acompanhada de forma — ver §6.6) */
  --presence-online:#3ecf8e; --presence-idle:#f5b83d; --presence-dnd:#ff6b6b; --presence-offline:#959db1;
}
:root[data-theme="light"] {
  color-scheme: light;
  --bg-rail:#e6e9f0; --bg-sidebar:#eff1f6; --bg-chat:#ffffff; --bg-elevated:#ffffff; --bg-hover:#e8ebf2;
  --bg-selected: var(--bg-hover);
  --text-primary:#171a23; --text-secondary:#4a5163; --text-muted:#586075;
  --border:#d5d9e3; --border-strong:#7b8397;
  --accent:#0f766e; --accent-hover:#115e59; --accent-active:#134e4a; --on-accent:#ffffff;
  --link:#0b6159; --focus-ring:#0f766e;
  --danger:#c92a2a; --success:#15803d; --warning:#a16207;
  --mention-bg:#c92a2a; --mention-fg:#ffffff;
  --presence-online:#15803d; --presence-idle:#a16207; --presence-dnd:#c92a2a; --presence-offline:#586075;
}
```
Resolver "seguir o sistema" **em JS** (`matchMedia('(prefers-color-scheme: dark)')`) e sempre gravar `data-theme` no `<html>`. Persistir a escolha; aplicar antes do primeiro paint (script inline) para evitar *flash*.

**Regras de uso de cor**
- `--text-muted` só para metadados (hora, contagens, dicas) e **nunca sobre `--accent`/cores saturadas**; sobre `--bg-hover` já foi verificado (≥4,5:1).
- `--border` é só divisor decorativo (≈1,3:1). **Campos, botões secundários, checkbox e cartões interativos usam `--border-strong`** (≥3:1).
- Nunca preto/branco puros como fundo de página; nunca cor como único indicador.
- Gradientes e transparências não podem reduzir contraste abaixo do mínimo (use a cor **resultante** no teste).
- Texto sobre `--accent`: sempre `--on-accent`. Sobre `--mention-bg`: `--mention-fg`.

**Contrastes verificados (resumo)** — escuro: texto-primário/chat 13,8 · secundário 8,6 · muted 6,1 · link 11,1 · foco 11,1 · on-accent 9,2 · `--border-strong` 3,7. Claro: primário 17,4 · secundário 7,9 · muted 6,3 · link 7,3 · foco 5,5 · on-accent 5,5 · `--border-strong` 3,8.

### 3.2 Tipografia
| Token | Tamanho/linha | Uso |
|---|---|---|
| `--text-xs` | 12/16 | metadados, rótulos de badge (mínimo absoluto) |
| `--text-sm` | 14/20 | UI secundária, chat **compacto**, listas |
| `--text-base` | **16/24** | **chat aconchegante (padrão)**, formulários |
| `--text-lg` | 18/26 | subtítulos, nome do canal no cabeçalho |
| `--text-xl` | 20/28 | títulos de modal |
| `--text-2xl` | 24/32 | títulos de página/configuração |
| `--text-3xl` | 32/40 | onboarding, estados vazios |
| `--text-4xl` · `--text-5xl` · `--text-6xl` | 40/48 · 56/60 · 72/76 | **só no site de download** (títulos de marca); a interface do app para no 3xl |
Pesos: 400 corpo, 500 UI/nomes, 600 títulos, 700 só ênfase pontual. `font-variant-numeric: tabular-nums` em contadores, tempo e durações. **Escala de fonte do usuário** (12–24 px no chat) deve escalar linhas e avatares proporcionalmente; layout testado a **200% de zoom**. Nunca < 12 px.

### 3.3 Espaço, forma, elevação, camadas
- **Grade de 4 px:** `--space-0:0; -1:2px; -2:4px; -3:8px; -4:12px; -5:16px; -6:20px; -7:24px; -8:32px; -9:48px; -10:64px`.
- **Raios:** `--radius-sm:4px; --radius-md:8px; --radius-lg:12px; --radius-xl:16px; --radius-full:9999px`.
- **Elevação:** no escuro, "mais alto" = **superfície mais clara** (`--bg-elevated`) + sombra curta (`0 4px 16px rgb(0 0 0 / .35)`); no claro, sombra suave (`0 4px 16px rgb(16 24 40 / .12)`). Sem sombras pesadas/coloridas.
- **Camadas:** `--z-base:0; --z-sticky:10; --z-dropdown:100; --z-overlay:200; --z-modal:300; --z-toast:400; --z-tooltip:500`.
- **Paleta de avatar padrão (8 cores, texto `#fff` ou `#111` conforme contraste ≥4,5):** gerar a partir de `hash(userId) % 8`; testar com o script cada par.

### 3.4 Movimento
`--dur-fast:100ms` (hover, ripple) · `--dur-base:160ms` (menus, tooltips) · `--dur-slow:240ms` (painéis, drawers) · `--dur-hero:360ms` (modais grandes, onboarding). Easing padrão `cubic-bezier(.2,0,0,1)`; saída mais rápida que entrada. Animar só `opacity` e `transform`. **`prefers-reduced-motion: reduce` ⇒ sem translação/escala/parallax; manter apenas fade ≤100 ms.** Sem animação em *loop* contínuo (exceção: anel de "falando" discreto, desligável). Rolagem da lista de mensagens **nunca** é animada por padrão.

## 4. Layout
| Região | Medida | Notas |
|---|---|---|
| Barra de servidores (*rail*) | **72 px** (tile 48 px) | rolável; DMs/Home no topo; "adicionar servidor" no fim |
| Lista de canais | **240 px** (redimensionável 200–320) | cabeçalho do servidor 48 px; painel do usuário/voz fixo no rodapé (52 px) |
| Chat | flexível, mín. 480 px | cabeçalho 48 px; compositor mín. 44 px, cresce até ~40% da altura |
| Lista de membros | **240 px** (recolhível) | agrupada por cargo |
| Janela mínima (desktop) | 940 × 500 | |

**Breakpoints:** `≥1200` 4 colunas · `900–1199` membros viram painel alternável · `600–899` rail+canais num *drawer*, chat em tela cheia · `<600` mobile: painel único com **barra inferior** (Servidores · Mensagens · Notificações · Você), voz como mini-player persistente. Conteúdo do chat com largura de leitura confortável; mídia limitada a ~400×300 (miniatura) com *lightbox*.

## 5. Estrutura visual da tela principal
```
┌────┬────────────┬──────────────────────────────┬───────────┐
│rail│ servidor ▾ │ # canal · tópico   🔍 📌 👥  │ membros   │
│ 72 │ canais     ├──────────────────────────────┤ por cargo │
│    │ (240)      │ mensagens (virtualizadas)    │ presença  │
│    │            ├──────────────────────────────┤           │
│    │ [voz/user] │ [ + ] compositor  😀 GIF  ➤  │           │
└────┴────────────┴──────────────────────────────┴───────────┘
```
Hierarquia: **conteúdo do chat > navegação de canais > rail > membros > cromo**. Um único ponto de cor forte por região.

## 6. Componentes e estados
Todo componente interativo implementa: `default · hover · focus-visible · active · disabled · loading · error` (+ `selected`/`unread` quando couber).

### 6.1 Rail (servidores)
Tile **quadrado arredondado** (`--radius-lg`) 48 px — *não* círculo→quadrado. Ativo: anel de 2 px `--accent` + fundo com gradiente sutil. Não lida: **ponto** abaixo do tile (não a barra lateral). Menções: *badge* `--mention-bg` no canto inferior direito com número (99+). Pastas de servidores: agrupam tiles com contorno. *Tooltip* à direita (atraso 300 ms) **e** `aria-label`.

### 6.2 Lista de canais
Ícone por tipo (texto `#`, voz alto-falante, anúncio megafone, fórum balões, mídia imagem, stage palco, thread ramificação, privado cadeado). Estados: normal · hover (`--bg-hover`) · **selecionado** (`--bg-selected` + barra de 3 px `--accent` à esquerda + texto primário) · **não lido** (texto primário + peso 600 + ponto) · **silenciado** (texto muted, ícone riscado) · **mencionado** (badge). Canal de voz mostra participantes aninhados (avatar 24 px, nome, ícones mudo/ensurdecido/transmitindo). Categorias recolhíveis (`aria-expanded`), arrastar para reordenar com alternativa por teclado.

### 6.3 Mensagem
- **Aconchegante:** avatar 40 px, nome (500) + cargo-cor + hora (`--text-xs`, muted) na 1ª linha; texto `--text-base`.
- **Compacta:** sem avatar, hora à esquerda, `--text-sm`.
- **Agrupamento:** mensagens do mesmo autor com < 7 min compartilham cabeçalho.
- **Hover:** barra de ações flutuante (reagir, responder, mais) com `--bg-elevated`; no teclado aparece no foco.
- **Resposta:** linha de pré-visualização com traço curvo e trecho do original (clicável).
- **Estados de envio:** `enviando` (opacidade .6) → `enviado` → `falhou` (texto `--danger`, ações **Tentar de novo / Apagar**).
- **Menção a você:** fundo `color-mix(in srgb, var(--accent) 12%, transparent)` + barra à esquerda; marcador "novas mensagens" com linha `--danger` e rótulo.
- **Código:** `JetBrains Mono` 14 px, fundo `--bg-elevated`, botão copiar; **spoiler:** bloco coberto, revela por clique/Enter; **citação:** barra 3 px `--border-strong`.
- **Mídia:** grade de até 4 anexos, `blurhash` enquanto carrega, *alt text* acessível; **embeds:** cartão com barra lateral de cor do site (limitar largura; truncar).
- **Reações:** chips 28 px (`--radius-full`), selecionada = contorno `--accent` + fundo 12% accent; contagem *tabular*.
- **Mensagem de sistema:** ícone + texto secundário, sem avatar.
- **Thread:** cartão "N respostas · última há X" abaixo da mensagem.
- Lista em `role="log"` com `aria-live="polite"` para novas mensagens; **nunca** rolar sozinho se o usuário leu histórico (mostrar botão "Ir para o fim · N novas").

### 6.4 Compositor
Campo auto-expansível (máx. ~10 linhas), borda `--border-strong`, foco = anel `--focus-ring`. Esquerda: anexar `+`. Direita: emoji, GIF, sticker, enviar. Barras acima: **respondendo a…**, anexos em fila (progresso, remover), aviso de limite de caracteres só perto do limite. Indicador "fulano está digitando…" com `aria-live="polite"`. Autocomplete de `@`, `#`, `:emoji:` e `/comandos` em *popover* navegável por setas.

### 6.5 Lista de membros
Cabeçalhos por cargo (`--text-xs`, caixa-alta com tracking .04em, muted) + contagem. Item: avatar 32 px + **ponto de presença** + nome na cor do cargo (garantir contraste ≥4,5 — se a cor do cargo falhar, exibir bolinha colorida e manter o nome em `--text-primary`) + linha de atividade (muted).

### 6.6 Presença (cor **e** forma)
| Estado | Forma | Token |
|---|---|---|
| Online | círculo cheio | `--presence-online` |
| Ausente | círculo com recorte (lua) | `--presence-idle` |
| Não perturbe | círculo com traço horizontal | `--presence-dnd` |
| Offline/invisível | anel vazio | `--presence-offline` |
| Transmitindo | pílula "AO VIVO" `--danger` | + texto |
Tamanho 10 px (avatar 32) / 14 px (avatar 80), com recorte de 3 px na cor da superfície. `aria-label` textual sempre.

### 6.7 Voz e vídeo
Cartão de participante: avatar/câmera, nome, ícones de mudo/ensurdecido/transmitindo. **Falando:** anel 2–3 px `--success` (animação opcional ≤160 ms) **+** `aria-label="falando"`. Layouts: **grade** (auto), **foco/orador** (um grande + faixa), **apresentação** (tela compartilhada + faixa). Controles fixos: mic, fone, câmera, tela, soundboard, sair (`--danger`). Painel de voz no rodapé da lista de canais: estado de conexão (verde/amarelo/vermelho **+ texto** "Conectado · 28 ms"), canal, botão desligar. Stage: palco (orador + palestrantes) e plateia em faixa; "pedir para falar" como ação clara.

### 6.8 Modais, menus, popovers, toasts
- **Modal:** `--bg-elevated`, `--radius-xl`, largura 440/600/800, foco preso, `Esc` fecha, retorna o foco ao gatilho, rolagem interna do corpo.
- **Menu de contexto/dropdown:** itens 32 px, ícone à esquerda, atalho à direita, item destrutivo em `--danger`, navegável por setas/typeahead.
- **Popover de perfil:** banner (gradiente permitido), avatar 80 px, cargos, nota, ações.
- **Toast:** canto inferior direito (superior no mobile), `role="status"` (ou `alert` para erro), auto-fecha em 5 s **exceto** erros/ações, pausa no hover/foco, máx. 3 empilhados.
- **Banner de conexão:** faixa fixa abaixo do cabeçalho: "Reconectando…" (warning) → "Sem conexão" (danger) → some em 1 s ao voltar.

### 6.9 Formulários e controles
Altura 40 px (32 compacto, 48 mobile), rótulo visível acima, erro abaixo com ícone+texto (`aria-describedby`), `--border-strong`, foco com anel. *Switch* com rótulo e estado textual para leitores de tela. Seletor de cor com valores numéricos e pré-visualização de contraste.

### 6.10 Avatares, badges, vazios, carregamento
Avatares 16/24/32/40/80/120 px (círculo; no rail, tile quadrado). Badges: `--radius-full`, `--text-xs`, 16 px de altura mín. **Estado vazio:** ilustração geométrica original + título (`--text-3xl`/`--text-xl`) + 1 ação. **Carregamento:** *skeleton* com forma da mensagem (sem *spinner* de tela cheia); *spinner* só em botões; progresso determinado em uploads.

## 7. Iconografia e ilustração
Lucide, traço 1.75, grade 20/24 px; ícone puramente decorativo = `aria-hidden`; ícone sozinho = `aria-label` + *tooltip*. Cores de ícone herdam `currentColor`. Ilustrações: formas simples, 2–3 cores da marca, funcionam em escuro e claro (preencher com tokens, não hex).

## 8. Acessibilidade (meta: WCAG 2.2 AA)
- **Contraste:** texto ≥4,5:1 (≥3:1 se ≥24 px ou ≥18,66 px/700); componentes de UI e indicadores de estado ≥3:1.
- **Foco:** `:focus-visible` com anel 2 px `--focus-ring` + *offset* 2 px, nunca removido; ordem de foco = ordem visual; sem armadilha de teclado.
- **Alvo:** ≥24×24 CSS px no desktop (WCAG 2.5.8); **≥44×44** em toque.
- **Teclado:** `Ctrl/⌘+K` *quick switcher*; `Alt+↑/↓` canais; `Alt+Shift+↑/↓` canais não lidos; `Esc` fecha camadas; `Ctrl+Enter`/`Enter` envia (configurável); atalhos listados em um painel (`Ctrl+/`); PTT configurável.
- **Semântica:** marcos (`header`, `nav`, `main`, `aside`); lista de canais como `nav > ul` com `aria-current="page"`; mensagens em `role="log"`; diálogos com `role="dialog"` + `aria-modal` + rótulo; ícones com nome acessível; avatar com `alt=""` quando o nome está ao lado.
- **Preferências do SO:** `prefers-reduced-motion`, `prefers-reduced-transparency` (trocar vidro/translucidez por superfícies opacas), `prefers-contrast: more` (trocar `--border` por `--border-strong`, aumentar peso), `forced-colors` (usar cores de sistema; manter bordas/anéis visíveis).
- **Conteúdo:** nada que pisque >3×/s; legendas/transcrição para mensagens de voz quando possível; mensagens de erro dizem **o que houve e como resolver**.
- **Zoom/escala:** funcional a 200% e com fonte do SO aumentada; sem rolagem horizontal da página.
- **Auditoria:** `axe` no CI + roteiro manual com leitor de tela (NVDA/VoiceOver) nos fluxos: entrar, enviar mensagem, trocar de canal, entrar na voz.

## 9. Temas e personalização
Escuro (padrão), Claro, **Sincronizar com o sistema**, **Alto contraste** (variante com `--border` = `--border-strong`, texto 100%). Personalização permitida: **cor de acento** (usuário escolhe entre 8 pré-definidas já validadas; qualquer outra só se o seletor garantir `--on-accent` ≥4,5:1), densidade (aconchegante/compacta), escala de fonte, redução de movimento, nomes de cargo coloridos on/off. Temas de terceiros/CSS custom: **fora do escopo** inicialmente (risco de contraste e segurança).

## 10. Identidade original — o que NÃO fazer
- **Não** usar a paleta "blurple" do Discord (família `#5865F2`), a fonte proprietária deles, o mascote, sons, ícones ou ilustrações, nem nome/logotipo parecidos.
- **Não** copiar o *morph* círculo→quadrado do rail, o pill lateral de não lidas, nem o traço exato de ícones/ilustrações deles.
- Semelhança **estrutural** (rail · canais · chat · membros · painel de voz) é aceitável por ser padrão do gênero; a **linguagem visual** (formas, cor, tipografia, ícones, microinterações, ilustração, sons) deve ser distinta.
- Antes de lançar: revisão de marca/identidade com advogado (ver `docs/04-roadmap.md` §6).

## 11. Checklist de entrega visual
- [ ] Só tokens (`var(--…)`), nenhum hex/px/z-index avulso
- [ ] Escuro **e** claro verificados; transição sem *flash*
- [ ] Contraste testado com `scripts/contrast.mjs` para cores novas
- [ ] Todos os estados (default/hover/focus/active/disabled/loading/error/selected/unread/vazio)
- [ ] Responsivo em 1280 / 800 / 390 px; sem rolagem horizontal; 200% de zoom ok
- [ ] Teclado completo + foco visível + ordem lógica; alvos ≥24/44 px
- [ ] Nomes acessíveis (ícones, avatares, estados de presença/fala)
- [ ] `prefers-reduced-motion`, `-contrast`, `-transparency`, `forced-colors` tratados
- [ ] Textos em pt-BR, tom direto, *sentence case*; strings externalizadas (i18n)
- [ ] Sem cópia de ativos/identidade do Discord
- [ ] Capturas (escuro/claro, desktop/mobile) anexadas ao PR

## 12. Entregáveis esperados do repositório
`packages/ui/src/tokens.css` (§3) · `packages/ui/src/theme.ts` (resolver de tema + script anti-flash) · biblioteca de componentes (Radix + Tailwind ou CSS Modules) · **Storybook** com um *story* por estado · testes visuais (Playwright snapshots) em escuro/claro · `docs/design/` com Figma/links e decisões (ADR de design).
