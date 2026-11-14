# 06 — Atualização automática do app

> Disponível a partir da **1.0.1**. A 1.0.0 não tem atualizador: quem estiver nela precisa instalar uma versão ≥ 1.0.1 **uma única vez**.

## Como funciona
1. Ao abrir, o app pergunta ao **servidor Aurora em que está logado** (ou ao último usado, na tela de login): `GET /api/updates/windows/x86_64/<versão-atual>`.
2. Se houver versão mais nova, o servidor responde com `version`, `url` e `signature` (formato "servidor dinâmico" do Tauri updater); senão, `204`.
3. O app baixa o instalador, **confere a assinatura** com a chave pública embutida nele e instala em modo **passivo**: o app fecha, instala e reabre sozinho.
4. Com o app aberto, ele verifica de novo a cada 15 min e sempre que você volta para a janela (no máximo a cada 5 min). Se houver versão nova, aparece um **botão verde de download na barra do topo** (ao lado da lista de membros); **o clique inicia a atualização**. Nada interrompe uma conversa sem você pedir. *(Desde a 1.1.1; a 1.1.0 mostrava um aviso flutuante.)*
5. Falhas (servidor fora do ar, rede) são silenciosas: o app continua na versão atual.

Peças: `apps/desktop/src-tauri/src/lib.rs` (comandos `check_update`/`install_update`), `packages/platform` (`checkForUpdate`/`installUpdate`), `apps/desktop/src/ui/UpdateGate.tsx`, `apps/server/src/updates.ts`, `scripts/release.ps1`.

## Publicar uma versão nova
1. Aumente a versão em `apps/desktop/src-tauri/tauri.conf.json` (e, por consistência, em `Cargo.toml` e `apps/desktop/package.json`).
2. Rode:
   ```bash
   pnpm release -- -Notes "O que mudou nesta versão"
   ```
3. Pronto: o script gera o app **assinado**, **confere o instalador com o Microsoft Defender**, copia o instalador para `apps/server/releases/<versão>/` e atualiza `apps/server/releases/latest.json`. Todos os apps ≥ 1.0.1 conectados a esse servidor se atualizam ao abrir.
4. Para subir ao servidor oficial: `pnpm deploy:server` ([07](07-publicacao.md)).

### Se o Defender acusar o instalador
O `pnpm release` para e não publica nada. Foi o que aconteceu com o 1.4.0: o modelo de aprendizado de máquina do Defender acusou `Trojan:Win32/Bearfoos.A!ml`. O sufixo `!ml` indica detecção por modelo, não por vírus conhecido. Esse 1.4.0 chegou a ser publicado antes de o script ter essa conferência, e quem atualizou teve o app apagado.
- Não é um recurso específico. Em 2026-11-13, o mesmo código recompilado saiu limpo, com e sem o "abrir com o Windows". O modelo implica com o arquivo exato de um app novo e sem certificado.
- Resolução: aumente a versão e gere de novo. Foi assim que saiu a 1.4.1, limpa.
- Se continuar acusando, envie o arquivo para análise em <https://www.microsoft.com/wdsi/filesubmission>, como "Software developer" e "Incorrectly detected".
- Para conferir um arquivo à mão, sem deixar o Defender apagá-lo:
  ```powershell
  & "C:\ProgramData\Microsoft\Windows Defender\Platform\CurrentVersion\MpCmdRun.exe" -Scan -ScanType 3 -File <arquivo> -DisableRemediation
  ```
- **1.11.0 (2026-11-13):** passou na conferência ao publicar e foi acusada 30 minutos depois, quando o Defender atualizou o modelo (definições 1.463.279 → 1.463.283). Quem atualizou teve o `aurora.exe` posto em quarentena pela proteção em tempo real. Saiu a 1.11.1, gerada de novo, e a 1.11.0 foi tirada do servidor. Desde então o `pnpm release`:
  - atualiza as definições do Defender antes de conferir;
  - confere o instalador **e** o `aurora.exe` que vai dentro dele;
  - grava "Aurora" como publicador no executável (antes aparecia "aurora").
- Mesmo assim, nada garante que uma versão limpa hoje continue limpa amanhã: sem certificado, cada versão começa sem reputação. A solução de longo prazo é o certificado de assinatura de código: com ele, a reputação passa de uma versão para a outra.

O instalador para quem ainda não tem o app fica em `apps/desktop/src-tauri/target/release/bundle/nsis/Aurora_<versão>_x64-setup.exe`.

## A chave de assinatura (importante)
- Fica em `%USERPROFILE%\.aurora\updater\` (`aurora.key`, `aurora.key.password`, `aurora.key.pub`), **fora do repositório**, com acesso só para o seu usuário do Windows.
- **Faça backup dessa pasta** (pendrive, cofre de senhas). Se ela se perder, os apps instalados **recusam** qualquer atualização nova, e todos terão de reinstalar manualmente uma versão com chave nova.
- Quem tiver essa chave consegue publicar atualizações para os seus usuários: nunca a coloque no git, em chat ou em servidor público.
- A chave pública está em `tauri.conf.json` (`plugins.updater.pubkey`); trocar a chave = nova pubkey + reinstalação manual por todos.

## Segurança e limitações conhecidas
- O transporte pode ser **HTTP** (servidor na rede local), por isso `dangerousInsecureTransportProtocol: true`. A proteção vem da **assinatura**: um pacote adulterado é recusado. Quando houver servidor na internet, usar **HTTPS** e remover essa opção.
- Sem certificado de assinatura de código do Windows, o **primeiro** download do instalador mostra o aviso do SmartScreen; as atualizações automáticas não passam por esse aviso.
- Só Windows x64 é publicado por enquanto.

## Verificado em 2026-11-12
- Testes automáticos das rotas: versão nova oferecida com URL e assinatura, `204` para quem está em dia, bloqueio de *path traversal* no download.
- **Teste real na máquina do dono:** Aurora 1.0.1 instalado → publicada 1.0.2 → ao abrir, o app encontrou a versão, baixou, conferiu a assinatura, instalou e **reabriu já na 1.0.2 em ~4 s**, sem nenhum clique (registro do Windows também atualizado).

## Linux (desde a 1.15.1)
- O `pnpm release` também gera o Linux.
  - O `scripts/build-linux.ps1` envia o código e a interface já gerada no Windows (com o servidor embutido) para a máquina Linux.
  - Lá, compila só a parte nativa, com `nice`, e traz `.AppImage` e `.deb`.
  - A **assinatura é feita no PC**: a chave nunca sai dele.
- **Onde compilar:** na base mais antiga suportada, que hoje é a máquina do servidor (Mint 22 = Ubuntu 24.04). Um app compilado num Linux mais novo (ex.: Kali) exige glibc mais nova e não abre no Ubuntu. O Kali fica para testar.
- O `latest.json` ganha `linux-x86_64-appimage`, `linux-x86_64-deb` e `linux-x86_64`. O app manda `?bundle=` na consulta, e cada tipo de instalação recebe o seu pacote.
- **Opções do release:**
  - `-SkipLinux`: só Windows. Quem usa Linux não recebe a versão.
  - `-LinuxServer`: outra máquina de build.
  - `-Local`: app de teste apontando para `localhost`. O padrão agora é o servidor oficial.
- **Testado na 1.15.1:** um app 1.15.0 no Kali atualizou sozinho para a 1.15.1. O arquivo ficou idêntico ao publicado (mesmo SHA-256), e o app reabriu no modo do servidor oficial.

