# Relik push service

Отправляет браузерные уведомления, когда приложение закрыто.
Клиент присылает `POST /notify` после успешной отправки сообщения; текст
сообщения на сервер **не передаётся** — уведомление беззвучное («Новое сообщение»).

## Что нужно

1. **service_role ключ Supabase** (Dashboard → Project Settings → API → `service_role`).
   Он секретный: только на сервере, в `/etc/relik-push.env`, никогда в клиенте.
2. Node.js 18+ на VPS.
3. Домен для HTTPS: используется `nip.io`, он сам резолвится в ваш IP
   (например `62-113-99-46.nip.io`).

## Установка на VPS

```bash
apt update && apt install -y nodejs npm caddy
mkdir -p /opt/relik-push && cd /opt/relik-push
# скопируйте сюда package.json и index.js из scripts/push-service
npm config set registry https://registry.npmmirror.com
npm install --omit=dev
```

`/etc/relik-push.env` (root:root, 600):

```ini
SUPABASE_URL=https://<project>.supabase.co
SUPABASE_ANON_KEY=<anon>
SUPABASE_SERVICE_KEY=<service_role>
VAPID_PUBLIC=<публичный ключ>
VAPID_PRIVATE=<приватный ключ>
VAPID_SUBJECT=mailto:you@example.com
PORT=8099
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
systemctl daemon-reload
systemctl enable --now relik-push
curl -s localhost:8099/healthz
```

`/etc/caddy/Caddyfile`:

```
62-113-99-46.nip.io {
    reverse_proxy 127.0.0.1:8099
}
```

```bash
ufw allow 80/tcp
ufw allow 443/tcp
systemctl reload caddy
curl -s https://62-113-99-46.nip.io/healthz
```

После этого в `js/config.js`:

```js
export const PUSH = {
  publicKey: '...',
  endpoint: 'https://62-113-99-46.nip.io/notify',
};
```

## Проверка

1. В приложении: Настройки → «Push при закрытом приложении» → включить, разрешить уведомления.
2. Закрыть вкладку/приложение.
3. Отправить сообщение со второго аккаунта.
4. Должно прийти уведомление; клик открывает нужный чат.

Если не приходит: `journalctl -u relik-push -n 50 --no-pager` и `curl -s localhost:8099/healthz`.
