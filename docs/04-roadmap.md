# 04 — Roadmap, backlog inicial, riscos e legal

> Todas as durações são **estimativas** para orientar decisão (não medições). Cenários: **Solo** = 1 dev experiente em tempo integral usando IA como acelerador; **Squad** = 5 pessoas (2 back, 2 front/desktop, 1 design/produto/QA-ops).

## 1. Expectativa realista
O Discord é o resultado de anos e centenas de engenheiros. "Quase todos os recursos" = **programa de vários anos**. O caminho viável é entregar **valor por camadas**, com marcos que já são produto utilizável:

| Marco | Escopo | Solo | Squad |
|---|---|---|---|
| **M1 — Alpha de chat** | P0 + P1 | ~4–5 meses | ~2–3 meses |
| **M2 — Beta fechado (chat + voz + desktop)** | + P2 | ~6–8 meses | ~3,5–4,5 meses |
| **M3 — Paridade essencial pública** | + P3 + T&S completo | ~11–14 meses | ~6–7 meses |
| **M4 — Plataforma/bots + monetização** | + P4 + P6 | ~18–24 meses | ~9–11 meses |
| **M5 — "Quase tudo" (inclui mobile, discovery, Activities)** | + P5 + P7 + P8 | ~30–40 meses | ~14–20 meses |

Recomendação: **mirar M2 como primeiro objetivo** (a prova de que a ideia funciona), com uma comunidade pequena de teste.

## 2. Fases

### P0 — Fundações (Solo 3–4 sem · Squad ~2 sem)
- Decisões **[ADR]**: nome/marca própria, escopo do produto (ver README), licença do código, stack (doc 03).
- Monorepo, CI (lint, typecheck, testes, build), Docker Compose (Postgres, Redis, NATS, MinIO, LiveKit), `packages/schema`, gerador de Snowflake, config/segredos, logging + OpenTelemetry básico.
- Design system mínimo (tokens, tema claro/escuro, componentes base) e protótipo navegável das telas principais (Figma).
- **Desktop-first:** esqueleto **Tauri 2** que **instala, abre, atualiza sozinho e fala com o backend local** — o **instalador é o 1º entregável**. Inclui o spike S1–S6 do [ADR-001](adr/ADR-001-runtime-desktop.md) (instalador, eficiência vs. controle, voz, tela, PTT global, integração com o SO) e os gates G1–G3. Pré-requisitos de instalação listados no ADR-001 §10 (exigem autorização).
- **Pronto quando:** instalador NSIS/MSI gerado, instalado e desinstalado; gates G1–G3 do ADR-001 avaliados com números; `pnpm dev` sobe tudo; CI verde; "hello world" de ponta a ponta no app desktop (cadastro → evento no gateway → UI).

### P1 — Chat núcleo / Tier 0 (Solo 10–14 sem · Squad 6–8 sem)
Conta+sessões; servidores, categorias, canais de texto; cargos e **permissões** (pacote compartilhado com testes de propriedade); convites; membros/kick/ban/timeout; mensagens (markdown, menções, reply, edição, exclusão, anexos, paginação por snowflake); **gateway** (IDENTIFY/RESUME/heartbeat/intents); DMs; presença básica; **não lidas/menções (ack)**; rate limiting; UI do app desktop com lista virtualizada; **Trust & Safety mínimo**: denunciar, ban, timeout, audit log básico, filtro de upload.
- **Pronto quando:** 200 usuários simultâneos num servidor sem perda de eventos; reconexão resume sem mensagens duplicadas/perdidas (teste de caos); SLO p95 de envio→entrega < 300 ms em rede local.

### P2 — Voz/vídeo e desktop / T1 (Solo 10–14 sem · Squad 6–8 sem)
LiveKit integrado; canais de voz (entrar/sair, mute/deafen, indicador de fala, mover/silenciar membros); câmera; **compartilhar tela**; PTT; seleção de dispositivos; ruído/eco; chamadas de DM/grupo; **integrações avançadas do app desktop** (PTT global incl. botões do mouse, badge, notificações com ação, captura de áudio do aplicativo, overlay opcional; o esqueleto/instalador/updater já nascem em P0); amigos/bloqueios; notificações nativas do SO (config por servidor/canal).
- **Pronto quando:** 25 pessoas em uma sala com áudio estável por 1 h; tela 1080p30 estável; instalador assinado atualizando sozinho.

### P3 — Chat rico + paridade essencial / T1→T2 (Solo 16–20 sem · Squad 8–10 sem)
Threads; reações e emoji/stickers personalizados; embeds/unfurl (SSRF-safe); pins; **busca**; encaminhar; enquetes; mensagens de voz; fórum/mídia/anúncio (+seguir canal); stage; soundboard; eventos agendados; status personalizado/ausência automática; temas/acessibilidade/i18n; passkeys/2FA; export/apagar dados; **AutoMod + audit log completo**; painel admin; verificação/níveis de segurança do servidor.
- **Pronto quando:** todos os itens T1 do doc 02 estão ✔; auditoria de acessibilidade (WCAG 2.2 AA nos fluxos principais); revisão de segurança externa leve.

### P4 — Plataforma de bots e apps / T3 (Solo 14–18 sem · Squad 8–10 sem)
Aplicações e bots + portal do dev; REST/Gateway público versionado e documentado (OpenAPI); **webhooks**; **slash commands**, interações, botões/selects/modais, componentes v2; **OAuth2** (provedor próprio); *linked roles*; SDKs (TS primeiro).
- **Decisão estratégica [ADR]:** manter API/gateway **compatíveis com a do Discord** (bots/libs como discord.js funcionariam quase sem mudanças → ecossistema pronto) **ou** API própria. Recomendação: desde P1 usar nomes/estruturas semelhantes (snowflake, intents, opcodes) — custo ~zero — e **decidir a compatibilidade só em P4**, avaliando risco jurídico e demanda.

### P5 — Comunidade e descoberta (Solo 10–12 sem · Squad ~6 sem)
Onboarding, tela de boas-vindas, regras/*membership screening*; Server Home/insights; **Discovery**; modo incidente/alerta de raid; templates de servidor; parceria/verificado; ferramentas de moderação avançadas (filas, notas de moderador, apelações).

### P6 — Monetização e premium (Solo 8–10 sem · Squad ~5 sem)
Plano premium (limites/benefícios), boost de servidor, SKUs/entitlements, assinaturas de cargo para criadores, checkout (cartão + **Pix**; avaliar Stripe/Mercado Pago/Pagar.me), notas fiscais e impostos, antifraude, estornos.

### P7 — Mobile (Solo 16–20 sem · Squad 10–12 sem)
Expo/RN: chat, voz em background (CallKit/ConnectionService), push, compartilhar para o app, câmera/galeria, deep links, revisão das lojas (**UGC exige** denúncia, bloqueio, filtro e moderação ativa).

### P8 — Escala e endurecimento (contínuo; 8–12 sem dedicadas)
Mensagens → ScyllaDB; *sharding* do gateway; Postgres com réplicas/partições; multi-região de voz; testes de carga (k6 + gerador de gateway); DR (RPO/RTO documentados); pentest; bug bounty; SRE (on-call, runbooks, SLOs/erro orçado).

### Opcionais / T4 (decidir depois)
E2EE de voz/vídeo e de DMs (MLS) · Activities (apps em iframe + SDK) · Rich Presence/RPC local e detecção de jogos · overlay em jogo · clips/replay · loja de jogos/saves em nuvem · SDK Social para jogos.

## 3. Backlog inicial (Sprint 0 + primeiros 4 sprints de 2 semanas — cenário Solo)
**Sprint 0 — Spike desktop (1–2 semanas, ADR-001 §9)**
0a. Pré-requisitos + repositório + monorepo `pnpm`/Turborepo.
0b. **S1**: esqueleto Tauri 2 + React com tokens (`packages/ui`) e `PlatformPort` (`packages/platform`); instalador NSIS/MSI; instalar/abrir/desinstalar. AC: tamanhos dentro do orçamento.
0c. **S2–S6**: eficiência (50 mil mensagens vs. build de controle), voz, tela com áudio, PTT global, integração SO. AC: relatório em `docs/spikes/` e gates G1–G3 decididos.

**Sprint 1 — Esqueleto de produto**
1. CI (lint, typecheck, testes, build do instalador) + Compose (Postgres, Redis, NATS, MinIO, LiveKit). AC: `pnpm dev` e `pnpm test` verdes no CI.
2. `packages/snowflake` (com testes de monotonicidade/relógio) e `packages/schema`.
3. Auth: cadastro, login, sessão com token opaco, logout. AC: argon2id, rate limit, testes e2e.
4. Shell do app desktop (barra de servidores, lista de canais, área de chat, lista de membros) com dados fake, seguindo o guia visual (`docs/design/guia-visual.md`).

**Sprint 2 — Servidores e canais**
5. CRUD de servidores/canais/categorias + convites (link com expiração/usos).
6. Cargos + `packages/permissions` com **testes de propriedade** (fast-check) cobrindo overrides/hierarquia/timeout.
7. Gateway v0: HELLO/IDENTIFY/HEARTBEAT/DISPATCH + assinatura por servidor.
8. Cliente: store normalizado + cliente de gateway com reconexão.

**Sprint 3 — Mensagens**
9. Enviar/listar/editar/apagar mensagens + paginação por snowflake + `nonce`.
10. Renderizador de Markdown seguro (pacote compartilhado) + menções.
11. Lista virtualizada com rolagem invertida/âncora (a parte mais difícil de UX).
12. Eventos `MESSAGE_CREATE/UPDATE/DELETE` filtrados por permissão.

**Sprint 4 — Estado de leitura, anexos, DMs**
13. `read_states` (ack debounced) + badges de não lidas/menções.
14. Upload com URL pré-assinada + worker de validação/thumbnail.
15. DMs e indicador "digitando…".
16. Rate limit por bucket + cabeçalhos; início do audit log.

## 4. Estratégia de qualidade
| Nível | Prática |
|---|---|
| Unitário | Vitest; **testes de propriedade** nas permissões, Snowflake, parser de Markdown |
| Contrato | OpenAPI/Zod ↔ cliente gerado; *golden files* de eventos do gateway |
| Integração | Testcontainers (Postgres/Redis/NATS) por serviço |
| E2E | Playwright contra a UI no navegador (`PlatformPort` = `browser`) + WebDriver do Tauri (`tauri-driver`) no app instalado; fluxos críticos em cada PR |
| Carga | k6 (REST), simulador de conexões WS (10k+), teste de sala LiveKit (N pubs/subs) |
| Caos | derrubar gateway/Redis/NATS durante tráfego; validar `RESUME` sem perda/duplicata |
| Segurança | SAST/DAST/dep-scan no CI, fuzzing de parsers (Markdown, uploads), pentest antes do M2 público |
| Acessibilidade | axe no CI + checagem manual com leitor de tela |
**Definition of Done:** código + testes + docs + métricas/alertas + feature flag + checklist de segurança/privacidade.

## 5. Registro de riscos
| Risco | Prob. | Impacto | Mitigação |
|---|---|---|---|
| Escopo infinito ("quase tudo") | Alta | Alto | Tiers, marcos M1–M5, **congelar escopo por fase**, backlog de T4 explícito |
| Lista de mensagens (virtualização/rolagem) travada ou lenta | Alta | Alto | Prototipar no Sprint 1–3; benchmark com 100k mensagens |
| Fan-out de eventos em servidores grandes | Média | Alto | Assinaturas preguiçosas, presença com *coalescing*, testes de carga cedo |
| Voz/vídeo instável ou cara | Média | Alto | LiveKit; medir banda/custo por minuto; limites de qualidade/participantes |
| Permissões com bug (vazamento de canal privado) | Média | **Crítico** | Pacote único + testes de propriedade + revisão de segurança + testes negativos em todo endpoint |
| Abuso/CSAM/spam quando abrir ao público | Alta | **Crítico** | T&S desde P1, hash matching, denúncia/fila, captcha, limites; obrigações legais (§6) |
| Custo de infra descontrolado (mídia, vídeo) | Média | Médio | Limites por plano, transcodificação sob demanda, TTL em mídia, alertas de custo |
| Risco jurídico (marca, ToS, cópia) | Média | Alto | Marca/UI/assets **originais**; sem cópia de código; revisão jurídica antes do beta público |
| Dependência de terceiros (GIF, push, pagamentos) | Média | Médio | Camada de abstração; provedores trocáveis |
| Burnout/foco do time solo | Média | Alto | Entregas pequenas, demos quinzenais, comunidade de teste desde M1 |

## 6. Legal, privacidade e conformidade (checklist antes do beta público)
- **Marca e identidade:** nome, logo, cores, sons, ícones, textos e *assets* **próprios**; não usar "Discord" nem confundir o usuário. Licenças de fontes/ícones/emoji (ex.: Twemoji/Noto) verificadas.
- **Termos do Discord / DISCLAIMER do REA:** a análise deste projeto foi só de inventário; não copiar código/estrings/ativos; não usar a API/infra do Discord no seu produto sem acordo.
- **LGPD (Brasil)** e, se houver usuários na UE/EUA, **GDPR/COPPA**: base legal, política de privacidade, DPO/contato, exportação/exclusão de dados, retenção, registro de operações, resposta a incidentes (72 h).
- **Marco Civil da Internet / ECA Digital / DSA (UE):** canal de denúncias, remoção de conteúdo ilegal, transparência, proteção de menores, verificação/estimativa de idade (<13 bloqueado; <18 com proteções).
- **CSAM e conteúdo ilegal:** detecção por hash (programas de hash sharing), fluxo de denúncia às autoridades (no Brasil: SaferNet/MPF; nos EUA: NCMEC) — **consultar advogado antes de abrir uploads públicos**.
- **Direitos autorais:** procedimento de notificação e remoção (DMCA/equivalente), repeat infringer policy.
- **Lojas de apps:** UGC exige denúncia, bloqueio, moderação ativa e política pública; pagamentos in-app sujeitos às regras das lojas.
- **Pagamentos:** PCI via provedor (nunca tocar em dados de cartão), notas fiscais, tributos, antifraude, estornos.
- **Segurança:** política de divulgação responsável (`security.txt`), pentest, backups testados.

## 7. Como trabalhar neste projeto
1. Manter stack, comandos e convenções documentados no README (derivados do doc 03).
2. Cada épico do backlog vira *issue* com critérios de aceite; trabalhar **uma fatia vertical por vez** (migração → API → evento → UI → teste).
3. Gerar **ADRs** para decisões abertas (README §3) antes de codar.
4. Pedir sempre: testes de propriedade para permissões, testes negativos de autorização por endpoint, e *threat model* curto por fase.
5. Re-rodar o REA (`compare-application-versions`) a cada trimestre para acompanhar novidades do mercado — apenas como inventário.
