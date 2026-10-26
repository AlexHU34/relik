#!/usr/bin/env bash
# Relik mail service installer (Ubuntu/Debian).
#
# Что делает:
#   1. копирует сервис в /opt/relik-mail;
#   2. создаёт /etc/relik-mail.env (если его ещё нет);
#   3. ставит systemd-юнит relik-mail;
#   4. запускает сервис на 127.0.0.1:8100;
#   5. открывает 80/443 для Caddy (если установлен ufw);
#   6. печатает, что осталось заполнить.
#
# Запуск (из каталога scripts/mail-service):
#   sudo bash install.sh
#
set -euo pipefail

if [ "$(id -u)" -ne 0 ]; then
  echo "Запустите от root: sudo bash install.sh" >&2
  exit 1
fi

if ! command -v curl >/dev/null 2>&1; then
  apt-get update -y >/dev/null 2>&1 || true
  apt-get install -y curl ca-certificates >/dev/null 2>&1 || true
fi

DIR="$(cd "$(dirname "$0")" && pwd)"
APP_DIR="/opt/relik-mail"
ENV_FILE="/etc/relik-mail.env"
UNIT="/etc/systemd/system/relik-mail.service"

say() { printf '\n\033[1;36m== %s\033[0m\n' "$*"; }
warn() { printf '\033[1;33m!! %s\033[0m\n' "$*"; }

say "Проверка Node.js"
if ! command -v node >/dev/null 2>&1; then
  warn "Node.js не найден. Установите Node 18+ (NodeSource) и повторите."
  exit 1
fi
NODE_MAJOR="$(node -p "process.versions.node.split('.')[0]")"
if [ "${NODE_MAJOR:-0}" -lt 18 ]; then
  warn "Нужен Node.js 18+, сейчас $(node -v)."
  exit 1
fi
NODE_BIN="$(command -v node)"
echo "node: $(node -v) ($NODE_BIN)"

say "Копирование сервиса"
install -d -m 755 "$APP_DIR"
install -m 644 "$DIR/index.js" "$APP_DIR/index.js"
install -m 644 "$DIR/package.json" "$APP_DIR/package.json"
install -m 755 "$DIR/test-hook.mjs" "$APP_DIR/test-hook.mjs"
if [ -f "$DIR/test/mail.test.js" ]; then
  install -d -m 755 "$APP_DIR/test"
  install -m 644 "$DIR/test/mail.test.js" "$APP_DIR/test/mail.test.js"
fi
if [ -f "$DIR/README.md" ]; then
  install -m 644 "$DIR/README.md" "$APP_DIR/README.md"
fi

if command -v npm >/dev/null 2>&1; then
  (cd "$APP_DIR" && npm install --omit=dev --no-audit --no-fund --registry=https://registry.npmmirror.com) \
    || warn "npm install не удался. Для MAIL_PROVIDER=smtp нужен nodemailer; Brevo работает без него."
else
  warn "npm не найден. Для MAIL_PROVIDER=smtp установите nodemailer; Brevo работает без него."
fi

say "Конфигурация"
if [ ! -f "$ENV_FILE" ]; then
  cat > "$ENV_FILE" <<EOF
HOST=127.0.0.1
PORT=8100

# smtp — напрямую через Яндекс (лучше для RU, DMARC проходит).
# brevo — через API Brevo (300/сутки, без app password).
MAIL_PROVIDER=smtp

SMTP_HOST=smtp.yandex.ru
SMTP_PORT=465
SMTP_SECURE=true
SMTP_USER=relik.support@yandex.ru
SMTP_PASS=

# Только для MAIL_PROVIDER=brevo
BREVO_API_KEY=

# Подтверждённый отправитель. Для smtp должен совпадать с SMTP_USER.
MAIL_FROM="Relik <relik.support@yandex.ru>"
MAIL_REPLY_TO=relik.support@yandex.ru

# Нужен для ссылок в письмах (recovery / magic link).
SUPABASE_URL=https://<project>.supabase.co

# Supabase → Authentication → Hooks → Send Email → сгенерировать секрет.
# Скопируйте сюда v1,whsec_...
SEND_EMAIL_HOOK_SECRET=

CODE_TTL_MINUTES=60
RATE_PER_EMAIL=5
RATE_WINDOW_MS=900000
RATE_GLOBAL_PER_MIN=30
BREVO_TIMEOUT_MS=4000
DRY_RUN=0
LOG_LEVEL=info
EOF
  chmod 600 "$ENV_FILE"
  echo "Создан $ENV_FILE"
else
  echo "Уже существует $ENV_FILE — не трогаю."
fi

say "systemd"
cat > "$UNIT" <<EOF
[Unit]
Description=Relik mail service (Supabase auth hook -> Brevo)
After=network-online.target
Wants=network-online.target

[Service]
Type=simple
User=www-data
Group=www-data
WorkingDirectory=/opt/relik-mail
EnvironmentFile=/etc/relik-mail.env
ExecStart=${NODE_BIN} /opt/relik-mail/index.js
Restart=always
RestartSec=3
NoNewPrivileges=true
PrivateTmp=true
ProtectSystem=strict
ProtectHome=true
ProtectKernelTunables=true
ProtectControlGroups=true
RestrictAddressFamilies=AF_INET AF_INET6
CapabilityBoundingSet=
MemoryMax=128M
TasksMax=64
SyslogIdentifier=relik-mail

[Install]
WantedBy=multi-user.target
EOF

systemctl daemon-reload
systemctl enable --now relik-mail
sleep 1
systemctl --no-pager --full status relik-mail | head -n 18 || true

say "Firewall"
if command -v ufw >/dev/null 2>&1; then
  ufw allow 80/tcp >/dev/null 2>&1 || true
  ufw allow 443/tcp >/dev/null 2>&1 || true
  ufw status | head -n 20 || true
else
  echo "ufw не найден — откройте 80/443 вручную."
fi

say "Проверка локально"
curl -fsS --max-time 5 http://127.0.0.1:8100/healthz || warn "healthz не ответил — смотрите journalctl -u relik-mail"

IP="$(curl -4 -fsS --max-time 8 https://ifconfig.me 2>/dev/null || true)"
if [ -z "$IP" ]; then
  IP="$(hostname -I 2>/dev/null | awk '{print $1}')"
fi

cat <<EOF

========================================================================
  Дальше:

  1. Транспорт (одно из двух):
     a) Яндекс SMTP — рекомендуется без домена:
        - включите «Почтовые программы» и пароль приложения;
        - в $ENV_FILE заполните SMTP_USER / SMTP_PASS;
        - MAIL_PROVIDER=smtp, MAIL_FROM = SMTP_USER.
     b) Brevo API — 300/сутки, без app password:
        - Senders → подтвердите MAIL_FROM;
        - SMTP & API → API Keys → v3;
        - MAIL_PROVIDER=brevo, BREVO_API_KEY=...

  2. Caddy (если ещё не установлен):
     - поставьте Caddy и добавьте сайт:

       mail.${IP}.nip.io {
           reverse_proxy 127.0.0.1:8100
       }

     - откройте 80/443;
     - проверьте: curl https://mail.${IP}.nip.io/healthz

  3. Supabase:
     - Authentication → Hooks → Send Email → HTTP;
     - URL: https://mail.${IP}.nip.io/hooks/send-email
     - Generate secret и скопируйте в $ENV_FILE (SEND_EMAIL_HOOK_SECRET)

  4. Перезапуск после правок:
     systemctl restart relik-mail
     journalctl -u relik-mail -n 50 --no-pager

  5. Тест без Supabase:
     SEND_EMAIL_HOOK_SECRET='<секрет>' TO_EMAIL='ваш@ящик' \\
       node /opt/relik-mail/test-hook.mjs

========================================================================
EOF

if [ -n "${IP}" ]; then
  warn "После создания хука в Supabase скопируйте сгенерированный секрет в"
  warn "  $ENV_FILE  →  SEND_EMAIL_HOOK_SECRET"
  warn "и перезапустите: systemctl restart relik-mail"
else
  warn "Не удалось определить внешний IP. Проверьте DNS/nip.io вручную."
fi

warn "Сервис не готов, пока не заполнены SMTP_PASS или BREVO_API_KEY, SEND_EMAIL_HOOK_SECRET и SUPABASE_URL."
