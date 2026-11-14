# 14 — Menu "+" do campo de mensagem

Hoje o "+" do campo de mensagem só abre o seletor de arquivos. O pedido é que ele vire um menu com as mesmas funções de outros apps de comunidade: enviar arquivo, criar tópico, criar enquete, usar apps, agendar mensagem e gravar mensagem de voz. A referência é só o comportamento; nada de código, texto ou identidade de outros apps.

**Regra:** o menu só mostra o que funciona de verdade. Cada item entra quando a sua fase for entregue, sem item "em breve" nem botão que não faz nada.

## Fases

### A — O menu (com a fase B)
- O "+" abre um menu com ícone e texto por item, navegável por setas e fechado por `Esc`, com o mesmo padrão dos outros menus do app.
- "Enviar um arquivo" vira o primeiro item. Arrastar e `Ctrl+V` continuam funcionando.
- Itens que dependem de permissão só aparecem para quem a tem.

### B — Enquete
- **Criar:**
  - pergunta (até 300 caracteres) e de 2 a 10 respostas (até 55 caracteres cada, com emoji opcional);
  - duração de 1 h, 4 h, 8 h, 24 h, 3 dias ou 1 semana;
  - "permitir mais de uma resposta".
- **Votar:** votar e tirar o voto ao vivo (gateway). A contagem e a porcentagem aparecem para quem já votou ou depois que a enquete acaba, e dá para ver quem votou em quê.
- **Encerrar:** fecha sozinha no fim do prazo, e quem criou pode encerrar antes. Mensagem de sistema "a enquete terminou", com a resposta vencedora.
- **Permissão nova:** **Criar enquetes** (no cargo padrão).
- **Testes de propriedade:**
  - um voto por pessoa por resposta;
  - quem não vê o canal não vota nem vê resultado;
  - enquete encerrada não aceita voto;
  - a contagem bate com os votos guardados.

### C — Gravar mensagem de voz
- Segurar ou clicar no microfone e gravar até 20 min. Na prévia, dá para ouvir, apagar ou enviar.
- **Formato:** Opus.
  - **Windows:** gravação pelo navegador interno.
  - **Linux:** gravação pelo app, porque o WebKitGTK não grava: o microfone escolhido nas configurações via PulseAudio, codificado em Opus no Rust (ADR-003).
- **Na conversa:** a mensagem mostra um player com a onda do som (calculada no app ao gravar), a duração e a velocidade (1x, 1,5x, 2x).
- **Permissão nova:** **Enviar mensagens de voz**.
- **Testes:** limite de duração e tamanho, tipo conferido pelos bytes no servidor (como os anexos), e player e onda (lógica pura).

### D — Agendar mensagem
- Escolher dia e hora (no fuso do aparelho). O servidor guarda e publica na hora, como se a pessoa tivesse enviado.
- **Antes de enviar:** uma lista "mensagens agendadas" por canal, com editar, enviar agora e cancelar.
- **Permissão conferida na hora de enviar:** se a pessoa perdeu a permissão ou saiu do servidor, a mensagem não sai e ela recebe um aviso.
- **Limites:** até 30 dias no futuro e 50 agendadas por pessoa.
- **Testes:** publica no horário (relógio de teste), respeita a permissão na hora e cancelar apaga.

### E — Criar tópico
- É o mesmo que "threads", do item de organização do servidor. Fase grande: canal filho com nome, aberto a partir de uma mensagem ou do zero; arquivamento por inatividade; lista de tópicos no canal; notificações e não lidas próprias; permissões herdadas do canal.
- Fica planejado à parte quando chegar a vez.

### F — Usar apps
- Depende da plataforma de bots e integrações (item 4): apps instalados no servidor, comandos de barra e cartões interativos.
- É a maior de todas. Planejar à parte.

## Ordem proposta
A + B → C → D → E → F, com uma versão publicada por fase.

## Situação
- Planejado em 2026-11-14.
- **Fases A e B entregues na 1.17.0** (2026-11-14):
  - menu "+" com "Enviar um arquivo" e "Criar enquete";
  - enquete com 2 a 10 respostas, duração e "mais de uma resposta";
  - votos ao vivo, resultado depois de votar, "ver votos", vencedora e "encerrar agora";
  - permissão "Criar enquetes", dada por migração ao @todos dos servidores que já existiam.
- **Testes:**
  - 8 no servidor: criação e validação, permissão, voto único e múltiplo com eventos, propriedade com 60 passos aleatórios contra um modelo, sigilo de canal privado, prazo e encerramento, exclusão em cascata e migração;
  - 5 da lógica pura no app;
  - roteiro de ponta a ponta no Edge headless;
  - conferência nos dois temas e em 390 px.
- **Mudança em relação ao plano:** não há mensagem de sistema "a enquete terminou". A própria enquete mostra "Encerrada · Vencedora", na hora certa, pelo relógio do app.
