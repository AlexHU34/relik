#!/bin/sh
# Сторож бэкапов: раз в час проверяет свежесть последнего дампа и, если бэкапы
# перестали делаться, пишет в Telegram. Без этого «cron молча умер» замечают
# только когда база уже потеряна.
#
# Установка (scripts/vps.sh делает это сам):
#   cp scripts/backup-watch.sh /usr/local/bin/relik-backup-watch
#   cat > /etc/cron.d/relik-backup-watch <<'EOF'
#   SHELL=/bin/sh
#   PATH=/usr/local/sbin:/usr/local/bin:/usr/sbin:/usr/bin:/sbin:/bin
#   17 * * * * root /usr/local/bin/relik-backup-watch
#   EOF
#
# Переменные: TELEGRAM_BOT_TOKEN, TELEGRAM_CHAT_ID (как у relik-push).
# Проверка вручную: /usr/local/bin/relik-backup-watch
set -eu

BACKUP_DIR="${BACKUP_DIR:-/var/backups/relik}"
STATE=/var/lib/relik-backup-watch.state

alert() {
  msg="$1"
  echo "$(date -Iseconds) $msg"
  if [ -n "${TELEGRAM_BOT_TOKEN:-}" ] && [ -n "${TELEGRAM_CHAT_ID:-}" ]; then
    curl -s -m 15 -X POST "https://api.telegram.org/bot${TELEGRAM_BOT_TOKEN}/sendMessage" \
      -d "chat_id=${TELEGRAM_CHAT_ID}" \
      --data-urlencode "text=Relik backup: $msg" >/dev/null || true
  fi
}

if [ -f /etc/relik-push.env ]; then
  # TELEGRAM_* уже лежат там для мониторинга — переиспользуем.
  set -a
  # shellcheck disable=SC1091
  . /etc/relik-push.env
  set +a
fi

newest="$(ls -1t "$BACKUP_DIR"/relik-*.dump.gz 2>/dev/null | head -1 || true)"
if [ -z "$newest" ]; then
  alert "нет ни одного бэкапа в $BACKUP_DIR"
  exit 1
fi

age_h=$(( ( $(date +%s) - $(stat -c %Y "$newest") ) / 3600 ))
size=$(stat -c %s "$newest")

if [ "$age_h" -gt 26 ] || [ "$size" -lt 10240 ]; then
  # Один алерт в сутки, чтобы не засыпать канал.
  today="$(date +%F)"
  if [ ! -f "$STATE" ] || [ "$(cat "$STATE" 2>/dev/null)" != "$today" ]; then
    alert "последний бэкап $(basename "$newest"): ${age_h}ч назад, $((size / 1024)) KB — проверьте /var/log/relik-backup.log"
    echo "$today" > "$STATE"
  fi
  exit 1
fi

rm -f "$STATE"
exit 0
