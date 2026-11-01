#!/bin/bash
# Тренировка восстановления из бэкапа. Запускать ТОЛЬКО на отдельной БД
# (пустой проект Supabase, локальный Postgres в docker) — не на проде.
#
#   bash scripts/restore-drill.sh "postgresql://postgres:...@host:5432/postgres" [дамп]
#
# Без второго аргумента берётся самый свежий /var/backups/relik/*.dump.gz.
# Скрипт отказывается работать, если в строке подключения узнаёт боевой проект.
#
# Что проверяется: дамп разворачивается целиком, затем считаются строки в
# ключевых таблицах. Ноль в profiles/messages — повод разбираться, а не «ок».
set -euo pipefail

TARGET_URL="${1:-${TARGET_URL:-}}"
if [ -z "$TARGET_URL" ]; then
  sed -n '2,10p' "$0"
  exit 2
fi

case "$TARGET_URL" in
  *sumaysqzahgesifdevxu*)
    echo "Отказ: в строке подключения боевой проект. Возьмите пустую тренировочную БД." >&2
    exit 2
    ;;
esac

DUMP="${2:-}"
if [ -z "$DUMP" ]; then
  DUMP="$(ls -1t /var/backups/relik/relik-*.dump.gz 2>/dev/null | head -1 || true)"
fi
if [ -z "$DUMP" ] || [ ! -f "$DUMP" ]; then
  echo "Не найден дамп. Укажите путь вторым аргументом." >&2
  exit 2
fi

for tool in gunzip pg_restore psql; do
  command -v "$tool" >/dev/null 2>&1 || { echo "Нет $tool (apt install postgresql-client)"; exit 2; }
done

START=$(date +%s)
echo "Дамп: $DUMP ($(du -h "$DUMP" | cut -f1))"
echo "Цель: ${TARGET_URL%%\?*}"

# --clean --if-exists: тренировочную БД можно переиспользовать.
gunzip -c "$DUMP" | pg_restore --no-owner --no-privileges --clean --if-exists -d "$TARGET_URL"

q() { psql "$TARGET_URL" -Atc "$1" 2>/dev/null || echo '?'; }
profiles=$(q "select count(*) from public.profiles")
messages=$(q "select count(*) from public.messages")
convos=$(q "select count(*) from public.conversations")
tables=$(q "select count(*) from information_schema.tables where table_schema='public'")

echo "────────────────────────────────────────"
echo "таблиц public : $tables"
echo "profiles      : $profiles"
echo "conversations : $convos"
echo "messages      : $messages"
echo "восстановление: $(( $(date +%s) - START )) с"

fail=0
[ "$tables" != "?" ] && [ "$tables" -ge 10 ] || { echo "✖ мало таблиц — дамп неполный"; fail=1; }
[ "$profiles" != "?" ] && [ "$profiles" -ge 1 ] || { echo "✖ нет профилей"; fail=1; }
[ "$messages" != "?" ] && [ "$messages" -ge 1 ] || { echo "✖ нет сообщений"; fail=1; }
[ "$fail" -eq 0 ] && echo "✔ восстановление читается"

exit "$fail"
