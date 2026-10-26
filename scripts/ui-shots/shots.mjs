/* РЎРєСЂРёРЅС€РѕС‚С‹ РёРЅС‚РµСЂС„РµР№СЃР° Relik РґР»СЏ UI-Р°СѓРґРёС‚Р°.
   Р—Р°РїСѓСЃРє: node shots.mjs [baseUrl]
   РќСѓР¶РµРЅ Chrome РёР»Рё Edge (РёСЃРїРѕР»СЊР·СѓРµРј СѓСЃС‚Р°РЅРѕРІР»РµРЅРЅС‹Р№, Р±РµР· СЃРєР°С‡РёРІР°РЅРёСЏ Chromium). */
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import puppeteer from 'puppeteer-core';

const BASE = process.argv[2] || 'http://localhost:8096';
const OUT = path.join(path.dirname(fileURLToPath(import.meta.url)), 'shots');
const EXE = [
  'C:/Program Files/Google/Chrome/Application/chrome.exe',
  'C:/Program Files (x86)/Microsoft/Edge/Application/msedge.exe',
].find((p) => fs.existsSync(p));

fs.mkdirSync(OUT, { recursive: true });

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

async function shot(page, name) {
  const file = path.join(OUT, `${name}.png`);
  await page.screenshot({ path: file, fullPage: false });
  console.log('shot:', file);
}

async function login(page) {
  await page.goto(`${BASE}/?demo=1`, { waitUntil: 'domcontentloaded', timeout: 60000 });
  await sleep(800);
  await page.evaluate(() => {
    const em = document.querySelector('#authEmail');
    const pw = document.querySelector('#authPass');
    if (!em || !pw) return;
    em.value = 'demo@relik.app';
    em.dispatchEvent(new Event('input', { bubbles: true }));
    pw.value = 'demo1234';
    pw.dispatchEvent(new Event('input', { bubbles: true }));
    document.querySelector('#authGo').click();
  });
  await sleep(2600);
}

const browser = await puppeteer.launch({
  executablePath: EXE,
  headless: 'new',
  args: ['--no-sandbox', '--disable-dev-shm-usage', '--lang=ru-RU', '--window-size=1440,900'],
  defaultViewport: { width: 1440, height: 900, deviceScaleFactor: 1 },
});

try {
  const page = await browser.newPage();
  await page.emulateMediaFeatures([{ name: 'prefers-color-scheme', value: 'dark' }]);

  // 1. Р­РєСЂР°РЅ РІС…РѕРґР° (РґРѕ Р»РѕРіРёРЅР°)
  await page.goto(`${BASE}/?demo=1`, { waitUntil: 'domcontentloaded', timeout: 60000 });
  await sleep(900);
  await shot(page, '01-auth-desktop');

  // 2. РћСЃРЅРѕРІРЅРѕР№ СЌРєСЂР°РЅ РїРѕСЃР»Рµ РІС…РѕРґР°
  await login(page);
  await shot(page, '02-app-desktop');

  // 3. РћС‚РєСЂС‹С‚С‹Р№ С‡Р°С‚
  await page.evaluate(() => document.querySelectorAll('.chat-item')[0]?.click());
  await sleep(900);
  await shot(page, '03-chat-desktop');

  // 4. РќР°СЃС‚СЂРѕР№РєРё
  await page.evaluate(() => document.querySelector('#settingsBtn')?.click());
  await sleep(500);
  await shot(page, '04-settings-desktop');
  await page.evaluate(() => { document.querySelector('#settingsOv').hidden = true; });

  // 5. РџР°Р»РёС‚СЂР° Ctrl+K
  await page.keyboard.down('Control');
  await page.keyboard.press('KeyK');
  await page.keyboard.up('Control');
  await sleep(500);
  await shot(page, '05-palette-desktop');
  await page.evaluate(() => { const p = document.querySelector('#paletteOv'); if (p) p.hidden = true; });

  // 6. РџСЂРѕС„РёР»СЊ СЃРѕР±РµСЃРµРґРЅРёРєР°
  await page.evaluate(() => document.querySelector('#chatWho')?.click());
  await sleep(500);
  await shot(page, '06-profile-desktop');
  await page.evaluate(() => { const p = document.querySelector('#profileOv'); if (p) p.hidden = true; });

  // 7. РўС‘РјРЅР°СЏ/СЃРІРµС‚Р»Р°СЏ С‚РµРјР°
  const light = await page.evaluate(() => {
    document.documentElement.dataset.theme = 'light';
    return document.documentElement.dataset.theme;
  });
  await sleep(400);
  await shot(page, '07-chat-light');
  await page.evaluate(() => { delete document.documentElement.dataset.theme; });

  // 8. РўРµР»РµС„РѕРЅ: РѕСЃРЅРѕРІРЅРѕР№ СЌРєСЂР°РЅ Рё С‡Р°С‚
  await page.setViewport({ width: 390, height: 844, deviceScaleFactor: 2, isMobile: true, hasTouch: true });
  await page.goto(`${BASE}/?demo=1#/app`, { waitUntil: 'domcontentloaded', timeout: 60000 });
  await sleep(2200);
  await page.evaluate(() => document.querySelectorAll('.chat-item')[0]?.click());
  await sleep(700);
  await shot(page, '08-chat-phone');

  // 9. РўРµР»РµС„РѕРЅ: РЅР°СЃС‚СЂРѕР№РєРё
  await page.evaluate(() => document.querySelector('#chatWho')?.click());
  await sleep(500);
  await shot(page, '09-profile-phone');

  // 10. РўРµР»РµС„РѕРЅ: СЌРєСЂР°РЅ РІС…РѕРґР°
  await page.evaluate(() => { location.hash = '#/auth'; });
  await sleep(700);
  await shot(page, '10-auth-phone');

  // 11. РџР»Р°РЅС€РµС‚
  await page.setViewport({ width: 768, height: 1024, deviceScaleFactor: 1 });
  await page.goto(`${BASE}/?demo=1#/app`, { waitUntil: 'domcontentloaded', timeout: 60000 });
  await sleep(2200);
  await shot(page, '11-app-tablet');
} finally {
  await browser.close();
}

console.log('Р“РѕС‚РѕРІРѕ. РџР°РїРєР°:', OUT);

