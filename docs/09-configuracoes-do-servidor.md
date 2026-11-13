# 09 — Configurações do servidor (cargos, permissões e moderação)

## De onde veio a lista (REA, 2026-11-13)
Mesmo método do [01](01-descobertas-rea.md) e do [08](08-configuracoes.md): só inventário, nada copiado.

| Alvo | Como | O que deu |
|---|---|---|
| Cliente web público do Discord (728 scripts exportados com `inspect-web-page` + `export-web-scripts`) | busca no enum de seções | **Seções do servidor:** visão geral, integração (onboarding), membros (editar, castigo, expulsar, banir), canais, cargos (editar, permissões), banimentos, convites, modelos, integrações, segurança, URL personalizada, emojis, figurinhas, sons, registro de auditoria (com filtro), moderação, AutoMod, comunidade (boas-vindas, verificação), análises, assinaturas de cargo, produtos, diretório de apps, perfil e etiqueta do servidor, tema, impulsos, webhooks e excluir. **Seções do canal:** visão geral, permissões (sobrescritas), convites, integrações e excluir. |
| Documentação oficial (`discord-api-docs`, baixada no 01) | `topics_permissions` | 53 permissões; hierarquia de cargos; ordem de cálculo das permissões (cargo base → cargos → sobrescritas do canal) |

**Regras do modelo, reescritas para o Aurora:**
- Todo servidor tem um cargo base que vale para todo mundo, o **@todos**.
- A permissão de um membro é a soma (OU) das permissões do @todos com as dos cargos dele. O **dono** e quem tem **Administrador** podem tudo.
- **Hierarquia:** a ordem dos cargos importa para gerenciar pessoas, não para somar permissões. Só dá para:
  - dar, tirar, editar ou excluir cargos **abaixo** do seu cargo mais alto;
  - expulsar ou banir quem tem o cargo mais alto **abaixo** do seu;
  - dar a um cargo apenas permissões que você mesmo tem.
- **Por canal (fase 2):** em cada canal, regras para o @todos, para cargos e para pessoas. Ordem: @todos, depois os cargos (somados), depois a pessoa; em cada passo, primeiro o que é negado, depois o que é permitido. Sem "Ver canais", nada mais vale naquele canal. Dono e Administrador ignoram as regras.
- **Castigo:** a pessoa continua no servidor e lê tudo, mas não escreve, não reage, não cria convites e sai da voz até a hora marcada. Sair e voltar não tira o castigo. Dono e Administrador não ficam de castigo.

## O que entra no Aurora
| Discord | Aurora | Fase |
|---|---|---|
| Visão geral (nome) | Renomear o servidor | 1 |
| Cargos + permissões | Cargos com nome, cor (paleta própria), "mostrar separado na lista de membros", ordem e 14 permissões | 1 |
| Membros | Lista com cargos; dar e tirar cargos; expulsar; banir | 1 |
| Banimentos | Lista (com motivo) e desbanir; quem foi banido não volta pelo convite | 1 |
| Convites | Lista (quem criou, usos, quando) e revogar | 1 |
| Canais (visão geral, excluir) | Renomear e excluir canais | 1 |
| Registro de auditoria | Quem fez o quê e quando | 1 |
| Excluir servidor / sair | Excluir (só o dono, digitando o nome) e sair do servidor | 1 |
| Permissões por canal (sobrescritas) | Canal privado, só leitura e Negar/Herdar/Permitir por cargo ou pessoa | 2 |
| Castigo (timeout), silenciar e mover na voz | Castigo de 1 minuto a 1 semana; silenciar para todos, mover de sala e desconectar | 2 |
| Ícone, banner, emojis, figurinhas, sons | Precisam de upload de arquivos | 3 |
| AutoMod, verificação, comunidade, boas-vindas | Fazem sentido com servidores grandes | 3 |
| Webhooks, integrações, diretório de apps, assinaturas, impulsos, produtos, URL personalizada, etiqueta | Fora do escopo por enquanto | — |

### Permissões da fase 1
| Permissão | Libera | @todos tem? |
|---|---|---|
| Administrador | tudo, inclusive o que vier depois | não |
| Gerenciar servidor | renomear; ver e revogar convites | não |
| Gerenciar cargos | criar, editar, ordenar e excluir cargos, dar e tirar cargos (abaixo do seu) | não |
| Gerenciar canais | criar, renomear e excluir canais | não |
| Expulsar membros | tirar alguém do servidor (pode voltar com convite) | não |
| Banir membros | tirar e impedir a volta; ver e desfazer banimentos | não |
| Ver registro de auditoria | ver quem fez o quê | não |
| Criar convite | gerar código de convite | sim |
| Enviar mensagens | escrever nos canais de texto | sim |
| Adicionar reações | reagir com emoji | sim |
| Gerenciar mensagens | apagar mensagens de outras pessoas | não |
| Conectar | entrar nos canais de voz | sim |
| Falar | usar o microfone na voz | sim |
| Transmitir | compartilhar a tela | sim |

### Permissões da fase 2
| Permissão | Libera | @todos tem? |
|---|---|---|
| Ver canais | ver os canais e ler as mensagens (tirar esconde; dá para liberar canal a canal) | sim |
| Castigar membros | deixar alguém só olhando por um tempo (abaixo do seu cargo) | não |
| Silenciar membros | desligar o microfone de alguém na voz até tirarem | não |
| Mover membros | levar alguém para outra sala de voz ou tirá-lo da voz | não |

Valem por canal: Ver canais, Enviar mensagens, Adicionar reações, Gerenciar mensagens, Conectar, Falar, Transmitir, Silenciar e Mover membros. As outras valem para o servidor inteiro.

**Sigilo:** num canal privado, quem não tem acesso não recebe nada dele: nem o canal, nem mensagens, reações, "digitando", menções, leitura ou quem está na voz. A API responde 404 (não revela que o canal existe). Quando o acesso muda, o canal aparece ou some na hora para cada pessoa.

A conferência é **no servidor**: a interface só esconde o que não pode. Na voz, a credencial do LiveKit só libera o microfone com "Falar" e a tela com "Transmitir".

## Situação
**Fase 1 entregue na 1.5.0** (2026-11-13). Verificado:
- 15 testes do cálculo de permissões, sendo 4 testes de propriedade com 500 servidores aleatórios cada: dono e Administrador podem tudo; ganhar cargo nunca tira permissão; ninguém mexe em quem está acima; ninguém concede o que não tem.
- 14 testes de ponta a ponta no servidor: hierarquia, mensagens, voz (credencial do LiveKit e gateway), expulsar, banir, convites, canais, auditoria, sair, excluir e migração de bancos antigos.
- Um teste que sobe o servidor com o Node puro (pegou um import sem extensão que só o Vitest resolvia).
- Telas conferidas nos temas escuro e claro e em 390 px, inclusive a visão de um membro sem permissões.

**Fase 2 entregue na 1.6.0** (2026-11-13). Verificado:
- Testes de propriedade do cálculo por canal (500 servidores aleatórios): sem regras = permissões do servidor; nada do servidor aparece do nada; sem "Ver canais" = nada; de castigo, no máximo ver.
- 8 testes de ponta a ponta: canal privado sem vazamento (mensagens, digitação, menções, leitura, voz), cargo ganho/perdido mostra/esconde o canal, só leitura, ninguém tira o próprio acesso nem mexe em quem está acima, castigo (inclusive sair e voltar), silenciar, mover e desconectar, e migração de bancos 1.5. Quebrar o filtro de mensagens de propósito faz o teste falhar.
- Telas conferidas nos temas escuro e claro e em 390 px, inclusive a visão de quem está de castigo.

## Onde fica cada coisa
- `packages/schema/src/permissions.ts`: as permissões, o cálculo e a hierarquia. É uma função pura, usada pelo servidor e pelo app, com testes de propriedade (regra 8).
- Servidor: tabelas `roles`, `member_roles`, `bans` e `audit_log`. Os servidores antigos ganham o @todos na migração, com as permissões padrão.
- 1.6: tabelas `channel_overwrites` e `moderation` (castigo e silêncio, que ficam mesmo se a pessoa sair e voltar). Na migração, o @todos ganha "Ver canais" uma vez só (`PRAGMA user_version`).
- Eventos da 1.6: `VOICE_MOVE` (só para quem foi movido ou desconectado); `MEMBER_UPDATE` passou a levar `timeoutUntil` e o estado de voz, `serverMuted`.
- Eventos novos do gateway (versão 2): `GUILD_UPDATE`, `GUILD_DELETE`, `GUILD_ROLES_UPDATE`, `MEMBER_UPDATE`, `MEMBER_REMOVE`, `CHANNEL_UPDATE` e `CHANNEL_DELETE`.
- App: tela de configurações do servidor (engrenagem no cabeçalho do servidor). A lista de membros fica agrupada pelos cargos marcados como "mostrar separado".
