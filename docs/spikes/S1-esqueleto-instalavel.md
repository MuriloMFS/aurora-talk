# S1 — Esqueleto instalável (Tauri 2 + React)

- **Data:** 2026-11-12 · **Máquina:** Windows 11 Pro, Ryzen 7 5700X (16 threads), 15,9 GB, WebView2 157.0.4341.42
- **Build:** Tauri CLI 2.12.4, `tauri` 2.12.5, Rust 1.99.1 (MSVC), React 19.3, Vite 8.3; perfil release com LTO, `opt-level = "s"`, `strip`
- **Conteúdo do app:** shell estático (rail, canais, chat com 9 mensagens fictícias, membros), sem rede, sem lista virtualizada
- **Situação:** ✅ **parcialmente aprovado**. Instalação, tamanho e desinstalação aprovados; RAM acima do orçamento proposto; updater ainda não testado

## Números medidos
| Métrica | Orçamento proposto (ADR-001 §7) | Medido | Situação |
|---|---|---|---|
| Instalador NSIS (`-setup.exe`) | ≤ 25 MB | **1,45 MB** | ✅ |
| Instalador MSI | — | 1,93 MB | ✅ |
| Instalado em disco | ≤ 60 MB | **3,40 MB** (2 arquivos) | ✅ (Discord: 471 MB) |
| Tempo de instalação silenciosa | — | 1,6 s | ✅ |
| Build release do zero / incremental | — | 197 s / 93 s | — |
| Janela criada após abrir (proxy, **não** é "interativa") | ≤ 1,5 s até interativa | 228 ms | ⚠️ métrica de interatividade ainda não medida |
| RAM, família de processos, ocioso aos 10 s | ≤ 200 MB (working set) | **395 MB** working set · **211 MB** privada (7 processos) | ❌ acima |
| RAM aos 40 s | — | 413 MB working set · 206 MB privada | ❌ acima |
| CPU ociosa (média de 30 s, dos 10 s aos 40 s após abrir) | ≤ 1 % | 6,2 % de 1 núcleo = **0,39 % do total** | ⚠️ ok se o orçamento é do total; janela inclui fim da inicialização |
| Desinstalação silenciosa | — | exit 0; pasta e registro removidos | ✅ (dados do WebView ficam em `%LOCALAPPDATA%\app.aurora.desktop`) |

Distribuição de memória aos 10 s: `aurora.exe` 28 MB WS / 5 MB privada; os 6 processos `msedgewebview2.exe` somam o resto (maior: 117 MB WS).

## Leitura
1. **Instalador e disco:** ganho enorme e confirmado (1,45 MB contra centenas de MB de um app Electron).
2. **Processo principal em Rust:** 28 MB de working set, só 5 MB privados. O ganho do "núcleo leve" é real.
3. **RAM total:** dominada pelo **WebView2 (Chromium)**, exatamente o risco descrito no ADR-001 §2 ("o renderer no Windows é Chromium nos dois casos"). O orçamento de 200 MB de *working set* foi proposto **sem medição** e não é atingível por um app WebView2 vazio. Parte do *working set* são páginas compartilhadas com o runtime do Edge; a memória **privada (~210 MB)** é o melhor indicador do custo real.
4. **Ainda não dá para concluir o gate G2:** ele compara contra a build de controle **Electron** e a UI otimizada do S2. Sem o controle, não sabemos se 210 MB privados são bons ou ruins para esta classe de app.

## O que falta para fechar o S1
- [ ] Atualizador assinado (`tauri-plugin-updater` + chave gerada com `tauri signer generate` **fora do repositório** + endpoint de teste)
- [ ] Teste em Windows **limpo** (VM/Windows Sandbox), incluindo o caso sem WebView2 (bootstrapper)
- [ ] Assinatura de código do instalador (SmartScreen) — depende de certificado
- [ ] Medir "janela interativa" (marca de tempo do 1º render do React enviada ao Rust) em vez do proxy de janela criada

## Próximo passo recomendado
**S2 (eficiência):** lista virtualizada com 50 mil mensagens e 300 avatares **na mesma UI**, numa build Tauri e numa build Electron de controle, medindo working set e memória privada da família de processos, arranque e CPU com o mesmo script ([`scripts/measure-desktop.ps1`](../../scripts/measure-desktop.ps1)). Com isso, recalibrar os orçamentos de RAM do ADR-001 §7 e decidir o gate G2.

## Como reproduzir
```bash
pnpm build:desktop
# instalador: apps/desktop/src-tauri/target/release/bundle/nsis/Aurora_0.1.0_x64-setup.exe
# instalar em silêncio: Aurora_0.1.0_x64-setup.exe /S   ·   desinstalar: %LOCALAPPDATA%\Aurora\uninstall.exe /S
```
Medição (instala, abre, mede RAM/CPU, captura a janela, fecha e desinstala):
```powershell
.\scripts\measure-desktop.ps1 -Setup "apps\desktop\src-tauri\target\release\bundle\nsis\Aurora_0.1.0_x64-setup.exe" -ShotPath "$env:TEMP\aurora.png"
```
O script soma `WorkingSetSize` e `PrivatePageCount` (`Win32_Process`) do `aurora.exe` e de todos os descendentes. A pasta `%LOCALAPPDATA%\app.aurora.desktop` (dados do WebView) não é removida pelo desinstalador silencioso.
