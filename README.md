# Aurora (nome provisório) — plano para construir um app de comunidades "estilo Discord"

> Este repositório, por ora, contém **apenas o plano** (sem código). O nome "Aurora" é um marcador: escolha um nome e identidade **próprios** — não use nome, logo, sons ou assets do Discord.

## 1. Resumo executivo
- **O que é:** plataforma de comunidades com servidores/canais, chat em tempo real, voz/vídeo/tela, DMs, cargos e permissões, moderação, bots/apps e (depois) monetização — **desktop-first** (app instalável para Windows), depois macOS/Linux e mobile.
- **Como descobrimos os recursos:** o **REA** foi usado para análise estática do Discord Desktop 1.0.9267 (shell, `core.asar`, módulos nativos e o bundle web público de login), cruzado com a **documentação oficial de desenvolvedores** (catálogos oficiais: 13 tipos de canal, 52 permissões, 37 tipos de mensagem, 33 features de servidor, 71 eventos de audit log, ~80 eventos de gateway recebidos…). Detalhes e limites em [`docs/01-descobertas-rea.md`](docs/01-descobertas-rea.md).
- **Stack recomendada (TypeScript ponta a ponta):** React + Vite (UI) · **Tauri 2 (desktop-first, sem Electron — [ADR-001](docs/adr/ADR-001-runtime-desktop.md))** · Expo/RN (mobile, depois) · Fastify (API) · gateway WebSocket próprio · PostgreSQL + Redis + NATS · S3/CDN · Meilisearch→OpenSearch · **LiveKit** para voz/vídeo/tela. Detalhes em [`docs/03-arquitetura.md`](docs/03-arquitetura.md).
- **Realidade de prazo:** primeiro marco útil (chat + voz + desktop, beta fechado) em **~6–8 meses solo** ou **~3,5–4,5 meses com 5 pessoas**; "quase tudo" é programa de **vários anos** — por isso os recursos estão em tiers (T0–T4). Detalhes em [`docs/04-roadmap.md`](docs/04-roadmap.md).
- **Maiores riscos:** escopo, lista de mensagens performática, bugs de permissão (vazamento de canal privado), abuso/CSAM ao abrir ao público, custo de voz/vídeo, risco jurídico de marca/cópia.

## 2. Índice
| Arquivo | Conteúdo |
|---|---|
| [`docs/01-descobertas-rea.md`](docs/01-descobertas-rea.md) | O que o REA analisou, evidências (IDs/hashes), achados por camada, limitações, como reproduzir |
| [`docs/02-inventario-de-recursos.md`](docs/02-inventario-de-recursos.md) | Matriz de ~125 recursos com **fonte**, **tier** (T0–T4) e **esforço** |
| [`docs/03-arquitetura.md`](docs/03-arquitetura.md) | Stack com alternativas, serviços, modelo de dados, **algoritmo de permissões**, gateway, voz, segurança, custos |
| [`docs/04-roadmap.md`](docs/04-roadmap.md) | Fases P0–P8, estimativas, backlog dos 4 primeiros sprints, testes, riscos, **checklist legal** |
| [`docs/05-v1-hoje.md`](docs/05-v1-hoje.md) | **Versão 1.0 (MVP de chat de texto em tempo real)**: escopo, desvios conscientes da arquitetura, como rodar |
| [`docs/06-atualizacoes.md`](docs/06-atualizacoes.md) | **Atualização automática** (desde a 1.0.1): como funciona, como publicar (`pnpm release`), cuidados com a chave de assinatura |
| [`docs/adr/ADR-001-runtime-desktop.md`](docs/adr/ADR-001-runtime-desktop.md) · [`ADR-002`](docs/adr/ADR-002-porta-de-midia.md) | **Decisão do runtime desktop** (opções, pontuação, fontes, orçamentos de performance, gates, plano de spike) e **portas** `PlatformPort`/`MediaEngine` |
| [`docs/design/guia-visual.md`](docs/design/guia-visual.md) | **Guia de design visual**: tokens (escuro/claro, contrastes verificados), tipografia, layout, componentes e estados, acessibilidade WCAG 2.2 AA, identidade original. Inclui `scripts/contrast.mjs` |

## 3. Decisões em aberto (o dono do projeto precisa decidir — registrar como ADR)
| # | Decisão | Opções | Recomendação padrão |
|---|---|---|---|
| 1 | Natureza do produto | SaaS público · **comunidade fechada** · self-hosted open source | Começar **comunidade fechada/beta**; abrir ao público só após T&S + legal |
| 2 | Time e orçamento | solo · squad | Define os prazos do doc 04; solo ⇒ cortar T2/T3 sem dó |
| 3 | Compatibilidade com API do Discord | própria · compatível (bots prontos) | Nomes/estruturas parecidos desde P1; **decidir em P4** |
| 4 | E2EE de voz/DMs | sem · SFrame · MLS | **Adiar** (T2/T4) |
| 5 | Desktop | Electron · **Tauri 2** · Flutter · Rust nativo | ✅ **Decidido (2026-11-12): Tauri 2** + porta de mídia ([ADR-001](docs/adr/ADR-001-runtime-desktop.md), [ADR-002](docs/adr/ADR-002-porta-de-midia.md)), condicionado aos gates G1–G3 do spike; Electron só como fallback |
| 6 | Mobile | RN/Expo · Tauri mobile · Flutter | **Desktop-first**; mobile em P7 (reavaliar RN × Tauri mobile na época) |
| 7 | Monetização | nenhuma · premium · criadores | Só após M3; provedores BR (Pix) a avaliar |
| 8 | Hospedagem | VPS/Coolify · cloud gerenciada | VPS no beta → K8s depois |
| 9 | Licença do código | proprietária · AGPL/MIT | Depende de #1 |
| 10 | Nome, identidade visual, domínio (inclusive domínio separado para conteúdo de usuário) e **identificador do app** (hoje `app.aurora.desktop`, provisório) | — | Definir antes do 1º release público — o identificador muda caminho de instalação e atualizações |

## 4. Próximos passos (Sprint 0 — desktop-first)
1. ✅ ADR-001 e ADR-002 **aceitos** (2026-11-12), condicionados aos gates do spike.
2. ✅ Pré-requisitos instalados (VS 2022 Build Tools C++, Rust 1.99.1 MSVC, pnpm 12.18.0).
3. ✅ Repositório git + monorepo `pnpm`/Turborepo.
4. ✅ Esqueleto **Tauri 2 + React** com os tokens do guia visual e a porta `PlatformPort` → instalador NSIS de **1,45 MB**.
5. ✅ Medido ([S1](docs/spikes/S1-esqueleto-instalavel.md)): instalador 1,45 MB. Spike S2–S6 **cancelado** pelo dono (Tauri definitivo).
6. ✅ **Versão 1.0** (2026-11-12): chat de texto em tempo real com servidor próprio e instalador Windows de 1,45 MB; 43 testes + ponta a ponta no app real — [como usar](docs/05-v1-hoje.md#começar-a-usar-passo-a-passo).
7. ✅ **1.0.1** atualização automática assinada · **1.1.0** canais de voz (LiveKit) — publicada via atualização automática; 55 testes + voz com áudio real entre dois clientes.
7. Docker Compose com Postgres, Redis, NATS, MinIO e **LiveKit** (Docker já instalado).
8. `packages/snowflake`, `packages/schema` e `packages/permissions` com testes (de propriedade nas permissões).
9. Responder as decisões **1, 2, 9 e 10** acima.
10. Conversa com advogado (LGPD, marca, T&S) antes de planejar o beta público.

## 5. Aviso
Os documentos descrevem **funcionalidades** e **arquitetura própria**; não contêm nem devem receber código, textos, imagens ou sons copiados do Discord. Estimativas de prazo/custo são ordens de grandeza para planejamento, não compromissos.
