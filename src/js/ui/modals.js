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
import { searchUsers, createDmChat, profilesByIds } from '../backend/chats.js';
import { listRequests, sendRequest, respondRequest, cancelRequest, removeContact, contactsReady, subscribeRequests, seedDemoRequests } from '../backend/contacts.js';
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

function closeOv(ov) {
  if (ov) ov.hidden = true;
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
