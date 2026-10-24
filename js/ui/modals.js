/* Relik — модальные окна: настройки, новый чат, создание группы, лайтбокс */
import { S, user } from './state.js';
import { $, esc, avatarHtml } from './utils.js';
import { icon } from './icons.js';
import { t, lang, setLang } from '../i18n/i18n.js';
import { idb, newId } from '../db/idb.js';
import { APP, SUPABASE } from '../config.js';
import { toast } from './toast.js';
import { renderSidebar, loadChats } from './sidebar.js';
import { updateProfile, saveAvatar } from '../backend/auth.js';
import { searchUsers, createDmChat } from '../backend/chats.js';
import { createGroup } from '../backend/groups.js';
import { THEMES, applyTheme, currentTheme } from './themes.js';
import { FONTS, applyFont, applyFontStack, currentFontId, saveCustomFont } from './fonts.js';
import { soundsEnabled, setSounds } from './sounds.js';
import { currentDevice } from './device.js';

let selectedGroupMembers = new Set();

export function initModals() {
  /* статичные иконки закрытия */
  document.querySelectorAll('.m-head [data-close]').forEach((b) => { b.innerHTML = icon('x', 18); });
  $('#lbX').innerHTML = icon('x', 20);
  $('#ncGroupIc').innerHTML = icon('users', 18);

  /* закрытие по крестику и клику по фону любого оверлея */
  document.querySelectorAll('.overlay').forEach((ov) => {
    ov.addEventListener('click', (e) => { if (e.target === ov) closeOv(ov); });
    const btn = ov.querySelector('[data-close]');
    if (btn) btn.addEventListener('click', () => closeOv(ov));
  });
  document.addEventListener('keydown', (e) => {
    if (e.key !== 'Escape') return;
    if (!$('#lightbox').hidden) closeLightbox();
    else { closeOv($('#settingsOv')); closeOv($('#ncOv')); closeOv($('#gcOv')); }
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
  $('#ncSearch').addEventListener('input', paintContacts);
  $('#ncGroup').addEventListener('click', openGroupCreator);
  $('#lbX').addEventListener('click', closeLightbox);
  document.addEventListener('relik:lang', paintContacts);

  /* ── создание группы ── */
  $('#gcSearch').addEventListener('input', paintGroupContacts);
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
  $('#avatarBtn').addEventListener('click', () => $('#avatarInput').click());
  $('#avatarInput').addEventListener('change', handleAvatar);
}

function closeOv(ov) {
  if (ov) ov.hidden = true;
}

/* ── ЛАЙТБОКС ── */
export function openLightbox(src) {
  $('#lbImg').src = src;
  $('#lightbox').hidden = false;
}
function closeLightbox() { $('#lightbox').hidden = true; }

/* ── НАСТРОЙКИ ── */
export function openSettings() {
  $('#nameInput').value = S.me?.name || '';
  $('#verStr').textContent = `v${APP.version} · ${APP.phase}`;
  paintLangSeg();
  paintThemes();
  paintFonts();
  $('#soundsToggle').checked = soundsEnabled();
  paintAvatar();
  $('#settingsOv').hidden = false;
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
  if (cur === 'custom') opts += '<option value="custom">Свой шрифт</option>';
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

  try {
    if (SUPABASE.url && SUPABASE.anonKey) {
      await updateProfile({ display_name: name });
    } else {
      S.me.name = name;
      await idb.put('settings', { key: 'me', value: S.me });
    }
    renderSidebar();
    toast(t('settings.saved'));
    $('#settingsOv').hidden = true;
  } catch (err) {
    toast(err.message || t('settings.error'));
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
        .map((p) => ({ id: p.id, name: p.display_name, hue: p.avatar_hue, avatar: p.avatar || null, seen: 'offline' }));
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
    return `<button class="contact" data-uid="${u.id}" data-hcid="${dm?.id || ''}">
      ${avatarHtml(u, { online: u.seen === 'online' })}
      <span class="info">
        <span class="n">${esc(u.name)}</span>
        <span class="s">${t('chat.' + u.seen)}</span>
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
        .map((p) => ({ id: p.id, name: p.display_name, hue: p.avatar_hue, avatar: p.avatar || null }));
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
    <button class="contact" data-gc-uid="${u.id}">
      ${avatarHtml(u)}
      <span class="info">
        <span class="n">${esc(u.name)}</span>
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
    return `<button class="group-member" data-uid="${uid}">
      ${avatarHtml(u)}
      <span>${esc(u.name)}</span>
      <span class="rm" data-rm="${uid}">${icon('x', 14)}</span>
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
  if (!title) { toast(t('group.needName')); return; }

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
