#!/usr/bin/env bash
# ============================================================
# Relik — подготовка VPS: coturn (TURN для звонков) + keep-alive Supabase
# Запуск (Ubuntu 22.04/24.04/26.04, от root):
#   curl -fsSL https://alexhu34.github.io/relik/scripts/vps.sh | bash
# Скрипт можно запускать повторно: пароль TURN сохраняется.
# ============================================================
set -euo pipefail

SUPABASE_URL="https://sumaysqzahgesifdevxu.supabase.co"
SUPABASE_KEY="sb_publishable_YotDOWeDBvBEzQTFiSJWlg_ljGjpm2Q"
CRED_FILE="/root/relik-turn.txt"
TURN_USER="relik"

say() { printf '\n\033[1;36m== %s\033[0m\n' "$*"; }
warn() { printf '\033[1;33m!! %s\033[0m\n' "$*"; }

if [ "$(id -u)" -ne 0 ]; then
  echo "Запусти от root: sudo -i, затем повтори команду." >&2
  exit 1
fi

say "Обновление системы"
export DEBIAN_FRONTEND=noninteractive
apt-get update -y
apt-get upgrade -y

say "Установка пакетов"
apt-get install -y coturn ufw curl ca-certificates

say "Определение публичного IP"
IP="$(curl -4 -fsS --max-time 10 https://ifconfig.me || true)"
[ -n "$IP" ] || IP="$(curl -4 -fsS --max-time 10 https://icanhazip.com | tr -d '[:space:]' || true)"
if [ -z "$IP" ]; then
  warn "Не удалось определить IP автоматически."
  IP="$(hostname -I | awk '{print $1}')"
  warn "Использую $IP — если это не публичный адрес, поправь external-ip в /etc/turnserver.conf"
fi
echo "IP: $IP"

say "Настройка coturn"
sed -i 's/^#\?TURNSERVER_ENABLED=.*/TURNSERVER_ENABLED=1/' /etc/default/coturn
grep -q '^TURNSERVER_ENABLED=1' /etc/default/coturn || echo 'TURNSERVER_ENABLED=1' >> /etc/default/coturn

# пароль сохраняем между запусками
if [ -f "$CRED_FILE" ]; then
  TURN_PASS="$(awk -F= '/^PASS=/{print $2}' "$CRED_FILE" | head -n1)"
fi
if [ -z "${TURN_PASS:-}" ]; then
  TURN_PASS="$(head -c 64 /dev/urandom | base64 | tr -dc 'A-Za-z0-9' | head -c 16)"
fi

cat > /etc/turnserver.conf <<EOF
listening-port=3478
fingerprint
lt-cred-mech
user=${TURN_USER}:${TURN_PASS}
realm=relik
external-ip=${IP}
min-port=49152
max-port=65535
no-cli
no-multicast-peers
no-loopback-peers
stale-nonce
total-quota=100
log-file=/var/log/turnserver.log
simple-log
EOF

systemctl enable coturn >/dev/null 2>&1 || true
systemctl restart coturn

say "Firewall"
ufw allow 22/tcp >/dev/null
ufw allow 3478/udp >/dev/null
ufw allow 3478/tcp >/dev/null
ufw allow 49152:65535/udp >/dev/null
ufw --force enable >/dev/null
ufw status | head -n 20

say "Keep-alive Supabase (раз в сутки)"
cat > /etc/cron.d/relik-keepalive <<EOF
SHELL=/bin/sh
PATH=/usr/local/sbin:/usr/local/bin:/usr/sbin:/usr/bin:/sbin:/bin
17 4 * * * root curl -fsS -o /dev/null --max-time 20 -H "apikey: ${SUPABASE_KEY}" "${SUPABASE_URL}/rest/v1/profiles?select=id&limit=1" || true
EOF
chmod 644 /etc/cron.d/relik-keepalive

say "Проверка"
sleep 2
ACTIVE="$(systemctl is-active coturn || true)"
LISTEN="$(ss -lunp 2>/dev/null | grep -c ':3478' || true)"

cat > "$CRED_FILE" <<EOF
URL=turn:${IP}:3478
USER=${TURN_USER}
PASS=${TURN_PASS}
EOF
chmod 600 "$CRED_FILE"

printf '\n────────────────────────────────────────\n'
printf '  coturn:   %s\n' "$ACTIVE"
printf '  порт 3478: %s слушающих сокетов\n' "$LISTEN"
printf '\n  TURN URL : turn:%s:3478\n' "$IP"
printf '  USER     : %s\n' "$TURN_USER"
printf '  PASS     : %s\n' "$TURN_PASS"
printf '\n  Эти три строки сохранены в %s\n' "$CRED_FILE"
printf '────────────────────────────────────────\n\n'

if [ "$ACTIVE" != "active" ]; then
  warn "coturn не запустился. Покажи вывод: journalctl -u coturn -n 40 --no-pager"
  exit 1
fi
printf 'Готово. Пришли TURN URL / USER / PASS — их нужно прописать в приложении.\n'
