# Relik push & status service

Один сервис на VPS делает три вещи:

1. **Рассылает push** — забирает задачи из `public.push_queue` в Supabase
   и отправляет беззвучные уведомления участникам чата.
2. **Пишет состояние сервера** в `public.service_status` раз в минуту:
   доступность Supabase и задержка, работает ли TURN, свободное место,
   возраст последнего бэкапа, глубина очереди.
3. **Обслуживает базу ночью** — чистит старые события, мёртвые подписки
   и зависшие задачи (RPC `relik_maintenance`).

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

## SQL

Перед запуском должны быть выполнены:

- `supabase/v2_features.sql` — таблица `push_subs`, `client_events`, модерация;
- `supabase/push_queue.sql` — очередь задач;
- `supabase/service_status.sql` — метрики сервера и `relik_maintenance()`.

## Проверка

```bash
curl -s localhost:8099/healthz
# {"ok":true,"ready":true,"processed":N,"sent":M,"errors":0}

# метрики в базе
curl -s "<SUPABASE_URL>/rest/v1/service_status?select=*" \
  -H "apikey: <anon>"
```

В приложении: `tools/status.html` → блок «Сервер (VPS)».

## Что важно

- `service_role` ключ даёт полный доступ к базе. Только в env-файле, права 600.
- Наружу открыты лишь 22 (SSH) и 3478 (TURN); 80/443 не нужны.
- Перевыпускайте ключ раз в 2–3 месяца.
