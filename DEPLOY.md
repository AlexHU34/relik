# Relik — Инструкция по деплою

## Предварительные требования

1. **Supabase проект** (бесплатный тариф)
   - Создайте проект на https://supabase.com
   - Выполните `supabase/schema.sql` в SQL Editor
   - Выполните `supabase/v1.4.sql` (E2E групп, Storage и настройки; или отдельные файлы из папки `supabase/`)
   - Включите Realtime для `messages` и `reactions`
   - Получите Project URL и anon key
   - Вставьте в `js/config.js`

2. **Git репозиторий**
   - Инициализируйте: `git init`
   - Добавьте файлы: `git add .`
   - Сделайте коммит: `git commit -m "Initial commit"`

## Варианты деплоя

> **Важно (Россия, без VPN):** `*.netlify.app` на многих провайдерах **замедляется до ~1–2 КБ/с**
> (TCP/TLS проходят, но тело ответа еле капает) — сайт «грузится бесконечно».
> Замеры с реальной сети без VPN: GitHub CDN — 6.4 МБ/с, Firebase Hosting — ~350 КБ/с,
> Vercel — ~176 КБ/с, Netlify (сайт) — **~1.4 КБ/с**. Cloudflare (`*.pages.dev`, `*.workers.dev`)
> вообще не открывается (таймаут соединения). Поэтому для РФ используйте **GitHub Pages** или Firebase.

### 1. GitHub Pages (рекомендуется для РФ)

**Без git, через браузер (2 минуты):**
1. github.com → New repository → имя `relik`, Public → Create.
2. «Add file» → «Upload files» → перетащите **содержимое** папки `relik`
   (`index.html`, `sw.js`, `.nojekyll`, `css/`, `js/`, `assets/`, `tools/`, `manifest.json`).
   Файл `.nojekyll` обязателен — он отключает обработку Jekyll.
3. Commit → Settings → Pages → Source: **Deploy from a branch**, Branch: `main`, Folder: `/ (root)` → Save.
4. Через 1–2 минуты сайт: `https://username.github.io/relik/`.

**Через git:**
```bash
cd C:\67\relik
git init
git add .
git commit -m "Relik"
git branch -M main
git remote add origin https://github.com/username/relik.git
git push -u origin main
```
Затем Settings → Pages → Branch `main`, Folder `/ (root)`.

> Приложение использует только относительные пути, поэтому работает и в подпапке `/relik/`.
> Не забудьте добавить новый адрес в Supabase → Authentication → URL Configuration (Site URL / Redirect URLs).

### 2. Firebase Hosting (тоже работает в РФ)

```bash
npm i -g firebase-tools
firebase login
firebase init hosting     # public directory: .  (папка relik), SPA: No
firebase deploy
```
Адрес: `https://<project>.web.app`.

### 3. Netlify (в РФ только через VPN)

```bash
npm install -g netlify-cli
cd relik
netlify deploy
```

Или через Dashboard: https://app.netlify.com → «Add new site» → «Deploy manually» → перетащите архив `relik-site-fixed.zip`.

### 4. Vercel

```bash
npm install -g vercel
cd relik
vercel
```

### 5. Обычный хостинг

Просто загрузите содержимое папки `relik` на любой хостинг с поддержкой HTTPS.

## Проверка после деплоя

1. Откройте деплоенный URL
2. Проверьте PWA:
   - В Chrome: откройте DevTools → Application → Service Workers
   - Должен быть активен service worker
3. Проверьте на мобильном:
   - Добавьте на главный экран
   - Проверьте адаптивность
4. Проверьте функциональность:
   - Регистрация
   - Отправка сообщений
   - Realtime доставка

## Environment Variables

Для деплоя на Netlify/Vercel можно использовать environment variables:

```bash
# Netlify
netlify env:set SUPABASE_URL "https://your-project.supabase.co"
netlify env:set SUPABASE_ANON_KEY "your-anon-key"

# Vercel
vercel env add SUPABASE_URL
vercel env add SUPABASE_ANON_KEY
```

Но для статического деплоя проще вставить ключи прямо в `js/config.js` перед деплоем.

##Troubleshooting

### Service Worker не работает
- Убедитесь, что сайт доступен по HTTPS
- Проверьте путь к `sw.js` в index.html
- Очистите кеш браузера

### Supabase CORS ошибка
- В Supabase Dashboard → Authentication → URL Configuration
- Добавьте ваш домен в Site URL и Redirect URLs

### Realtime не работает
- Проверьте, что Realtime включён для нужных таблиц
- Проверьте RLS политики
- Посмотрите в Console браузера

### Файлы не загружаются
- Убедитесь, что bucket `files` существует
- Проверьте RLS политики для Storage
- Проверьте размер файла (лимит 1GB на бесплатном тарифе)
