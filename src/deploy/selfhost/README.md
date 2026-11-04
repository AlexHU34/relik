# Переезд бэкенда на свой VPS (self-hosted Supabase)

Готовый комплект: `docker-compose.yml`, `.env.example`, `Caddyfile.snippet`.
Нужен из-за сети: из РФ запросы к `*.supabase.co` рвутся (`ERR_CONNECTION_RESET`,
`WebSocket handshake timeout`), а задержка до eu-west-1 — 68 мс на round trip.

## 0. Что должно быть на сервере

| Параметр | Минимум | Откуда |
|---|---|---|
| RAM | **4 ГБ** | стек Supabase ~2.5 ГБ + Caddy/coturn/push/mail |
| Диск | **40 ГБ** свободно | база + объекты бакета + 14 дней дампов |
| Docker | 24+ с compose v2 | `curl -fsSL https://get.docker.com \| sh` |
| Домен | `relik.best` уже указывает сюда | ничего менять не нужно |

Проверка: `free -m`, `df -h /`, `docker --version`.

## 1. Подготовка (до переключения)

```bash
# свежий дамп боевой базы и его проверка
/usr/local/bin/relik-backup
ls -1t /var/backups/relik/*.gz | head -1
pg_restore --list "$(ls -1t /var/backups/relik/*.gz | head -1 | sed 's/\.gz$//')" >/dev/null
```

Список объектов бакета `files` (пригодится для переноса медиа):

```bash
cd /opt && /usr/bin/env python3 /root/relik/copy_storage.py --list > /root/storage-list.txt
```

## 2. Запуск стека

```bash
mkdir -p /opt/relik-supabase && cd /opt/relik-supabase
cp /root/relik/deploy/selfhost/docker-compose.yml .
cp /root/relik/deploy/selfhost/.env.example .env
chmod 600 .env
# заполнить .env (JWT_SECRET, ключи, пароль БД), см. комментарии в файле
docker compose pull
docker compose up -d
docker compose ps          # db должен быть healthy
```

Health-проверки (локально, до Caddy):

```bash
curl -s -o /dev/null -w "auth %{http_code}\n"  http://127.0.0.1:9999/health
curl -s -o /dev/null -w "rest %{http_code}\n"  http://127.0.0.1:3000/
curl -s -o /dev/null -w "store %{http_code}\n" http://127.0.0.1:5000/status
```

## 3. Перенос данных

```bash
gunzip -c /var/backups/relik/<последний>.gz > /tmp/relik.dump
docker compose exec -T db pg_restore \
  --no-owner --no-privileges --no-comments \
  -U postgres -d postgres < /tmp/relik.dump
```

Важно: дамп содержит схемы `auth`, `public`, `storage`. Роли (`anon`,
`authenticated`, `service_role`, `supabase_auth_admin`, `supabase_storage_admin`)
создаёт сам образ `supabase/postgres` — `--no-owner` их не трогает.

Если `pg_restore` ругается на уже существующие объекты — это нормально при
повторном прогоне: добавьте `--clean --if-exists`.

Медиа (объекты бакета `files` в дамп БД не попадают):

```bash
python3 /root/relik/copy_storage.py --all   # скачивает из старого проекта и грузит в новый
```

## 4. Переключение (окно ~5 минут)

1. Вставить блок из `Caddyfile.snippet` в сайт `relik.best`.
2. `caddy validate --config /etc/caddy/Caddyfile && systemctl reload caddy`.
3. Проверить: `curl -s https://relik.best/auth/v1/health`, затем приложение.

Клиент менять не нужно: `js/config.js` уже указывает на `https://relik.best`.

## 5. Проверки после переключения

- вход тестовым аккаунтом, отправка/получение сообщения;
- открытие старой переписки (расшифровка v1) и старого фото (Storage);
- `tools/health.html`, `tools/status.html`;
- звонок (coturn остаётся на этом сервере);
- `docker compose logs --tail=50 auth rest realtime storage` — без ошибок.

## 6. Бэкапы и откат

- `relik-backup` переключить на локальную базу: `PGHOST=127.0.0.1` в
  `/etc/relik-backup.env` (пароль — `POSTGRES_PASSWORD`). Офсайт-копия
  (`secrets/pull_backup.py`) продолжает работать как есть.
- Откат за 2 минуты: убрать блок `/auth|/rest|/realtime|/storage` из Caddy и
  вернуть `SERVER_URL`/ключи старого проекта в `js/config.js` (или просто
  `systemctl reload caddy` до старого конфига). Старый проект Supabase **не
  удалять 30 дней** — это и есть откат.

## 7. Что учесть

- **JWT_SECRET**: если взять секрет прежнего проекта — сессии не слетят.
  Новый секрет = все входят заново (одноразово).
- **Realtime**: контейнер `realtime` публикует таблицу `messages` сам
  (`SEED_SELF_HOST=true`); если realtime не поднимается — приложение всё равно
  работает на опросе (догон каждые 4–15 с).
- **Медиа**: после переноса `storage.objects` и файлов старые фото открываются;
  ключи шифрования едут внутри сообщений, менять ничего не надо.
- **Память**: если сервер 2 ГБ — storage и realtime начнут вытесняться swap;
  минимум 4 ГБ не случайность.
