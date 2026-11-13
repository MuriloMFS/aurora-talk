#!/usr/bin/env bash
# Vigia do IP público: o LiveKit descobre o IP externo só ao iniciar; em internet residencial o IP
# muda quando o roteador reconecta. Se mudar, reinicia a voz (as chamadas reconectam sozinhas).
# Fonte do IP: a própria Cloudflare (cdn-cgi/trace), que já é o provedor do tunnel.
set -euo pipefail
STATE="$HOME/aurora/data/ip-publico.txt"
ip="$(curl -fsS --max-time 10 https://1.1.1.1/cdn-cgi/trace | awk -F= '$1 == "ip" { print $2 }')"
[[ "$ip" =~ ^[0-9.]+$ ]] || { echo "não consegui ler o IP público agora; tento de novo depois"; exit 0; }
old="$(cat "$STATE" 2>/dev/null || true)"
if [ "$ip" != "$old" ]; then
  echo "$ip" > "$STATE"
  if [ -n "$old" ]; then
    echo "IP público mudou de $old para $ip: reiniciando a voz"
    systemctl --user restart aurora-livekit.service
  fi
fi
