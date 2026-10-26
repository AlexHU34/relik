/* Relik — резервная копия ключа: файл и кодовая фраза (12 слов).
   Открывается из настроек и автоматически, если после сброса пароля
   бэкап не расшифровался. */

import { t } from '../i18n/i18n.js';
import { esc } from './utils.js';
import { toast } from './toast.js';
import { confirmAction } from './dialog.js';
import { S } from './state.js';
import * as R from '../crypto/recovery.js';
import {
  getLocalPrivateKeyJwk, savePrivateKey, savePasswordBackup,
  getRecoveryBlob, saveRecoveryBlob,
} from '../backend/keyStore.js';

let rememberedPassword = '';
let phraseWords = '';

export function setReencryptPassword(pw) {
  rememberedPassword = String(pw || '');
}

/* ── каркас оверлеев ─────────────────────────────────────── */

function overlay(id) {
  let ov = document.getElementById(id);
  if (ov) return ov;
  ov = document.createElement('div');
  ov.className = 'overlay';
  ov.id = id;
  ov.hidden = true;
  ov.innerHTML = '<div class="modal" role="dialog" aria-modal="true"><header class="m-head">'
    + `<h3></h3><button class="icon-btn" data-close type="button" aria-label="${esc(t('common.close'))}"></button>`
    + '</header><div class="m-body"></div></div>';
  document.body.appendChild(ov);
  ov.addEventListener('click', (e) => {
    if (e.target.closest('[data-close]') || e.target === ov) {
      if (ov.dataset.locked === '1') return;
      ov.hidden = true;
    }
  });
  return ov;
}

function open(id, title, bodyHtml, { locked = false } = {}) {
  const ov = overlay(id);
  ov.dataset.locked = locked ? '1' : '';
  ov.querySelector('h3').textContent = title;
  const closeBtn = ov.querySelector('[data-close]');
  if (closeBtn) closeBtn.hidden = locked;
  ov.querySelector('.m-body').innerHTML = bodyHtml;
  ov.hidden = false;
  return ov;
}

function close(id) {
  const ov = document.getElementById(id);
  if (ov) { ov.hidden = true; ov.dataset.locked = ''; }
}

/* ── настройки: резервная копия ──────────────────────────── */

export function refreshKeyStatus() {
  const el = document.getElementById('keyStatus');
  if (!el) return;
  getRecoveryBlob().then((blob) => {
    const hasKey = !!S.me?.privateKey;
    if (!hasKey) el.textContent = t('key.statusNoKey');
    else if (blob) el.textContent = t('key.statusOn');
    else el.textContent = t('key.statusOff');
    el.style.color = blob && hasKey ? 'var(--ok, #3ecf8e)' : 'var(--warn, #e0a23c)';
  }).catch(() => { el.textContent = t('key.statusUnknown'); });
}

export async function openKeyPanel() {
  const hasKey = !!S.me?.privateKey;
  const blob = await getRecoveryBlob().catch(() => null);
  const status = !hasKey ? t('key.statusNoKey') : (blob ? t('key.statusOn') : t('key.statusOff'));

  open('keyOv', t('key.title'), `
    <p class="field-hint" data-status>${esc(status)}</p>
    <div class="key-actions">
      <button class="btn" id="keyPhraseBtn" type="button" ${hasKey ? '' : 'disabled'}>${esc(t('key.makePhrase'))}</button>
      <button class="btn btn-ghost" id="keyFileBtn" type="button" ${hasKey ? '' : 'disabled'}>${esc(t('key.downloadFile'))}</button>
      <button class="btn btn-ghost" id="keyRestoreBtn" type="button">${esc(t('key.restore'))}</button>
    </div>
    <p class="field-hint">${esc(t('key.explain'))}</p>
  `);

  const ov = document.getElementById('keyOv');
  ov.querySelector('#keyPhraseBtn')?.addEventListener('click', makePhrase);
  ov.querySelector('#keyFileBtn')?.addEventListener('click', downloadKeyFile);
  ov.querySelector('#keyRestoreBtn')?.addEventListener('click', () => { close('keyOv'); openRecoveryFlow(); });
}

/* ── создание фразы ──────────────────────────────────────── */

async function makePhrase() {
  const jwk = await getLocalPrivateKeyJwk();
  if (!jwk) { toast(t('key.statusNoKey'), { type: 'error' }); return; }

  const existing = await getRecoveryBlob().catch(() => null);
  if (existing) {
    const ok = await confirmAction({
      title: t('key.rewriteTitle'),
      text: t('key.rewriteText'),
      ok: t('key.rewriteOk'),
      danger: true,
    });
    if (!ok) return;
  }

  phraseWords = await R.newMnemonic();
  const words = phraseWords.split(' ');

  const ov = open('keyPhraseOv', t('key.phraseTitle'), `
    <p class="field-hint">${esc(t('key.phraseWarn'))}</p>
    <div class="key-words">${words.map((w, i) => `<span class="key-word"><b>${i + 1}</b>${esc(w)}</span>`).join('')}</div>
    <label class="key-check"><input type="checkbox" id="keySaved"> ${esc(t('key.savedCheck'))}</label>
    <div class="key-actions">
      <button class="btn btn-ghost" id="keyCopy" type="button">${esc(t('key.copy'))}</button>
      <button class="btn btn-ghost" id="keyTxt" type="button">${esc(t('key.downloadTxt'))}</button>
      <button class="btn" id="keyConfirm" type="button" disabled>${esc(t('key.confirm'))}</button>
    </div>
  `);

  const check = ov.querySelector('#keySaved');
  const confirmBtn = ov.querySelector('#keyConfirm');
  check.addEventListener('change', () => { confirmBtn.disabled = !check.checked; });

  ov.querySelector('#keyCopy').addEventListener('click', async () => {
    try {
      await navigator.clipboard.writeText(phraseWords);
      toast(t('key.copied'));
    } catch (e) { toast(t('key.copyFail'), { type: 'error' }); }
  });

  ov.querySelector('#keyTxt').addEventListener('click', () => {
    const text = [
      'Relik — кодовая фраза восстановления',
      '',
      phraseWords,
      '',
      `Аккаунт: ${S.me?.username ? '@' + S.me.username : (S.me?.mail || '')}`,
      `Дата: ${new Date().toLocaleString('ru-RU')}`,
      '',
      '12 слов дают полный доступ к переписке. Храните их как пароль от банка.',
    ].join('\n');
    R.downloadText('relik-recovery-phrase.txt', text, 'text/plain');
  });

  confirmBtn.addEventListener('click', async () => {
    confirmBtn.disabled = true;
    try {
      const blob = await R.encryptPrivateKeyWithMnemonic(jwk, phraseWords);
      await saveRecoveryBlob(blob);
      close('keyPhraseOv');
      close('keyOv');
      refreshKeyStatus();
      phraseWords = '';
      toast(t('key.phraseSaved'), { type: 'success' });
    } catch (err) {
      const code = String(err?.message || '');
      toast(code === 'need_sql' ? t('key.needSql') : t('key.saveFail'), { type: 'error' });
      confirmBtn.disabled = false;
    }
  });
}

/* ── файл ключа ──────────────────────────────────────────── */

async function downloadKeyFile() {
  const jwk = await getLocalPrivateKeyJwk();
  if (!jwk) { toast(t('key.statusNoKey'), { type: 'error' }); return; }
  const ok = await confirmAction({
    title: t('key.fileTitle'),
    text: t('key.fileWarn'),
    ok: t('key.fileOk'),
    danger: true,
  });
  if (!ok) return;
  const recovery = await getRecoveryBlob().catch(() => null);
  const data = R.buildKeyFile({ me: S.me, privateKeyJwk: jwk, recovery });
  const done = R.downloadText(R.fileNameFor(S.me), JSON.stringify(data, null, 2));
  toast(done ? t('key.fileSaved') : t('key.saveFail'), { type: done ? 'success' : 'error' });
}

/* ── восстановление доступа ──────────────────────────────── */

export function openRecoveryFlow({ force = false, password = '' } = {}) {
  const pw = password || rememberedPassword;
  const ov = open('recoverOv', force ? t('key.recoverTitleForce') : t('key.recoverTitle'), `
    <p class="field-hint">${esc(force ? t('key.recoverWhy') : t('key.recoverHow'))}</p>
    <div class="key-tabs">
      <button class="key-tab on" type="button" data-rtab="phrase">${esc(t('key.tabPhrase'))}</button>
      <button class="key-tab" type="button" data-rtab="file">${esc(t('key.tabFile'))}</button>
    </div>
    <div id="keyRecPhrase">
      <textarea class="input key-phrase" id="keyPhraseInput" rows="3" placeholder="${esc(t('key.phrasePlaceholder'))}" spellcheck="false" autocomplete="off"></textarea>
      <p class="field-hint">${esc(t('key.phraseHint'))}</p>
    </div>
    <div id="keyRecFile" hidden>
      <input type="file" id="keyFileInput" accept=".json,application/json">
      <p class="field-hint">${esc(t('key.fileHint'))}</p>
    </div>
    <div class="field">
      <span>${esc(t('key.passwordLabel'))}</span>
      <input class="input" id="keyPassword" type="password" autocomplete="current-password" value="${esc(pw)}">
      <span class="field-hint">${esc(t('key.passwordHint'))}</span>
    </div>
    <div class="key-actions">
      <button class="btn" id="keyRecoverGo" type="button">${esc(t('key.recoverGo'))}</button>
    </div>
    <p class="field-hint" id="keyRecoverMsg"></p>
  `, { locked: force });

  let mode = 'phrase';
  const msg = (text, bad = true) => {
    const el = ov.querySelector('#keyRecoverMsg');
    if (!el) return;
    el.textContent = text || '';
    el.style.color = bad ? 'var(--bad, #e0575d)' : 'var(--ok, #3ecf8e)';
  };

  ov.querySelectorAll('[data-rtab]').forEach((b) => {
    b.addEventListener('click', () => {
      mode = b.dataset.rtab;
      ov.querySelectorAll('[data-rtab]').forEach((x) => x.classList.toggle('on', x === b));
      ov.querySelector('#keyRecPhrase').hidden = mode !== 'phrase';
      ov.querySelector('#keyRecFile').hidden = mode !== 'file';
      msg('');
    });
  });

  ov.querySelector('#keyRecoverGo').addEventListener('click', async (e) => {
    const btn = e.currentTarget;
    btn.disabled = true;
    msg(t('key.checking'), false);
    try {
      const password = ov.querySelector('#keyPassword').value;
      let jwk = null;
      let fileRecovery = null;

      if (mode === 'phrase') {
        const phrase = ov.querySelector('#keyPhraseInput').value;
        if (!R.isMnemonicValid(phrase)) throw new Error('bad_mnemonic');
        const blob = await getRecoveryBlob();
        if (!blob) throw new Error('no_recovery');
        jwk = await R.decryptPrivateKeyWithMnemonic(blob, phrase);
        if (!password) throw new Error('no_password');
      } else {
        const input = ov.querySelector('#keyFileInput');
        const file = input?.files?.[0];
        if (!file) throw new Error('bad_file');
        const parsed = R.parseKeyFile(await file.text());
        jwk = parsed.privateKeyJwk;
        fileRecovery = parsed.recovery;
      }

      await savePrivateKey(jwk);
      if (fileRecovery) await saveRecoveryBlob(fileRecovery).catch(() => {});

      /* обновляем парольный бэкап: после сброса пароля он зашифрован старым */
      if (password) {
        try { await savePasswordBackup(jwk, password); } catch (err) { /* не блокируем восстановление */ }
        rememberedPassword = password;
      }

      msg(t('key.recovered'), false);
      toast(t('key.recoveredToast'), { type: 'success' });
      setTimeout(() => { location.reload(); }, 700);
    } catch (err) {
      const code = String(err?.message || '');
      if (code === 'bad_mnemonic') msg(t('key.badPhrase'));
      else if (code === 'wrong_phrase') msg(t('key.badPhrase'));
      else if (code === 'no_recovery') msg(t('key.needPhraseSetup'));
      else if (code === 'bad_file') msg(t('key.badFile'));
      else if (code === 'no_password') msg(t('key.needPassword'));
      else if (code === 'no_user') msg(t('key.needLogin'));
      else msg(t('key.recoverFail'));
      btn.disabled = false;
    }
  });

  return ov;
}
