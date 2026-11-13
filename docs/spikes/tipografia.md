# Tamanho do texto (medição, 13/11/2026)

**Pergunta:** o texto do app parecia grande demais comparado a outros apps de comunidade.

## Como foi medido
- Referência: folhas de estilo públicas de um app web de comunidade, carregadas sem login num Edge headless descartável (inventário passivo, só números; nada copiado).
- Nosso app: Edge headless sobre `pnpm dev:web`, lendo `getComputedStyle` dos elementos.
- Fontes: `CanvasRenderingContext2D.measureText` da mesma frase a 16 px.

## Resultados
| | Referência | Aurora (antes) |
|---|---|---|
| Escala (px) | 12 · 14 · 16 · 18 · 20 · 24 · 32 | 12 · 14 · 16 · 18 · 20 · 24 · 32 |
| Mensagem | 16 / linha 22 | 16 / linha 24 |
| Corpo 16 px | linha 20 | linha 24 |
| Item da lista de membros | 42 px (avatar 32) | 40 px (avatar 32) |
| Cabeçalhos | 48–49 px | 48 px |

Os px eram os mesmos; a diferença estava na fonte. Mesma frase a 16 px:

| Fonte | Largura | Altura do "x" |
|---|---|---|
| fonte da referência (400) | 337,9 px | 8 px |
| Inter (400) | 377,5 px (+12%) | 9 px |
| Inter 15 px | 353,9 px | 9 px |
| Inter 14 px | 330,3 px | 8 px |

**Inter a 14 px ≈ referência a 16 px.**

## Decisão
- Escala do app: 12/16 · 13/18 · **14/20** · 16/22 · 18/24 · 22/28 · 28/36 (`packages/ui/src/tokens.css`).
- O mínimo continua 12 px.
- Chat: o padrão passa a ser 14 px, com altura de linha = tamanho × 1,43. Quem estava no padrão antigo (16) passa para 14; quem escolheu outro tamanho mantém o que escolheu.
- O site de download mantém a escala de leitura (`data-scale="leitura"`).
