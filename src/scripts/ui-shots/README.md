# UI-скриншоты Relik

Скрипт делает набор скриншотов ключевых экранов для аудита интерфейса.
Работает через `puppeteer-core` и **уже установленный** Chrome или Edge —
Chromium не скачивается.

## Запуск

```powershell
# 1. Поднять сайт
cd C:\67\relik
py -m http.server 8096

# 2. Поставить зависимость (один раз)
cd scripts\ui-shots
npm install

# 3. Снять скриншоты
npm run shots
```

Результат — `scripts/ui-shots/shots/*.png`:

| Файл | Экран |
|---|---|
| `01-auth-desktop.png` | вход, ПК |
| `02-app-desktop.png` | список чатов, ПК |
| `03-chat-desktop.png` | чат, ПК |
| `04-settings-desktop.png` | настройки |
| `05-palette-desktop.png` | палитра Ctrl+K |
| `06-profile-desktop.png` | профиль собеседника |
| `07-chat-light.png` | светлая тема |
| `08-chat-phone.png` | чат, iPhone 390×844 |
| `09-profile-phone.png` | профиль, телефон |
| `10-auth-phone.png` | вход/профиль, телефон |
| `11-app-tablet.png` | планшет 768×1024 |

Скрипт сам входит в демо-режим (`?demo=1`, `demo@relik.app` / `demo1234`).

## Свой адрес

```powershell
node shots.mjs https://alexhu34.github.io/relik
```

## Как использовать для итераций

1. Снять скриншоты → 2. найти проблемы (свои + чужие замечания) →
3. поправить CSS/JS → 4. снять заново → 5. сравнить `03`, `08` и `04`.

Скриншоты и `node_modules` в репозиторий не попадают (см. `.gitignore`).
