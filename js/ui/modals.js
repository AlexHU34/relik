/* Relik — модальные окна: настройки, новый чат, создание группы, лайтбокс */
import { S, user, emit } from './state.js';
import { $, esc, avatarHtml, adminBadge } from './utils.js';
import { icon } from './icons.js';
import { t, lang, setLang } from '../i18n/i18n.js';
import { idb, newId } from '../db/idb.js';
import { APP, SUPABASE } from '../config.js';
import { toast } from './toast.js';
import { renderSidebar, loadChats } from './sidebar.js';
import { updateProfile, saveAvatar, normalizeUsername, isValidUsername, isUsernameTaken, hasUsernameColumn, signOutAll } from '../backend/auth.js';
import { searchUsers, createDmChat, listProfiles, setUserRole } from '../backend/chats.js';
import { createGroup } from '../backend/groups.js';
import { THEMES, applyTheme, currentTheme } from './themes.js';
import { FONTS, applyFont, applyFontStack, currentFontId, saveCustomFont } from './fonts.js';
import { soundsEnabled, setSounds } from './sounds.js';
import { notificationsEnabled, setNotifications } from './notify.js';
import { prefs, WALLPAPERS, ACCENTS, setTextSize, setWallpaper, setMotion, setEnterToSend, setAccent, setCustomWall, clearChatPrefs } from './prefs.js';
import { confirmAction } from './dialog.js';
import { addMemberToGroup, removeMemberFromGroup, updateGroupTitle, leaveGroup } from '../backend/groups.js';
import { canInstall, promptInstall } from './install.js';
import { exportChats } from './export.js';
import { hasPin, enablePin, disablePin, changePin } from './pin.js';
import { hasGroupKeysTable } from '../backend/groupKeys.js';
import { storageAvailable } from '../backend/storage.js';

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
const paintAdminUsersDebounced = debounce(paintAdminUsers);
const paintGroupAddDebounced = debounce(paintGroupAddList);

export function initModals() {
  /* статичные иконки закрытия */
  document.querySelectorAll('.m-head [data-close]').forEach((b) => { b.innerHTML = icon('x', 18); });
  $('#lbX').innerHTML = icon('x', 20);
  $('#lbDl').innerHTML = icon('dl', 20);
  $('#lbDl').title = t('media.download');
  $('#lbDl').setAttribute('aria-label', t('media.download'));
  $('#ncGroupIc').innerHTML = icon('users', 18);

  /* закрытие по крестику и клику по фону любого оверлея */
  document.querySelectorAll('.overlay').forEach((ov) => {
    ov.addEventListener('click', (e) => { if (e.target === ov) closeOv(ov); });
    ov.querySelectorAll('[data-close]').forEach((btn) => {
      btn.addEventListener('click', () => closeOv(ov));
    });
  });
  document.addEventListener('keydown', (e) => {
    if (e.key !== 'Escape') return;
    if (!$('#lightbox').hidden) closeLightbox();
    else {
      closeOv($('#settingsOv')); closeOv($('#ncOv')); closeOv($('#gcOv'));
      closeOv($('#pollOv')); closeOv($('#adminOv')); closeOv($('#profileOv'));
      closeOv($('#groupOv')); closeOv($('#readOv'));
    }
  });

  /* ── настройки ── */
  $('#saveProfile').addEventListener('click', saveProfile);
  $('#langSeg').addEventListener('click', (e) => {
    const b = e.target.closest('[data-lang]');
    if (b) setLang(b.dataset.lang);
    paintLangSeg();
  });
  document.addEventListener('relik:lang', paintLangSeg);

  /* ── новый чат ── */
  $('#ncSearch').addEventListener('input', paintContactsDebounced);
  $('#ncGroup').addEventListener('click', openGroupCreator);
  $('#lbX').addEventListener('click', closeLightbox);
  $('#lbDl').addEventListener('click', downloadLightbox);
  document.addEventListener('relik:lang', paintContacts);

  /* ── создание группы ── */
  $('#gcSearch').addEventListener('input', paintGroupContactsDebounced);
  $('#gcCreate').addEventListener('click', createGroupChat);

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
  $('#adminUsersBtn').addEventListener('click', openAdminUsers);
  $('#adminSearch').addEventListener('input', paintAdminUsersDebounced);

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
  });
}

function closeOv(ov) {
  if (ov) ov.hidden = true;
}

/* ── ЛАЙТБОКС ── */
let lightboxSrc = '';
let lightboxName = 'relik-image.jpg';

export function openLightbox(src, name) {
  lightboxSrc = String(src || '');
  lightboxName = name ? String(name) : 'relik-image.jpg';
  $('#lbImg').src = lightboxSrc;
  $('#lbImg').alt = lightboxName;
  $('#lightbox').hidden = false;
}
function closeLightbox() {
  $('#lightbox').hidden = true;
  $('#lbImg').src = '';
  lightboxSrc = '';
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
  $('#adminField').hidden = S.me?.role !== 'admin';
  const allBtn = $('#logoutAllBtn');
  if (allBtn) allBtn.hidden = !(SUPABASE.url && SUPABASE.anonKey);
  paintAvatar();
  paintMigrationStatus();
  const body = $('#settingsOv .m-body');
  if (body) body.scrollTop = 0;
  $('#settingsOv').hidden = false;
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

function paintPinSettings() {
  const on = hasPin();
  const toggle = $('#pinToggle');
  if (toggle) toggle.checked = on;
  const btn = $('#pinChangeBtn');
  if (btn) btn.hidden = !on;
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
  el.innerHTML = S.me?.avatar
    ? `<img src="${esc(S.me.avatar)}" alt="">`
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

function paintLangSeg() {
  document.querySelectorAll('#langSeg [data-lang]').forEach((b) => {
    b.classList.toggle('on', b.dataset.lang === lang);
  });
}

async function saveProfile() {
  const name = $('#nameInput').value.trim();
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
  setTimeout(() => $('#groupTitleInput').focus(), 60);
}

function canManageGroup(chat) {
  if (!chat) return false;
  if (S.me?.role === 'admin') return true;
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
        <span class="n">${esc(u.name)}${me ? ` <em class="member-you">${t('group.you')}</em>` : ''}${adminBadge(u)}</span>
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
      <span class="info"><span class="n">${esc(u.name)}${adminBadge(u)}</span>
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

/* ── АДМИН: список пользователей ── */
async function openAdminUsers() {
  $('#adminSearch').value = '';
  $('#adminOv').hidden = false;
  await paintAdminUsers();
}

async function paintAdminUsers() {
  const wrap = $('#adminList');
  wrap.innerHTML = `<div class="nc-hint">…</div>`;

  try {
    const q = $('#adminSearch').value.trim().replace(/^@+/, '').toLowerCase();
    const list = (await listProfiles()).filter((p) => {
      if (!q) return true;
      return String(p.display_name || '').toLowerCase().includes(q) ||
        String(p.username || '').toLowerCase().includes(q);
    });
    wrap.innerHTML = list.map((p) => {
      const role = p.role || 'user';
      const isMe = p.id === S.me?.id;
      const next = role === 'admin' ? 'user' : 'admin';
      const label = role === 'admin' ? t('admin.unmake') : t('admin.make');
      return `<div class="admin-user">
        ${avatarHtml({ name: p.display_name, hue: p.avatar_hue })}
        <span class="info">
          <span class="n">${esc(p.display_name)}${adminBadge(p)}${isMe ? ` <span class="field-hint">(${t('admin.you')})</span>` : ''}</span>
          <span class="u">${p.username ? '@' + esc(p.username) : '—'}</span>
        </span>
        ${isMe ? '' : `<button class="btn btn-ghost" type="button" data-role-uid="${esc(p.id)}" data-role="${next}">${label}</button>`}
      </div>`;
    }).join('') || `<div class="nc-hint">${t('admin.empty')}</div>`;

    wrap.querySelectorAll('[data-role-uid]').forEach((btn) => {
      btn.addEventListener('click', async () => {
        btn.disabled = true;
        try {
          await setUserRole(btn.dataset.roleUid, btn.dataset.role);
          const u = S.users.find((x) => x.id === btn.dataset.roleUid);
          if (u) u.role = btn.dataset.role;
          toast(t('settings.saved'));
          await paintAdminUsers();
        } catch (err) {
          console.error('Set role error:', err);
          toast(t('admin.error'));
          btn.disabled = false;
        }
      });
    });
  } catch (err) {
    console.error('Admin list error:', err);
    wrap.innerHTML = `<div class="nc-hint">${esc(err.message || t('toast.error'))}</div>`;
  }
}

/* ── НОВЫЙ ЧАТ ── */
export function openNewChat() {
  $('#ncSearch').value = '';
  $('#ncOv').hidden = false;
  paintContacts();
}

async function paintContacts() {
  const wrap = $('#ncList');
  if (!wrap || $('#ncOv').hidden) return;
  const q = $('#ncSearch').value.trim();

  let users;
  if (SUPABASE.url && SUPABASE.anonKey) {
    try {
      const profiles = await searchUsers(q);
      users = profiles
        .filter((p) => p.id !== S.me?.id)
        .map((p) => ({ id: p.id, name: p.display_name, hue: p.avatar_hue, avatar: p.avatar || null, username: p.username || null, role: p.role || 'user', seen: 'offline' }));
      mergeUsers(users);
    } catch (err) {
      console.error('Search users error:', err);
      users = S.users.filter((u) => !u.id.startsWith('u_') && (!q || u.name.toLowerCase().includes(q.toLowerCase())));
    }
  } else {
    users = S.users.filter((u) => !q || u.name.toLowerCase().includes(q.toLowerCase()));
  }

  wrap.innerHTML = users.map((u) => {
    const dm = S.chats.find((c) => c.kind === 'dm' && c.userId === u.id);
    return `<button class="contact" data-uid="${esc(u.id)}" data-hcid="${esc(dm?.id || '')}">
      ${avatarHtml(u, { online: u.seen === 'online' })}
      <span class="info">
        <span class="n">${esc(u.name)}${adminBadge(u)}</span>
        <span class="s">${u.username ? '@' + esc(u.username) : t('chat.' + u.seen)}</span>
      </span>
    </button>`;
  }).join('') || `<div class="nc-hint">${t('newchat.empty')}</div>`;
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
  const uid = c.dataset.uid;
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
    const u = user(uid);
    const fresh = {
      id: newId(), kind: 'dm', userId: uid, members: [uid],
      unread: 0, last: null,
    };
    S.chats.push(fresh);
    idb.put('chats', fresh);
    location.hash = `#/chat/${fresh.id}`;
  }
}

/* ── создание группы ── */
function openGroupCreator() {
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

  let users;
  if (SUPABASE.url && SUPABASE.anonKey) {
    try {
      const profiles = await searchUsers(q);
      users = profiles
        .filter((p) => p.id !== S.me?.id)
        .map((p) => ({ id: p.id, name: p.display_name, hue: p.avatar_hue, avatar: p.avatar || null, username: p.username || null, role: p.role || 'user' }));
      mergeUsers(users);
    } catch (err) {
      console.error('Search users error:', err);
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
        <span class="n">${esc(u.name)}${adminBadge(u)}</span>
      </span>
    </button>
  `).join('') || `<div class="nc-hint">${t('newchat.empty')}</div>`;

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
      <span>${esc(u.name)}${adminBadge(u)}</span>
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
