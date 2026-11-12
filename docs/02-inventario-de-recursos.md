# 02 — Inventário de recursos e priorização

**Legenda de fonte:** `D` = docs oficiais (alta confiança) · `R` = observado pelo REA no desktop · `W` = pista no bundle web (baixa) · `K` = conhecimento geral do produto, **não verificado nesta rodada**.
**Tier:** `T0` MVP (sem isso não é chat) · `T1` paridade essencial · `T2` engajamento/diferencial · `T3` plataforma e monetização · `T4` nicho/adiar.
**Esforço** (1 dev experiente, incluindo testes): `S` ≤1 sem · `M` 1–3 sem · `L` 1–2 meses · `XL` >2 meses.

## 1. Conta, identidade e segurança da conta
| Recurso | Fonte | Tier | Esf. | Notas |
|---|---|---|---|---|
| Cadastro/login e-mail+senha (Argon2id), verificação de e-mail, reset | K | T0 | M | Captcha (Turnstile/hCaptcha) desde o início |
| Sessões/dispositivos, logout remoto, tokens rotativos | K | T0 | M | token opaco + refresh; lista de dispositivos |
| 2FA TOTP + códigos de backup | K | T1 | S | |
| **Passkeys/WebAuthn** | R (WEBAUTHN_*) | T1 | M | |
| Login por QR / handoff para mobile | W (`handoff_token`) | T2 | M | |
| Perfil: avatar, banner, bio, pronomes, cor, nome de exibição, status personalizado | D/K | T0–T1 | M | |
| Decoração de avatar/efeitos de perfil | W (shop) | T4 | M | só com loja |
| Conexões externas (Spotify, Steam, GitHub, YouTube, Twitch, Xbox…) | D (23 serviços) | T2 | M/serviço | via OAuth2; mostrar no perfil |
| Exportar/Apagar dados (LGPD/GDPR) | K | T1 | M | obrigatório antes de abrir ao público |
| Verificação de idade / bloqueio <13 | K | T1 | M | requisito legal/lojas de apps |

## 2. Relacionamentos e DMs
| Recurso | Fonte | Tier | Esf. |
|---|---|---|---|
| DM 1:1 | D (`DM`) | T0 | M |
| Grupo de DM (até N pessoas), ícone, nome | D (`GROUP_DM`) | T1 | M |
| Amigos: pedido/aceitar/remover, bloquear, ignorar | K | T1 | M |
| Solicitações de mensagem / filtro de spam em DM | K | T2 | M |
| Chamadas 1:1 e em grupo (toque, atender, recusar) | D (msg `CALL`) | T1 | L |
| Convites de amigo (link `FRIEND`) | D (`Invite Types`) | T2 | S |

## 3. Servidores (guilds)
| Recurso | Fonte | Tier | Esf. |
|---|---|---|---|
| Criar/editar/excluir servidor, ícone, dono, transferir posse | D | T0 | M |
| Canais e **categorias**, reordenar, arrastar | D | T0 | M |
| **Cargos** (cor, hierarquia, ícone) + overrides por canal | D | T0 | L |
| Membros: lista, apelido, kick, ban, timeout | D (`MODERATE_MEMBERS`) | T0/T1 | M |
| **Convites** (expiração, usos, temporário, vanity URL) | D | T0 | M |
| Níveis de verificação, filtro de conteúdo explícito, MFA para moderar | D (enums) | T1 | S |
| Templates de servidor | D (`guild-template`) | T3 | S |
| Canal de sistema (boas-vindas/boosts), regras, atualizações | D | T1 | S |
| **Onboarding**, tela de boas-vindas, *membership screening* | D (features + audit log) | T2 | L |
| **Discovery** (diretório de servidores) | D | T3 | L |
| **Server Home / guia / insights** | D (`VIEW_GUILD_INSIGHTS`, `HOME_SETTINGS_*`) | T2/T3 | L |
| Boosts e níveis (tiers 0–3) → limites maiores | D (`premium_tier`) | T3 | L |
| Parceria/verificado/badges | D | T4 | S |
| Convites pausados / alerta de raid (modo incidente) | D (`INVITES_DISABLED`, msgs 36–39) | T2 | M |

## 4. Canais (13 tipos oficiais)
| Tipo | Tier | Esf. | Notas |
|---|---|---|---|
| Texto, DM, Grupo DM, Categoria | T0–T1 | — | núcleo |
| Voz | T1 | L | LiveKit |
| Anúncio (+ **seguir canal**/crosspost) | T2 | M | flags `CROSSPOSTED/IS_CROSSPOST` |
| Threads pública/privada/anúncio | T1 | L | arquivamento automático, membros |
| **Fórum** (tags, layout lista/galeria, ordenação) | T2 | L | `REQUIRE_TAG`, `PINNED` |
| **Mídia** (galeria) | T2 | M | |
| **Stage** (palco, pedir para falar) | T2 | L | `REQUEST_TO_SPEAK` |
| Status do canal de voz | D (`SET_VOICE_CHANNEL_STATUS`) | T2 | S |
| Slowmode, NSFW, limite de usuários, bitrate, modo de vídeo auto/full | D | T1 | S |
| Diretório (legado) | T4 | — | ignorar |

## 5. Mensagens
| Recurso | Fonte | Tier | Esf. |
|---|---|---|---|
| Enviar/editar/apagar, histórico paginado, rolagem infinita virtualizada | D | T0 | L |
| Markdown (negrito, itálico, código, citação, spoiler, listas, títulos), menções (@user, @cargo, @everyone/@here, #canal) | D/K | T0 | M |
| Anexos (imagem, vídeo, áudio, arquivo), limite por plano, spoiler, alt-text | D | T0 | L |
| **Respostas** (reply) | D (`REPLY`) | T0 | S |
| **Reações** (inclui custom e *super reactions*) | D/K | T1 | M |
| **Embeds/link preview** (rich, imagem, vídeo, gifv, artigo) | D (`Embed Types`) | T1 | L |
| **Encaminhar** mensagem (snapshot) | D (`FORWARD`, `HAS_SNAPSHOT`) | T2 | M |
| **Enquetes** (polls) + resultado | D (`poll`) | T2 | M |
| **Mensagens de voz** | D (`IS_VOICE_MESSAGE`) + R | T2 | M |
| **Fixar** (pins) | D (`PIN_MESSAGES`) | T1 | S |
| Suprimir embeds / sem notificação (`@silent`) | D (flags) | T2 | S |
| Efêmeras (apenas p/ quem usou o comando) | D (`EPHEMERAL`) | T3 | S |
| Digitando…, indicador de não lidas, "marcar como lida" | D/K | T0/T1 | M |
| Busca de mensagens (filtros: de, em, tem, menção, data) | K | T1 | L |
| Inbox de menções / mensagens salvas | K | T2 | M |
| Tradução, TTS (`/tts`) | D (`SEND_TTS_MESSAGES`) | T4 | S |
| **Componentes v2** (containers, seções, galerias) | D (20 tipos) | T3 | L |

## 6. Voz, vídeo e transmissão
| Recurso | Fonte | Tier | Esf. |
|---|---|---|---|
| Entrar/sair de canal de voz, mutar, ensurdecer, indicador de fala | D/R | T1 | L |
| Seleção de dispositivos, teste de microfone, sensibilidade (VAD) | R | T1 | M |
| **Push-to-talk** (atalho global no desktop) | R (`setPTTActive`, input global) | T1 | M |
| Supressão de ruído, cancelamento de eco, AGC | R (Krisp) | T1 | M | RNNoise/WebRTC APM (open source) |
| Volume/mute **por usuário**, pan, áudio posicional | R | T2 | M |
| Câmera, **fundo desfocado/virtual** | R (mediapipe) | T2 | M |
| **Compartilhar tela / Go Live** (janela, tela inteira, áudio do app) | R | T1 | L |
| Qualidade/resolução/FPS, simulcast, fallback de codec | R | T2 | M |
| **E2EE de voz/vídeo (DAVE/MLS)** | D + R | T2 | XL |
| Prioridade de fala, mover/silenciar/desconectar membros | D (permissões) | T1 | S |
| **Stage** com palestrantes/plateia | D | T2 | L |
| **Soundboard** (sons por servidor, externos, efeitos de voz) | D (`soundboard`, `Voice Channel Effect`) | T2 | M |
| **Clips/replay** dos últimos N s | R (`startReplay`) | T3 | L |
| Seleção de região de voz / failover | D/W (`RTCRegionStore`) | T2 | M |
| Canal de AFK + timeout | K | T2 | S |

## 7. Presença e atividades
| Recurso | Fonte | Tier | Esf. |
|---|---|---|---|
| Status: online/ausente/não perturbe/invisível; **ausência automática por ociosidade** | D + R (`GET_SYSTEM_IDLE_TIME`) | T1 | M |
| Status personalizado (texto+emoji, expiração) | K | T2 | S |
| **Rich Presence** (atividade, jogo, Spotify, party, join) | D (`Activity Object`, `rpc`) | T2 | L |
| Detecção de jogos | R (`game_utils`) | T3 | L |
| RPC local (pipe+WebSocket) para apps de terceiros | D + R | T3 | M |
| **Activities** (mini-apps em iframe, multiplayer) | D (`activities`) | T3 | XL |
| Overlay em jogo | R | T4 | XL |
| Saves em nuvem/loja de jogos | R (`dispatch/cloudsync`) | T4 | XL |

## 8. Notificações e estado de leitura
| Recurso | Fonte | Tier | Esf. |
|---|---|---|---|
| Contadores de não lidas/menções por canal e servidor (`ack`) | K | T0 | M |
| Configuração por servidor/canal/categoria (todas/menções/nada), silenciar por tempo, suprimir @everyone/@cargos | K | T1 | M |
| Notificações desktop nativas, badge, bandeja | R | T1 | M |
| Push mobile (FCM/APNs) e Web Push | K | T1 | L |
| Notificações por e-mail (digest) | K | T3 | S |

## 9. Moderação, segurança e confiança (T&S)
| Recurso | Fonte | Tier | Esf. |
|---|---|---|---|
| Kick, ban, timeout, prune, limpar mensagens do banido | D | T0/T1 | M |
| **Audit log** (71 eventos) | D | T1 | L |
| **AutoMod** (palavras, spam, menções em massa, presets, perfil) com ações (bloquear, alertar, timeout, bloquear interação) | D | T2 | L |
| Denunciar mensagem/usuário/servidor + fila interna | K | T1 | L | **obrigatório** para lojas de apps |
| Filtro de mídia explícita (hash/ML) | W + D (enum) | T1 | L | requisitos legais (CSAM) |
| Alertas de segurança, bloqueio de links, verificação | D | T2 | M |
| Rate limits e anti-abuso (buckets, headers) | D (`rate-limits`) | T0 | M |
| Painel admin interno (usuários, servidores, reports, takedown) | K | T1 | L |

## 10. Expressões e mídia social
| Recurso | Fonte | Tier | Esf. |
|---|---|---|---|
| Emoji Unicode + picker, histórico de uso | W (`EmojiUsageHistory`) | T0 | S |
| **Emoji personalizado** (estático/animado), externos | D | T1 | M |
| **Stickers** (padrão/guild, Lottie/APNG/GIF) | D | T2 | M |
| **GIFs** (provedor externo) | K | T2 | M | verificar disponibilidade/termos da API |
| Soundboard (ver §6), cargos com ícone, cores em gradiente | D (features) | T2/T3 | S |
| Eventos agendados (voz/stage/externo, RSVP) | D | T2 | M |

## 11. Plataforma e desenvolvedores
| Recurso | Fonte | Tier | Esf. |
|---|---|---|---|
| Aplicações/bots, tokens, portal do desenvolvedor | D | T3 | L |
| REST API versionada + **Gateway** WebSocket para bots (intents) | D | T3 | L |
| **Webhooks** (entrada, seguidor de canal, de aplicação) | D | T2 | M |
| **Slash commands**, menus de contexto, autocomplete, modais | D | T3 | L |
| **Interações** (HTTP ou gateway), botões/selects | D | T3 | L |
| **OAuth2** (provedor próprio: escopos, PKCE, instalar app) | D | T3 | L |
| Role connections / linked roles | D | T3 | M |
| App directory, descoberta de apps | D | T4 | L |
| Embedded App SDK + Social SDK (jogos) | D | T4 | XL |
| Equipes (teams) de desenvolvedores | D | T4 | M |

## 12. Monetização e premium
| Recurso | Fonte | Tier | Esf. |
|---|---|---|---|
| Plano premium (limites maiores, emoji em qualquer lugar, perfil, upload) | D (`premium_type`) | T3 | L |
| Boost de servidor | D | T3 | M |
| **Assinaturas de cargo** (criadores) / loja | D + W | T3 | XL |
| SKUs, entitlements, compras únicas, IAP em Activities | D | T3 | L |
| Checkout/pagamentos (cartão, Pix), notas fiscais, estorno | W (`checkout*`) | T3 | L |
| "Shop", cosméticos, quests/anúncios | W | T4 | L |

## 13. Cliente: desktop, mobile, UX
| Recurso | Fonte | Tier | Esf. |
|---|---|---|---|
| UI responsiva (React) — alvo de dev/teste no navegador; **o produto é o app desktop** | K | T0 | XL |
| **Desktop** (Tauri 2, ver ADR-001): instalador, tray, badge, auto-update assinado, abrir no login, atalhos globais, notificações | R | T0/T1 | L |
| Mobile (iOS/Android): chat, voz em background, push, share extension | K | T3 | XL |
| Temas (claro/escuro/OS), densidade compacta/aconchegante, zoom, fonte | K | T1 | M |
| **Acessibilidade** (leitor de tela, movimento reduzido, contraste, teclado) | R (`ACCESSIBILITY_*`) | T1 | L |
| **i18n** (pt-BR primeiro, en, es) | K | T1 | M |
| Atalhos de teclado, *quick switcher* (Ctrl+K) | K | T1 | M |
| Modo streamer (ocultar dados) | K | T4 | S |
| Sincronização de configurações entre dispositivos | W (`UserSettingsSync`) | T1 | M |
| Barra de título customizada, PiP, anti-captura | R | T2 | M |

## 14. Resumo por tier (para decidir escopo)
- **T0 (MVP de chat):** **app desktop instalável (Tauri)**, conta, servidores, canais texto, cargos/permissões básicas, convites, mensagens (markdown, anexos, reply), DMs, não lidas, rate limit.
- **T1 (paridade essencial):** voz, compartilhar tela, threads, reações, embeds, pins, busca, amigos, notificações, integrações desktop avançadas (PTT global, tray, badge), moderação básica/audit log, denúncias, LGPD, a11y/i18n.
- **T2:** fórum/mídia/stage/anúncio, enquetes, mensagens de voz, soundboard, stickers, eventos, AutoMod, onboarding, Rich Presence, E2EE.
- **T3:** bots/slash/OAuth2/interações, webhooks avançados, componentes v2, Activities, monetização, mobile, discovery.
- **T4:** overlay, loja de jogos/cloud saves, quests/anúncios, shop de cosméticos, SDKs de jogos.
