# Apertar para falar (S5 / gate G3 do ADR-001) — medição, 13/11/2026

**Como funciona:** o app nativo consulta SÓ a tecla escolhida (`GetAsyncKeyState`) a cada 8 ms, e só enquanto a pessoa está numa sala de voz no modo apertar para falar (`apps/desktop/src-tauri/src/push_to_talk.rs`). Não há gancho global de teclado (`WH_KEYBOARD_LL`): o app não vê as outras teclas.

No modo apertar para falar, o microfone já entra preparado e mudo. Abrir e fechar só liga e desliga o envio da trilha, sem pedir o dispositivo de novo.

## 1. Detecção da tecla (nativo)
- **Teste:** `cargo test --lib medir_latencia -- --ignored --nocapture`, no mesmo laço do app numa thread.
  - O teste simula 100 apertos de F24 (`SendInput`) em momentos que não batem com o laço.
  - Rodou 2 vezes.

| Rodada | Média | p50 | p95 | Máx. | Apertos perdidos |
|---|---|---|---|---|---|
| 1 | 4,6 ms | 4,6 ms | 8,1 ms | 9,0 ms | 0/100 |
| 2 | 4,7 ms | 5,0 ms | 8,1 ms | 8,7 ms | 0/100 |

## 2. Da tecla até o servidor de voz ver o microfone aberto (navegador)
- **Montagem:**
  - Edge headless com microfone falso;
  - LiveKit local em modo dev;
  - tecla V simulada na página;
  - estado do microfone lido no LiveKit (`listParticipants`) a cada ~5 ms.
- **Resultado:** 10 apertos, entre 19 e 48 ms.
  - O número inclui a ida da sinalização "desmutou" até o servidor e o próprio intervalo da leitura.
  - É um teto. O som começa a sair no aparelho quando a trilha é ligada, antes de o servidor registrar.
- **Atraso ao soltar de 200 ms:** o microfone continuou aberto 100 ms depois de soltar e fechou entre 177 e 210 ms nas 10 vezes.
- **Mudo vence a tecla:** desmutar com a tecla solta deixa o microfone fechado. Trocar para detecção de voz no meio da sala abre na hora; voltar para apertar para falar fecha.

## Conclusão
- **G3 atendido para teclado e mouse** (botões do meio e laterais via `GetAsyncKeyState`): a detecção nativa fica abaixo de 10 ms, sem perder o soltar, dentro do orçamento de 30 ms.
- **Não medido aqui:** com um jogo real em tela cheia. Fica para conferir no uso.
- **Limite conhecido do Windows:** se o jogo roda como administrador, um app comum não vê as teclas dele. A tela de configurações avisa.
