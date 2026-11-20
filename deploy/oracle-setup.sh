#!/usr/bin/env bash
# Instala (o actualiza) Time to Break en una VM Ubuntu — pensado para Oracle Cloud Always Free en
# Santiago de Chile — con Node, un servicio systemd y Caddy con HTTPS automático.
#
# Uso, dentro de la VM:
#   curl -fsSL https://raw.githubusercontent.com/Santisola/Time-to-break/main/deploy/oracle-setup.sh | sudo bash
# Con dominio propio (opcional):  ... | sudo DOMAIN=juegos.midominio.com bash
# Sin dominio usa <ip-con-guiones>.sslip.io, que apunta solo a la IP de la VM.
set -euo pipefail
export DEBIAN_FRONTEND=noninteractive

REPO="https://github.com/Santisola/Time-to-break.git"
DIR="/opt/time-to-break"
SERVICE="time-to-break"

if [ "$(id -u)" -ne 0 ]; then
  echo "Correlo con sudo." >&2
  exit 1
fi

echo "==> Paquetes base"
apt-get update -qq
apt-get install -y -qq git curl gnupg debian-keyring debian-archive-keyring apt-transport-https iptables-persistent >/dev/null

if ! command -v node >/dev/null || [ "$(node -p 'process.versions.node.split(".")[0]')" -lt 22 ]; then
  echo "==> Node 22"
  curl -fsSL https://deb.nodesource.com/setup_22.x | bash - >/dev/null
  apt-get install -y -qq nodejs >/dev/null
fi

if ! command -v caddy >/dev/null; then
  echo "==> Caddy (proxy con HTTPS automático)"
  curl -1sLf 'https://dl.cloudsmith.io/public/caddy/stable/gpg.key' | gpg --dearmor --yes -o /usr/share/keyrings/caddy-stable-archive-keyring.gpg
  curl -1sLf 'https://dl.cloudsmith.io/public/caddy/stable/debian.deb.txt' >/etc/apt/sources.list.d/caddy-stable.list
  apt-get update -qq
  apt-get install -y -qq caddy >/dev/null
fi

echo "==> Código"
id -u ttb >/dev/null 2>&1 || useradd --system --home "$DIR" --shell /usr/sbin/nologin ttb
if [ -d "$DIR/.git" ]; then
  git -C "$DIR" fetch -q origin main
  git -C "$DIR" reset -q --hard origin/main
else
  git clone -q "$REPO" "$DIR"
fi
(cd "$DIR" && npm ci --omit=dev --silent)
chown -R ttb:ttb "$DIR"

echo "==> Servicio"
cat >/etc/systemd/system/$SERVICE.service <<EOF
[Unit]
Description=Time to Break
After=network.target

[Service]
User=ttb
WorkingDirectory=$DIR
Environment=NODE_ENV=production PORT=3000
ExecStart=/usr/bin/node server.js
Restart=always
RestartSec=2

[Install]
WantedBy=multi-user.target
EOF
systemctl daemon-reload
systemctl enable -q "$SERVICE"
systemctl restart "$SERVICE"

echo "==> HTTPS"
PUBLIC_IP="$(curl -fsS https://checkip.amazonaws.com | tr -d '[:space:]')"
HOST="${DOMAIN:-${PUBLIC_IP//./-}.sslip.io}"
cat >/etc/caddy/Caddyfile <<EOF
$HOST {
  reverse_proxy localhost:3000
}
EOF
systemctl restart caddy

# Las imágenes Ubuntu de Oracle traen iptables cerrado salvo SSH: abrir 80 y 443.
for port in 80 443; do
  iptables -C INPUT -p tcp --dport "$port" -m conntrack --ctstate NEW -j ACCEPT 2>/dev/null ||
    iptables -I INPUT 1 -p tcp --dport "$port" -m conntrack --ctstate NEW -j ACCEPT
done
netfilter-persistent save >/dev/null

sleep 2
if curl -fsS "http://localhost:3000/health" >/dev/null; then
  echo
  echo "Listo: https://$HOST"
  echo "(La primera vez Caddy tarda unos segundos en sacar el certificado.)"
else
  echo "El servicio no responde. Mirá los logs con: journalctl -u $SERVICE -n 50" >&2
  exit 1
fi
