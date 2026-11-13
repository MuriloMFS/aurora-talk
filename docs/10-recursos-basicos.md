# 10 — Recursos básicos que faltam (item 1)

O que todo usuário de app de comunidade espera e o Aurora ainda não tem. Comparação funcional com o
Discord (só o comportamento; nada de código, texto ou identidade dele).

| Falta | Por que importa |
|---|---|
| Foto de perfil | Hoje são iniciais com cor; difícil reconhecer as pessoas |
| Imagens e arquivos nas mensagens (inclusive colar print) | É metade do uso de um chat |
| Amigos e bloqueio | Base para conversar fora dos servidores e se proteger |
| Mensagens diretas e grupos | Hoje só dá para conversar dentro de um servidor |
| Status (ausente, não perturbe, invisível, personalizado) | Hoje só online/offline; "não perturbe" precisa calar notificações |
| Recuperar a conta e 2FA | Quem esquece a senha hoje perde a conta |
| Prévia de links e GIFs | Conforto; dependem de decisões (abaixo) |

## Ordem e fases

Cada fase vira uma versão (1.7, 1.8, …), testada e publicada antes da próxima.

### Fase A — Arquivos no servidor + foto de perfil (1.7)
A base de tudo que envolve upload. Começa pela foto de perfil, que é o caso mais simples.

- **Armazenamento:** arquivos em `data/files/` no servidor (disco tem 844 GB livres), com metadados no
  SQLite (`files`: id, dono, tipo, tamanho, hash, criado em). Nome no disco = id, nunca o nome enviado.
- **Tipo conferido pelos bytes** (assinatura do arquivo), não pela extensão nem pelo que o cliente diz.
  Imagens aceitas: PNG, JPEG, WebP, GIF. Nada de SVG ou HTML servido como página.
- **Servir com segurança:** `X-Content-Type-Options: nosniff`; o que não é imagem vai como download
  (`Content-Disposition: attachment`); cache longo por endereço com hash.
- **Foto de perfil:** recorte quadrado e redução para 256 px **no app** (canvas), antes de enviar, então o
  servidor não precisa de biblioteca nativa de imagem. Limite de 2 MB. Pública (como no Discord), com
  `User.avatar` (id do arquivo) e `USER_UPDATE` ao vivo. Sem foto, continua o avatar de iniciais.
- **App:** CSP do Tauri passa a aceitar imagens do servidor oficial (`img-src` com o endereço dele);
  "Minha conta" ganha trocar e remover foto.
- **Testes:** tipo falso (exe renomeado para .png) recusado; limite de tamanho; foto aparece para todos
  na hora.

### Fase B — Anexos nas mensagens (1.8)
- Até **10 arquivos por mensagem, 25 MB cada** (o túnel aceita até 100 MB; o Discord gratuito usa 10 MB).
- Enviar pelo botão **+**, **arrastar e soltar** e **Ctrl+V** (print). Fila acima do campo com progresso,
  remover e "enviar com texto".
- Imagens aparecem na conversa (miniatura com tamanho reservado, sem pular a rolagem) e abrem em tela
  cheia; outros arquivos viram cartão com nome, tamanho e baixar.
- **Sigilo:** anexo de canal privado não pode vazar. `<img>` não manda o token, então o endereço do anexo
  é **assinado e expira** (gerado quando a mensagem é entregue a quem vê o canal). Link copiado e
  repassado para de funcionar depois do prazo.
- Apagar a mensagem apaga os arquivos; upload que não virou mensagem em 1 h é limpo.
- Limite por pessoa (ex.: 30 uploads/min) contra abuso.

### Fase C — Amigos, bloqueio e mensagens diretas (1.9)
- **Amigos:** pedir por @usuário, aceitar, recusar, cancelar, desfazer. Lista com abas Online, Todos,
  Pendentes e Bloqueados.
- **Bloquear:** a pessoa bloqueada não manda DM, não pede amizade; mensagens dela nos servidores ficam
  recolhidas ("Mensagem de alguém que você bloqueou — mostrar").
- **Mensagens diretas:** canal sem servidor (`type: "dm"`), entre 2 pessoas; **grupo** com até 10.
  Tudo o que o chat já faz vale ali (respostas, reações, menções, anexos, não lidas, digitando).
  Toda mensagem direta conta como menção (selo e notificação).
- **Quem pode me mandar DM:** amigos e quem divide servidor comigo (padrão, como no Discord), com opção
  em Privacidade para "só amigos".
- **App:** botão "Início" no topo da barra de servidores com amigos e conversas diretas; "Enviar
  mensagem" no perfil de qualquer membro.
- **Testes de propriedade:** ninguém fora da conversa recebe nada dela; bloqueio barra DM e pedido.

### Fase D — Status (1.10)
- Online, **Ausente** (automático depois de 10 min sem mexer no computador, ajustável), **Não perturbe**
  (sem som, notificação nem piscar; selo continua) e **Invisível** (aparece offline para os outros).
- **Status personalizado:** texto curto + emoji, com "limpar depois de" (30 min, 1 h, hoje, nunca).
- `PRESENCE_UPDATE` ganha `status` e `customStatus`; apps antigos continuam recebendo `online`.
- Detectar inatividade é coisa do sistema: entra no `PlatformPort` (Tauri e navegador), regra 1.

### Fase E — Segurança da conta (1.11)
- **Códigos de recuperação:** 10 códigos de uso único, mostrados uma vez (salvar/baixar). Com um deles,
  dá para trocar a senha sem e-mail.
- **Verificação em duas etapas (2FA)** com app autenticador (TOTP, padrão aberto), códigos de
  recuperação valendo também para ela.
- **Sessões ativas:** ver aparelhos conectados e sair de cada um.
- **E-mail** (recuperar senha por e-mail, avisos de login novo) só se for escolhido um provedor de envio
  (ver decisões).

### Fase F — Prévia de links e GIFs (depois)
- **Prévia de links:** o servidor busca título, descrição e imagem da página. Risco de SSRF: só
  http/https, bloqueia IPs internos (127.x, 10.x, 192.168.x, 169.254.x…), confere de novo após
  redirecionar, tempo e tamanho limitados, cache. Opção para desligar.
- **GIFs:** depende de um provedor externo (chave de API e as buscas das pessoas vão para ele).

## Situação
- **Fase A entregue na 1.7.0** (2026-11-13): 6 testes no servidor (tipo pelos bytes, programa renomeado recusado, SVG recusado, limite, troca apaga a foto antiga, foto aparece para os outros na hora e nas mensagens) e conferência visual nos dois temas com uma imagem real retangular.

- **Fase B entregue na 1.8.0** (2026-11-13), com 25 MB por arquivo e 10 por mensagem: 10 testes no servidor (link assinado, adulterado e vencido, arquivo que finge ser imagem vai como download, anexo alheio ou de outro canal recusado, limites, ordem, limpeza ao apagar e varredura, migração da 1.7) e conferência visual (botão +, arrastar, fila, grade, tela cheia, outro membro, tema claro e 390 px).

- **Fase C entregue na 1.9.0** (2026-11-13): 8 testes no servidor (pedido, aceitar, recusar; conversa a dois que só aparece para o outro com a primeira mensagem; quem está fora recebe 404 e não vê o "digitando"; fechar e reabrir; quem pode mandar mensagem; bloqueio sem revelar; grupo com dono, renomear, pôr, tirar e sair; migração da tabela de canais) e conferência visual (amigos, pendentes, conversa, grupo nos temas escuro e claro, mensagem de bloqueado recolhida, 390 px).

- **Fase D entregue na 1.10.0** (2026-11-13): 4 testes no servidor (ausente só com todos os aparelhos parados; não perturbe e personalizado ao vivo e nos outros aparelhos; invisível offline também para amigos; personalizado que vence sozinho e validação) e conferência visual (menu de status, personalizado com emoji, lista de membros e amigos nos dois temas).

- **Fase E entregue na 1.11.0** (2026-11-13), sem e-mail: TOTP conferido com os vetores oficiais das RFC 4226 e 6238; 6 testes de ponta a ponta no servidor (aparelhos, ligar com confirmação, login com código e com código de recuperação, código repetido, esqueci a senha, desligar, limite de tentativas) e o fluxo inteiro pela tela (ligar com QR, códigos, sair e entrar com código, esqueci a senha).

## Decisões que precisam de você
1. **Provedor de e-mail** (fase E): sem um, a recuperação é só por códigos. Opções: um serviço de envio
   transacional (exige domínio verificado, ex.: o muriloferreira.dev) ou deixar sem e-mail por enquanto.
2. **GIFs** (fase F): usar um provedor externo ou não ter GIFs.
3. ~~Limites de arquivo~~: ficou 25 MB por arquivo e 10 por mensagem (1.8.0).

## Fora deste item
Câmera, push-to-talk global, categorias, threads, busca, fixar, notificações por canal, emojis próprios,
app de celular e bots ficam nos itens 2, 3 e 4.
