/* Relik — модальные окна: новый чат, группа, люди, поиск, лайтбокс.
   Настройки — в ./modals/settings.js, просмотр медиа — в ./modals/lightbox.js. */
import { S, user, chatById, chatTitle } from './state.js';
import { $, esc, avatarHtml, fmtTime } from './utils.js';
import { icon } from './icons.js';
import { t, setLang } from '../i18n/i18n.js';
import { idb, newId } from '../db/idb.js';
import { SUPABASE } from '../config.js';
import { toast } from './toast.js';
import { renderSidebar, loadChats } from './sidebar.js';
import { signOutAll, deleteAccount } from '../backend/auth.js';
import { searchUsers } from '../backend/chats.js';
import { pushState, enablePush, disablePush } from '../backend/push.js';
import { openKeyPanel } from './keyRecovery.js';
import { createGroup } from '../backend/groups.js';
import { applyTheme, currentTheme } from './themes.js';
import { applyFont, applyFontStack, saveCustomFont } from './fonts.js';
import { setSounds } from './sounds.js';
import { setNotifications } from './notify.js';
import { prefs, setTextSize, setWallpaper, setMotion, setEnterToSend, setAccent, setCustomWall, setHideOnline } from './prefs.js';
import { confirmAction } from './dialog.js';
import { canInstall, promptInstall } from './install.js';
import { exportChats } from './export.js';
import { enablePin, disablePin, changePin, lockNow } from './pin.js';
import { openLightbox, stepLightbox, closeLightbox, downloadLightbox } from './modals/lightbox.js';
import {
  openPeople, paintPeople, paintRequests, peopleAction, paintContacts,
} from './modals/contacts.js';
export {
  openNewChat, contactClicked, openDmWith, refreshRequests,
  updateReqBadge, openPeople, openRequests, startContactRealtime,
} from './modals/contacts.js';
import { closeOv, mergeUsers } from './modals/shared.js';
import {
  openGroupManager, addGroupMemberClicked, saveGroupTitle, leaveCurrentGroup, paintGroupAddList,
} from './modals/group.js';
import {
  openSettings, saveProfile, paintSecNav, paintProfileDirty, paintLangSeg,
  paintThemes, paintFonts, paintTextSize, paintWalls, paintAccents, wallToDataUrl,
  paintPinSettings, paintStorage, clearStorageCache,
  compactHistory, askPersistentStorage, handleAvatar, clearLocalCache,
} from './modals/settings.js';

export { openLightbox, openSettings, openGroupManager };


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

/* closeOv импортируется из ./modals/shared.js */



/* Закрыть все «мимолётные» окна: Esc и любая навигация по хешу */
export function closeTransientOverlays() {
  closeOv($('#settingsOv')); closeOv($('#ncOv')); closeOv($('#gcOv'));
  closeOv($('#pollOv')); closeOv($('#profileOv'));
  closeOv($('#groupOv')); closeOv($('#readOv'));
  closeOv($('#peopleOv')); closeOv($('#reqOv')); closeOv($('#gsOv'));
  closeOv($('#mediaOv')); closeOv($('#scheduleOv')); closeOv($('#schedListOv')); closeOv($('#fwdOv'));
  closeOv($('#keyOv')); closeOv($('#keyPhraseOv'));
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
