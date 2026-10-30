#!/usr/bin/env bash
# ============================================================
# Relik — резервное зеркало статики на VPS (Caddy + git pull).
#
# Зачем: приложение статическое, поэтому его можно отдавать с двух адресов.
# Основной — GitHub Pages, резервный — этот VPS. Если GitHub Pages у
# провайдера тормозит, вы переключаете A-запись домена на VPS и всё работает:
# данные остаются в Supabase, ничего не теряется.
#
# Запуск (на VPS, от root):
#   DOMAIN=relik.example.ru bash mirror-static.sh
#   DOMAIN=relik.example.ru BRANCH=main bash mirror-static.sh
#
# Что делает:
#   1) ставит git и rsync;
#   2) клонирует github.com/AlexHU34/relik в /opt/relik-src;
#   3) раз в 5 минут: git pull + rsync в /var/www/relik (атомарно);
#   4) добавляет сайт в Caddy (/etc/caddy/relik.caddy) и перезагружает его;
#   5) проверяет, что страница отдаётся локально.
#
# Откат: systemctl disable --now relik-mirror.timer; rm /etc/caddy/relik.caddy
# ============================================================
set -euo pipefail

DOMAIN="${DOMAIN:-}"
BRANCH="${BRANCH:-main}"
REPO="${REPO:-https://github.com/AlexHU34/relik.git}"
SRC="/opt/relik-src"
DST="/var/www/relik"

say() { printf '\n\033[1;36m== %s\033[0m\n' "$*"; }
warn() { printf '\033[1;33m!! %s\033[0m\n' "$*"; }

if [ "$(id -u)" -ne 0 ]; then
  echo "Запусти от root: sudo -i, затем DOMAIN=... bash mirror-static.sh" >&2
  exit 1
fi
if [ -z "$DOMAIN" ]; then
  echo "Нужен домен: DOMAIN=relik.example.ru bash mirror-static.sh" >&2
  echo "A-запись домена должна уже указывать на этот сервер." >&2
  exit 1
fi
case "$DOMAIN" in
  example.com|example.ru|relik.example.ru)
    echo "Похоже, домен не заменён: $DOMAIN" >&2
    exit 1
    ;;
esac

say "Пакеты"
export DEBIAN_FRONTEND=noninteractive
apt-get update -y
apt-get install -y git rsync curl ca-certificates caddy

say "Исходники сайта"
if [ -d "$SRC/.git" ]; then
  git -C "$SRC" fetch --depth 1 origin "$BRANCH"
  git -C "$SRC" reset --hard "origin/$BRANCH"
else
  rm -rf "$SRC"
  git clone --depth 1 --branch "$BRANCH" "$REPO" "$SRC"
fi
mkdir -p "$DST"

say "Скрипт обновления"
cat > /usr/local/bin/relik-mirror.sh <<EOF
#!/bin/sh
# Подтягивает свежий сайт и раскладывает его для Caddy.
set -e
REPO="$REPO"
BRANCH="$BRANCH"
SRC="$SRC"
DST="$DST"
LOG=/var/log/relik-mirror.log

# Без блокировки ручной запуск и таймер могут схватиться за один shallow-клон
# («shallow file has changed since we read it»).
exec 9>/run/relik-mirror.lock
flock -n 9 || exit 0

cd "\$SRC"
# -q: не засоряем лог строкой «From github» на каждый тик таймера
for i in 1 2 3; do
  git fetch -q --depth 1 origin "\$BRANCH" 2>>"\$LOG" && break
  echo "\$(date -Iseconds) fetch failed (try \$i)" >>"\$LOG"
  sleep \$((i * 5))
done
LOCAL=\$(git rev-parse HEAD)
REMOTE=\$(git rev-parse "origin/\$BRANCH" 2>/dev/null || echo "\$LOCAL")
[ "\$LOCAL" = "\$REMOTE" ] && exit 0

git reset --hard -q "\$REMOTE" >>"\$LOG" 2>&1
mkdir -p "\$DST"
rsync -a --delete --exclude '.git' --exclude 'mobile' --exclude 'relik-desktop' "\$SRC/" "\$DST/"
echo "\$(date -Iseconds) updated to \$(git rev-parse --short HEAD)" >>"\$LOG"
EOF
chmod 755 /usr/local/bin/relik-mirror.sh

cat > /etc/systemd/system/relik-mirror.service <<'EOF'
[Unit]
Description=Relik static mirror sync
After=network-online.target
Wants=network-online.target

[Service]
Type=oneshot
ExecStart=/usr/local/bin/relik-mirror.sh
EOF

cat > /etc/systemd/system/relik-mirror.timer <<'EOF'
[Unit]
Description=Relik static mirror sync every 5 min

[Timer]
OnBootSec=60
OnUnitActiveSec=300

[Install]
WantedBy=timers.target
EOF

systemctl daemon-reload
systemctl enable --now relik-mirror.timer
/usr/local/bin/relik-mirror.sh || true
rsync -a --delete --exclude '.git' --exclude 'mobile' --exclude 'relik-desktop' "$SRC/" "$DST/"

say "Caddy"
mkdir -p /etc/caddy /var/log/caddy
sed "s/relik\.example\.ru/${DOMAIN}/g" "$SRC/scripts/Caddyfile.relik" > /etc/caddy/relik.caddy
touch /etc/caddy/Caddyfile
if ! grep -q 'relik\.caddy' /etc/caddy/Caddyfile; then
  printf '\n# Relik static mirror\nimport /etc/caddy/relik.caddy\n' >> /etc/caddy/Caddyfile
  echo "добавил import в /etc/caddy/Caddyfile"
fi
caddy validate --config /etc/caddy/Caddyfile >/dev/null
systemctl reload caddy 2>/dev/null || systemctl restart caddy
sleep 1

say "Проверка"
# Проверяем именно так, как придут люди: с правильным SNI (--resolve),
# иначе Caddy не знает, какой сертификат отдать, и соединение рвётся.
CODE="$(curl -sk -o /dev/null -w '%{http_code}' --max-time 20 --resolve "${DOMAIN}:443:127.0.0.1" "https://${DOMAIN}/index.html" || true)"
echo "локально: HTTP ${CODE}"

if [ "$CODE" != "200" ]; then
  warn "Caddy не отдал страницу. Проверьте: journalctl -u caddy -n 40 --no-pager"
  warn "Если сертификат ещё не выпущен — домен должен уже указывать на этот IP."
  exit 1
fi

cat <<EOF

Готово. Зеркало: https://${DOMAIN}/
Обновляется автоматически каждые 5 минут (systemctl list-timers relik-mirror.timer).

Как переключиться, если GitHub Pages тормозит:
  DNS → A-запись ${DOMAIN} → IP этого сервера (TTL 300), подождать 5 минут.

Что проверить после переключения:
  curl -sI https://${DOMAIN}/sw.js | grep -i cache
  https://${DOMAIN}/tools/status.html
EOF
