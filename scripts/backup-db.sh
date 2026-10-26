# Резервное копирование БД Relik (P0-5)
#
# Где запускать: на VPS (Linux) в cron, раз в сутки.
# Нужен клиент PostgreSQL: apt install postgresql-client
#
# Переменные:
#   PGHOST      aws-0-eu-west-1.pooler.supabase.com
#   PGPORT      5432
#   PGUSER      postgres.<project-ref>
#   PGPASSWORD  пароль БД (Supabase → Project Settings → Database)
#   PGDATABASE  postgres
#
# Пример crontab (03:20 каждый день):
#   20 3 * * *  PGPASSWORD='...' /bin/bash /opt/relik/backup-db.sh >> /var/log/relik-backup.log 2>&1
#
# Восстановление (проверять раз в квартал на пустом проекте!):
#   pg_restore --no-owner --no-privileges -d "$TARGET_URL" /var/backups/relik-YYYY-MM-DD.dump

set -euo pipefail

BACKUP_DIR="${BACKUP_DIR:-/var/backups/relik}"
KEEP_DAYS="${KEEP_DAYS:-14}"
STAMP="$(date +%F)"
FILE="$BACKUP_DIR/relik-$STAMP.dump"

mkdir -p "$BACKUP_DIR"

pg_dump \
  --host="${PGHOST:?PGHOST required}" \
  --port="${PGPORT:-5432}" \
  --username="${PGUSER:?PGUSER required}" \
  --dbname="${PGDATABASE:-postgres}" \
  --no-owner --no-privileges \
  --format=custom \
  --file="$FILE"

# Проверка, что дамп читается (а не «создался пустым»)
pg_restore --list "$FILE" > /dev/null

find "$BACKUP_DIR" -name 'relik-*.dump' -mtime +"$KEEP_DAYS" -delete

echo "$(date -Iseconds) ok: $(du -h "$FILE" | cut -f1) $FILE"

# Отдельно: файлы Storage (медиа) не входят в дамп БД.
# Их бэкапят через Supabase Dashboard → Storage → Download или rclone по S3-ключу.
