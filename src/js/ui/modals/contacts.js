/* Relik — контакты: новый чат, поиск людей, заявки, realtime.
   Вынесено из modals.js; общий mergeUsers — в ./shared.js. */
import { S, user } from '../state.js';
import { $, esc, avatarHtml } from '../utils.js';
import { t } from '../../i18n/i18n.js';
import { idb, newId } from '../../db/idb.js';
import { SUPABASE } from '../../config.js';
import { toast } from '../toast.js';
import { loadChats } from '../sidebar.js';
import { searchUsers, createDmChat, profilesByIds } from '../../backend/chats.js';
import { listRequests, sendRequest, respondRequest, cancelRequest, removeContact, contactsReady, subscribeRequests, seedDemoRequests } from '../../backend/contacts.js';
import { mergeUsers, closeOv } from './shared.js';


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

export async function paintContacts() {
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

export async function paintPeople() {
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

export async function paintRequests() {
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
export async function peopleAction(e) {
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
