#!/bin/bash
# Ежедневный бэкап БД Relik (pg_dump → gzip + проверка читаемости + ретенция).
#
# Запуск на VPS (cron, 03:17 UTC):
#   17 3 * * * root /usr/local/bin/relik-backup >> /var/log/relik-backup.log 2>&1
#
# Настройки — в /etc/relik-backup.env:
#   PGHOST, PGPORT, PGUSER, PGPASSWORD, PGDATABASE   (роль с pg_read_all_data)
#   BACKUP_DIR=/var/backups/relik                    (по умолчанию)
#   KEEP_DAYS=14                                     (по умолчанию)
#   RCLONE_REMOTE=                                  (например, r2:relik-backups — офсайт)
#
# Важно: /var/backups/relik лежит на том же VPS. Для настоящей защиты от потери
# сервера задайте RCLONE_REMOTE (rclone config) — файл уедет в объектное хранилище.
#
# Проверка вручную:
#   bash scripts/backup-db.sh                 # сделать бэкап сейчас
#   bash scripts/backup-db.sh --check         # свежесть последнего бэкапа (для мониторинга)
#
# Восстановление (в пустую БД! pg_restore перезапишет данные):
#   gunzip -c /var/backups/relik/relik-YYYY-MM-DD.dump.gz \
#     | pg_restore --no-owner --no-privileges -d "$TARGET_URL"
#   затем: supabase/*.sql не нужны — схема уже внутри дампа.
#
# Для тренировки восстановления есть scripts/restore-drill.sh.
set -euo pipefail

BACKUP_DIR="${BACKUP_DIR:-/var/backups/relik}"
KEEP_DAYS="${KEEP_DAYS:-14}"
STAMP="$(date +%F)"
OUT="$BACKUP_DIR/relik-$STAMP.dump"
MIN_BYTES="${MIN_BYTES:-10240}"

if [ "${1:-}" = "--check" ]; then
  newest="$(ls -1t "$BACKUP_DIR"/relik-*.dump.gz 2>/dev/null | head -1 || true)"
  if [ -z "$newest" ]; then
    echo "backup-check: нет ни одного бэкапа в $BACKUP_DIR"
    exit 1
  fi
  age_h=$(( ( $(date +%s) - $(stat -c %Y "$newest") ) / 3600 ))
  size=$(stat -c %s "$newest")
  echo "backup-check: $newest, ${age_h}ч назад, $((size / 1024)) KB"
  [ "$age_h" -le 26 ] || { echo "backup-check: последний бэкап старше 26 часов"; exit 1; }
  [ "$size" -ge "$MIN_BYTES" ] || { echo "backup-check: файл подозрительно мал"; exit 1; }
  exit 0
fi

# Конфиг с секретами: права 600, владелец root.
if [ -f /etc/relik-backup.env ]; then
  set -a
  # shellcheck disable=SC1091
  . /etc/relik-backup.env
  set +a
fi

: "${PGHOST:?PGHOST не задан (см. /etc/relik-backup.env)}"
: "${PGUSER:?PGUSER не задан}"

mkdir -p "$BACKUP_DIR"
START=$(date +%s)

# Два запуска одновременно не нужны и удваивают нагрузку на БД.
if command -v flock >/dev/null 2>&1; then
  exec 9>"/var/lock/relik-backup.lock"
  flock -n 9 || { echo "$(date -Iseconds) skip: предыдущий бэкап ещё идёт"; exit 0; }
fi

cleanup() { rm -f "$OUT" "$OUT.gz"; }
trap cleanup ERR

pg_dump \
  --host="$PGHOST" \
  --port="${PGPORT:-5432}" \
  --username="$PGUSER" \
  --dbname="${PGDATABASE:-postgres}" \
  --no-owner --no-privileges \
  --format=custom \
  --file="$OUT"

# Файл должен читаться pg_restore: ловим обрыв соединения и «пустой» дамп.
pg_restore --list "$OUT" > /dev/null

gzip -f "$OUT"

size=$(stat -c %s "$OUT.gz")
if [ "$size" -lt "$MIN_BYTES" ]; then
  echo "$(date -Iseconds) fail: дамп слишком мал ($size байт)" >&2
  exit 1
fi

# Офсайт-копия (если настроен rclone remote): без неё бэкап живёт на том же диске.
if [ -n "${RCLONE_REMOTE:-}" ] && command -v rclone >/dev/null 2>&1; then
  rclone copyto "$OUT.gz" "${RCLONE_REMOTE%/}/$(basename "$OUT.gz")" \
    && echo "offsite: ${RCLONE_REMOTE%/}/$(basename "$OUT.gz")"
fi

find "$BACKUP_DIR" -name 'relik-*.dump.gz' -mtime +"$KEEP_DAYS" -delete

echo "$(date -Iseconds) ok $OUT.gz ($((size / 1024)) KB, $(( $(date +%s) - START ))s)"
