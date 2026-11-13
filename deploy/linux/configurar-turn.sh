#!/usr/bin/env bash
# Liga o retransmissor TURN da Cloudflare (voz e tela pela internet sem abrir portas no roteador).
# Pede o "Turn Token ID" e o "API Token" criados no painel da Cloudflare (Realtime → TURN Server),
# confere com a Cloudflare e grava em ~/aurora/aurora.env (só o dono lê). Nada passa por chat ou log.
#
# Uso (do PC de desenvolvimento): ssh -t mfs@192.168.50.107 bash ~/aurora/bin/configurar-turn.sh
#        ou, para desligar:      ssh mfs@192.168.50.107 bash ~/aurora/bin/configurar-turn.sh --desligar
set -euo pipefail
APP="$HOME/aurora"
ENV="$APP/aurora.env"
PORT="$(sed -n 's/^AURORA_PORT=//p' "$ENV" 2>/dev/null | head -1)"
PORT="${PORT:-3300}"

fail() { printf '\n\033[1;31mERRO: %s\033[0m\n' "$*" >&2; exit 1; }
ok() { printf '\033[1;32m%s\033[0m\n' "$*"; }
[ -f "$ENV" ] || fail "não achei $ENV. Rode o deploy do Aurora antes (pnpm deploy:server)."

save() { # troca (ou remove) as linhas do retransmissor sem mexer no resto do arquivo
  local tmp
  tmp="$(mktemp "$APP/.aurora.env.XXXXXX")"
  grep -v '^CLOUDFLARE_TURN_' "$ENV" > "$tmp" || true
  [ $# -eq 2 ] && printf 'CLOUDFLARE_TURN_KEY_ID=%s\nCLOUDFLARE_TURN_API_TOKEN=%s\n' "$1" "$2" >> "$tmp"
  chmod 600 "$tmp"
  mv "$tmp" "$ENV"
}

relay_on() { curl -fsS "http://127.0.0.1:$PORT/api/health" 2>/dev/null | grep -q '"voiceRelay":true'; }

restart() {
  systemctl --user restart aurora-server.service
  for _ in $(seq 1 20); do curl -fsS "http://127.0.0.1:$PORT/api/health" >/dev/null 2>&1 && return 0; sleep 0.5; done
  fail "o servidor não voltou. Veja: journalctl --user -u aurora-server -n 50"
}

if [ "${1:-}" = "--desligar" ]; then
  save
  restart
  ok "Retransmissor desligado: a voz pela internet volta a depender de portas abertas."
  exit 0
fi

[ -t 0 ] || fail "este comando pergunta os valores: rode com 'ssh -t' (terminal interativo)."
echo "Retransmissor TURN da Cloudflare para a voz do Aurora."
echo "Os valores estão no painel da Cloudflare: Realtime → TURN Server → sua chave."
read -r -p "Turn Token ID: " KEY_ID
# O token aparece como asteriscos (dá para ver que a colagem entrou, sem expor o segredo na tela).
printf 'API Token (cole e aperte Enter): '
API_TOKEN=""
while IFS= read -r -s -n 1 ch; do
  [ -z "$ch" ] && break # Enter
  if [ "$ch" = $'\x7f' ] || [ "$ch" = $'\b' ]; then # apagar
    [ -n "$API_TOKEN" ] && { API_TOKEN="${API_TOKEN%?}"; printf '\b \b'; }
  else
    API_TOKEN+="$ch"
    printf '*'
  fi
done
echo
KEY_ID="$(printf '%s' "$KEY_ID" | tr -d '[:space:]')"
API_TOKEN="$(printf '%s' "$API_TOKEN" | tr -d '[:space:]')"
[ -n "$API_TOKEN" ] && printf 'Token recebido: %d caracteres, termina em ...%s\n' "${#API_TOKEN}" "${API_TOKEN: -4}"
# O arquivo de ambiente é lido pelo bash e pelo systemd: só caracteres que não precisam de aspas.
[[ "$KEY_ID" =~ ^[A-Za-z0-9_-]{8,128}$ ]] || fail "o Turn Token ID parece errado (esperava letras e números). Copie de novo do painel."
[[ "$API_TOKEN" =~ ^[A-Za-z0-9._-]{16,256}$ ]] || fail "o API Token parece errado (esperava letras e números). Copie de novo do painel."

echo "Conferindo com a Cloudflare..."
# Token vai por stdin (config do curl), não na linha de comando: não aparece em 'ps'.
answer="$(mktemp)"
trap 'rm -f "$answer"' EXIT
status="$(printf 'header = "Authorization: Bearer %s"\n' "$API_TOKEN" | curl -sS -K - -o "$answer" -w '%{http_code}' --max-time 15 \
  -H 'Content-Type: application/json' --data '{"ttl":60}' \
  "https://rtc.live.cloudflare.com/v1/turn/keys/$KEY_ID/credentials/generate-ice-servers")" || fail "não consegui falar com a Cloudflare. Confira a internet do servidor e tente de novo."
case "$status" in
  200|201) ;;
  404) fail "a Cloudflare não achou nenhuma chave TURN com o ID $KEY_ID. Copie o 'Turn Token ID' da chave em Realtime → TURN Server (não o ID da conta nem de um app) e rode de novo." ;;
  401|403) fail "o ID da chave existe, mas o API Token não é dela (HTTP $status). Copie o token da mesma chave (ou crie uma chave nova) e rode de novo." ;;
  *) fail "a Cloudflare respondeu HTTP $status ($(head -c 200 "$answer")). Tente de novo em alguns minutos." ;;
esac

save "$KEY_ID" "$API_TOKEN"
restart
relay_on || fail "gravei a chave, mas o servidor não ligou o retransmissor. Veja: journalctl --user -u aurora-server -n 50"
ok "Pronto: retransmissor ligado. Quem estiver fora da sua rede entra na voz sem portas abertas."
