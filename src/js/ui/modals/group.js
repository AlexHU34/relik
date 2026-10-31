/* Relik — управление группой: участники, название, выход.
   Вынесено из modals.js; зависит только от бэкенда групп и общих хелперов. */
import { S, user, emit } from '../state.js';
import { $, esc, avatarHtml } from '../utils.js';
import { icon } from '../icons.js';
import { t } from '../../i18n/i18n.js';
import { toast } from '../toast.js';
import { idb } from '../../db/idb.js';
import { SUPABASE } from '../../config.js';
import { confirmAction } from '../dialog.js';
import { renderSidebar } from '../sidebar.js';
import { addMemberToGroup, removeMemberFromGroup, updateGroupTitle, leaveGroup } from '../../backend/groups.js';
import { hasGroupKeysTable } from '../../backend/groupKeys.js';
import { searchUsers } from '../../backend/chats.js';
import { clearChatPrefs } from '../prefs.js';
import { mergeUsers } from './shared.js';


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

export async function paintGroupAddList() {
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

export async function addGroupMemberClicked(e) {
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

export async function saveGroupTitle() {
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

export async function leaveCurrentGroup() {
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
