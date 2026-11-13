#!/usr/bin/env bash
# Instala ou atualiza o Aurora neste Linux, como usuário comum (sem sudo).
# Quem chama é o scripts/deploy.ps1 (do PC de desenvolvimento), depois de enviar esta pasta.
#
#   ~/aurora/
#     bin/aurora-server.mjs   servidor (API + gateway + site), um arquivo só
#     site/                   página de download
#     releases/               instaladores + latest.json (atualização automática)
#     data/aurora.db          banco (SQLite) + backups/
#     node/                   Node.js próprio (versão fixa, conferida por SHA-256)
#     livekit/                servidor de voz e tela (versão fixa, conferida por SHA-256)
#     aurora.env              configuração e chaves (gerado uma vez, só o dono lê)
#
# Portas (todas só em 127.0.0.1, menos a mídia): 3300 API/site · 7880 sinalização da voz
# · 7881/tcp e 7882/udp mídia da voz. Nada precisa ser aberto no roteador: quem está fora da rede
# chega à mídia pelo retransmissor TURN da Cloudflare (bin/configurar-turn.sh liga).
#
# Uso: bash install.sh [--livekit-url wss://voz.seudominio.com]
set -euo pipefail

NODE_VERSION="22.23.1"
LIVEKIT_VERSION="1.13.11"
APP="$HOME/aurora"
SRC="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
LIVEKIT_URL=""

while [ $# -gt 0 ]; do
  case "$1" in
    --livekit-url) LIVEKIT_URL="${2:-}"; shift 2 ;;
    *) echo "Opção desconhecida: $1" >&2; exit 2 ;;
  esac
done

say() { printf '\n\033[1;36m== %s\033[0m\n' "$*"; }
fail() { printf '\n\033[1;31mERRO: %s\033[0m\n' "$*" >&2; exit 1; }

[ "$(uname -m)" = "x86_64" ] || fail "este instalador é para Linux x86_64 (encontrado: $(uname -m))."
for tool in curl tar sha256sum systemctl; do command -v "$tool" >/dev/null || fail "falta o programa '$tool'."
done
mkdir -p "$APP"/{bin,site,releases,data/backups,node,livekit}
chmod 700 "$APP"

# ---------- Node.js (versão fixa, conferida) ----------
if [ ! -x "$APP/node/bin/node" ] || [ "$("$APP/node/bin/node" -v)" != "v$NODE_VERSION" ]; then
  say "Baixando Node.js $NODE_VERSION"
  tmp="$(mktemp -d)"
  file="node-v$NODE_VERSION-linux-x64.tar.xz"
  curl -fsSL -o "$tmp/$file" "https://nodejs.org/dist/v$NODE_VERSION/$file"
  curl -fsSL -o "$tmp/SHASUMS256.txt" "https://nodejs.org/dist/v$NODE_VERSION/SHASUMS256.txt"
  (cd "$tmp" && grep "  $file\$" SHASUMS256.txt | sha256sum -c --quiet) || fail "o Node.js baixado não confere com o SHA-256 oficial."
  rm -rf "$APP/node" && mkdir -p "$APP/node"
  tar -xJf "$tmp/$file" -C "$APP/node" --strip-components=1
  rm -rf "$tmp"
fi
echo "Node: $("$APP/node/bin/node" -v)"

# ---------- LiveKit (versão fixa, conferida) ----------
if [ ! -x "$APP/livekit/livekit-server" ] || ! "$APP/livekit/livekit-server" --version 2>/dev/null | grep -q "$LIVEKIT_VERSION"; then
  say "Baixando LiveKit $LIVEKIT_VERSION"
  tmp="$(mktemp -d)"
  file="livekit_${LIVEKIT_VERSION}_linux_amd64.tar.gz"
  base="https://github.com/livekit/livekit/releases/download/v$LIVEKIT_VERSION"
  curl -fsSL -o "$tmp/$file" "$base/$file"
  curl -fsSL -o "$tmp/checksums.txt" "$base/checksums.txt"
  (cd "$tmp" && grep "  $file\$" checksums.txt | sha256sum -c --quiet) || fail "o LiveKit baixado não confere com o SHA-256 oficial."
  tar -xzf "$tmp/$file" -C "$tmp"
  install -m 755 "$tmp/livekit-server" "$APP/livekit/livekit-server"
  rm -rf "$tmp"
fi
echo "LiveKit: $("$APP/livekit/livekit-server" --version 2>/dev/null | head -1)"

# ---------- configuração e chaves (geradas uma vez) ----------
ENV="$APP/aurora.env"
if [ ! -f "$ENV" ]; then
  say "Gerando configuração e chaves da voz"
  umask 077
  cat > "$ENV" <<EOF
# Gerado por install.sh em $(date -Iseconds). Só o dono lê (chmod 600). Não versionar.
AURORA_HOST=127.0.0.1
AURORA_PORT=3300
AURORA_TRUST_CLOUDFLARE=1
AURORA_DB=$APP/data/aurora.db
AURORA_RELEASES=$APP/releases
AURORA_SITE=$APP/site
LIVEKIT_API_KEY=AK$(head -c 12 /dev/urandom | od -An -tx1 | tr -d ' \n')
LIVEKIT_API_SECRET=$(head -c 32 /dev/urandom | base64 | tr -d '/+=\n')
# endereço público da voz (sinalização pelo tunnel), ex.: wss://voz.seudominio.com
AURORA_LIVEKIT_URL=
EOF
  umask 022
fi
chmod 600 "$ENV"
if [ -n "$LIVEKIT_URL" ]; then
  case "$LIVEKIT_URL" in wss://*) ;; *) fail "--livekit-url precisa começar com wss:// (recebido: $LIVEKIT_URL)" ;; esac
  sed -i "s#^AURORA_LIVEKIT_URL=.*#AURORA_LIVEKIT_URL=$LIVEKIT_URL#" "$ENV"
fi
# shellcheck disable=SC1090
set -a; . "$ENV"; set +a

# LiveKit: sinalização só local (o tunnel leva até ela); mídia em UDP 7882 / TCP 7881.
# Anuncia o IP da rede local (quem está em casa conecta direto) e o IP público: quem está fora
# chega pelo retransmissor TURN, que só aceita pacotes do IP público anunciado (por isso o
# aurora-ipwatch reinicia a voz quando ele muda). Redes internas do Docker ficam de fora.
LAN_IP="$(ip -4 route get 1.1.1.1 2>/dev/null | awk '{for (i = 1; i < NF; i++) if ($i == "src") print $(i + 1)}' | head -1)"
[ -n "$LAN_IP" ] || fail "não consegui descobrir o IP deste servidor na rede local."
umask 077
cat > "$APP/livekit/livekit.yaml" <<EOF
port: 7880
bind_addresses:
  - 127.0.0.1
rtc:
  tcp_port: 7881
  udp_port: 7882
  use_external_ip: true
  advertise_internal_ip: true
  ips:
    includes:
      - $LAN_IP/32
keys:
  $LIVEKIT_API_KEY: $LIVEKIT_API_SECRET
logging:
  level: info
EOF
umask 022

# ---------- serviços (systemd do usuário) ----------
UNITS="$HOME/.config/systemd/user"
mkdir -p "$UNITS"
install -m 644 "$SRC/aurora-server.service" "$UNITS/aurora-server.service"
install -m 644 "$SRC/aurora-livekit.service" "$UNITS/aurora-livekit.service"
install -m 644 "$SRC/aurora-ipwatch.service" "$UNITS/aurora-ipwatch.service"
install -m 644 "$SRC/aurora-ipwatch.timer" "$UNITS/aurora-ipwatch.timer"
systemctl --user daemon-reload

say "Atualizando arquivos"
systemctl --user stop aurora-server.service 2>/dev/null || true
if [ -f "$APP/data/aurora.db" ]; then
  cp "$APP/data/aurora.db" "$APP/data/backups/aurora-$(date +%Y%m%d-%H%M%S).db"
  ls -1t "$APP/data/backups/"aurora-*.db 2>/dev/null | tail -n +11 | xargs -r rm -f # guarda os 10 mais novos
fi
install -m 644 "$SRC/bin/aurora-server.mjs" "$APP/bin/aurora-server.mjs"
install -m 755 "$SRC/aurora-ipwatch.sh" "$APP/bin/aurora-ipwatch.sh"
install -m 755 "$SRC/configurar-turn.sh" "$APP/bin/configurar-turn.sh"
[ -f "$SRC/bin/aurora-server.mjs.map" ] && install -m 644 "$SRC/bin/aurora-server.mjs.map" "$APP/bin/aurora-server.mjs.map"
rm -rf "$APP/site.new" && cp -r "$SRC/site" "$APP/site.new" && rm -rf "$APP/site" && mv "$APP/site.new" "$APP/site"
cp -r "$SRC/releases/." "$APP/releases/"

systemctl --user enable aurora-server.service aurora-livekit.service >/dev/null
systemctl --user enable --now aurora-ipwatch.timer >/dev/null
systemctl --user restart aurora-livekit.service
systemctl --user start aurora-server.service

# ---------- conferência ----------
say "Conferindo"
ok=1
for i in $(seq 1 20); do curl -fsS "http://127.0.0.1:$AURORA_PORT/api/health" >/dev/null 2>&1 && break; sleep 0.5; done
if curl -fsS "http://127.0.0.1:$AURORA_PORT/api/health"; then echo; else ok=0; echo "API não respondeu: journalctl --user -u aurora-server -n 50"; fi
for i in $(seq 1 20); do curl -fsS http://127.0.0.1:7880 >/dev/null 2>&1 && break; sleep 0.5; done
if curl -fsS http://127.0.0.1:7880 >/dev/null 2>&1; then echo "Voz (LiveKit) respondendo em 127.0.0.1:7880"; else ok=0; echo "LiveKit não respondeu: journalctl --user -u aurora-livekit -n 50"; fi

if [ "$(loginctl show-user "$USER" -p Linger --value 2>/dev/null)" != "yes" ]; then
  loginctl enable-linger "$USER" 2>/dev/null || true
fi
if [ "$(loginctl show-user "$USER" -p Linger --value 2>/dev/null)" = "yes" ]; then
  echo "Os serviços sobem sozinhos quando o PC liga."
else
  echo "ATENÇÃO: para os serviços subirem com o PC ligado sem ninguém logado, rode uma vez: sudo loginctl enable-linger $USER"
fi
[ -z "${AURORA_LIVEKIT_URL:-}" ] && echo "ATENÇÃO: falta o endereço público da voz (AURORA_LIVEKIT_URL) em $ENV."
if curl -fsS "http://127.0.0.1:$AURORA_PORT/api/health" 2>/dev/null | grep -q '"voiceRelay":true'; then
  echo "Voz pela internet: retransmissor TURN da Cloudflare ligado."
else
  echo "Voz pela internet: falta ligar o retransmissor. Rode: ssh -t $USER@$LAN_IP bash ~/aurora/bin/configurar-turn.sh"
fi
[ "$ok" = 1 ] && say "Aurora instalado e no ar (o acesso público vem pelo Cloudflare Tunnel: docs/07-publicacao.md)." || fail "algum serviço não subiu (veja acima)."
