# Архитектура Relik (после разреза монолитов)

Документ описывает, **где что лежит** и **как модули общаются**. Актуален для 1.40+.

## Слои

```
js/
  config.js          константы, ключи Supabase, флаги (CRYPTO_V2)
  main.js            точка входа: тема, язык, экран входа (~120 строк)
  boot/
    auth.js          экран входа, регистрация, код доступа, верификация
    runtime.js       плашка сети, обновление SW, обслуживание хранилища, bootDone
    app.js           ПРИЛОЖЕНИЕ (грузится динамически после входа): чат, сайдбар,
                     модалки, realtime, восстановление сессии
  core/
    outbox.js        ЧИСТАЯ логика очереди исходящих (состояния, backoff, dedupe)
  ui/
    state.js         глобальное состояние S + шина событий
    utils.js         $, esc, форматирование, аватары
    router.js        hash-роутер
    sidebar.js       список чатов, папки, поиск по чатам
    chatView.js      контроллер экрана чата (~1500): init, openChat, realtime, renderMessages
    chat/            фичи экрана чата
      render.js        HTML пузыря/медиа/реакций/опросов (чистые функции)
      receipts.js      прочтения и ✓✓
      ttl.js           исчезающие сообщения
      forward.js       пересылка
      profile.js       карточка, отпечаток, QR, жалоба, медиа-галерея
      select.js        режим выбора нескольких сообщений
      voice.js         воспроизведение голосовых
    composer.js      поле ввода (~720)
    composer/        отправка и медиа
      retry.js         ретраи и outbox
      media.js         сжатие, шифрование, загрузка
      scheduled.js     отложенные
      polls.js         опросы и реакции
    modals.js        окна: новый чат, группа, люди, поиск (~700)
    modals/
      settings.js      настройки
      group.js         управление группой
      contacts.js      контакты, заявки, люди
      lightbox.js      просмотр медиа
      shared.js        closeOv, mergeUsers
  backend/           Supabase: auth, chats, messages, storage, groups, keystore…
                     sdk.js — ленивая загрузка supabase-js (213 КБ) после первого экрана;
                     supabaseClient.js — ensureClient() и один клиент на вкладку;
                     net.js — таймауты, повтор сетевых ошибок, тексты ошибок входа
  crypto/            v1 (ECDH+AES) и v2 (X3DH + Double Ratchet)
  db/                IndexedDB: сообщения, чаты, медиа-кэш, сжатие истории
```

## Правила

1. **Никаких циклических импортов через `chatView`.** Если фиче нужна функция экрана
   (`renderMessages`, `byId`, `els`), она получает её через `bind*Hooks`:

   ```js
   // chat/select.js
   let hooks = { getEls: () => ({}), renderMessages: () => {} };
   export function bindSelectHooks(next) { hooks = { ...hooks, ...next }; }

   // chatView.js
   bindSelectHooks({ getEls: () => els, renderMessages: () => renderMessages() });
   ```

2. **Чистая логика — отдельно от DOM.** Что можно посчитать без браузера
   (`core/outbox.js`, `ui/msgWindow.js`, `chat/render.js`), живёт без `document`
   и покрыто тестами (`scripts/test.mjs`).

3. **Один модуль — одна причина для изменения.** Лимит 400 строк проверяет
   `scripts/check-size.mjs`; легаси-файлы закреплены на текущем размере и не могут расти.

4. **Новый ассет → `sw.js` `ASSETS` + поднять `VER`.** Проверяется `check-assets.mjs` и CI.

5. **Сборка обязательна.** `dist/` собирает Vite (`scripts/build.mjs`), там же
   чинится PWA-манифест. Деплой идёт из `dist/` (`publish-github.ps1`).

## Как ходит сообщение
**Отправка:** `composer.sendCurrent` → `backend/messages.sendMessage` (шифрование v1/v2) →
Supabase → локальная копия в IndexedDB → `chatView.deliverMessage` → `appendToFeed` или
`renderMessages`.

**Приём:** realtime `subscribeToChat` / `subscribeAllMessages` → `mergeMessages` (дедуп по id) →
`deliverMessage` → точечные апдейты (`refreshTicks`, `refreshMessageReactions`,
`refreshPollCard`) вместо полной перерисовки.

**Ретраи:** `composer/retry.js` берёт кандидатов через `core/outbox.pickDue` (backoff,
потолок 24 ч), повторяет отправку, дубликат по `messages.id` считается успехом.

## Как добавить фичу

1. Если это чистая логика — новый модуль в `core/` или рядом с фичей, плюс тест.
2. Если это часть экрана — `ui/chat/<фича>.js` с `bind<Фича>Hooks` для DOM-функций.
3. Если нужен новый DOM-элемент — `index.html` + `sw.js` `ASSETS` + `VER`.
4. Прогнать `node scripts/check-all.mjs`, затем `node scripts/build.mjs`, затем e2e.
5. Задеплоить `publish-github.ps1` и проверить `sw.js`/чанк на живом сайте.

## Где смотреть дальше

- Остаток разреза: `chatView.js` (`initChatView`, `openChat`, `renderMessages`) — 1512 строк.
- Производительность: виртуализация ленты, ленивая загрузка оболочки.
- Крипто: включение v2 после теста на двух устройствах (`CRYPTO-V2.md`).
- Эксплуатация: `OPS.md`, `DEPLOY.md`, `PLAN-10X.md` (план и KPI).
