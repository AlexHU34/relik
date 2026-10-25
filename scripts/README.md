# Проверки Relik

Три уровня проверки. Все запускаются **без звука**: Chrome стартует с `--mute-audio`,
страницы ничего не воспроизводят.

## 1. Предпроверка на устройстве (2 минуты)

Открой на каждом устройстве:

```
https://alexhu34.github.io/relik/tools/preflight.html
```

Проверяет: версию сайта, доступность Supabase, **TURN (ICE relay)** — главное,
микрофон, камеру, push, service worker, хранилище, сеть.

Что считать нормой:

| Строка | Норма |
|---|---|
| TURN (ICE relay) | **OK**, relay выдан (обычно 100–800 мс) |
| Микрофон | найдено ≥ 1, разрешение `granted` или `prompt` |
| Push | `granted` + «подписка есть» — после включения в настройках |
| Service worker | `activated`, кэш `relik-vX.Y.Z` |

Кнопка «Скопировать отчёт» даёт JSON — присылай его при проблемах.

## 2. Проверка TURN из браузера (автоматически)

```powershell
node scripts/ice-check.mjs
```

Запускает headless Chrome, открывает предпроверку и печатает вердикт.
Код возврата: `0` — TURN работает, `1` — нет, `2` — браузер не найден.

Полезные флаги:

```powershell
node scripts/ice-check.mjs --url http://localhost:8096/
node scripts/ice-check.mjs --port 9335 --timeout 60000
$env:CHROME_PATH='C:\Program Files\Google\Chrome\Application\chrome.exe'
```

## 3. Двухаккаунтный e2e

Демо-режим (проверяет сам харнесс, аккаунты не нужны):

```powershell
node scripts/e2e.mjs --demo --url http://localhost:8096/
```

Боевой прогон с двумя аккаунтами в **разных профилях Chrome**:

```powershell
$env:EMAIL_A='admin@example.com'
$env:PASS_A='пароль_админа'
$env:NAME_A='Admin'
$env:EMAIL_B='grandma@example.com'
$env:PASS_B='пароль_бабушки'
$env:NAME_B='Grandma'
$env:USERNAME_B='Grandma'

node scripts/e2e.mjs
```

Что проверяет:

1. вход A и B;
2. заявка в контакты A → B;
3. принятие заявки на B;
4. открытие личного чата;
5. A отправляет сообщение — B его видит;
6. B отвечает — A видит ответ.

Флаг `--keep` оставляет браузеры открытыми для разбора.

## Частые причины провала

| Симптом | Что смотреть |
|---|---|
| `TURN: relay не получен` | ufw на VPS, `systemctl status coturn`, `journalctl -u coturn` |
| вход не выполнен | неверный пароль, либо в браузере уже другая сессия |
| B не видит сообщение | `docs`: проверь статус в `tools/status.html`, realtime/RLS |
| заявка не уходит | выполнена ли `supabase/contacts.sql` |
| e2e падает на первом шаге | сайт не открылся: проверь `--url` и сеть |
