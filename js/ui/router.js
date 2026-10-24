/* Relik — простой hash-роутер: #/auth, #/app, #/chat/:id, #/join/:id */
import { S } from './state.js';
import { $ } from './utils.js';
import { showChat, openChat } from './chatView.js';
import { loadChats } from './sidebar.js';
import { joinConversation } from '../backend/chats.js';
import { SUPABASE } from '../config.js';
import { currentDevice } from './device.js';

export function showAuth(on = true) {
  $('#authView').hidden = !on;
  $('#appView').hidden = on;
}

export function showApp() {
  $('#authView').hidden = true;
  $('#appView').hidden = false;
}

export function route() {
  const h = location.hash;

  /* Ссылка-приглашение: если не вошли — запомним и покажем вход */
  if (h.startsWith('#/join/')) {
    const joinId = decodeURIComponent(h.slice(7));
    if (!S.me) {
      sessionStorage.setItem('relik.pendingJoin', joinId);
      showAuth();
      return;
    }
    showApp();
    handleJoin(joinId);
    return;
  }

  if (!S.me || h === '#/' || h === '' || h === '#/auth') {
    if (!S.me) { showAuth(); return; }
  }
  if (!S.me) { showAuth(); return; }
  showApp();
  if (h.startsWith('#/chat/')) {
    const id = decodeURIComponent(h.slice(7));
    if (currentDevice() === 'phone') $('#appView').classList.add('pane-chat');
    if (S.active !== id) openChat(id);
    else showChat();
  } else {
    if (currentDevice() === 'phone') $('#appView').classList.remove('pane-chat');
    showChat();
  }
}

/* Присоединение к чату по инвайт-ссылке */
async function handleJoin(joinId) {
  try {
    if (SUPABASE.url && SUPABASE.anonKey) {
      await joinConversation(joinId);
      await loadChats();
    }
    if (!S.chats.some((c) => c.id === joinId)) {
      await loadChats();
    }
  } catch (err) {
    console.error('Join error:', err);
  }
  location.hash = `#/chat/${joinId}`;
}

export function go(hash) {
  if (location.hash === hash) route();
  else location.hash = hash;
}

export function initRouter() {
  window.addEventListener('hashchange', route);
}
