# 12 — Chat do dia a dia (item 3)

O que falta no uso diário do chat, comparando com o comportamento de outros apps de comunidade (nada de código, texto ou identidade deles).

## Como está hoje (1.14)
- **Já funciona:** responder, editar, reações, menções a pessoas, markdown, anexos (25 MB, 10 por mensagem), não lidas por canal, aviso do Windows quando alguém menciona você e conversas diretas.
- **Busca:** só de pessoas, pela barra do topo.

| Falta | Por que importa |
|---|---|
| Buscar mensagens | "Cadê aquele link/print que alguém mandou?" é a pergunta mais comum num servidor |
| Mensagens fixadas | Regras, links e combinados ficam à mão sem rolar o histórico |
| Notificações por servidor e por canal, e @todos | Servidor grande vira barulho; sem @todos não há como avisar todo mundo de uma vez |
| Apelido por servidor | Cada turma chama a pessoa de um jeito |
| Prévia de links | Saber o que é o link antes de abrir |
| Emojis do servidor | Identidade da turma |
| GIFs | Conforto; depende de decisão (abaixo) |

## Ordem e fases

### Fase A — Buscar mensagens (1.15)
**Índice no servidor:**
- tabela virtual FTS5 (`messages_fts`), alimentada por gatilhos no inserir, editar e apagar;
- o índice antigo é montado uma vez, na migração;
- já conferido no `node:sqlite`: o tokenizador `unicode61 remove_diacritics 2` acha "Ação" buscando "acao".

**O que dá para buscar:**
- texto livre, com prefixo (`jog` acha "jogo");
- filtros:
  - `de:@pessoa`
  - `em:#canal`
  - `tem:anexo`, `tem:link`, `tem:imagem`
  - `antes:2026-11-01`, `depois:…`
- o escopo é o servidor aberto ou a conversa direta aberta;
- resultados do mais novo para o mais antigo, 25 por página.

**Sigilo:**
- só aparecem mensagens de canais que a pessoa pode ver e ler o histórico agora;
- a permissão é aplicada no servidor, na consulta, nunca no app;
- canal privado, conversa alheia e castigo não vazam.

**App:**
- a busca do topo ganha a aba "Mensagens", ao lado de "Pessoas";
- os resultados aparecem num painel à direita, com o trecho e o termo destacado;
- clicar leva à mensagem: carrega o histórico em volta dela (`GET …/messages?around=id`) e destaca por 2 s.

**Testes:**
- de propriedade, no servidor: nenhum resultado de canal que a pessoa não pode ver, em qualquer combinação de cargo e permissão por canal;
- filtros, acentos, edição e apagar refletidos no índice;
- migração com histórico existente;
- no app: o parser dos filtros (lógica pura).

### Fase B — Fixar mensagens (1.15)
- **Quem fixa:** quem tem a permissão **Gerenciar mensagens**. Em conversa direta, qualquer participante.
- **Limite:** até 50 por canal; acima disso, a mensagem de erro explica como resolver.
- **No canal:**
  - mensagem de sistema "Lia fixou uma mensagem" (com "ver fixadas");
  - ícone de alfinete no cabeçalho, que abre a lista com "ir até a mensagem" e "desafixar";
  - evento novo no gateway: `CHANNEL_PINS_UPDATE`.
- **Testes:** permissão (de propriedade), limite, apagar uma mensagem fixada a tira da lista, quem não vê o canal não vê as fixadas.

### Fase C — Notificações por servidor e canal, e @todos (1.16)
**Níveis** (por servidor, e por canal, que vence o do servidor):
- Todas as mensagens;
- Só menções (padrão em servidor com mais de 50 membros);
- Nada.

**Silenciar:**
- por 15 min, 1 h, 8 h, 24 h ou "até eu reativar";
- canal silenciado fica apagado na lista, não acende não lidas, nem selo, nem som.

**Menções em grupo:**
- **@todos** (todo mundo que vê o canal) e **@aqui** (só quem está online);
- só para quem tem a permissão nova **Mencionar todos**, que não vem no cargo padrão;
- "Ignorar @todos e @aqui" fica nas configurações do servidor de cada pessoa.

**Onde fica salvo:** na conta, sincronizado entre os aparelhos, com o evento `USER_GUILD_SETTINGS_UPDATE`.

**Testes:**
- matriz nível × silêncio × tipo de menção → avisa ou não (lógica pura, de propriedade);
- sem a permissão, @todos vira texto comum.

### Fase D — Apelido por servidor (1.16)
- Apelido de até 32 caracteres, que aparece no lugar do nome em tudo daquele servidor.
- Permissões novas: **Trocar o próprio apelido** (no cargo padrão) e **Gerenciar apelidos**, que respeita a hierarquia de cargos como a moderação.
- O registro de ações anota a troca feita por moderador.

### Fase E — Prévia de links (1.17)
**Busca da prévia:**
- O servidor (não o app) busca título, descrição e imagem (`og:*`) do primeiro link da mensagem.
- Quem abre a conversa não fala com o site de fora.

**Contra SSRF:**
- só http e https, portas 80 e 443;
- o endereço é resolvido e conferido antes de conectar: IPs privados, locais, de loopback e de nuvem são bloqueados, inclusive depois de redirecionamentos;
- no máximo 3 redirecionamentos, 1 MB lido, 5 s de prazo;
- a imagem é baixada, conferida pelos bytes e servida pelo nosso servidor, como os anexos.

**Cache e controle:**
- prévia guardada por 24 h;
- o autor pode remover a prévia;
- `<link>` não gera prévia.

### Fase F — Emojis do servidor (1.17)
- Até 50 por servidor (PNG, WebP ou GIF, até 256 KB, recortados para 128 px no app), com a permissão nova **Gerenciar emojis**.
- Uso com `:nome:`: o autocompletar já existe para emojis padrão.
- Aparecem no seletor numa aba do servidor.
- Funcionam em qualquer canal do servidor e, para membros, em conversas diretas.

### Fase G — GIFs (depende de decisão)
- Botão de GIF no compositor, com busca e tendências.
- Exige um provedor externo: as buscas das pessoas vão para ele e há uma chave de API.

## Situação
- Planejado em 2026-11-14.
- **Fase A entregue na 1.15.0** (2026-11-14):
  - índice FTS5 com gatilhos e migração do histórico;
  - busca no servidor inteiro ou na conversa;
  - filtros `de:`, `em:`, `tem:`, `antes:` e `depois:`;
  - painel de resultados com destaque;
  - ir até a mensagem: se ela é antiga, abre o trecho em volta, com "carregar mais novas" e "ir para o presente". O "ir até a resposta" das mensagens antigas também passou a funcionar.
- **Testes da fase A:**
  - 7 no servidor: acentos e prefixo, edição e exclusão no índice, filtros e páginas;
  - sigilo de propriedade: 12 rodadas aleatórias de cargos e sobrescritas, com 4 pessoas, sem nunca vazar canal que a pessoa não vê, e sem faltar nada que ela vê;
  - conversa direta, janela em volta e migração de banco antigo;
  - 5 testes do leitor de filtros e 1 do estado da janela antiga;
  - roteiro de ponta a ponta com 120 mensagens no Edge headless;
  - conferência das telas nos dois temas e em 390 px.

## Decisões que precisam de você
1. **Notificações** (fase C): salvas na conta, sincronizadas entre aparelhos (proposta), ou por aparelho.
2. **GIFs** (fase G): usar um provedor externo ou não ter GIFs por enquanto.
3. **@todos em servidor grande:** pedir confirmação ("isto avisa N pessoas") acima de 50 membros (proposta) ou nunca pedir.

## Fora deste item
Threads, fóruns, eventos, modo lento e AutoMod ficam no item de organização do servidor.
