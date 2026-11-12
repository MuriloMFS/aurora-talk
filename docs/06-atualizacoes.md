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
3. Pronto: o script gera o app **assinado**, copia o instalador para `apps/server/releases/<versão>/` e atualiza `apps/server/releases/latest.json`. Todos os apps ≥ 1.0.1 conectados a esse servidor se atualizam ao abrir.

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
