/* Relik — модальные окна: настройки, новый чат, создание группы, лайтбокс */
import { S, user, emit, chatById, chatTitle } from './state.js';
import { $, esc, avatarHtml, fmtTime, fmtSize, safeImgSrc } from './utils.js';
import { icon } from './icons.js';
import { t, lang, setLang } from '../i18n/i18n.js';
import { idb, newId } from '../db/idb.js';
import { APP, SUPABASE } from '../config.js';
import { sb } from '../backend/supabaseClient.js';
import { toast } from './toast.js';
import { renderSidebar, loadChats } from './sidebar.js';
import { updateProfile, saveAvatar, normalizeUsername, isValidUsername, isUsernameTaken, hasUsernameColumn, signOutAll, deleteAccount } from '../backend/auth.js';
import { searchUsers, createDmChat, profilesByIds } from '../backend/chats.js';
import { listRequests, sendRequest, respondRequest, cancelRequest, removeContact, contactsReady, subscribeRequests, seedDemoRequests } from '../backend/contacts.js';
import { pushSupported, pushState, enablePush, disablePush } from '../backend/push.js';
import { openKeyPanel, refreshKeyStatus } from './keyRecovery.js';
import { createGroup } from '../backend/groups.js';
import { THEMES, applyTheme, currentTheme } from './themes.js';
import { FONTS, applyFont, applyFontStack, currentFontId, saveCustomFont } from './fonts.js';
import { soundsEnabled, setSounds } from './sounds.js';
import { notificationsEnabled, setNotifications } from './notify.js';
import { prefs, WALLPAPERS, ACCENTS, setTextSize, setWallpaper, setMotion, setEnterToSend, setAccent, setCustomWall, clearChatPrefs, setHideOnline } from './prefs.js';
import { confirmAction } from './dialog.js';
import { addMemberToGroup, removeMemberFromGroup, updateGroupTitle, leaveGroup } from '../backend/groups.js';
import { canInstall, promptInstall } from './install.js';
import { exportChats } from './export.js';
import { hasPin, enablePin, disablePin, changePin, lockNow } from './pin.js';
import { hasGroupKeysTable } from '../backend/groupKeys.js';
import { storageAvailable, clearMediaObjectUrls } from '../backend/storage.js';
import { mediaStats, storageEstimate, persistedStorage, ensurePersistentStorage, clearMediaCache, MEDIA_MAX_BYTES } from '../db/mediaCache.js';

let selectedGroupMembers = new Set();

function debounce(fn, ms = 260) {
  let timer = null;
  return (...args) => {
    clearTimeout(timer);
    timer = setTimeout(() => fn(...args), ms);
  };
}

const paintContactsDebounced = debounce(paintContacts);
const paintGroupContactsDebounced = debounce(paintGroupContacts);
const paintGroupAddDebounced = debounce(paintGroupAddList);
const paintPeopleDebounced = debounce(paintPeople);

export function initModals() {
  /* статичные иконки закрытия */
  document.querySelectorAll('.m-head [data-close]').forEach((b) => { b.innerHTML = icon('x', 18); });
  $('#lbX').innerHTML = icon('x', 20);
  $('#lbDl').innerHTML = icon('dl', 20);
  $('#lbDl').title = t('media.download');
  $('#lbDl').setAttribute('aria-label', t('media.download'));
  $('#ncGroupIc').innerHTML = icon('users', 18);
  if ($('#ncPeopleIc')) $('#ncPeopleIc').innerHTML = icon('search', 18);

  /* закрытие по крестику и клику по фону любого оверлея */
  document.querySelectorAll('.overlay').forEach((ov) => {
    ov.addEventListener('click', (e) => { if (e.target === ov) closeOv(ov); });
    ov.querySelectorAll('[data-close]').forEach((btn) => {
      btn.addEventListener('click', () => closeOv(ov));
    });
  });

  /* ── доступность: Tab не выходит из открытого окна ── */
  const dialogRoots = [...document.querySelectorAll('.overlay, .lightbox')];
  const trapStack = [];
  const focusables = (root) => [...root.querySelectorAll(
    'a[href],button:not([disabled]),input:not([disabled]):not([type="hidden"]),select:not([disabled]),textarea:not([disabled]),[tabindex]:not([tabindex="-1"])'
  )].filter((el) => !el.hidden && el.getClientRects().length > 0);
  const topTrap = () => trapStack[trapStack.length - 1] || null;

  const pushTrap = (root) => {
    if (trapStack.some((t) => t.root === root)) return;
    const prev = document.activeElement;
    trapStack.push({ root, prev });
    const list = focusables(root);
    const first = root.querySelector('[autofocus]') || list[0] || root;
    if (first === root && !root.hasAttribute('tabindex')) root.setAttribute('tabindex', '-1');
    try { first.focus({ preventScroll: true }); } catch (e) { /* ignore */ }
  };

  const popTrap = (root) => {
    const i = trapStack.findIndex((t) => t.root === root);
    if (i < 0) return;
    const [t] = trapStack.splice(i, 1);
    const top = topTrap();
    const list = top ? focusables(top.root) : [];
    const target = top ? (list[0] || top.root) : t.prev;
    if (target && target.isConnected && !root.contains(target)) {
      try { target.focus({ preventScroll: true }); } catch (e) { /* ignore */ }
    }
  };

  document.addEventListener('keydown', (e) => {
    if (e.key !== 'Tab') return;
    const top = topTrap();
    if (!top) return;
    const list = focusables(top.root);
    if (!list.length) { e.preventDefault(); return; }
    const first = list[0];
    const last = list[list.length - 1];
    const active = document.activeElement;
    if (!top.root.contains(active)) { e.preventDefault(); first.focus(); return; }
    if (e.shiftKey && active === first) { e.preventDefault(); last.focus(); }
    else if (!e.shiftKey && active === last) { e.preventDefault(); first.focus(); }
  }, true);

  const trapObserver = new MutationObserver((muts) => {
    for (const m of muts) {
      const root = m.target;
      if (!(root instanceof Element) || !root.matches('.overlay, .lightbox')) continue;
      if (!root.hidden) pushTrap(root);
      else popTrap(root);
    }
  });
  dialogRoots.forEach((root) => {
    trapObserver.observe(root, { attributes: true, attributeFilter: ['hidden'] });
    if (!root.hidden) pushTrap(root);
  });
  document.addEventListener('keydown', (e) => {
    if (e.key !== 'Escape') return;
    if (!$('#lightbox').hidden) closeLightbox();
    else closeTransientOverlays();
  });
  document.addEventListener('keydown', (e) => {
    if ($('#lightbox').hidden) return;
    if (e.key === 'ArrowLeft') { e.preventDefault(); stepLightbox(-1); }
    else if (e.key === 'ArrowRight') { e.preventDefault(); stepLightbox(1); }
  });
  $('#lbPrev')?.addEventListener('click', () => stepLightbox(-1));
  $('#lbNext')?.addEventListener('click', () => stepLightbox(1));

/* ── настройки ── */
  $('#saveProfile').addEventListener('click', saveProfile);
  $('#secNav')?.addEventListener('click', (e) => {
    const b = e.target.closest('[data-target]');
    if (!b) return;
    paintSecNav(b.dataset.target);
    document.querySelector(b.dataset.target)?.scrollIntoView({ block: 'start', behavior: 'smooth' });
  });
  /* полоска под панелью появляется только когда список прокручен */
  const mBody = $('#settingsOv .m-body');
  mBody?.addEventListener('scroll', () => {
    if (mBody.scrollTop > 2) delete mBody.dataset.atTop;
    else mBody.dataset.atTop = '1';
  }, { passive: true });
  ['#nameInput', '#usernameInput'].forEach((sel) => {
    $(sel)?.addEventListener('input', paintProfileDirty);
  });
  $('#langSeg').addEventListener('click', (e) => {
    const b = e.target.closest('[data-lang]');
    if (b) setLang(b.dataset.lang);
    paintLangSeg();
  });
  document.addEventListener('relik:lang', paintLangSeg);

  /* ── новый чат ── */
  $('#ncSearch').addEventListener('input', paintContactsDebounced);
  $('#ncGroup').addEventListener('click', openGroupCreator);
  $('#ncPeople').addEventListener('click', () => {
    $('#ncOv').hidden = true;
    openPeople();
  });
  $('#ncList').addEventListener('click', (e) => {
    if (e.target.closest('[data-retry-contacts]')) paintContacts();
    if (e.target.closest('[data-find-people]')) {
      $('#ncOv').hidden = true;
      openPeople();
    }
  });
  $('#lbX').addEventListener('click', closeLightbox);
  $('#lbDl').addEventListener('click', downloadLightbox);
  document.addEventListener('relik:lang', paintContacts);

  /* ── поиск людей и заявки в контакты ── */
  $('#peopleSearch').addEventListener('input', paintPeopleDebounced);
  $('#peopleList').addEventListener('click', peopleAction);
  $('#reqIn').addEventListener('click', peopleAction);
  $('#reqOut').addEventListener('click', peopleAction);
  $('#reqContacts').addEventListener('click', peopleAction);

  /* ── поиск по всей переписке ── */
  $('#gsSearch').addEventListener('input', gsDebounced);
  $('#gsList').addEventListener('click', gsPick);
  document.addEventListener('click', (e) => {
    if (e.target.closest('[data-search-messages]')) {
      openGlobalSearch($('#searchInput')?.value || '');
    }
  });
  /* Ctrl/Cmd+Shift+F — сквозной поиск, Ctrl/Cmd+F остаётся за чатом */
  document.addEventListener('keydown', (e) => {
    if (!(e.ctrlKey || e.metaKey) || !e.shiftKey) return;
    if (!(e.code === 'KeyF' || String(e.key).toLowerCase() === 'f') || !S.me) return;
    if ($('#paletteOv') && !$('#paletteOv').hidden) return;
    e.preventDefault();
    openGlobalSearch($('#searchInput')?.value || '');
  });

  /* ── хранилище ── */
  $('#storageClearBtn')?.addEventListener('click', clearStorageCache);
  $('#storageCompactBtn')?.addEventListener('click', compactHistory);
  $('#storagePersistBtn')?.addEventListener('click', askPersistentStorage);

  document.addEventListener('relik:lang', () => {
    if (!$('#peopleOv').hidden) paintPeople();
    if (!$('#reqOv').hidden) paintRequests();
  });

  /* ── создание группы ── */
  $('#gcSearch').addEventListener('input', paintGroupContactsDebounced);
  $('#gcCreate').addEventListener('click', createGroupChat);
  $('#gcContacts').addEventListener('click', (e) => {
    if (e.target.closest('[data-retry-groups]')) paintGroupContacts();
  });

  /* ── темы, шрифты, звуки, аватар ── */
  $('#themeGrid').addEventListener('click', (e) => {
    const b = e.target.closest('[data-theme-id]');
    if (!b) return;
    applyTheme(b.dataset.themeId);
    paintThemes();
  });
  $('#fontSelect').addEventListener('change', (e) => {
    if (e.target.value === 'custom') {
      const stack = localStorage.getItem('relik.font');
      if (stack) applyFontStack(stack, false);
    } else {
      applyFont(e.target.value);
    }
  });
  $('#fontUploadBtn').addEventListener('click', () => $('#fontUpload').click());
  $('#fontUpload').addEventListener('change', async (e) => {
    const f = e.target.files && e.target.files[0];
    if (!f) return;
    try {
      await saveCustomFont(f);
      localStorage.setItem('relik.fontId', 'custom');
      await paintFonts();
      toast(t('settings.fontLoaded'));
    } catch (err) {
      toast(t('settings.fontError'));
    }
    e.target.value = '';
  });
  $('#soundsToggle').addEventListener('change', (e) => setSounds(e.target.checked));
  /* ── Web Push ── */
  const paintPush = async () => {
    const box = $('#pushToggle');
    if (!box) return;
    const st = await pushState();
    box.checked = st === 'on';
    box.disabled = st === 'unsupported';
    const hint = $('#pushHint');
    if (hint) {
      hint.textContent = st === 'unsupported'
        ? t('settings.pushNoSupport')
        : st === 'denied'
          ? t('settings.pushDenied')
          : t('settings.pushHint');
    }
  };
  paintPush();
  $('#pushToggle')?.addEventListener('change', async (e) => {
    const want = e.target.checked;
    e.target.disabled = true;
    try {
      if (want) {
        await enablePush();
        toast(t('settings.pushOn'));
      } else {
        await disablePush();
        toast(t('settings.pushOff'));
      }
    } catch (err) {
      const code = String(err?.message || '');
      e.target.checked = !want;
      toast(
        /denied/i.test(code) ? t('settings.pushDenied')
          : /unsupported/i.test(code) ? t('settings.pushNoSupport')
            : /need_sql/i.test(code) ? t('settings.pushNeedSql')
              : /no_backend|not_configured/i.test(code) ? t('settings.pushNoServer')
                : t('toast.error'),
        { type: 'error' },
      );
    } finally {
      e.target.disabled = false;
      paintPush();
    }
  });
  $('#notifyToggle').addEventListener('change', async (e) => {
    const wanted = e.target.checked;
    try {
      await setNotifications(wanted);
      toast(t('settings.saved'));
    } catch (err) {
      e.target.checked = !wanted;
      toast(err.message || t('settings.notifyDenied'));
    }
  });
  $('#avatarBtn').addEventListener('click', () => $('#avatarInput').click());
  $('#avatarInput').addEventListener('change', handleAvatar);
  $('#keyPanelBtn')?.addEventListener('click', openKeyPanel);

  /* ── удаление аккаунта ── */
  $('#deleteAccountBtn')?.addEventListener('click', async () => {
    const ok = await confirmAction({
      title: t('settings.deleteAccountTitle'),
      text: t('settings.deleteAccountText'),
      ok: t('settings.deleteAccountOk'),
      danger: true,
      iconName: 'trash',
    });
    if (!ok) return;
    try {
      if (SUPABASE.url && SUPABASE.anonKey) {
        await deleteAccount();
      } else {
        await idb.clear('messages').catch(() => {});
        await idb.del('settings', 'me').catch(() => {});
      }
      toast(t('settings.accountDeleted'));
      setTimeout(() => location.reload(), 600);
    } catch (err) {
      console.error('Delete account error:', err);
      const msg = String(err?.message || '');
      toast(/could not find|does not exist|schema cache|function/i.test(msg)
        ? t('settings.deleteAccountSql')
        : (msg || t('toast.error')), { type: 'error' });
    }
  });

  /* ── оформление: размер текста, обои, анимации, Enter ── */
  $('#textSizeSeg')?.addEventListener('click', (e) => {
    const b = e.target.closest('[data-size]');
    if (!b) return;
    setTextSize(b.dataset.size);
    paintTextSize();
  });
  $('#wallGrid')?.addEventListener('click', (e) => {
    const b = e.target.closest('[data-wall]');
    if (!b) return;
    if (b.dataset.wall === 'custom' && !prefs.customWall) {
      $('#wallUpload').click();
      return;
    }
    setWallpaper(b.dataset.wall);
    paintWalls();
  });
  $('#accentGrid')?.addEventListener('click', (e) => {
    const b = e.target.closest('[data-accent]');
    if (!b) return;
    setAccent(b.dataset.accent);
    applyTheme(currentTheme(), false);
    paintAccents();
  });
  $('#wallUploadBtn')?.addEventListener('click', () => $('#wallUpload').click());
  $('#wallUpload')?.addEventListener('change', async (e) => {
    const f = e.target.files && e.target.files[0];
    e.target.value = '';
    if (!f) return;
    try {
      const src = await wallToDataUrl(f);
      setCustomWall(src);
      paintWalls();
      toast(t('settings.saved'), { type: 'success' });
    } catch (err) {
      toast(t('settings.wallTooBig'), { type: 'error' });
    }
  });
  $('#enterSendToggle')?.addEventListener('change', (e) => setEnterToSend(e.target.checked));
  $('#motionToggle')?.addEventListener('change', (e) => setMotion(e.target.checked));
  $('#hideOnlineToggle')?.addEventListener('change', (e) => {
    setHideOnline(e.target.checked);
    import('../backend/presence.js').then((m) => m.updateLastSeen?.()).catch(() => {});
    toast(t('settings.saved'));
  });
  $('#pinToggle')?.addEventListener('change', async (e) => {
    const wanted = e.target.checked;
    e.target.disabled = true;
    try {
      const ok = wanted ? await enablePin() : await disablePin();
      if (!ok) e.target.checked = !wanted;
    } finally {
      e.target.disabled = false;
      paintPinSettings();
    }
  });
  $('#pinChangeBtn')?.addEventListener('click', async () => {
    await changePin();
    paintPinSettings();
  });
  $('#pinLockBtn')?.addEventListener('click', () => {
    $('#settingsOv').hidden = true;
    lockNow();
  });
  $('#clearLocalBtn')?.addEventListener('click', clearLocalCache);
  const runExport = async (format, btn) => {
    if (btn) btn.disabled = true;
    try {
      const n = await exportChats(format);
      toast(t('settings.exported').replace('{n}', String(n)), { type: 'success' });
    } catch (err) {
      console.error('Export error:', err);
      toast(t('toast.error'), { type: 'error' });
    } finally {
      if (btn) btn.disabled = false;
    }
  };
  $('#exportJsonBtn')?.addEventListener('click', (e) => runExport('json', e.currentTarget));
  $('#exportHtmlBtn')?.addEventListener('click', (e) => runExport('html', e.currentTarget));
  $('#logoutAllBtn')?.addEventListener('click', async () => {
    const ok = await confirmAction({
      title: t('settings.logoutAll'),
      text: t('settings.logoutAllText'),
      ok: t('settings.logoutAllOk'),
      danger: true,
      iconName: 'logout',
    });
    if (!ok) return;
    await signOutAll();
    location.reload();
  });
  $('#installBtn')?.addEventListener('click', async () => {
    const ok = await promptInstall();
    $('#installBtn').hidden = !canInstall();
    if (ok) toast(t('settings.installed'), { type: 'success' });
  });
  document.addEventListener('relik:install-available', () => {
    const btn = $('#installBtn');
    if (btn && !$('#settingsOv').hidden) btn.hidden = !canInstall();
  });

  /* ── управление группой ── */
  $('#groupTitleSave')?.addEventListener('click', saveGroupTitle);
  $('#groupLeave')?.addEventListener('click', leaveCurrentGroup);
  $('#groupAddBtn')?.addEventListener('click', () => {
    const panel = $('#groupAddPanel');
    panel.hidden = !panel.hidden;
    if (!panel.hidden) {
      $('#groupAddSearch').value = '';
      paintGroupAddList();
      setTimeout(() => $('#groupAddSearch').focus(), 40);
    }
  });
  $('#groupAddSearch')?.addEventListener('input', paintGroupAddDebounced);
  $('#groupAddList')?.addEventListener('click', addGroupMemberClicked);

  document.addEventListener('relik:lang', () => {
    paintTextSize();
    paintWalls();
    paintAccents();
    paintThemes();
    paintFonts();
    paintLangSeg();
    paintPinSettings();
    if (!$('#settingsOv').hidden) paintStorage();
  });
}

function closeOv(ov) {
  if (ov) ov.hidden = true;
}

/* ── ЛАЙТБОКС ── */
let lightboxSrc = '';
let lightboxName = 'relik-image.jpg';
let lightboxGallery = [];
let lightboxIndex = 0;

function showLightboxItem() {
  const item = lightboxGallery[lightboxIndex];
  if (!item) return;
  lightboxSrc = item.src;
  lightboxName = item.name || 'relik-image.jpg';
  $('#lbImg').src = lightboxSrc;
  $('#lbImg').alt = lightboxName;
  const many = lightboxGallery.length > 1;
  const prev = $('#lbPrev');
  const next = $('#lbNext');
  const count = $('#lbCount');
  if (prev) prev.hidden = !many;
  if (next) next.hidden = !many;
  if (count) {
    count.hidden = !many;
    count.textContent = many ? `${lightboxIndex + 1} / ${lightboxGallery.length}` : '';
  }
}

export function openLightbox(src, name, gallery = null) {
  const items = (Array.isArray(gallery) ? gallery : [])
    .filter((it) => it?.src)
    .map((it) => ({ src: it.src, name: it.name || 'relik-image.jpg' }));
  lightboxGallery = items.length ? items : [{ src: String(src || ''), name: name ? String(name) : 'relik-image.jpg' }];
  const wanted = String(src || '');
  const idx = lightboxGallery.findIndex((it) => it.src === wanted);
  lightboxIndex = idx >= 0 ? idx : 0;
  showLightboxItem();
  $('#lightbox').hidden = false;
}

function stepLightbox(dir) {
  if (lightboxGallery.length < 2) return;
  lightboxIndex = (lightboxIndex + dir + lightboxGallery.length) % lightboxGallery.length;
  showLightboxItem();
}

function closeLightbox() {
  $('#lightbox').hidden = true;
  $('#lbImg').src = '';
  lightboxSrc = '';
  lightboxGallery = [];
  lightboxIndex = 0;
}
function downloadLightbox() {
  if (!lightboxSrc) return;
  const a = document.createElement('a');
  a.href = lightboxSrc;
  a.download = lightboxName || 'relik-image.jpg';
  a.rel = 'noopener';
  document.body.appendChild(a);
  a.click();
  a.remove();
}

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
function paintSecNav(activeTarget = null) {
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

async function paintMigrationStatus() {
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

async function paintStorage() {
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

async function askPersistentStorage() {
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

async function clearStorageCache() {
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
async function compactHistory() {
  const { messageStats, compactMessages, KEEP_PER_CHAT, OLDER_THAN_DAYS } =
    await import('../db/compaction.js');
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

function paintPinSettings() {
  const on = hasPin();
  const toggle = $('#pinToggle');
  if (toggle) toggle.checked = on;
  const btn = $('#pinChangeBtn');
  if (btn) btn.hidden = !on;
  const lockBtn = $('#pinLockBtn');
  if (lockBtn) lockBtn.hidden = !on;
}

function paintTextSize() {
  document.querySelectorAll('#textSizeSeg [data-size]').forEach((b) => {
    b.classList.toggle('on', b.dataset.size === prefs.textSize);
  });
}

function paintWalls() {
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

function paintAccents() {
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
function wallToDataUrl(file) {
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

function paintThemes() {
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

function paintFonts() {
  const sel = $('#fontSelect');
  if (!sel) return;
  const cur = currentFontId();
  let opts = FONTS.map((f) => `<option value="${f.id}">${esc(f.name)}</option>`).join('');
  if (cur === 'custom') opts += `<option value="custom">${t('settings.customFont')}</option>`;
  sel.innerHTML = opts;
  sel.value = cur === 'custom' ? 'custom' : cur;
}

function paintAvatar() {
  const el = $('#avatarPreview');
  if (!el) return;
  const av = safeImgSrc(S.me?.avatar);
  el.innerHTML = av
    ? `<img src="${esc(av)}" alt="">`
    : `<b>${esc((S.me?.name || '?').slice(0, 1).toUpperCase())}</b>`;
  el.dataset.h = S.me?.hue ?? 0;
}

function cropImage(file, size) {
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

async function handleAvatar(e) {
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

/* Закрыть все «мимолётные» окна: Esc и любая навигация по хешу */
export function closeTransientOverlays() {
  closeOv($('#settingsOv')); closeOv($('#ncOv')); closeOv($('#gcOv'));
  closeOv($('#pollOv')); closeOv($('#profileOv'));
  closeOv($('#groupOv')); closeOv($('#readOv'));
  closeOv($('#peopleOv')); closeOv($('#reqOv')); closeOv($('#gsOv'));
  closeOv($('#mediaOv')); closeOv($('#scheduleOv')); closeOv($('#schedListOv')); closeOv($('#fwdOv'));
  closeOv($('#keyOv')); closeOv($('#keyPhraseOv'));
}

function paintLangSeg() {
  document.querySelectorAll('#langSeg [data-lang]').forEach((b) => {
    b.classList.toggle('on', b.dataset.lang === lang);
  });
}

function paintProfileDirty() {
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

async function saveProfile() {
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
async function clearLocalCache() {
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

/* ── Управление группой ─────────────────────────────────────── */
let groupChat = null;

export function openGroupManager(chat) {
  if (!chat || chat.kind !== 'group') return;
  groupChat = chat;
  $('#groupTitleInput').value = chat.title || '';
  $('#groupAddPanel').hidden = true;
  $('#groupAddSearch').value = '';
  $('#groupOv').hidden = false;
  paintGroupMemberList();
  paintGroupE2eStatus(chat);
  setTimeout(() => $('#groupTitleInput').focus(), 60);
}

async function paintGroupE2eStatus(chat) {
  const el = $('#groupE2eStatus');
  if (!el) return;
  if (!(SUPABASE.url && SUPABASE.anonKey)) {
    el.textContent = '';
    return;
  }
  el.textContent = t('group.e2eChecking');
  try {
    const ok = await hasGroupKeysTable();
    el.textContent = t(ok ? 'group.e2eOn' : 'group.e2eOff');
    el.style.color = ok ? 'var(--ok, #3ecf8e)' : 'var(--warn)';
  } catch (e) {
    el.textContent = t('group.e2eOff');
  }
}

function canManageGroup(chat) {
  if (!chat) return false;
  if (!chat.createdBy) return true;
  return chat.createdBy === S.me?.id;
}

function groupMemberIds(chat) {
  const ids = [S.me?.id, ...(chat.members || [])].filter(Boolean);
  return [...new Set(ids)];
}

function paintGroupMemberList() {
  const chat = groupChat;
  const wrap = $('#groupMemberList');
  if (!chat || !wrap) return;
  const manage = canManageGroup(chat);
  wrap.innerHTML = groupMemberIds(chat).map((uid) => {
    const u = user(uid);
    const me = uid === S.me?.id;
    return `<div class="member-row">
      ${avatarHtml(u, { sm: true, online: u.seen === 'online' })}
      <span class="info">
        <span class="n">${esc(u.name)}${me ? ` <em class="member-you">${t('group.you')}</em>` : ''}</span>
        <span class="s">${u.username ? '@' + esc(u.username) : t('chat.' + (u.seen || 'offline'))}</span>
      </span>
      ${manage && !me ? `<button class="icon-btn member-rm" type="button" data-rm-member="${esc(uid)}"
        title="${t('group.remove')}" aria-label="${t('group.remove')}">${icon('userMinus', 17)}</button>` : ''}
    </div>`;
  }).join('');

  wrap.querySelectorAll('[data-rm-member]').forEach((btn) => {
    btn.addEventListener('click', () => removeGroupMember(btn.dataset.rmMember));
  });

  $('#groupLeave').textContent = t('group.leave');
  $('#groupTitleSave').textContent = t('settings.save');
}

async function removeGroupMember(uid) {
  const chat = groupChat;
  if (!chat || !uid) return;
  const u = user(uid);
  const ok = await confirmAction({
    title: t('group.removeTitle'),
    text: t('group.removeText').replace('{name}', u.name),
    ok: t('group.remove'),
    danger: true,
    iconName: 'userMinus',
  });
  if (!ok) return;

  try {
    if (SUPABASE.url && SUPABASE.anonKey) await removeMemberFromGroup(chat.id, uid);
    chat.members = (chat.members || []).filter((id) => id !== uid);
    await idb.put('chats', chat);
    emit('chat:updated', { id: chat.id });
    paintGroupMemberList();
    if (!$('#groupAddPanel').hidden) await paintGroupAddList();
    renderSidebar();
    toast(t('group.removed'), { type: 'success' });
  } catch (err) {
    console.error('Remove member error:', err);
    toast(t('group.removeError'), { type: 'error' });
  }
}

async function paintGroupAddList() {
  const chat = groupChat;
  const wrap = $('#groupAddList');
  if (!chat || !wrap) return;
  const q = $('#groupAddSearch').value.trim();
  wrap.innerHTML = `<div class="nc-hint">…</div>`;

  let users;
  try {
    if (SUPABASE.url && SUPABASE.anonKey) {
      const profiles = await searchUsers(q);
      users = profiles.map((p) => ({
        id: p.id, name: p.display_name, hue: p.avatar_hue, avatar: p.avatar || null,
        username: p.username || null, role: p.role || 'user', seen: 'offline',
      }));
      mergeUsers(users);
    } else {
      users = S.users.filter((u) => u.id !== 'u_me');
    }
  } catch (err) {
    console.error('Group search error:', err);
    users = S.users.filter((u) => u.id !== 'u_me');
  }

  const excluded = new Set(groupMemberIds(chat));
  users = users.filter((u) => !excluded.has(u.id) && (!q || u.name.toLowerCase().includes(q.toLowerCase())
    || String(u.username || '').toLowerCase().includes(q.toLowerCase())));

  wrap.innerHTML = users.slice(0, 40).map((u) => `
    <button class="contact" type="button" data-add-member="${esc(u.id)}">
      ${avatarHtml(u)}
      <span class="info"><span class="n">${esc(u.name)}</span>
      <span class="s">${u.username ? '@' + esc(u.username) : ''}</span></span>
      <span class="member-add">${icon('plus', 16)}</span>
    </button>`).join('') || `<div class="nc-hint">${t('newchat.empty')}</div>`;
}

async function addGroupMemberClicked(e) {
  const btn = e.target.closest('[data-add-member]');
  if (!btn || !groupChat) return;
  const uid = btn.dataset.addMember;
  btn.disabled = true;
  try {
    if (SUPABASE.url && SUPABASE.anonKey) await addMemberToGroup(groupChat.id, uid);
    groupChat.members = [...new Set([...(groupChat.members || []), uid])];
    await idb.put('chats', groupChat);
    emit('chat:updated', { id: groupChat.id });
    paintGroupMemberList();
    await paintGroupAddList();
    renderSidebar();
    toast(t('group.added'), { type: 'success' });
  } catch (err) {
    console.error('Add member error:', err);
    btn.disabled = false;
    toast(t('group.addError'), { type: 'error' });
  }
}

async function saveGroupTitle() {
  const chat = groupChat;
  if (!chat) return;
  const title = $('#groupTitleInput').value.trim();
  if (!title) { toast(t('group.needName'), { type: 'error' }); return; }
  if (title === chat.title) { toast(t('settings.saved'), { type: 'success' }); return; }
  try {
    if (SUPABASE.url && SUPABASE.anonKey) await updateGroupTitle(chat.id, title);
    chat.title = title;
    await idb.put('chats', chat);
    emit('chat:updated', { id: chat.id });
    renderSidebar();
    toast(t('settings.saved'), { type: 'success' });
  } catch (err) {
    console.error('Rename group error:', err);
    toast(t('group.renameError'), { type: 'error' });
  }
}

async function leaveCurrentGroup() {
  const chat = groupChat;
  if (!chat) return;
  const ok = await confirmAction({
    title: t('side.leaveTitle'),
    text: t('side.leaveText'),
    ok: t('side.leaveOk'),
    danger: true,
    iconName: 'logout',
  });
  if (!ok) return;

  try {
    if (SUPABASE.url && SUPABASE.anonKey) await leaveGroup(chat.id);
  } catch (err) {
    console.error('Leave group error:', err);
    toast(t('side.leaveError'), { type: 'error' });
    return;
  }

  S.chats = S.chats.filter((c) => c.id !== chat.id);
  delete S.messages[chat.id];
  clearChatPrefs(chat.id);
  if (S.unreadFrom) delete S.unreadFrom[chat.id];
  if (S.renderLimit) delete S.renderLimit[chat.id];
  await idb.del('chats', chat.id);
  if (S.active === chat.id) {
    S.active = null;
    $('#appView').classList.remove('pane-chat');
    location.hash = '#/app';
  }
  $('#groupOv').hidden = true;
  groupChat = null;
  renderSidebar();
  toast(t('side.left'), { type: 'success' });
}

export function openGlobalSearch(initial = '') {
  const ov = $('#gsOv');
  if (!ov) return;
  gsCache = null;
  $('#gsSearch').value = initial;
  ov.hidden = false;
  paintGlobalSearch();
  setTimeout(() => { try { $('#gsSearch').focus(); } catch (e) { /* ignore */ } }, 60);
}

const gsDebounced = debounce(paintGlobalSearch, 220);

/* Индекс строится один раз на открытие модалки и живёт 20 секунд:
   раньше каждый символ заново читал все сообщения из IndexedDB. */
let gsCache = null;

async function gsIndex() {
  if (gsCache && Date.now() - gsCache.at < 20000) return gsCache.items;
  let all = [];
  try {
    all = await idb.getAll('messages');
  } catch (e) {
    all = [];
  }
  const items = all
    .filter((m) => !m.hidden && !m.localDeleted && m.text)
    .sort((a, b) => (b.ts || 0) - (a.ts || 0))
    .map((m) => ({ m, text: String(m.text), low: String(m.text).toLowerCase() }));
  gsCache = { at: Date.now(), items };
  return items;
}

async function paintGlobalSearch() {
  const wrap = $('#gsList');
  if (!wrap || $('#gsOv').hidden) return;
  const q = $('#gsSearch').value.trim().toLowerCase();
  if (q.length < 2) {
    wrap.innerHTML = `<div class="nc-hint">${t('gs.typeMore')}</div>`;
    return;
  }
  if (!wrap.querySelector('.contact')) wrap.innerHTML = `<div class="nc-hint">${t('people.loading')}</div>`;

  const index = await gsIndex();
  if ($('#gsOv').hidden || $('#gsSearch').value.trim().toLowerCase() !== q) return;

  const hits = index.filter((x) => x.low.includes(q)).slice(0, 60).map((x) => x.m);

  if (!hits.length) {
    wrap.innerHTML = `<div class="nc-hint">${t('gs.empty')}</div>`;
    return;
  }

  wrap.innerHTML = hits.map((m) => {
    const chat = chatById(m.chatId);
    const title = chat ? chatTitle(chat) : '…';
    const idx = String(m.text).toLowerCase().indexOf(q);
    const from = Math.max(0, idx - 35);
    const snippet = (from > 0 ? '…' : '') + String(m.text).slice(from, idx + q.length + 55) + (m.text.length > idx + q.length + 55 ? '…' : '');
    return `<button class="contact" data-gs-chat="${esc(m.chatId)}" data-gs-id="${esc(m.id)}">
      <span class="c-ic">${icon('search', 16)}</span>
      <span class="info">
        <span class="n">${esc(title)}</span>
        <span class="s">${esc(snippet)}</span>
      </span>
      <span class="s" style="flex:none">${fmtTime(m.ts)}</span>
    </button>`;
  }).join('');
}

function flashSearchHit(msgId) {
  try {
    const safe = String(msgId).replace(/["\\]/g, '');
    const el = document.querySelector(`.msg[data-mid="${safe}"]`);
    if (!el) return;
    el.scrollIntoView({ block: 'center', behavior: 'smooth' });
    el.classList.add('flash');
    setTimeout(() => el.classList.remove('flash'), 1500);
  } catch (e) { /* ignore */ }
}

async function gsPick(e) {
  const b = e.target.closest('[data-gs-chat]');
  if (!b) return;
  const chatId = b.dataset.gsChat;
  const msgId = b.dataset.gsId;
  $('#gsOv').hidden = true;
  if (location.hash === `#/chat/${chatId}`) {
    flashSearchHit(msgId);
  } else {
    location.hash = `#/chat/${chatId}`;
    setTimeout(() => flashSearchHit(msgId), 700);
  }
}

/* ── НОВЫЙ ЧАТ: только принятые контакты ── */
export function openNewChat() {
  $('#ncSearch').value = '';
  $('#ncOv').hidden = false;
  paintContacts();
}

function mapProfile(p) {
  return {
    id: p.id,
    name: p.display_name,
    hue: p.avatar_hue,
    avatar: p.avatar || null,
    username: p.username || null,
    role: p.role || 'user',
    seen: 'offline',
  };
}

async function paintContacts() {
  const wrap = $('#ncList');
  if (!wrap || $('#ncOv').hidden) return;
  const q = $('#ncSearch').value.trim().toLowerCase();
  if (!wrap.querySelector('.contact')) wrap.innerHTML = `<div class="nc-hint">${t('newchat.loading')}</div>`;

  let users = [];
  let failed = false;
  let errMsg = '';
  let noContacts = false;
  const real = SUPABASE.url && SUPABASE.anonKey;

  if (real) {
    try {
      const ready = await contactsReady();
      if (ready) {
        await refreshRequests();
        const ids = [...new Set(S.contacts.map((c) => c.userId))].filter((id) => id && id !== S.me?.id);
        if (ids.length) {
          const profiles = await profilesByIds(ids);
          users = profiles.map(mapProfile);
          mergeUsers(users);
        } else {
          noContacts = true;
        }
      } else {
        /* миграции контактов нет — работаем по-старому, показываем всех */
        const profiles = await searchUsers(q);
        users = profiles.map(mapProfile).filter((u) => u.id !== S.me?.id);
        mergeUsers(users);
      }
    } catch (err) {
      console.error('Contacts load error:', err);
      failed = true;
      errMsg = String(err?.message || err || '').trim().slice(0, 160);
      users = S.users.filter((u) => !u.id.startsWith('u_'));
      for (const c of S.chats) {
        if (c.kind !== 'dm' || !c.userId) continue;
        if (users.some((u) => u.id === c.userId)) continue;
        users.push({ id: c.userId, name: c.title || '', hue: c.hue ?? 210, avatar: null, username: null, role: 'user', seen: 'offline' });
      }
    }
  } else {
    /* демо: тоже только принятые контакты */
    await refreshRequests();
    const ids = new Set(S.contacts.map((c) => c.userId));
    noContacts = ids.size === 0;
    users = S.users.filter((u) => u.id !== S.me?.id && ids.has(u.id));
  }

  if (q) {
    users = users.filter((u) => String(u.name || '').toLowerCase().includes(q)
      || String(u.username || '').toLowerCase().includes(q));
  }

  if (!users.length) {
    const hint = failed ? 'newchat.loadError' : noContacts ? 'newchat.noContacts' : 'newchat.empty';
    wrap.innerHTML = `<div class="nc-hint">${t(hint)}
      ${noContacts || failed ? `<button class="btn btn-ghost" type="button" data-find-people>${t('newchat.findPeople')}</button>` : ''}
      ${failed ? `<button class="btn btn-ghost" type="button" data-retry-contacts>${t('newchat.retry')}</button>` : ''}
      ${failed && errMsg ? `<div class="nc-err">${esc(errMsg)}</div>` : ''}
    </div>`;
    return;
  }

  wrap.innerHTML = users.map((u) => {
    const dm = S.chats.find((c) => c.kind === 'dm' && c.userId === u.id);
    return `<button class="contact" data-uid="${esc(u.id)}" data-hcid="${esc(dm?.id || '')}">
      ${avatarHtml(u, { online: u.seen === 'online' })}
      <span class="info">
        <span class="n">${esc(u.name)}</span>
        <span class="s">${u.username ? '@' + esc(u.username) : t('chat.' + u.seen)}</span>
      </span>
    </button>`;
  }).join('');
}

/* Добавить/обновить контакты в общем состоянии */
function mergeUsers(list) {
  for (const u of list) {
    const i = S.users.findIndex((x) => x.id === u.id);
    if (i >= 0) S.users[i] = { ...S.users[i], ...u };
    else S.users.push(u);
  }
}

/* клик по контакту → создать/открыть личный чат */
export async function contactClicked(e) {
  const c = e.target.closest('.contact[data-uid]');
  if (!c) return;
  $('#ncOv').hidden = true;
  location.hash = '#/app';
  await openDmWith(c.dataset.uid);
}

/* открыть (или создать) личный чат с человеком */
export async function openDmWith(uid) {
  if (!uid) return;
  const chat = S.chats.find((x) => x.kind === 'dm' && x.userId === uid);
  if (chat) { location.hash = `#/chat/${chat.id}`; return; }

  if (SUPABASE.url && SUPABASE.anonKey) {
    try {
      const chatId = await createDmChat(uid);
      await loadChats();
      location.hash = `#/chat/${chatId}`;
    } catch (err) {
      console.error('Create chat error:', err);
      toast(err.message || t('toast.error'));
    }
  } else {
    const fresh = {
      id: newId(), kind: 'dm', userId: uid, members: [uid],
      unread: 0, last: null,
    };
    S.chats.push(fresh);
    idb.put('chats', fresh);
    location.hash = `#/chat/${fresh.id}`;
  }
}

/* ── Поиск людей и заявки в контакты ───────────────────────── */

/* обновить заявки и счётчик на конверте */
export async function refreshRequests() {
  if (!S.me) return { incoming: [], outgoing: [], contacts: [] };
  let data = { incoming: [], outgoing: [], contacts: [] };
  try {
    /* в демо-режиме один раз показываем входящую заявку, чтобы был виден механизм */
    if (!(SUPABASE.url && SUPABASE.anonKey)) await seedDemoRequests(S.users);
    data = await listRequests();
  } catch (err) {
    console.error('Contact requests error:', err);
  }
  S.reqIn = data.incoming || [];
  S.reqOut = data.outgoing || [];
  S.contacts = data.contacts || [];
  updateReqBadge();
  return data;
}

export function updateReqBadge() {
  const badge = $('#reqBadge');
  if (!badge) return;
  const n = S.reqIn.length;
  badge.textContent = n > 99 ? '99+' : String(n);
  badge.hidden = n === 0;
  const btn = $('#requestsBtn');
  if (btn) btn.classList.toggle('has-requests', n > 0);
}

export function openPeople() {
  if (!$('#peopleOv')) return;
  $('#peopleSearch').value = '';
  $('#peopleOv').hidden = false;
  paintPeople();
  setTimeout(() => { try { $('#peopleSearch').focus(); } catch (e) { /* ignore */ } }, 80);
}

function relOf(uid) {
  const contact = S.contacts.find((c) => c.userId === uid);
  if (contact) return { kind: 'contact', reqId: contact.reqId };
  const inc = S.reqIn.find((r) => r.from === uid);
  if (inc) return { kind: 'incoming', reqId: inc.id };
  const out = S.reqOut.find((r) => r.to === uid);
  if (out) return { kind: 'outgoing', reqId: out.id };
  return { kind: 'none' };
}

function peopleActions(uid, rel) {
  if (rel.kind === 'contact') {
    return `<button class="pc-btn" type="button" data-pact="write" data-puid="${esc(uid)}">${esc(t('people.write'))}</button>`;
  }
  if (rel.kind === 'incoming') {
    return `<button class="pc-btn ok" type="button" data-pact="accept" data-preq="${esc(rel.reqId)}" data-puid="${esc(uid)}">${esc(t('req.accept'))}</button>`;
  }
  if (rel.kind === 'outgoing') {
    return `<button class="pc-btn" type="button" data-pact="cancel" data-preq="${esc(rel.reqId)}" data-puid="${esc(uid)}">${esc(t('req.cancel'))}</button>`;
  }
  return `<button class="pc-btn ok" type="button" data-pact="add" data-puid="${esc(uid)}">${esc(t('people.add'))}</button>`;
}

function peopleRow(u) {
  const rel = relOf(u.id);
  const sub = rel.kind === 'outgoing'
    ? esc(t('people.pendingOut'))
    : rel.kind === 'contact'
      ? esc(t('req.inContacts'))
      : u.username ? '@' + esc(u.username) : esc(t('chat.' + (u.seen || 'offline')));
  return `<div class="contact people-row" data-puid="${esc(u.id)}">
    ${avatarHtml(u, { online: u.seen === 'online' })}
    <span class="info">
      <span class="n">${esc(u.name)}</span>
      <span class="s">${sub}</span>
    </span>
    <span class="pc-act">${peopleActions(u.id, rel)}</span>
  </div>`;
}

async function paintPeople() {
  const wrap = $('#peopleList');
  if (!wrap || $('#peopleOv').hidden) return;
  const q = $('#peopleSearch').value.trim();
  if (!wrap.querySelector('.people-row')) wrap.innerHTML = `<div class="nc-hint">${t('people.loading')}</div>`;

  await refreshRequests();

  let profiles = [];
  let failed = '';
  if (SUPABASE.url && SUPABASE.anonKey) {
    try {
      profiles = await searchUsers(q);
    } catch (err) {
      console.error('People search error:', err);
      failed = String(err?.message || err || '').slice(0, 160);
    }
  } else {
    const needle = q.replace(/^@+/, '').toLowerCase();
    profiles = S.users
      .filter((u) => u.id !== S.me?.id)
      .filter((u) => !needle || u.name.toLowerCase().includes(needle))
      .map((u) => ({ id: u.id, display_name: u.name, avatar_hue: u.hue, avatar: u.avatar || null, username: u.username || null, role: u.role || 'user' }));
  }

  const users = profiles
    .filter((p) => p.id !== S.me?.id)
    .map((p) => ({ id: p.id, name: p.display_name, hue: p.avatar_hue, avatar: p.avatar || null, username: p.username || null, role: p.role || 'user' }));
  mergeUsers(users);

  /* контакты — первыми */
  users.sort((a, b) => {
    const ra = relOf(a.id).kind === 'contact' ? 0 : 1;
    const rb = relOf(b.id).kind === 'contact' ? 0 : 1;
    return ra - rb;
  });

  if (!users.length) {
    wrap.innerHTML = `<div class="nc-hint">${t(failed ? 'people.error' : (q ? 'people.empty' : 'people.hintEmpty'))}
      ${failed ? `<div class="nc-err">${esc(failed)}</div>` : ''}
    </div>`;
    return;
  }

  wrap.innerHTML = users.map(peopleRow).join('');
}

export async function openRequests() {
  if (!$('#reqOv')) return;
  $('#reqOv').hidden = false;
  paintRequests();
}

async function paintRequests() {
  const inWrap = $('#reqIn');
  const outWrap = $('#reqOut');
  const ctWrap = $('#reqContacts');
  if (!inWrap || $('#reqOv').hidden) return;
  inWrap.innerHTML = outWrap.innerHTML = ctWrap.innerHTML = `<div class="nc-hint">${t('people.loading')}</div>`;

  const ok = await contactsReady();
  if (!ok) {
    inWrap.innerHTML = `<div class="nc-hint">${t('req.needSql')}<div class="nc-err">supabase/contacts.sql</div></div>`;
    outWrap.innerHTML = '';
    ctWrap.innerHTML = '';
    return;
  }

  await refreshRequests();

  const rowsFor = (list, kind) => list.map((r) => {
    const uid = kind === 'in' ? r.from : (kind === 'out' ? r.to : r.userId);
    const u = user(uid);
    const name = u?.name || '…';
    const acts = kind === 'in'
      ? `<button class="pc-btn ok" type="button" data-pact="accept" data-preq="${esc(r.id)}" data-puid="${esc(uid)}">${esc(t('req.accept'))}</button>
         <button class="pc-btn" type="button" data-pact="decline" data-preq="${esc(r.id)}" data-puid="${esc(uid)}">${esc(t('req.decline'))}</button>`
      : kind === 'out'
        ? `<button class="pc-btn" type="button" data-pact="cancel" data-preq="${esc(r.id)}" data-puid="${esc(uid)}">${esc(t('req.cancel'))}</button>`
        : `<button class="pc-btn ok" type="button" data-pact="write" data-puid="${esc(uid)}">${esc(t('people.write'))}</button>
           <button class="pc-btn" type="button" data-pact="remove" data-puid="${esc(uid)}">${esc(t('req.remove'))}</button>`;
    return `<div class="contact people-row">
      ${avatarHtml(u)}
      <span class="info">
        <span class="n">${esc(name)}</span>
        <span class="s">${u?.username ? '@' + esc(u.username) : (kind === 'in' ? t('req.wants') : kind === 'out' ? t('people.pendingOut') : t('req.inContacts'))}</span>
      </span>
      <span class="pc-act">${acts}</span>
    </div>`;
  }).join('');

  inWrap.innerHTML = rowsFor(S.reqIn, 'in') || `<div class="nc-hint">${t('req.emptyIn')}</div>`;
  outWrap.innerHTML = rowsFor(S.reqOut, 'out') || `<div class="nc-hint">${t('req.emptyOut')}</div>`;
  ctWrap.innerHTML = rowsFor(S.contacts, 'ct') || `<div class="nc-hint">${t('req.emptyContacts')}</div>`;
}

/* действия в обоих окнах */
async function peopleAction(e) {
  const btn = e.target.closest('[data-pact]');
  if (!btn) {
    /* клик по строке контакта — открыть переписку */
    const row = e.target.closest('.people-row');
    if (row && relOf(row.dataset.puid).kind === 'contact') {
      closeOv($('#peopleOv'));
      closeOv($('#reqOv'));
      await openDmWith(row.dataset.puid);
    }
    return;
  }
  const act = btn.dataset.pact;
  const uid = btn.dataset.puid;
  const reqId = btn.dataset.preq;
  btn.disabled = true;
  try {
    if (act === 'add') {
      const status = await sendRequest(uid);
      toast(t(status === 'accepted' ? 'req.accepted' : 'req.sent'));
    } else if (act === 'accept') {
      await respondRequest(reqId, true);
      toast(t('req.accepted'));
    } else if (act === 'decline') {
      await respondRequest(reqId, false);
      toast(t('req.declined'));
    } else if (act === 'cancel') {
      await cancelRequest(reqId);
      toast(t('req.canceled'));
    } else if (act === 'remove') {
      await removeContact(uid);
      toast(t('req.removed'));
    } else if (act === 'write') {
      closeOv($('#peopleOv'));
      closeOv($('#reqOv'));
      await openDmWith(uid);
      return;
    }
  } catch (err) {
    console.error('Contact action error:', err);
    const msg = String(err?.message || err || '');
    toast(/could not find|does not exist|schema cache/i.test(msg) ? t('req.needSql') : (msg || t('toast.error')), { type: 'error' });
  }
  await refreshRequests();
  if (!$('#peopleOv').hidden) paintPeople();
  if (!$('#reqOv').hidden) paintRequests();
}

/* realtime: пришла заявка — показать сразу */
let reqSub = null;
export function startContactRealtime() {
  if (reqSub) return;
  reqSub = subscribeRequests(async (payload) => {
    await refreshRequests();
    if (payload?.eventType === 'INSERT' && $('#reqOv').hidden) {
      toast(t('req.toastNew'));
    }
    if (!$('#peopleOv').hidden) paintPeople();
    if (!$('#reqOv').hidden) paintRequests();
  });
}

/* ── создание группы ── */
export function openGroupCreator() {
  $('#ncOv').hidden = true;
  selectedGroupMembers.clear();
  $('#gcTitle').value = '';
  $('#gcSearch').value = '';
  $('#gcMembers').innerHTML = '';
  $('#gcOv').hidden = false;
  paintGroupContacts();
}

async function paintGroupContacts() {
  const wrap = $('#gcContacts');
  if (!wrap || $('#gcOv').hidden) return;
  const q = $('#gcSearch').value.toLowerCase().trim();
  if (!wrap.querySelector('.contact')) wrap.innerHTML = `<div class="nc-hint">${t('newchat.loading')}</div>`;

  let users;
  let failed = false;
  let errMsg = '';
  if (SUPABASE.url && SUPABASE.anonKey) {
    try {
      const profiles = await searchUsers(q);
      users = profiles
        .filter((p) => p.id !== S.me?.id)
        .map((p) => ({ id: p.id, name: p.display_name, hue: p.avatar_hue, avatar: p.avatar || null, username: p.username || null, role: p.role || 'user' }));
      mergeUsers(users);
    } catch (err) {
      console.error('Search users error:', err);
      failed = true;
      errMsg = String(err?.message || err || '').trim().slice(0, 160);
      users = S.users.filter((u) => !u.id.startsWith('u_') && (!q || u.name.toLowerCase().includes(q.toLowerCase())));
    }
  } else {
    users = S.users.filter((u) => u.id !== 'u_me' && (!q || u.name.toLowerCase().includes(q.toLowerCase())));
  }

  const available = users.filter((u) => !selectedGroupMembers.has(u.id));

  wrap.innerHTML = available.map((u) => `
    <button class="contact" data-gc-uid="${esc(u.id)}">
      ${avatarHtml(u)}
      <span class="info">
        <span class="n">${esc(u.name)}</span>
      </span>
    </button>
  `).join('') || `<div class="nc-hint">${t(failed ? 'group.searchError' : 'newchat.empty')}
    ${failed ? `<button class="btn btn-ghost" type="button" data-retry-groups>${t('newchat.retry')}</button>` : ''}
    ${failed && errMsg ? `<div class="nc-err">${esc(errMsg)}</div>` : ''}
  </div>`;

  wrap.querySelectorAll('[data-gc-uid]').forEach((btn) => {
    btn.addEventListener('click', () => {
      selectedGroupMembers.add(btn.dataset.gcUid);
      paintGroupMembers();
      paintGroupContacts();
    });
  });
}

function paintGroupMembers() {
  const container = $('#gcMembers');
  if (!container) return;

  container.innerHTML = Array.from(selectedGroupMembers).map((uid) => {
    const u = user(uid);
    return `<button class="group-member" data-uid="${esc(uid)}">
      ${avatarHtml(u)}
      <span>${esc(u.name)}</span>
      <span class="rm" data-rm="${esc(uid)}">${icon('x', 14)}</span>
    </button>`;
  }).join('');

  container.querySelectorAll('[data-rm]').forEach((btn) => {
    btn.addEventListener('click', (e) => {
      e.stopPropagation();
      selectedGroupMembers.delete(btn.dataset.rm);
      paintGroupMembers();
      paintGroupContacts();
    });
  });
}

async function createGroupChat() {
  const title = $('#gcTitle').value.trim();
  if (!title) { toast(t('group.needName'), { type: 'error' }); return; }
  if (!selectedGroupMembers.size) { toast(t('group.needMembers'), { type: 'error' }); return; }

  $('#gcOv').hidden = true;

  if (SUPABASE.url && SUPABASE.anonKey) {
    try {
      const group = await createGroup(title, Array.from(selectedGroupMembers));
      await loadChats();
      location.hash = `#/chat/${group.id}`;
    } catch (err) {
      console.error('Create group error:', err);
      toast(err.message || t('toast.error'));
    }
    return;
  }

  /* Демо-режим */
  const chatId = newId();
  const fresh = {
    id: chatId, kind: 'group', title, hue: 5,
    members: [...selectedGroupMembers],
    unread: 0, last: null,
  };
  S.chats.push(fresh);
  await idb.put('chats', fresh);
  renderSidebar();
  location.hash = `#/chat/${chatId}`;
}

/* экспортируем для доступа извне (main.js) */
export { selectedGroupMembers };
