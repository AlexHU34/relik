# Деплой Relik

Актуально для 1.30+. Сайт — статика, но **собирается**: на GitHub Pages уезжает `dist/`, а не исходники.

## Что нужно

- Node.js 20+ (проверено на 24; CI и `.nvmrc` — 22). Для воспроизводимых сборок держите тот же мажор Node, что в `.nvmrc`, и не удаляйте `package-lock.json`.
- Проект Supabase (URL + publishable/anon key в `js/config.js`).
- Репозиторий GitHub и включённый Pages: **Settings → Pages → Deploy from a branch → `main` / `/ (root)`**.
- `.nojekyll` в корне сайта (сборка копирует его сама).

## Локально

```powershell
cd C:\67\relik
npm ci                 # один раз / после изменения package-lock.json
npm run dev            # dev-сервер Vite с HMR
node scripts/build.mjs # собрать dist/
node scripts/check-all.mjs   # тесты, типы, линтер, бюджеты
```

Проверка собранного:

```powershell
node scripts/check-dist.mjs                       # ASSETS, 404, CSP, размер критического пути
node scripts/reproducible.mjs                     # две сборки подряд → хеши совпадают
py -m http.server 8100 --directory dist           # локальный «прод»
node scripts/e2e.mjs --demo --url http://localhost:8100/
```

## Публикация

```powershell
powershell -ExecutionPolicy Bypass -File C:\67\publish-github.ps1 "что изменилось"
```

Скрипт делает всё сам:

1. быстрые проверки (`check-assets`, `check-i18n`, `check-csp`, `check-size`, юнит-тесты);
2. `node scripts/build.mjs` — Vite-сборка в `dist/`;
3. `node scripts/check-dist.mjs` — если сборка битая, деплой не начнётся;
4. чистит в `C:\67\relik-github` прошлые артефакты сайта;
5. копирует `dist/` в корень зеркала, а исходники — в `src/`;
6. коммитит и пушит в `github.com/AlexHU34/relik` (`main`).

Через ~1 минуту: <https://relik.best/>.
Проверка: `sw.js` → `const VER = 'relik-vX.Y.Z'`, `index.html` → `assets/index-<hash>.js` (200).

## Как устроен репозиторий

```
/            ← собранный сайт (index.html, assets/, js/vendor, sw.js, tools/)
/src         ← исходники (js/, css/, scripts/, supabase/, package.json, .github/)
/.github     ← workflow Checks (запускается в src/)
```

- Pages отдаёт **корень**.
- CI (`Checks`) выполняет `npm ci`, `check-all`, сборку, `check-dist` и UI-смоук **в `src/`**.
- Менять код нужно только в `C:\67\relik`; `relik-github` — зеркало, руками не правим.

## Проверка целостности после деплоя

```powershell
node scripts/verify-live.mjs https://relik.best/
```

Скрипт скачивает `integrity.json` (манифест SHA-256 всех файлов сборки) и сверяет
каждый файл на сервере. Ловит подмену JS, битый деплой и залипший кэш.
В `index.html` у вендорного `supabase.js` стоит SRI: если файл изменят,
браузер откажется его выполнять.

## Воспроизводимость сборки

```powershell
node scripts/reproducible.mjs   # npm run check:repro
```

Дважды собирает проект с нуля (с `TZ=UTC`) и сравнивает SHA-256 всех 48 файлов
из `integrity.json`. `check:repro` входит в CI, поэтому «плавающая» сборка
(время в файле, `Math.random`, порядок обхода каталога) не пройдёт проверку.
Для повторяемости между машинами нужны одинаковый мажор Node (`.nvmrc` = 22)
и неизменённый `package-lock.json`.

## Почта и SMTP (письма Supabase)

Домен `relik.best` обслуживается в Beget (раздел **Почта**). Свой SMTP нужен,
чтобы письма подтверждения и сброса пароля не уходили в спам и не упирались
в лимит бесплатного SMTP Supabase.

1. В панели Beget → Почта → создать ящик (`no-reply@relik.best` или `support@relik.best`),
   пароль сгенерировать кнопкой и сохранить в менеджере паролей.
2. Supabase → **Authentication → Emails → SMTP Settings**: host `smtp.beget.com`,
   port `465` (SSL) или `587` (STARTTLS), username — полный адрес ящика,
   password — пароль ящика, sender — тот же адрес.
3. Проверить: Authentication → Users → «Send password recovery» на тестовый адрес.
4. Пароль ящика **не** хранить в репозитории и не присылать в чат — только в панели Supabase.

**Текущее состояние (проверено 01.11.2026):** ящик `support@relik.best` создан, SMTP
`smtp.beget.com:465` проверен прямым подключением (AUTH OK, письмо доставлено),
SPF `v=spf1 redirect=beget.com` работает. DKIM **не включён** — в панели Beget
переключателя нет; при необходимости включается через поддержку Beget
(нужна TXT-запись `beget._domainkey.relik.best`). Без DKIM письма доходят,
но у Gmail выше шанс попасть в «Спам».

## Откат

- Быстро: `cd C:\67\relik-github; git revert HEAD; git push`.
- Полностью: в `C:\67\relik` есть история и теги (`git log`, `git tag`), можно собрать старый коммит и опубликовать.

## Версия

Поднимать в трёх местах одновременно:

- `js/config.js` → `APP.version`
- `sw.js` → `const VER = 'relik-vX.Y.Z'`
- `package.json` / `version.json`

`scripts/check-assets.mjs` предупредит, если `VER` и `APP.version` разошлись — забытый bump ломает обновление у людей.

## Если что-то пошло не так

| Симптом | Причина |
|---|---|
| На сайте старый код | не собрали `dist/` или закешировался service worker: обновите страницу дважды, проверьте `VER` |
| Пустой экран, в консоли CSP | правили inline-скрипт в `index.html` — обновите хеш (`node scripts/check-csp.mjs` подскажет) |
| 404 на `assets/*.js` | деплой скопировал старый `index.html`; пересоберите и опубликуйте снова |
| GitHub Actions красный | смотрите лог шага; локально те же проверки: `node scripts/check-all.mjs` |
| Netlify/Vercel | оставлены как резерв (`netlify.toml`, `vercel.json`), но в РФ Netlify практически не работает без VPN |

## Supabase

SQL-миграции — в `supabase/migrations/` (применять по порядку, см. `README.md` там же). Исторические файлы из `supabase/*.sql` уже применены на боевой базе.
