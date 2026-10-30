/* Relik — экспорт переписки в JSON и HTML (локально, без сервера) */
import { S, user } from './state.js';
import { idb } from '../db/idb.js';
import { SUPABASE } from '../config.js';
import { esc, fmtDay, fmtTime, fmtDur } from './utils.js';
import { chatTitle } from './state.js';
import { lang } from '../i18n/i18n.js';

function msgText(m) {
  if (m.deleted) return '[deleted]';
  if (m.type === 'poll') return `[poll] ${m.poll?.q || ''}`;
  if (m.type === 'image') return `[photo] ${m.file?.name || ''}`;
  if (m.type === 'video') return `[video] ${m.file?.name || ''}`;
  if (m.type === 'videoNote') return '[video note]';
  if (m.type === 'album') return `[album] ${(m.album || []).length}`;
  if (m.type === 'file') return `[file] ${m.file?.name || ''}`;
  if (m.type === 'voice') return `[voice] ${fmtDur(m.voice?.dur || 0)}`;
  return String(m.text || '');
}

function senderName(m) {
  if (m.sender === 'u_me') return S.me?.name || 'me';
  return user(m.sender).name;
}

async function collect() {
  const chats = [...(S.chats || [])];
  const result = [];
  for (const chat of chats) {
    let messages = [];
    /* сначала кэш, потом (если есть сервер) — полная история */
    if (S.active === chat.id && S.messages[chat.id]?.length) {
      messages = S.messages[chat.id];
    } else {
      try { messages = await idb.messagesOf(chat.id); } catch (e) { messages = []; }
    }
    if (SUPABASE.url && SUPABASE.anonKey) {
      try {
        const { loadMessagesPage } = await import('../backend/messages.js');
        const { oldestTs } = await import('./msgWindow.js');
        /* история грузится страницами: экспорт должен быть полным */
        const all = [];
        let before = 0;
        for (let i = 0; i < 60; i++) {
          const { messages: page, hasMore } = await loadMessagesPage(
            chat.id, chat.kind, chat.publicKey, before ? { before } : {},
          );
          if (page.length) all.unshift(...page);
          if (!hasMore) break;
          before = oldestTs(page);
          if (!before) break;
        }
        if (all.length) messages = all;
      } catch (e) { /* остаёмся на кэше */ }
    }
    result.push({
      chat,
      messages: (messages || [])
        .filter((m) => !m.hidden && !m.localDeleted)
        .sort((a, b) => (a.ts || 0) - (b.ts || 0)),
    });
  }
  return result;
}

function download(name, text, mime) {
  const blob = new Blob([text], { type: mime });
  const url = URL.createObjectURL(blob);
  const a = document.createElement('a');
  a.href = url;
  a.download = name;
  document.body.appendChild(a);
  a.click();
  a.remove();
  setTimeout(() => URL.revokeObjectURL(url), 5000);
}

function stamp() {
  const d = new Date();
  const p = (n) => String(n).padStart(2, '0');
  return `${d.getFullYear()}-${p(d.getMonth() + 1)}-${p(d.getDate())}-${p(d.getHours())}${p(d.getMinutes())}`;
}

function toJson(data) {
  return JSON.stringify({
    app: 'Relik',
    exportedAt: new Date().toISOString(),
    me: S.me ? { id: S.me.id, name: S.me.name } : null,
    chats: data.map(({ chat, messages }) => ({
      id: chat.id,
      kind: chat.kind,
      title: chatTitle(chat),
      messages: messages.map((m) => ({
        at: new Date(m.ts).toISOString(),
        from: senderName(m),
        type: m.type || 'text',
        text: msgText(m),
        edited: !!m.edited,
        file: m.file ? { name: m.file.name || '', size: m.file.size || 0 } : undefined,
      })),
    })),
  }, null, 2);
}

function toHtml(data) {
  const labels = lang === 'ru'
    ? { title: 'Экспорт Relik', nobody: 'Нет сообщений', edited: 'изменено' }
    : { title: 'Relik export', nobody: 'No messages', edited: 'edited' };
  const body = data.map(({ chat, messages }) => `
    <section>
      <h2>${esc(chatTitle(chat))}</h2>
      ${messages.length ? messages.map((m) => `
        <div class="m${m.sender === 'u_me' ? ' me' : ''}">
          <div class="meta"><b>${esc(senderName(m))}</b> · ${esc(fmtDay(m.ts))} ${esc(fmtTime(m.ts))}${m.edited ? ` · ${labels.edited}` : ''}</div>
          <div class="text">${esc(msgText(m))}</div>
        </div>`).join('') : `<p class="empty">${labels.nobody}</p>`}
    </section>`).join('');

  return `<!DOCTYPE html><html lang="${lang}"><head><meta charset="utf-8">
<title>${esc(labels.title)}</title>
<style>
  body{margin:0;padding:24px;background:#0b0e14;color:#e8eaf2;font:15px/1.5 Inter,system-ui,sans-serif}
  main{max-width:860px;margin:0 auto}
  h1{font-size:22px;margin:0 0 6px}.sub{color:#9aa3b5;font-size:12px;margin-bottom:24px}
  section{margin:0 0 28px}h2{font-size:16px;border-bottom:1px solid #20262f;padding-bottom:8px;margin:0 0 12px}
  .m{padding:8px 12px;margin:6px 0;border-radius:12px;background:#151a23;border:1px solid #232b39;max-width:80%}
  .m.me{margin-left:auto;background:#20273d;border-color:#2c3550}
  .meta{font-size:11px;color:#8892a6;margin-bottom:3px}.text{white-space:pre-wrap;word-break:break-word}
  .empty{color:#6c7590;font-size:13px}
</style></head><body><main>
<h1>${esc(labels.title)}</h1>
<div class="sub">${esc(new Date().toLocaleString())} · Relik</div>
${body}
</main></body></html>`;
}

export async function exportChats(format = 'json') {
  const data = await collect();
  if (format === 'html') {
    download(`relik-export-${stamp()}.html`, toHtml(data), 'text/html;charset=utf-8');
  } else {
    download(`relik-export-${stamp()}.json`, toJson(data), 'application/json;charset=utf-8');
  }
  return data.reduce((n, x) => n + x.messages.length, 0);
}
