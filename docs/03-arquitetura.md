# 03 — Arquitetura e stack recomendadas

> Premissas: equipe pequena (1–6 pessoas), TypeScript como linguagem comum (vocês já usam Node/TS), meta inicial de **10 mil usuários simultâneos**, desenho que não impeça chegar a milhões. Decisões marcadas **[ADR]** devem virar um Architecture Decision Record em `docs/adr/` antes de implementar.

## 1. Princípios
1. **Não reinventar o difícil:** SFU de voz/vídeo, busca e armazenamento de objetos são *comprados/open source*; o que é produto (permissões, mensagens, gateway, UX) é próprio.
2. **Monólito modular primeiro, serviços depois.** Um repositório, poucos processos: `api`, `gateway`, `worker`. Separe quando a métrica pedir.
3. **Contract-first:** schemas Zod → OpenAPI + tipos do cliente + validação de eventos do gateway. Um só lugar define o formato.
4. **Tempo real é o produto:** todo estado visível chega por evento (`DISPATCH`), nunca por polling.
5. **Segurança e moderação são recursos de primeira classe**, não fase final.
6. **IDs Snowflake** (64 bits ordenáveis por tempo) desde o dia 1 — paginação, sharding e ordenação ficam grátis.

## 2. Stack (com alternativas)
| Camada | Escolha | Por quê | Alternativa |
|---|---|---|---|
| Linguagem | **TypeScript** (Node 22 LTS) + **Rust só na cola nativa do desktop** | TS na UI e no back (time já domina); Rust restrito a `apps/desktop/src-tauri` ([ADR-001](adr/ADR-001-runtime-desktop.md)) | Go para gateway/media se medições exigirem |
| Monorepo | **pnpm + Turborepo** | cache e tarefas por pacote | Nx |
| API HTTP | **Fastify** + Zod + OpenAPI | rápido, schema-first | Hono, NestJS |
| Gateway WS | **uWebSockets.js** (ou `ws`) | dezenas de milhares de conexões por nó | Go (`nhooyr/websocket`), Elixir |
| Banco relacional | **PostgreSQL 16** | usuários, servidores, cargos, canais, permissões | — |
| ORM/queries | **Drizzle** ou Kysely + migrações SQL | tipos fortes, SQL transparente | Prisma |
| Mensagens | Postgres **particionado** (hash de `channel_id` + faixa de tempo) → **ScyllaDB/Cassandra** quando passar de ~1–2 B linhas | começar simples; modelo já pensado p/ migrar | — |
| Cache/estado efêmero | **Redis/Valkey** | presença, sessões do gateway, rate limit, contadores | KeyDB |
| Barramento de eventos | **NATS JetStream** | fan-out por tópicos `guild.{id}`, replay curto | Redis Streams (mais simples no início), Kafka (excesso) |
| Arquivos | **S3 compatível** (Cloudflare R2/MinIO) + CDN | anexos, avatares, emoji | — |
| Imagens/vídeo | **imgproxy**/sharp + **ffmpeg** (workers) | thumbs, WebP/AVIF, transcodificação | — |
| Busca | **Meilisearch/Typesense** (início) → **OpenSearch** | filtros por autor/canal/data | Postgres FTS no MVP |
| **Voz/vídeo/tela** | **LiveKit** (Apache-2.0, self-host) | SFU WebRTC, simulcast, E2EE (SFrame), SDKs web/RN/nativo | mediasoup, Janus, Pion |
| UI (app desktop; navegador só para dev/teste) | **React 19 + Vite + TanStack Router/Query + Zustand**, Tailwind + Radix | ecossistema, velocidade | Solid/Svelte |
| Lista de mensagens | **TanStack Virtual** com rolagem invertida + âncora | ponto crítico de UX/perf | implementação própria |
| Desktop | **Tauri 2** (shell Rust + WebView do SO, UI React) — [ADR-001](adr/ADR-001-runtime-desktop.md) | instalador pequeno, shell em Rust, mesma UI em TS; no Windows o WebView2 é Chromium (WebRTC completo); mídia atrás de uma porta ([ADR-002](adr/ADR-002-porta-de-midia.md)) | Electron (fallback com a mesma UI), Flutter, Tauri+CEF (quando estável) |
| Mobile | **Expo/React Native** + SDK LiveKit RN | reuso de lógica TS | Flutter |
| Push | FCM + APNs + Web Push (VAPID) | — | OneSignal |
| E-mail | Postmark/Resend/SES | — | SMTP próprio (não) |
| Auth | opaco + refresh rotativo; Argon2id; TOTP; WebAuthn (`simplewebauthn`) | revogação simples | JWT curto + refresh |
| Anti-bot | Cloudflare Turnstile | — | hCaptcha |
| Observabilidade | OpenTelemetry → Prometheus/Grafana/Loki/Tempo; erros: Sentry/GlitchTip | — | Datadog |
| Infra | Docker Compose (dev) → VPS/Coolify (beta) → **Kubernetes** (produção) | evolui sem reescrever | Fly.io/Render |
| IaC/CI | Terraform + GitHub Actions | — | — |
| Testes | Vitest, Playwright, k6, testes de contrato | — | — |

## 3. Visão de serviços
```mermaid
flowchart LR
  subgraph Clients
    W[Web (dev/teste)] --- D[Desktop Tauri] --- M[Mobile RN]
  end
  W & D & M -->|HTTPS REST| API
  W & D & M -->|WSS eventos| GW[Gateway]
  W & D & M -->|WebRTC| LK[LiveKit SFU]
  API -->|publica eventos| BUS[(NATS JetStream)]
  BUS --> GW
  API --> PG[(PostgreSQL)]
  API --> RD[(Redis)]
  GW --> RD
  API -->|upload presigned| S3[(Object storage + CDN)]
  API -->|token de sala| LK
  WK[Workers: mídia, embeds, push, e-mail, indexação, automod] --> BUS
  WK --> S3 & PG & SE[(Search)]
  API --> SE
```
- **api**: REST, validação, permissões, escrita no banco, publica eventos.
- **gateway**: conexões WebSocket, sessões, assinatura de tópicos, *fan-out*, presença.
- **worker**: tarefas assíncronas idempotentes (fila no NATS/Redis).
- **voice**: LiveKit + serviço fino que emite tokens por permissão (`CONNECT`, `SPEAK`, `STREAM`…).
- **admin**: painel interno de T&S (app separado, autenticação forte).

### Layout do monorepo
```
discord-clone/
  apps/ desktop/ (UI React + src-tauri/) api/ gateway/ worker/ admin/ mobile/ (P7)
  packages/ ui/ (tokens, tema, componentes) platform/ (PlatformPort + MediaEngine — ADR-002)
            schema/ (Zod+tipos) sdk/ (cliente TS) permissions/ markdown/ config/ snowflake/
  infra/ docker/ k8s/ terraform/
  docs/ adr/ spikes/ ...
```
A UI mora em `apps/desktop`; o mesmo frontend roda no navegador (`pnpm dev:web`) com a implementação `browser` da `PlatformPort`, só para desenvolvimento e testes.
`packages/permissions` e `packages/markdown` são **compartilhados cliente+servidor** (mesma regra no UI e na API; o servidor sempre decide).

## 4. Modelo de dados essencial (esboço)
```sql
-- IDs = bigint snowflake (gerado na aplicação)
users(id, username, display_name, email, password_hash, avatar, banner, bio, flags bigint, created_at, ...)
sessions(id, user_id, token_hash, device, ip, created_at, last_seen, revoked_at)
relationships(user_id, target_id, type /*friend|blocked|pending_in|pending_out*/, created_at)
guilds(id, owner_id, name, icon, features text[], verification_level, notif_level, explicit_filter, premium_tier, ...)
roles(id, guild_id, name, color, position, permissions bigint, flags, icon)
channels(id, guild_id null, type smallint, parent_id, name, topic, position, nsfw, rate_limit, bitrate, user_limit, flags, last_message_id, archived/locked/auto_archive for threads)
permission_overwrites(channel_id, target_id, target_type /*role|member*/, allow bigint, deny bigint)
guild_members(guild_id, user_id, nick, joined_at, timeout_until, flags)  member_roles(guild_id, user_id, role_id)
invites(code, guild_id, channel_id, inviter_id, max_uses, uses, expires_at, temporary)
messages(channel_id, id, author_id, content, type, flags, reference_message_id, edited_at, pinned, embeds jsonb, components jsonb, ...)
  -- PK (channel_id, id); partição por tempo; id ordena = created_at
attachments(id, message_id, filename, content_type, size, width, height, url_key, spoiler, alt)
reactions(channel_id, message_id, emoji, user_id)  + contagem agregada em Redis/coluna
read_states(user_id, channel_id, last_ack_id, mention_count)   -- debounced
audit_log_entries(id, guild_id, actor_id, action_type, target_id, changes jsonb, reason, created_at)
applications/bots/webhooks/oauth_tokens/commands...  (fase 4)
reports(id, reporter_id, target_type, target_id, reason, status, ...)  -- T&S
```
**Mensagens em Scylla (futuro):** partição `(channel_id, bucket)` onde `bucket = floor(message_id_timestamp / 10 dias)`, clustering `message_id DESC`. Pense nisso agora: toda leitura é "N mensagens antes/depois/ao redor de um ID".

## 5. Permissões (regra das mais importantes do produto)
52 permissões oficiais em *bitfield* (`bigint`). Algoritmo (descrito nos docs oficiais — reimplementar, com testes de propriedade):
```ts
const ALL = ~0n;
function basePermissions(guild, member): bigint {
  if (guild.ownerId === member.id) return ALL;
  let p = guild.everyoneRole.permissions;
  for (const r of member.roles) p |= r.permissions;
  return (p & ADMINISTRATOR) ? ALL : p;
}
function channelPermissions(base: bigint, member, channel): bigint {
  if (base & ADMINISTRATOR) return ALL;
  let p = base;
  const ow = (id) => channel.overwrites.get(id);
  let o = ow(channel.guildId);               // @everyone
  if (o) p = (p & ~o.deny) | o.allow;
  let allow = 0n, deny = 0n;                 // cargos: acumula antes de aplicar
  for (const r of member.roles) { o = ow(r.id); if (o) { allow |= o.allow; deny |= o.deny; } }
  p = (p & ~deny) | allow;
  o = ow(member.id);                          // membro por último
  if (o) p = (p & ~o.deny) | o.allow;
  if (!(p & VIEW_CHANNEL)) p = 0n;            // sem ver o canal = sem nada
  if (member.timeoutUntil > now) p &= (VIEW_CHANNEL | READ_MESSAGE_HISTORY);
  return p;
}
```
Regras extras a testar: hierarquia de cargos (só gerencia quem está acima), `MANAGE_ROLES` não concede cargos acima do próprio, permissões que exigem 2FA do servidor, canais de voz/stage com subconjuntos próprios, permissões implícitas em threads. **Cache:** calcular por (membro, canal) com invalidação por evento de cargo/overwrite.

## 6. Gateway em tempo real
- **Protocolo (próprio, inspirado no documentado):** `HELLO(heartbeat_interval)` → `IDENTIFY(token, intents, properties)` → `READY(session_id, user, guilds, resume_url)`; `HEARTBEAT/ACK` com número de sequência; `DISPATCH(op=0, t, s, d)`; `RESUME(session_id, seq)` com *replay buffer* (Redis, ~2–5 min); `RECONNECT`, `INVALID_SESSION`.
- **Compressão e encoding:** JSON no início; `zstd`/`zlib-stream` (o desktop oficial embute erlpack+zstd — R). MessagePack opcional.
- **Intents** (filtram quais eventos cada conexão recebe) — barato de fazer agora, essencial para bots e para economizar banda.
- **Assinaturas:** ao conectar, o usuário assina `user.{id}` e `guild.{id}` dos seus servidores. Em servidores grandes use **assinaturas preguiçosas**: só recebe presença/membros dos canais visíveis (lista de membros por faixas), nunca "todos os membros".
- **Fan-out:** `api` publica em `guild.{id}`; **gateway** filtra por permissão (`VIEW_CHANNEL`) antes de enviar. Presença com *coalescing* (agrupa mudanças a cada ~1–2 s) e teto por servidor.
- **Escala:** gateway *stateless* exceto sessões em memória + Redis; *sharding* por `user_id`; balanceamento por IP-hash/consistent hash; *graceful drain* em deploy (clientes reconectam com jitter).
- **Contrapressão:** buffer por conexão com limite; cliente lento é derrubado e faz `RESUME`.

## 7. API REST
- Versionamento no path (`/v1`), erros tipados, **rate limit por bucket** com cabeçalhos `X-RateLimit-*`/`Retry-After` e limite global (token bucket em Redis; modelo documentado em `topics/rate-limits`).
- Paginação por snowflake (`before/after/around`, `limit`).
- Idempotência: `nonce` em criação de mensagens (de-duplica reenvio otimista).
- Uploads: `POST /attachments` → URL pré-assinada → worker valida (tipo real por *magic bytes*, tamanho, antivírus, hash de mídia ilegal) → só então a mensagem referencia o anexo.
- **Embeds/unfurl:** worker isolado, **proteção SSRF** (bloquear IPs privados/metadata, limitar redirecionamentos/tamanho/tempo, DNS pinning).

## 8. Voz, vídeo e tela
- Cada canal de voz/stage = **sala LiveKit**; `api` valida permissão e emite *access token* com `canPublish`, `canSubscribe`, `canPublishScreen` derivados de `CONNECT/SPEAK/STREAM/USE_VAD/PRIORITY_SPEAKER`.
- Eventos de estado (quem está em qual canal, mutes de servidor) via `VOICE_STATE_UPDATE` no gateway; LiveKit cuida da mídia.
- Cliente: seleção de dispositivos, VAD/sensibilidade, **PTT** (web: apenas com foco; **desktop: atalho global** via módulo nativo), supressão de ruído **RNNoise (WASM)** e `echoCancellation/AGC` do navegador, volume/pan por usuário com `WebAudio`, tela com áudio (`getDisplayMedia`; no desktop, `desktopCapturer` + captura de áudio de aplicação).
- **E2EE (T2):** LiveKit oferece E2EE (SFrame). O desktop oficial usa MLS/DAVE (descrito em `topics/voice-connections`); decisão **[ADR]**: SFrame com troca de chaves própria (rápido) vs MLS (OpenMLS/mls-rs; mais robusto, mais trabalho).
- Multi-região: nós LiveKit por região + escolha por latência; reconexão rápida (ICE restart) e *fallback* de codec (VP9→VP8→H264).

## 9. Cliente (web/desktop)
- **Estado:** normalizado por entidade (guilds/channels/messages/users) atualizado por eventos do gateway; TanStack Query só para leituras sob demanda.
- **Resiliência:** reconexão com *backoff + jitter*, `RESUME`, fila de envio offline, UI otimista com `nonce`.
- **Performance:** virtualização, imagens com `blurhash`, `content-visibility`, *code-splitting* por rota, `OffscreenCanvas` para processamento de imagem (o shell oficial usa worker para isso — R).
- **Cache local:** IndexedDB (últimas N mensagens por canal) para abrir instantâneo.
- **i18n:** ICU/Lingui; **a11y:** ARIA live regions para mensagens, foco previsível, atalhos configuráveis.
- **Desktop (Tauri 2, desktop-first):** a UI **nunca** chama o Tauri direto; usa `PlatformPort` e `MediaEngine` (pacote `packages/platform`, [ADR-002](adr/ADR-002-porta-de-midia.md)), com implementações `tauri` (produto) e `browser` (dev/Playwright). Rust fica restrito à **cola nativa** em `apps/desktop/src-tauri`: janela, bandeja (mutar/ensurdecer), badge, notificações, ociosidade do SO, atalhos/entrada global (teclado e **botões do mouse**), autostart, instância única, *deep link* e atualizador assinado. Permissões/capabilities do Tauri em *deny by default*, CSP estrita, comandos IPC por lista permitida. Instalador NSIS/MSI com WebView2 via bootstrapper. Capacidades-alvo vêm do §2.2 do doc 01. **Orçamentos de performance e gates** estão no ADR-001 §7–8.

## 10. Segurança (checklist de arquitetura)
Argon2id + *pepper*; rate limit por IP/conta/dispositivo; captcha em cadastro/login suspeito; cookies `HttpOnly+SameSite` para web; CSP estrita; sanitização do renderizador de Markdown (lista permitida); validação de upload; segredos em cofre (SOPS/Vault/Doppler); *audit log* interno de ações de admin; separar domínio de **conteúdo de usuário** (CDN em outro registrável) para mitigar XSS; backups criptografados + teste de restauração; dependabot/Renovate; SAST/DAST no CI; *threat model* por fase.

## 11. Capacidade e custo (estimativas grosseiras — validar com teste de carga)
| Estágio | Usuários simultâneos | Infra típica | Custo/mês (ordem de grandeza) |
|---|---|---|---|
| Alpha | ≤200 | 1 VPS (4 vCPU/8 GB) com Compose + R2 | US$ 30–80 |
| Beta | ≤5 mil | 2–3 VPS (api/gateway/db), LiveKit dedicado, R2+CDN | US$ 300–1.000 |
| Lançamento | ~50 mil | K8s pequeno, Postgres gerenciado/réplicas, Redis, NATS, N nós LiveKit | US$ 3–10 mil |
Voz/vídeo/tela dominam banda e custo; mensagens são baratas se o armazenamento for bem modelado.

## 12. Referências open source para **estudar** (verifique licenças — várias são AGPL)
LiveKit (SFU), **Spacebar** (reimplementação compatível com a API do Discord), **Stoat/Revolt**, Matrix/Element, Mattermost, Zulip, Rocket.Chat. Use para comparar modelagem e armadilhas; **não copie trechos** sem checar licença.
