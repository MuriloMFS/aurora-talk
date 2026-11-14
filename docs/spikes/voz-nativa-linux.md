# Voz nativa no Linux: spike (L1, ADR-003), 14/11/2026

**Pergunta:** o SDK de Rust do LiveKit (`livekit` 0.11.0, `libwebrtc` 0.4.1) faz voz no Linux sem o WebRTC do navegador interno?

## Montagem
- **Kali** (Dell G15, Xfce/X11, PulseAudio sobre PipeWire 1.6.9): binário de teste com `PlatformAudio`, o módulo de áudio do próprio WebRTC (ADM; no Linux, PulseAudio ou ALSA). O microfone é capturado e o som dos outros é tocado pelo WebRTC, como no Chrome; o cancelamento de eco usa o que está tocando como referência.
- **Servidores de teste no Kali:** Aurora e LiveKit 1.13.11, o mesmo fixado no projeto, com SHA-256 conferido.
- **Segunda pessoa:** Aurora web num Edge sem janela no PC Windows, com microfone falso (tom), na mesma sala.

## Resultados
| O quê | Resultado |
|---|---|
| Compilar no Linux | ok. Binário de 39 MB com o WebRTC embutido; o WebRTC vem pré-compilado do LiveKit |
| Listar dispositivos | 3 microfones e 5 saídas do notebook, pelo PulseAudio/PipeWire |
| Escolher a saída | ok (`set_playout_device_by_index`) |
| Entrar na sala | 21 ms sozinho; 136–141 ms com a outra pessoa conectada (rede local) |
| Publicar o microfone | 6 ms depois de entrar |
| Receber o áudio do Windows | ok: 48.000 amostras/s contínuas por 11 s, nível RMS ~2.900 (o tom do microfone falso) |
| Microfone do Kali chegando ao Windows | ok no app, com voz real (ver "Depois, no app") |

## O que a API oferece (e o que não)
- **Tem:** TURN (`RoomOptions.rtc_config.ice_servers`), mudo (`LocalAudioTrack::mute`), ensurdecer (`set_enabled(false)` nas trilhas recebidas), eco, ruído e ganho (`configure_audio_processing`), troca de dispositivo no meio da chamada (`switch_*_device`) e "quem está falando" (`ActiveSpeakersChanged`).
- **Não tem:** volume do microfone e volume de quem fala (nem geral, nem por pessoa). Isso exige um caminho próprio de mixagem, decidido com medição antes de existir. Até lá, os controles de volume ficam desativados no Linux, com explicação, e não fingem funcionar.
- **Achado para a L4:** o `libwebrtc` traz `desktop_capturer`, a captura de tela do próprio WebRTC. Avaliar antes de escrever captura própria por PipeWire.

## Conclusão
O caminho do ADR-003 funciona no Linux. Ele virou o `NativeMediaEngine` dentro do app (1.16.0).

## Depois, no app (14/11/2026)
- **Microfone com voz real:** o dono falou no Kali, e a pessoa no Windows viu "Ana falando" em 28 leituras de 2 em 2 s.
- **Saída escolhida:** fixada antes de entrar, ela se perdia quando o primeiro áudio chegava (o WebRTC abre a saída nessa hora e usa a padrão). Agora o motor reaplica a escolha a cada áudio novo. Conferido pelo PulseAudio: o fluxo do app ficou na saída HDMI escolhida, com a outra pessoa falando.
- **Teste de microfone:** o WebRTC não entrega áudio do microfone fora de uma chamada (0 quadros em 3 s). Por isso, o teste lê do PulseAudio. Os ids que o WebRTC dá no Linux são posições ("index:N"), e o nome mostrado é a descrição da entrada no PulseAudio.
