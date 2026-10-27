#!/usr/bin/env node
/* Relik — перекачать локальный Inter с Google Fonts.
   Нужен только при обновлении шрифта: обычная работа сайта сеть Google не трогает.

   Запуск (из папки relik):
     node scripts/fetch-fonts.mjs

   Что делает:
   - забирает css2?family=Inter:wght@400..800 для современного Chrome (отдаёт woff2);
   - оставляет подмножества cyrillic / latin (+ ext), потому что в приложении
     только русский и английский, а лишние файлы — это лишние 100+ КБ;
   - кладёт файлы в assets/fonts/inter-*.woff2;
   - перегенерирует css/fonts.css.

   После обновления: поднять VER в sw.js, чтобы старый кэш удалился. */
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const OUT_FONT = path.join(ROOT, 'assets', 'fonts');
const OUT_CSS = path.join(ROOT, 'css', 'fonts.css');
const UA = 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/131.0.0.0 Safari/537.36';
const WANTED = ['cyrillic-ext', 'cyrillic', 'latin-ext', 'latin'];
const CSS_URL = 'https://fonts.googleapis.com/css2?family=Inter:wght@400..800&display=swap';

const css = await (await fetch(CSS_URL, { headers: { 'User-Agent': UA } })).text();
const blocks = [...css.matchAll(/\/\*\s*([\w-]+)\s*\*\/\s*@font-face\s*\{([\s\S]*?)\}/g)]
  .map((m) => ({ subset: m[1], body: m[2] }));
if (!blocks.length) throw new Error('Google Fonts вернул CSS без @font-face');

fs.mkdirSync(OUT_FONT, { recursive: true });
const parts = [];
for (const b of blocks) {
  if (!WANTED.includes(b.subset)) continue;
  const url = (b.body.match(/url\((https:[^)]+)\)/) || [])[1];
  const range = (b.body.match(/unicode-range:\s*([^;]+);/) || [])[1];
  if (!url || !range) continue;
  const res = await fetch(url, { headers: { 'User-Agent': UA } });
  if (!res.ok) throw new Error(`${b.subset}: HTTP ${res.status}`);
  const buf = Buffer.from(await res.arrayBuffer());
  const name = `inter-${b.subset}.woff2`;
  fs.writeFileSync(path.join(OUT_FONT, name), buf);
  console.log(`${name}  ${(buf.length / 1024).toFixed(1)} KB`);
  parts.push({ name, range: range.trim() });
}
if (!parts.length) throw new Error('ни одного подмножества не скачали');

const header = `/* Relik — Inter (шрифт по умолчанию) лежит локально.
   Зачем: fonts.googleapis.com в РФ бывает медленным или недоступен, а это
   два лишних DNS+TLS хендшейка в критическом пути первой отрисовки.
   Файлы — вариативный Inter 400..800 (OFL-1.1), подмножества cyr/lat.
   Обновить: node scripts/fetch-fonts.mjs (перекачивает с Google Fonts). */
`;
const out = header + parts.map((p) => `/* ${p.name} */
@font-face {
  font-family: 'Inter';
  font-style: normal;
  font-weight: 400 800;
  font-display: swap;
  src: url('../assets/fonts/${p.name}') format('woff2');
  unicode-range: ${p.range};
}`).join('\n') + '\n';
fs.writeFileSync(OUT_CSS, out, 'utf8');
console.log(`css/fonts.css обновлён (${(out.length / 1024).toFixed(1)} KB)`);
