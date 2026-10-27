#!/usr/bin/env node
/* Визуальный регресс без зависимостей.
   Снимает эталонные экраны (тёмная + светлая тема, 3 устройства) и сравнивает
   хеши с базой. Изменился хеш — значит вёрстка поехала: смотрите новые PNG.

     node scripts/visual.mjs --url http://localhost:8096/ --out shots/visual/run
     node scripts/visual.mjs --url ... --update     # перезаписать базу
     node scripts/visual.mjs --url ... --check      # падать при расхождении (для CI)

   База: scripts/visual-baseline.json (хеши), PNG — в каталоге OUT.
   Требуется Chrome/Edge; в CI визуальный прогон не обязателен. */
import { mkdirSync, readFileSync, writeFileSync, existsSync } from 'node:fs';
import { createHash } from 'node:crypto';
import { join } from 'node:path';
import { launch, sleep, waitFor } from './lib/cdp.mjs';

const argv = process.argv.slice(2);
const has = (n) => argv.includes(`--${n}`);
const arg = (n, d) => {
  const i = argv.indexOf(`--${n}`);
  return i >= 0 && argv[i + 1] ? argv[i + 1] : d;
};

const BASE = arg('url', 'http://localhost:8096/').replace(/\/?$/, '/');
const OUT = arg('out', 'shots/visual/run');
const CHECK = has('check');
const UPDATE = has('update');
const BASE_FILE = 'scripts/visual-baseline.json';

const DEVICES = [
  { id: 'desktop', width: 1440, height: 900, mobile: false },
  { id: 'tablet', width: 834, height: 1112, mobile: true },
  { id: 'phone', width: 390, height: 844, mobile: true },
];

mkdirSync(OUT, { recursive: true });

/* Без живого сервера Chrome покажет свой экран ошибки, а мы снимем его как
   «регресс». Лучше упасть сразу и понятно. */
try {
  const probe = await fetch(BASE, { cache: 'no-store' });
  /* тело обязательно дочитываем: иначе undici ловит битый keep-alive
     от python http.server и падает с AssertionError уже после проверки */
  await probe.text().catch(() => '');
  if (!probe.ok) throw new Error(`HTTP ${probe.status}`);
} catch (err) {
  console.error(`Сервер не отвечает: ${BASE} (${err?.message || err})`);
  console.error('Запустите: cd relik; py -m http.server 8096');
  process.exit(2);
}

const hash = (buf) => createHash('sha256').update(buf).digest('hex').slice(0, 16);

const ctx = await launch({ port: 9334, size: [1440, 900] });
const shots = [];
let failed = 0;

/* Глушим анимации и фиксируем часы: иначе «22:45» в ленте меняет каждый
   прогон и хеши не совпадают. Экраны с живыми счётчиками помечаем volatile. */
const FIXED_TS = Date.UTC(2026, 9, 27, 12, 0, 0);
await ctx.send('Page.addScriptToEvaluateOnNewDocument', {
  source: `(function(){
    var FIXED = ${FIXED_TS};
    var Real = Date;
    function Fake(...a){ return a.length ? new Real(...a) : new Real(FIXED); }
    Fake.now = function(){ return FIXED; };
    Fake.parse = Real.parse; Fake.UTC = Real.UTC;
    Fake.prototype = Real.prototype;
    window.Date = Fake;
    document.addEventListener('DOMContentLoaded', function(){
      var s = document.createElement('style');
      s.textContent = '*,*::before,*::after{animation-duration:0s!important;animation-delay:0s!important;transition:none!important}';
      document.head.appendChild(s);
    });
  })();`,
});

const STABLE_CSS = `(function(){
  var s = document.createElement('style');
  s.textContent = '#toasts{display:none!important}.typing{display:none!important}';
  document.head.appendChild(s);
  document.querySelectorAll('#toasts').forEach(function(n){ n.remove(); });
  return true;
})()`;

async function snap(name, device, { volatile = false } = {}) {
  await ctx.device(device.width, device.height, device.mobile);
  await sleep(450);
  await ctx.evaluate(STABLE_CSS);
  await sleep(120);
  const png = await ctx.screenshot();
  if (!png) {
    console.error(`  FAIL  ${name}: пустой скриншот`);
    failed += 1;
    return;
  }
  const file = join(OUT, `${name}.png`);
  writeFileSync(file, png);
  /* volatile-экраны содержат живые числа (занятое место, счётчики) —
     снимаем их для глазами, но из сравнения хешей исключаем */
  shots.push({ name, hash: hash(png), file, volatile });
  console.log(`  OK    ${name}  ${hash(png)}  ${Math.round(png.length / 1024)} KB${volatile ? '  (volatile)' : ''}`);
}

async function loadDemo() {
  await ctx.goto(`${BASE}?demo=1`, 1400);
  /* ?demo=1 подменяет бэкенд на IndexedDB; вход — обычной формой
     (в демо принимается любой email/пароль). */
  const inApp = await ctx.evaluate(`!document.getElementById('appView')?.hidden`);
  if (!inApp) {
    await ctx.evaluate(`(function(){
      var e=document.getElementById('authEmail'), p=document.getElementById('authPass');
      if(!e||!p) return false;
      e.value='demo@relik.app';
      p.value='demo12345';
      document.getElementById('authForm').requestSubmit();
      return true;
    })()`);
    await sleep(1200);
  }
  await waitFor(ctx, `!document.getElementById('appView')?.hidden`, 25000, 500);
  /* первый запуск демо — даём сиду и анимациям устояться */
  await sleep(1200);
  const ok = await ctx.evaluate(`!document.getElementById('appView')?.hidden`);
  if (!ok) {
    const why = await ctx.evaluate(`document.querySelector('.toast')?.innerText || document.getElementById('authErr')?.innerText || ''`);
    throw new Error('вход в демо не выполнен: ' + String(why).slice(0, 160));
  }
}

try {
  await loadDemo();

  for (const d of DEVICES) {
    await snap(`app-${d.id}`, d);
  }

  /* чат: на каждом устройстве открываем первый диалог уже после ресайза —
     на телефоне список и чат это разные панели */
  for (const d of DEVICES) {
    await ctx.device(d.width, d.height, d.mobile);
    await sleep(500);
    const opened = await ctx.evaluate(`(function(){
      var row = document.querySelector('.chat-item[data-cid]');
      if (!row) return false;
      row.click();
      return true;
    })()`);
    /* на телефоне чат открывается отдельной панелью — дожидаемся её */
    if (opened) await waitFor(ctx, `!document.getElementById('chatActive')?.hidden`, 8000);
    /* демо проставляет «прочитано» по таймеру и догружает медиа — ждём,
       иначе галочки и превью попадают в кадр в разном состоянии */
    await sleep(2600);
    if (opened) await snap(`chat-${d.id}`, d, { volatile: true });
    else console.log('  SKIP  экран чата: нет чатов в демо-данных');
  }

  /* настройки */
  await ctx.device(1440, 900, false);
  await ctx.evaluate(`document.getElementById('settingsBtn')?.click()`);
  await sleep(700);
  await snap('settings-desktop', { width: 1440, height: 900, mobile: false }, { volatile: true });
  await ctx.evaluate(`document.querySelector('#settingsOv [data-close]')?.click()`);
  await sleep(300);

  /* светлая тема (равноправная: проверяем контраст и читаемость) */
  await ctx.evaluate(`localStorage.setItem('relik.theme','light')`);
  await loadDemo();
  await snap('app-light-desktop', { width: 1440, height: 900, mobile: false });
  await snap('app-light-phone', { width: 390, height: 844, mobile: true });
  await ctx.evaluate(`localStorage.removeItem('relik.theme')`);
} catch (err) {
  console.error('Визуальный прогон упал:', err?.message || err);
  failed += 1;
} finally {
  ctx.close();
}

/* Сравнение с базой */
let baseline = null;
if (existsSync(BASE_FILE)) {
  try { baseline = JSON.parse(readFileSync(BASE_FILE, 'utf8')); } catch (e) { baseline = null; }
}
const map = Object.fromEntries(shots.filter((s) => !s.volatile).map((s) => [s.name, s.hash]));

if (UPDATE) {
  mkdirSync('scripts', { recursive: true });
  writeFileSync(BASE_FILE, JSON.stringify(map, null, 2) + '\n');
  console.log(`\nБаза обновлена: ${BASE_FILE} (${shots.length} экранов)`);
} else if (baseline) {
  const changed = [];
  for (const [name, h] of Object.entries(map)) {
    if (baseline[name] && baseline[name] !== h) changed.push(name);
  }
  if (changed.length) {
    console.log(`\nИзменились экраны (${changed.length}): ${changed.join(', ')}`);
    console.log(`PNG: ${OUT}. Если это ожидаемо — обновите базу: --update`);
    if (CHECK) failed += 1;
  } else {
    console.log('\nВизуально всё совпадает с базой.');
  }
} else {
  console.log(`\nБазы нет. Создать: node scripts/visual.mjs --url ${BASE} --update`);
}

if (failed) process.exit(1);
