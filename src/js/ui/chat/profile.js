/* Relik — карточка собеседника: отпечаток ключа, QR, жалоба, медиа-галерея.
   Вынесено из chatView: у этого блока своё состояние и нет обратных зависимостей. */
/* global qrcode */
import { S, chatById } from '../state.js';
import { $, esc, avatarHtml, safeImgSrc } from '../utils.js';
import { icon } from '../icons.js';
import { t } from '../../i18n/i18n.js';
import { toast } from '../toast.js';
import { idb } from '../../db/idb.js';
import { sb } from '../../backend/supabaseClient.js';
import { logEvent } from '../../backend/telemetry.js';
import { isBlocked, blockUser, unblockUser } from '../../backend/blocks.js';
import { confirmAction } from '../dialog.js';
import { renderSidebar } from '../sidebar.js';
import { syncExpanded, setLabel } from '../a11y.js';
import { openLightbox, openGroupManager } from '../modals.js';
import { fingerprintForPair } from '../../crypto/fingerprint.js';
import { paintTtl } from './ttl.js';

const FP_KEY = 'relik.fp.v1';
let profileFp = null;            // { chatId, peerId, fullHex, display, changed }
const fpWarned = new Set();      // чтобы не повторять тост при каждом открытии

/* ── отпечаток ключа ──────────────────────────────────────── */
function loadFpSeen() {
  try {
    const raw = JSON.parse(localStorage.getItem(FP_KEY) || '{}');
    return raw && typeof raw === 'object' ? raw : {};
  } catch (e) {
    return {};
  }
}

function saveFpSeen(peerId, fullHex) {
  if (!peerId || !fullHex) return;
  try {
    const all = loadFpSeen();
    all[peerId] = fullHex;
    localStorage.setItem(FP_KEY, JSON.stringify(all));
  } catch (e) { /* приватный режим */ }
}

async function peerFingerprint(chat) {
  if (!chat || chat.kind !== 'dm' || !chat.userId) return null;
  if (!S.me?.id || !S.me?.publicKey || !chat.publicKey) return null;
  try {
    const fp = await fingerprintForPair(S.me.id, S.me.publicKey, chat.userId, chat.publicKey);
    const seen = loadFpSeen();
    const previous = seen[chat.userId] || '';
    return { ...fp, peerId: chat.userId, changed: !!previous && previous !== fp.fullHex };
  } catch (err) {
    return null;
  }
}

export async function renderProfileFingerprint(chat) {
  const block = $('#profileFp');
  if (!block) return;
  profileFp = null;
  block.hidden = true;
  const qrBox = $('#fpQr');
  if (qrBox) { qrBox.hidden = true; qrBox.innerHTML = ''; }
  const qrBtn = $('#fpQrBtn');
  if (qrBtn) qrBtn.textContent = t('fp.qr');
  const fp = await peerFingerprint(chat);
  if (!fp || S.active !== chat.id) return;

  profileFp = { chatId: chat.id, ...fp };
  block.hidden = false;
  const code = $('#fpCode');
  if (code) {
    code.textContent = fp.display;
    code.title = t('fp.copy');
  }
  const warn = $('#fpWarn');
  if (warn) warn.hidden = !fp.changed;
  const accept = $('#fpAccept');
  if (accept) accept.hidden = !fp.changed;
  if (!loadFpSeen()[chat.userId]) saveFpSeen(chat.userId, fp.fullHex);
}

export async function warnPeerKeyChange(chat) {
  const fp = await peerFingerprint(chat);
  if (!fp || S.active !== chat.id) return;
  if (!loadFpSeen()[chat.userId]) {
    saveFpSeen(chat.userId, fp.fullHex);
    return;
  }
  if (fp.changed) {
    if (fpWarned.has(chat.id)) return;
    fpWarned.add(chat.id);
    toast(t('fp.changedToast'), {
      type: 'warn',
      duration: 0,
      action: {
        label: t('fp.check'),
        onClick: () => {
          if (chatById(chat.id)) {
            S.active = chat.id;
            location.hash = `#/chat/${chat.id}`;
            openChatProfile();
          }
        },
      },
    });
  }
}

export function copyProfileFingerprint() {
  if (!profileFp?.display) return;
  const text = profileFp.display;
  const done = () => toast(t('fp.copied'), { type: 'success' });
  if (navigator.clipboard?.writeText) {
    navigator.clipboard.writeText(text).then(done).catch(() => toast(text));
  } else {
    toast(text);
  }
}

/* Подтвердить новый отпечаток (кнопка «Проверил»). */
export function acceptFingerprint() {
  if (!profileFp) return;
  saveFpSeen(profileFp.peerId, profileFp.fullHex);
  profileFp.changed = false;
  const warn = $('#fpWarn');
  if (warn) warn.hidden = true;
  const accept = $('#fpAccept');
  if (accept) accept.hidden = true;
  toast(t('fp.accepted'), { type: 'success' });
}

/* qrcode.js — 55 КБ, нужен только для QR в карточке безопасности.
   Грузим по требованию: при первом запуске эти килобайты не конкурируют
   с модулями приложения (важно на мобильном интернете). */
let qrLibPromise = null;

function loadQrLib() {
  if (typeof qrcode === 'function') return Promise.resolve(true);
  if (qrLibPromise) return qrLibPromise;
  qrLibPromise = new Promise((resolve) => {
    const s = document.createElement('script');
    s.src = new URL('js/vendor/qrcode.js', document.baseURI).href;
    s.onload = () => resolve(typeof qrcode === 'function');
    s.onerror = () => { qrLibPromise = null; resolve(false); };
    document.head.appendChild(s);
  });
  return qrLibPromise;
}

export async function toggleProfileQr() {
  const box = $('#fpQr');
  const btn = $('#fpQrBtn');
  if (!box || !profileFp) return;
  if (!box.hidden) {
    box.hidden = true;
    box.innerHTML = '';
    if (btn) btn.textContent = t('fp.qr');
    syncExpanded();
    return;
  }
  const ready = await loadQrLib();
  if (!ready) {
    toast(t('fp.qrError'), { type: 'error' });
    return;
  }
  if (!box.hidden) return; // пока грузили, окно уже открыли
  try {
    const qr = qrcode(0, 'M');
    qr.addData(profileFp.fullHex);
    qr.make();
    box.innerHTML = qr.createSvgTag({ cellSize: 4, margin: 1 });
    box.hidden = false;
    if (btn) btn.textContent = t('fp.qrHide');
    setLabel('fpQrBtn', 'fp.qrHide');
    syncExpanded();
  } catch (err) {
    console.warn('QR error:', err);
    toast(t('fp.qrError'), { type: 'error' });
  }
}

/* ── жалоба на сообщение ───────────────────────────────────── */
const REPORT_REASONS = [
  { code: 'spam', key: 'report.r.spam' },
  { code: 'scam', key: 'report.r.scam' },
  { code: 'threat', key: 'report.r.threat' },
  { code: 'illegal', key: 'report.r.illegal' },
  { code: 'other', key: 'report.r.other' },
];

function pickReportReason() {
  return new Promise((resolve) => {
    const ov = document.createElement('div');
    ov.className = 'overlay';
    ov.innerHTML = `
      <div class="modal" role="dialog" aria-modal="true">
        <header class="m-head">
          <h3>${esc(t('report.title'))}</h3>
          <button class="icon-btn" data-close type="button" aria-label="${esc(t('common.close'))}"></button>
        </header>
        <div class="m-body">
          <p class="field-hint">${esc(t('report.pick'))}</p>
          <div class="report-reasons">
            ${REPORT_REASONS.map((r) => `<button class="contact" type="button" data-reason="${r.code}">
              <span class="info"><span class="n">${esc(t(r.key))}</span></span>
            </button>`).join('')}
          </div>
          <p class="field-hint">${esc(t('report.text'))}</p>
        </div>
      </div>`;
    const done = (value) => { ov.remove(); resolve(value); };
    ov.addEventListener('click', (e) => {
      if (e.target.closest('[data-close]') || e.target === ov) return done(null);
      const b = e.target.closest('[data-reason]');
      if (b) done(b.dataset.reason);
    });
    document.body.appendChild(ov);
  });
}

export async function reportMessage(m) {
  const chat = chatById(S.active);
  if (!chat || !m) return;
  const reason = await pickReportReason();
  if (!reason) return;
  try {
    const { error } = await sb.from('reports').insert({
      chat_id: chat.id,
      message_id: m.id,
      reporter_id: S.me.id,
      sender_id: m.sender === 'u_me' ? S.me.id : m.sender,
      message_ts: new Date(m.ts).toISOString(),
      reason: 'user_report:' + reason,
    });
    if (error) throw error;
    toast(t('report.sent'), { type: 'success' });
    logEvent('report_sent', { chat: chat.kind });
  } catch (err) {
    const msg = String(err?.message || '');
    toast(/does not exist|42P01|schema cache|relation/i.test(msg) ? t('report.needSql') : t('report.failed'), { type: 'error' });
  }
}

/* ── медиа-галерея чата ───────────────────────────────────── */
export async function openChatMedia() {
  const chat = chatById(S.active);
  if (!chat) return;
  $('#profileOv').hidden = true;
  const grid = $('#mediaGrid');
  grid.innerHTML = `<div class="nc-hint">${t('people.loading')}</div>`;
  $('#mediaOv').hidden = false;

  let all = [];
  try {
    all = await idb.messagesOf(chat.id);
  } catch (e) { all = S.messages[chat.id] || []; }

  const items = [];
  for (const m of all) {
    if (m.hidden || m.localDeleted || m.deleted) continue;
    if (m.type === 'image' && m.file?.src) items.push({ src: m.file.src, name: m.file.name, kind: 'img', ts: m.ts });
    if (m.type === 'video' && (m.thumb || m.file?.src)) items.push({ src: m.thumb || m.file.src, name: m.file?.name, kind: 'vid', ts: m.ts });
    if (m.type === 'videoNote' && m.thumb) items.push({ src: m.thumb, name: t('msg.videoNote'), kind: 'vid', ts: m.ts });
    if (m.type === 'album') {
      for (const it of m.album || []) {
        if (it?.src) items.push({ src: it.src, name: it.name, kind: 'img', ts: m.ts });
      }
    }
  }

  if (!items.length) {
    grid.innerHTML = `<div class="nc-hint">${t('media.empty')}</div>`;
    return;
  }

  grid.innerHTML = items
    .sort((a, b) => (b.ts || 0) - (a.ts || 0))
    .map((it, i) => `<button type="button" class="media-cell" data-media-idx="${i}">
      ${safeImgSrc(it.src)
        ? `<img src="${esc(safeImgSrc(it.src))}" loading="lazy" decoding="async" alt="">`
        : `<span style="display:grid;place-items:center;width:100%;height:100%;color:var(--tx-3)">${icon('image', 22)}</span>`}
      ${it.kind === 'vid' ? `<span class="media-play">${icon('play', 18)}</span>` : ''}
    </button>`).join('');

  grid.onclick = (e) => {
    const b = e.target.closest('[data-media-idx]');
    if (!b) return;
    const it = items[Number(b.dataset.mediaIdx)];
    if (!it) return;
    openLightbox(it.src, it.name || 'relik-media');
  };
}

/* ── карточка собеседника / группы ────────────────────────── */
export function openChatProfile() {
  const chat = chatById(S.active);
  if (!chat) return;

  const isDm = chat.kind === 'dm';
  const u = isDm
    ? (S.users.find((x) => x.id === chat.userId) || { name: chat.title || '…', hue: chat.hue ?? 0, seen: 'offline' })
    : { name: chat.title || '…', hue: chat.hue ?? 5 };

  $('#profileHero').innerHTML = avatarHtml(u, { lg: true });
  $('#profileName').innerHTML = esc(u.name);
  $('#profileUsername').textContent = isDm && u.username ? '@' + u.username : '';
  $('#profileStatus').textContent = isDm
    ? (u.seen === 'online' ? t('chat.online') : t('chat.' + u.seen))
    : t('chat.members').replace('{n}', String((chat.members?.length || 0) + 1));

  $('#profileCall').hidden = !isDm;
  $('#profileVideo').hidden = !isDm;
  const blockBtn = $('#profileBlock');
  if (blockBtn) {
    const blocked = isDm && isBlocked(chat.userId);
    blockBtn.hidden = !isDm;
    blockBtn.textContent = t(blocked ? 'profile.unblock' : 'profile.block');
    blockBtn.classList.toggle('btn-danger-soft', !blocked);
    blockBtn.onclick = async () => {
      if (!isDm) return;
      const ok = await confirmAction({
        title: t(blocked ? 'profile.unblockTitle' : 'profile.blockTitle'),
        text: t(blocked ? 'profile.unblockText' : 'profile.blockText'),
        ok: t(blocked ? 'profile.unblock' : 'profile.block'),
        danger: !blocked,
        iconName: 'shield',
      });
      if (!ok) return;
      try {
        if (blocked) await unblockUser(chat.userId);
        else await blockUser(chat.userId);
        toast(t(blocked ? 'profile.unblocked' : 'profile.blocked'));
        $('#profileOv').hidden = true;
        renderSidebar();
      } catch (err) {
        toast(err?.message || t('toast.error'), { type: 'error' });
      }
    };
  }
  const manage = $('#profileManage');
  if (manage) {
    manage.hidden = isDm;
    manage.onclick = () => {
      $('#profileOv').hidden = true;
      openGroupManager(chat);
    };
  }
  renderProfileFingerprint(chat).catch(() => {});
  paintTtl(chat);
  const mediaBtn = $('#profileMedia');
  if (mediaBtn) mediaBtn.onclick = () => openChatMedia();
  $('#profileOv').hidden = false;
}
