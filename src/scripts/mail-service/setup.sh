#!/usr/bin/env bash
# Интерактивная настройка Relik mail-service.
# Запускать на VPS: sudo bash /opt/relik-mail/setup.sh
# Секреты вводятся скрыто и не попадают в историю команд.
set -euo pipefail

ENV="/etc/relik-mail.env"
SERVICE="relik-mail"
HEALTH="http://127.0.0.1:8100/healthz"

if [ "$(id -u)" -ne 0 ]; then
  echo "Запустите от root: sudo bash $0" >&2
  exit 1
fi
if [ ! -f "$ENV" ]; then
  echo "Нет $ENV. Сначала запустите install.sh." >&2
  exit 1
fi

say() { printf '\n\033[1;36m== %s\033[0m\n' "$*"; }
warn() { printf '\033[1;33m!! %s\033[0m\n' "$*"; }

current() {
  grep -E "^$1=" "$ENV" | head -n1 | cut -d= -f2- | sed 's/^"//; s/"$//' || true
}

set_key() {
  local key="$1" val="$2"
  if grep -q "^${key}=" "$ENV"; then
    awk -v k="$key" -v v="$val" '
      BEGIN { FS=OFS="=" }
      $1 == k { print k "=" v; next }
      { print }
    ' "$ENV" > "$ENV.tmp"
    mv "$ENV.tmp" "$ENV"
  else
    printf '%s=%s\n' "$key" "$val" >> "$ENV"
  fi
}

say "Текущее состояние"
echo "MAIL_PROVIDER=$(current MAIL_PROVIDER)"
echo "SMTP_USER=$(current SMTP_USER)"
echo "SEND_EMAIL_HOOK_SECRET=$([ -n "$(current SEND_EMAIL_HOOK_SECRET)" ] && echo 'задан' || echo 'пусто')"
echo "SMTP_PASS=$([ -n "$(current SMTP_PASS)" ] && echo 'задан' || echo 'пусто')"

say "Почта Яндекса"
DEF_USER="$(current SMTP_USER)"
[ -n "$DEF_USER" ] || DEF_USER="relik.support@yandex.ru"
read -rp "Адрес почты [$DEF_USER]: " MAIL_USER
MAIL_USER="${MAIL_USER:-$DEF_USER}"

read -rsp "Пароль приложения (Enter — оставить текущий): " SMTP_PASS
echo
if [ -z "${SMTP_PASS:-}" ]; then
  SMTP_PASS="$(current SMTP_PASS)"
fi
if [ -z "${SMTP_PASS:-}" ]; then
  warn "Пароль приложения обязателен. Создайте его в Яндекс ID → Безопасность → Пароли приложений."
  exit 1
fi

read -rsp "Секрет Supabase (v1,whsec_..., Enter — оставить текущий): " HOOK_SECRET
echo
if [ -z "${HOOK_SECRET:-}" ]; then
  HOOK_SECRET="$(current SEND_EMAIL_HOOK_SECRET)"
fi
if [ -z "${HOOK_SECRET:-}" ]; then
  warn "Секрет Supabase обязателен: Authentication → Hooks → Send Email → Generate secret."
  exit 1
fi
case "$HOOK_SECRET" in
  v1,whsec_*) : ;;
  *) warn "Секрет не похож на v1,whsec_... — записываю как есть, но проверьте его." ;;
esac

say "Запись конфигурации"
set_key MAIL_PROVIDER smtp
set_key SMTP_HOST smtp.yandex.ru
set_key SMTP_PORT 465
set_key SMTP_SECURE true
set_key SMTP_USER "$MAIL_USER"
set_key SMTP_PASS "$SMTP_PASS"
set_key MAIL_FROM "\"Relik <$MAIL_USER>\""
set_key MAIL_REPLY_TO "$MAIL_USER"
set_key SEND_EMAIL_HOOK_SECRET "$HOOK_SECRET"
set_key DRY_RUN 0
chmod 600 "$ENV"

say "Перезапуск"
systemctl restart "$SERVICE"
sleep 2
systemctl is-active "$SERVICE" || true
echo
curl -s --max-time 10 "$HEALTH" || true
echo

if ! curl -s --max-time 10 "$HEALTH" | grep -q '"ready":true'; then
  warn "Сервис не готов. Смотрите:"
  echo "  journalctl -u $SERVICE -n 60 --no-pager"
  echo "  grep -E '^(MAIL_PROVIDER|SMTP_USER|SEND_EMAIL_HOOK_SECRET|SMTP_PASS)=' $ENV"
  exit 1
fi

say "Готово"
read -rp "Тестовый email для отправки кода (Enter — пропустить): " TEST_TO
if [ -n "${TEST_TO:-}" ]; then
  SEND_EMAIL_HOOK_SECRET="$HOOK_SECRET" TO_EMAIL="$TEST_TO" \
    node /opt/relik-mail/test-hook.mjs || true
else
  echo "Проверка пропущена. Позже:"
  echo "  SEND_EMAIL_HOOK_SECRET='...' TO_EMAIL='you@mail' node /opt/relik-mail/test-hook.mjs"
fi

echo
echo "Supabase → Authentication → Hooks → Send Email → HTTP:"
echo "  URL: https://mail.62-113-99-46.nip.io/hooks/send-email"
echo "  Secret: тот, что вы ввели выше"
echo "Не забудьте включить Confirm email."
