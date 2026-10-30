#!/usr/bin/env bash
# ============================================================
# Relik — подготовка VPS: coturn (TURN для звонков) + watchdog + keep-alive
# Запуск (Ubuntu 22.04/24.04/26.04, от root):
#   curl -fsSL https://alexhu34.github.io/relik/scripts/vps.sh | bash
# Скрипт можно запускать повторно: пароль TURN сохраняется.
#
# Что делает:
#   1) ставит и настраивает coturn (TURN/STUN на 3478);
#   2) поднимает swap, если RAM мало (иначе OOM убивает node/coturn);
#   3) ставит watchdog: раз в минуту поднимает упавшие coturn и relik-push;
#   4) ставит keep-alive Supabase каждые 5 минут (чтобы free-проект не уснул
#      и чтобы в логе была видна деградация до того, как её заметят люди);
#   5) открывает порты и печатает, что осталось сделать руками.
#
# Переменные (необязательно):
#   RELIK_WEB=1   — открыть 80/443 (если на этом же VPS стоит Caddy с зеркалом)
# ============================================================
set -euo pipefail

SUPABASE_URL="https://sumaysqzahgesifdevxu.supabase.co"
SUPABASE_KEY="sb_publishable_YotDOWeDBvBEzQTFiSJWlg_ljGjpm2Q"
CRED_FILE="/root/relik-turn.txt"
TURN_USER="relik"
RELIK_WEB="${RELIK_WEB:-0}"

say() { printf '\n\033[1;36m== %s\033[0m\n' "$*"; }
warn() { printf '\033[1;33m!! %s\033[0m\n' "$*"; }

if [ "$(id -u)" -ne 0 ]; then
  echo "Запусти от root: sudo -i, затем повтори команду." >&2
  exit 1
fi

say "Обновление системы"
export DEBIAN_FRONTEND=noninteractive
APT_OPTS="-y -o Dpkg::Options::=--force-confdef -o Dpkg::Options::=--force-confold"
apt-get update -y
# shellcheck disable=SC2086
apt-get upgrade $APT_OPTS

say "Установка пакетов"
# shellcheck disable=SC2086
apt-get install $APT_OPTS coturn ufw curl ca-certificates

say "Swap (если RAM меньше 2 ГБ)"
if ! swapon --show | grep -q .; then
  MEM_MB="$(awk '/MemTotal/{printf "%d", $2/1024}' /proc/meminfo)"
  if [ "${MEM_MB:-0}" -lt 2048 ]; then
    fallocate -l 2G /swapfile || dd if=/dev/zero of=/swapfile bs=1M count=2048
    chmod 600 /swapfile
    mkswap /swapfile >/dev/null
    swapon /swapfile
    grep -q '^/swapfile' /etc/fstab || echo '/swapfile none swap sw 0 0' >> /etc/fstab
    sysctl -q -w vm.swappiness=20
    grep -q '^vm.swappiness' /etc/sysctl.conf || echo 'vm.swappiness=20' >> /etc/sysctl.conf
    echo "swap 2G включён (было ${MEM_MB} МБ RAM)"
  else
    echo "RAM ${MEM_MB} МБ — swap не нужен"
  fi
else
  echo "swap уже есть: $(swapon --show --noheadings | awk '{print $1, $3}' | tr '\n' ' ')"
fi

say "Проверка времени (для TLS и токенов)"
timedatectl set-ntp true 2>/dev/null || true
timedatectl 2>/dev/null | grep -E 'System clock synchronized|NTP service' || true

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
[ -f /etc/default/coturn ] || echo 'TURNSERVER_ENABLED=1' > /etc/default/coturn
sed -i 's/^#\?TURNSERVER_ENABLED=.*/TURNSERVER_ENABLED=1/' /etc/default/coturn || true
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

say "Watchdog сервисов (раз в минуту)"
cat > /usr/local/bin/relik-watchdog.sh <<'EOF'
#!/bin/sh
# Поднимает упавшие сервисы Relik. Пишет только при инциденте, чтобы не шуметь.
for svc in coturn relik-push; do
  systemctl list-unit-files "${svc}.service" >/dev/null 2>&1 || continue
  if ! systemctl is-active --quiet "$svc"; then
    echo "$(date -Iseconds) $svc was down -> restart" >> /var/log/relik-watchdog.log
    systemctl restart "$svc" || true
  fi
done
EOF
chmod 755 /usr/local/bin/relik-watchdog.sh
cat > /etc/cron.d/relik-watchdog <<'EOF'
SHELL=/bin/sh
PATH=/usr/local/sbin:/usr/local/bin:/usr/sbin:/usr/bin:/sbin:/bin
* * * * * root /usr/local/bin/relik-watchdog.sh
EOF
chmod 644 /etc/cron.d/relik-watchdog

say "Keep-alive Supabase (каждые 5 минут, с логом)"
cat > /usr/local/bin/relik-keepalive.sh <<EOF
#!/bin/sh
# Один запрос к Auth и один к REST: если Supabase недоступен — увидим в логе.
KEY="${SUPABASE_KEY}"
BASE="${SUPABASE_URL}"
code_auth=\$(curl -s -o /dev/null -w '%{http_code}' --max-time 20 -H "apikey: \$KEY" "\$BASE/auth/v1/health" || echo 000)
code_rest=\$(curl -s -o /dev/null -w '%{http_code}' --max-time 20 -H "apikey: \$KEY" "\$BASE/rest/v1/profiles?select=id&limit=1" || echo 000)
if [ "\$code_auth" != "200" ] || [ "\$code_rest" != "200" ]; then
  echo "\$(date -Iseconds) auth=\$code_auth rest=\$code_rest" >> /var/log/relik-keepalive.log
fi
EOF
chmod 755 /usr/local/bin/relik-keepalive.sh
rm -f /etc/cron.d/relik-keepalive
cat > /etc/cron.d/relik-keepalive <<'EOF'
SHELL=/bin/sh
PATH=/usr/local/sbin:/usr/local/bin:/usr/sbin:/usr/bin:/sbin:/bin
*/5 * * * * root /usr/local/bin/relik-keepalive.sh
EOF
chmod 644 /etc/cron.d/relik-keepalive
/usr/local/bin/relik-keepalive.sh || true

say "Firewall"
ufw allow 22/tcp >/dev/null
ufw allow 3478/udp >/dev/null
ufw allow 3478/tcp >/dev/null
ufw allow 49152:65535/udp >/dev/null
if [ "$RELIK_WEB" = "1" ]; then
  ufw allow 80/tcp >/dev/null
  ufw allow 443/tcp >/dev/null
fi
ufw --force enable >/dev/null
ufw status | head -n 20

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
printf '────────────────────────────────────────\n'

if [ "$ACTIVE" != "active" ]; then
  warn "coturn не запустился. Покажи вывод: journalctl -u coturn -n 40 --no-pager"
  exit 1
fi

cat <<'EOF'

Что осталось сделать руками (один раз):
  1) relik-push (push + мониторинг): scripts/push-service/README.md
     В /etc/relik-push.env добавить алерты:
       TELEGRAM_BOT_TOKEN=...
       TELEGRAM_CHAT_ID=...
       SUPABASE_ANON_KEY=<publishable key>
     затем: systemctl restart relik-push && curl -s localhost:8099/healthz
  2) История доступности: выполнить supabase/service_uptime.sql в Supabase.
  3) Бэкапы БД: scripts/backup-db.sh в cron (03:20), проверить restore.
  4) Резервная статика: scripts/mirror-static.sh + scripts/Caddyfile.relik.
  5) Внешний монитор (не зависит от этого VPS): UptimeRobot/BetterStack
     на https://alexhu34.github.io/relik/tools/status.html раз в 5 минут.

Готово. Пришли TURN URL / USER / PASS — их нужно прописать в js/config.js.
EOF
