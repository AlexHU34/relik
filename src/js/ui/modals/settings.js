/* Relik — окно настроек: профиль, темы, шрифты, обои, данные, PIN.
   Вынесено из modals.js: свой импорт-лист и локальный closeOv. */
import { S } from '../state.js';
import { $, esc, fmtSize, safeImgSrc } from '../utils.js';
import { t, lang } from '../../i18n/i18n.js';
import { idb } from '../../db/idb.js';
import { APP, SUPABASE } from '../../config.js';
import { toast } from '../toast.js';
import { renderSidebar, loadChats } from '../sidebar.js';
import { updateProfile, saveAvatar, normalizeUsername, isValidUsername, isUsernameTaken, hasUsernameColumn } from '../../backend/auth.js';
import { THEMES, currentTheme } from '../themes.js';
import { FONTS, currentFontId } from '../fonts.js';
import { soundsEnabled } from '../sounds.js';
import { notificationsEnabled } from '../notify.js';
import { prefs, WALLPAPERS, ACCENTS } from '../prefs.js';
import { confirmAction } from '../dialog.js';
import { canInstall } from '../install.js';
import { hasPin } from '../pin.js';
import { hasGroupKeysTable } from '../../backend/groupKeys.js';
import { storageAvailable, clearMediaObjectUrls } from '../../backend/storage.js';
import { mediaStats, storageEstimate, persistedStorage, ensurePersistentStorage, clearMediaCache, MEDIA_MAX_BYTES } from '../../db/mediaCache.js';
import { refreshKeyStatus } from '../keyRecovery.js';

/* ── НАСТРОЙКИ ── */
export function openSettings() {
  $('#nameInput').value = S.me?.name || '';
  $('#usernameInput').value = S.me?.username || '';
  paintProfileDirty();
  $('#verStr').textContent = `v${APP.version} · ${APP.phase}`;
  paintLangSeg();
  paintThemes();
  paintFonts();
  paintTextSize();
  paintWalls();
  paintAccents();
  $('#soundsToggle').checked = soundsEnabled();
  $('#notifyToggle').checked = notificationsEnabled();
  paintPinSettings();
  const installBtn = $('#installBtn');
  if (installBtn) installBtn.hidden = !canInstall();
  $('#enterSendToggle').checked = prefs.enterToSend !== false;
  $('#motionToggle').checked = prefs.motion !== false;
  $('#hideOnlineToggle').checked = prefs.hideOnline === true;
  const allBtn = $('#logoutAllBtn');
  if (allBtn) allBtn.hidden = !(SUPABASE.url && SUPABASE.anonKey);
  paintAvatar();
  paintMigrationStatus();
  paintStorage();
  refreshKeyStatus();
  const body = $('#settingsOv .m-body');
  if (body) { body.scrollTop = 0; body.dataset.atTop = '1'; }
  paintSecNav();
  $('#settingsOv').hidden = false;
}

/* Активный раздел в прилипшей панели: пониматно, где ты находишься,
   и не нужно возвращаться к началу длинного списка. */
export function paintSecNav(activeTarget = null) {
  const nav = $('#secNav');
  if (!nav) return;
  const buttons = [...nav.querySelectorAll('[data-target]')];
  if (!buttons.length) return;
  const current = activeTarget || buttons[0].dataset.target;
  for (const b of buttons) {
    const on = b.dataset.target === current;
    b.classList.toggle('on', on);
    b.setAttribute('aria-current', on ? 'true' : 'false');
  }
}

export async function paintMigrationStatus() {
  const el = $('#migrationStatus');
  if (!el) return;
  if (!(SUPABASE.url && SUPABASE.anonKey)) {
    el.textContent = t('settings.migrDemo');
    return;
  }
  el.textContent = t('settings.migrChecking');
  try {
    const [groups, files] = await Promise.all([hasGroupKeysTable(), storageAvailable()]);
    el.textContent = `${t('settings.migrGroups')}: ${t(groups ? 'settings.on' : 'settings.off')} · `
      + `${t('settings.migrFiles')}: ${t(files ? 'settings.on' : 'settings.off')}`;
  } catch (e) {
    el.textContent = t('settings.migrError');
  }
}

/* ── Хранилище: занятое место, защита от очистки, медиа-кэш ── */
let storagePaintToken = 0;

export async function paintStorage() {
  const field = $('#storageField');
  if (!field) return;
  const token = ++storagePaintToken;
  const stateEl = $('#storageState');
  if (stateEl) {
    stateEl.textContent = t('people.loading');
    stateEl.className = 'storage-state';
  }
  const [stats, est, persisted] = await Promise.all([
    mediaStats().catch(() => ({ count: 0, bytes: 0 })),
    storageEstimate().catch(() => ({ usage: 0, quota: 0 })),
    persistedStorage().catch(() => false),
  ]);
  if (token !== storagePaintToken) return;

  const quota = est.quota || 0;
  const used = est.usage || 0;
  const pct = quota
    ? Math.min(100, Math.round((used / quota) * 100))
    : Math.min(100, Math.round((stats.bytes / MEDIA_MAX_BYTES) * 100));

  const fill = $('#storageBarFill');
  if (fill) {
    fill.style.width = `${Math.max(stats.count || used ? 2 : 0, pct)}%`;
    fill.classList.toggle('warn', pct >= 80);
  }
  const pctEl = $('#storagePct');
  if (pctEl) {
    pctEl.textContent = !quota && !stats.count
      ? '—'
      : (pct === 0 && (used > 0 || stats.bytes > 0) ? '<1%' : `${pct}%`);
  }

  if (stateEl) {
    stateEl.textContent = t(persisted ? 'storage.persisted' : 'storage.eviction');
    stateEl.className = 'storage-state ' + (persisted ? 'ok' : 'warn');
  }
  const meta = $('#storageMeta');
  if (meta) {
    meta.textContent = quota
      ? t('storage.meta')
        .replace('{n}', String(stats.count))
        .replace('{media}', fmtSize(stats.bytes))
        .replace('{used}', fmtSize(used))
        .replace('{quota}', fmtSize(quota))
      : t('storage.metaUnknown')
        .replace('{n}', String(stats.count))
        .replace('{media}', fmtSize(stats.bytes));
  }

  const persistBtn = $('#storagePersistBtn');
  if (persistBtn) persistBtn.hidden = !!persisted || !navigator.storage?.persist;
}

export async function askPersistentStorage() {
  const btn = $('#storagePersistBtn');
  if (btn) btn.disabled = true;
  try {
    const ok = await ensurePersistentStorage();
    toast(t(ok ? 'storage.persistedToast' : 'storage.persistDenied'), { type: ok ? 'success' : 'warn' });
  } finally {
    if (btn) btn.disabled = false;
    paintStorage();
  }
}

export async function clearStorageCache() {
  const stats = await mediaStats().catch(() => ({ count: 0, bytes: 0 }));
  if (!stats.count) {
    toast(t('storage.empty'));
    return;
  }
  const ok = await confirmAction({
    title: t('storage.clear'),
    text: t('storage.clearText'),
    ok: t('storage.clearOk'),
    danger: true,
    iconName: 'hardDrive',
  });
  if (!ok) return;
  await clearMediaCache();
  toast(t('storage.cleared'), { type: 'success' });
  paintStorage();
}

/* Сжатие истории: сообщения в IndexedDB раньше росли вечно и упирались
   в квоту браузера. Серверная история остаётся — она догружается страницами. */
export async function compactHistory() {
  const { messageStats, compactMessages, KEEP_PER_CHAT, OLDER_THAN_DAYS } =
    await import('../../db/compaction.js');
  const stats = await messageStats().catch(() => ({ total: 0, chats: 0 }));
  const ok = await confirmAction({
    title: t('storage.compactTitle'),
    text: t('storage.compactText')
      .replace('{n}', String(stats.total))
      .replace('{keep}', String(KEEP_PER_CHAT))
      .replace('{days}', String(OLDER_THAN_DAYS)),
    ok: t('storage.compactOk'),
    iconName: 'hardDrive',
  });
  if (!ok) return;
  const { removed } = await compactMessages().catch(() => ({ removed: 0 }));
  toast(removed
    ? t('storage.compactDone').replace('{n}', String(removed))
    : t('storage.compactNothing'), { type: removed ? 'success' : undefined });
  paintStorage();
}

export function paintPinSettings() {
  const on = hasPin();
  const toggle = $('#pinToggle');
  if (toggle) toggle.checked = on;
  const btn = $('#pinChangeBtn');
  if (btn) btn.hidden = !on;
  const lockBtn = $('#pinLockBtn');
  if (lockBtn) lockBtn.hidden = !on;
}

export function paintTextSize() {
  document.querySelectorAll('#textSizeSeg [data-size]').forEach((b) => {
    b.classList.toggle('on', b.dataset.size === prefs.textSize);
  });
}

export function paintWalls() {
  const wrap = $('#wallGrid');
  if (!wrap) return;
  wrap.innerHTML = WALLPAPERS.map((w) => {
    const label = t(w.labelKey) || w.name;
    const custom = w.id === 'custom' && prefs.customWall
      ? ` style="background-image:url('${prefs.customWall}');background-size:cover;background-position:center"`
      : '';
    return `
    <button type="button" class="wall-swatch wsw-${w.id}${w.id === prefs.wallpaper ? ' on' : ''}"
      data-wall="${w.id}" title="${esc(label)}" aria-label="${esc(label)}"${custom}><i></i></button>
  `;
  }).join('');
}

export function paintAccents() {
  const wrap = $('#accentGrid');
  if (!wrap) return;
  wrap.innerHTML = ACCENTS.map((a) => {
    const bg = a.c
      ? `background:linear-gradient(135deg,${a.c[0]},${a.c[1]} 55%,${a.c[2]})`
      : 'background:linear-gradient(135deg,var(--blue),var(--violet))';
    return `<button type="button" class="accent-swatch${a.id === prefs.accent ? ' on' : ''}"
      data-accent="${a.id}" title="${esc(t(a.labelKey))}" aria-label="${esc(t(a.labelKey))}"
      style="${bg}"></button>`;
  }).join('');
}

/* Свои обои: ужимаем до 1600px и кладём в localStorage */
export function wallToDataUrl(file) {
  return new Promise((resolve, reject) => {
    const url = URL.createObjectURL(file);
    const img = new Image();
    img.onload = () => {
      try {
        const variants = [[1600, 0.74], [1280, 0.68], [1000, 0.6]];
        for (const [max, q] of variants) {
          const scale = Math.min(1, max / Math.max(img.width, img.height));
          const c = document.createElement('canvas');
          c.width = Math.max(1, Math.round(img.width * scale));
          c.height = Math.max(1, Math.round(img.height * scale));
          const g = c.getContext('2d');
          g.drawImage(img, 0, 0, c.width, c.height);
          const src = c.toDataURL('image/jpeg', q);
          if (src.length <= 850000) { resolve(src); return; }
        }
        reject(new Error('too big'));
      } catch (e) {
        reject(e);
      } finally {
        URL.revokeObjectURL(url);
      }
    };
    img.onerror = () => { URL.revokeObjectURL(url); reject(new Error('image')); };
    img.src = url;
  });
}

export function paintThemes() {
  const wrap = $('#themeGrid');
  if (!wrap) return;
  const cur = currentTheme();
  wrap.innerHTML = THEMES.map((th) => `
    <button type="button" class="theme-swatch${th.id === cur ? ' on' : ''}"
            data-theme-id="${th.id}" title="${esc(th.name)}"
            aria-label="${esc(th.name)}" aria-pressed="${th.id === cur}"
            style="background:${th.swatch[0]}"><i style="--sw-accent:${th.swatch[1]}"></i></button>
  `).join('');
}

export function paintFonts() {
  const sel = $('#fontSelect');
  if (!sel) return;
  const cur = currentFontId();
  let opts = FONTS.map((f) => `<option value="${f.id}">${esc(f.name)}</option>`).join('');
  if (cur === 'custom') opts += `<option value="custom">${t('settings.customFont')}</option>`;
  sel.innerHTML = opts;
  sel.value = cur === 'custom' ? 'custom' : cur;
}

export function paintAvatar() {
  const el = $('#avatarPreview');
  if (!el) return;
  const av = safeImgSrc(S.me?.avatar);
  el.innerHTML = av
    ? `<img src="${esc(av)}" alt="">`
    : `<b>${esc((S.me?.name || '?').slice(0, 1).toUpperCase())}</b>`;
  el.dataset.h = S.me?.hue ?? 0;
}

export function cropImage(file, size) {
  return new Promise((resolve, reject) => {
    const url = URL.createObjectURL(file);
    const img = new Image();
    img.onload = () => {
      const c = document.createElement('canvas');
      c.width = size;
      c.height = size;
      const g = c.getContext('2d');
      const side = Math.min(img.width, img.height);
      g.drawImage(img, (img.width - side) / 2, (img.height - side) / 2, side, side, 0, 0, size, size);
      URL.revokeObjectURL(url);
      resolve(c.toDataURL('image/jpeg', 0.85));
    };
    img.onerror = () => { URL.revokeObjectURL(url); reject(new Error('image')); };
    img.src = url;
  });
}

export async function handleAvatar(e) {
  const file = e.target.files && e.target.files[0];
  if (!file) return;
  try {
    const dataUrl = await cropImage(file, 256);
    if (SUPABASE.url && SUPABASE.anonKey) {
      /* Сохраняем на бэкенде — аватар переживёт перезагрузку и появится на других устройствах */
      await saveAvatar(dataUrl);
    }
    S.me.avatar = dataUrl;
    await idb.put('settings', { key: 'me', value: S.me });
    renderSidebar();
    paintAvatar();
    toast(t('settings.saved'));
  } catch (err) {
    console.error('Avatar save error:', err);
    toast(err.message || t('settings.error'));
  }
  e.target.value = '';
}

export function paintLangSeg() {
  document.querySelectorAll('#langSeg [data-lang]').forEach((b) => {
    b.classList.toggle('on', b.dataset.lang === lang);
  });
}

export function paintProfileDirty() {
  const btn = $('#saveProfile');
  if (!btn) return;
  const name = ($('#nameInput').value || '').trim();
  const uname = normalizeUsername($('#usernameInput').value || '');
  const dirty = name !== (S.me?.name || '')
    || uname !== String(S.me?.username || '').toLowerCase();
  btn.disabled = !dirty || !name;
  const hint = $('#saveState');
  if (hint) hint.textContent = dirty ? t('settings.unsaved') : '';
}

export async function saveProfile() {
  if (!name) { toast(t('auth.needName')); return; }

  const rawUsername = $('#usernameInput').value.trim();
  const username = normalizeUsername(rawUsername);
  const real = !!(SUPABASE.url && SUPABASE.anonKey);

  if (rawUsername && !isValidUsername(username)) {
    toast(t('settings.usernameInvalid'));
    return;
  }

  try {
    const updates = { display_name: name };

    if (real) {
      const hasCol = await hasUsernameColumn();
      if (rawUsername && !hasCol) { toast(t('settings.usernameNoDb')); return; }

      if (rawUsername && hasCol &&
          username.toLowerCase() !== String(S.me?.username || '').toLowerCase()) {
        if (await isUsernameTaken(username, S.me?.id)) {
          toast(t('settings.usernameTaken'));
          return;
        }
      }

      if (hasCol) updates.username = username || null;
      await updateProfile(updates);
    } else {
      updates.username = username || null;
      S.me = { ...S.me, ...updates };
      await idb.put('settings', { key: 'me', value: S.me });
    }

    S.me = { ...S.me, ...updates };
    await idb.put('settings', { key: 'me', value: S.me });
    renderSidebar();
    toast(t('settings.saved'));
    $('#settingsOv').hidden = true;
  } catch (err) {
    console.error('Save profile error:', err);
    if (err.code === '23505' || /duplicate|unique/i.test(err.message || '')) {
      toast(t('settings.usernameTaken'));
    } else {
      toast(err.message || t('settings.error'));
    }
  }
}

/* ── Данные: очистка локального кэша (ключи и профиль остаются) ── */
export async function clearLocalCache() {
  const ok = await confirmAction({
    title: t('settings.clearCache'),
    text: t('settings.clearCacheText'),
    ok: t('settings.clearCacheOk'),
    danger: true,
    iconName: 'database',
  });
  if (!ok) return;

  try {
    await Promise.all([idb.clear('messages'), idb.clear('chats'), idb.clear('media')]);
  } catch (e) { /* ignore */ }

  S.messages = {};
  S.active = null;
  S.chats = [];
  S.unreadFrom = {};
  S.renderLimit = {};
  clearMediaObjectUrls();
  $('#settingsOv').hidden = true;
  location.hash = '#/app';

  if (SUPABASE.url && SUPABASE.anonKey) {
    await loadChats();
    renderSidebar();
    toast(t('settings.cacheCleared'), { type: 'success' });
  } else {
    /* демо: после перезагрузки seedIfEmpty заново наполнит чаты */
    toast(t('settings.cacheCleared'), { type: 'success' });
    setTimeout(() => location.reload(), 500);
  }
}
