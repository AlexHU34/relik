# Relik push & status service

Один сервис на VPS делает четыре вещи:

1. **Рассылает push** — забирает задачи из `public.push_queue` в Supabase
   и отправляет беззвучные уведомления участникам чата.
2. **Проверяет сервис** (раз в минуту): сайт на GitHub Pages, Auth, REST,
   Storage, Realtime (настоящий WebSocket) и TURN. Два сбоя подряд — алерт
   в Telegram, восстановление — второе сообщение.
3. **Пишет состояние** в `public.service_status` (последний срез) и в
   `public.service_samples` (история раз в 5 минут — для честного процента
   доступности в `tools/status.html`).
4. **Обслуживает базу ночью** — чистит старые события, мёртвые подписки,
   зависшие задачи и историю старше 30 дней (RPC `relik_maintenance`).

Входящий HTTPS **не нужен**: сервис сам ходит в Supabase по service-ключу.
Слушает только `127.0.0.1:8099` для `/healthz`.

## Установка

```bash
apt update && apt install -y nodejs npm
mkdir -p /opt/relik-push && cd /opt/relik-push
# скопировать сюда index.js и package.json
npm config set registry https://registry.npmmirror.com
npm install --omit=dev
```

`/etc/relik-push.env` (chmod 600):

```ini
SUPABASE_URL=https://<project>.supabase.co
SUPABASE_SERVICE_KEY=<service_role / sb_secret_...>
VAPID_PUBLIC=<публичный VAPID>
VAPID_PRIVATE=<приватный VAPID>
VAPID_SUBJECT=mailto:you@example.com
PORT=8099
INTERVAL=3000

# Мониторинг (необязательно, но именно он даёт «99%»)
SUPABASE_ANON_KEY=sb_publishable_...
TELEGRAM_BOT_TOKEN=123456789:AA...
TELEGRAM_CHAT_ID=123456789
ALERT_AFTER=2
MONITOR_INTERVAL=60000
# MONITOR=0                       # выключить проверки
# MONITOR_FRONT=https://alexhu34.github.io/relik/index.html
```

`/etc/systemd/system/relik-push.service`:

```ini
[Unit]
Description=Relik push sender
After=network-online.target
Wants=network-online.target

[Service]
EnvironmentFile=/etc/relik-push.env
ExecStart=/usr/bin/node /opt/relik-push/index.js
Restart=always
RestartSec=3
User=www-data
NoNewPrivileges=true
ProtectSystem=strict
PrivateTmp=true

[Install]
WantedBy=multi-user.target
```

```bash
systemctl daemon-reload && systemctl enable --now relik-push
curl -s localhost:8099/healthz
```

`scripts/vps.sh` дополнительно ставит watchdog: если `relik-push` или `coturn`
упали, они поднимаются в течение минуты (`/usr/local/bin/relik-watchdog.sh`).

## SQL

Перед запуском должны быть выполнены:

- `supabase/v2_features.sql` — таблица `push_subs`, `client_events`, модерация;
- `supabase/push_queue.sql` — очередь задач;
- `supabase/service_status.sql` — метрики сервера и `relik_maintenance()`;
- `supabase/service_uptime.sql` — расширенные поля статуса и история
  `service_samples` (без него мониторинг работает, истории и процента нет).

## Проверка

```bash
curl -s localhost:8099/healthz
# {"ok":true,"ready":true,...,"uptime24h":99.8,"checks":{"front":{"ok":true,...},...}}

# метрики в базе
curl -s "<SUPABASE_URL>/rest/v1/service_status?select=*" \
  -H "apikey: <anon>"

# история доступности
curl -s "<SUPABASE_URL>/rest/v1/service_samples?select=ts,ok,rest_ms&order=ts.desc&limit=10" \
  -H "apikey: <anon>"
```

В приложении: `tools/status.html` → блок «Сервер (VPS)» и «Доступность за 24 часа».
Алерты: Telegram (см. `OPS.md`, раздел 4.1).

## Что важно

- `service_role` ключ даёт полный доступ к базе. Только в env-файле, права 600.
- Наружу открыты лишь 22 (SSH) и 3478 (TURN); 80/443 не нужны.
- Перевыпускайте ключ раз в 2–3 месяца.
- `TELEGRAM_*` необязательны: без них проверки и история работают, но алертов нет.
- Мониторинг не может сообщить о падении самого VPS — для этого нужен внешний
  наблюдатель (`OPS.md`, 4.3).
