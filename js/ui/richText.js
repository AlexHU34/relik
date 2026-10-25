/* Relik — безопасное форматирование текста сообщений.
   Поддержка: **жирный**, *курсив*, `код`, ~~зачёркнутый~~, ссылки, @упоминания.
   Всё экранируется: HTML из сообщения никогда не исполняется. */
import { esc } from './utils.js';

const TOKEN_RE = /(`[^`\n]+`)|(\*\*[^*\n]+\*\*)|(~~[^~\n]+~~)|(\*[^*\n]+\*)|(\b(?:https?:\/\/|www\.)[^\s<>"']+)/gi;
const MENTION_RE = /(^|[\s(])@([A-Za-z][A-Za-z0-9_]{2,31})\b/g;

function trimUrl(raw) {
  let url = raw;
  /* точки/запятые/скобки в конце — обычно часть предложения, а не ссылки */
  for (let guard = 0; guard < 12; guard++) {
    const last = url.slice(-1);
    if ('.,;:!?…'.includes(last)) { url = url.slice(0, -1); continue; }
    if (last === ')' && (url.match(/\)/g) || []).length > (url.match(/\(/g) || []).length) {
      url = url.slice(0, -1); continue;
    }
    if (last === ']' && (url.match(/\]/g) || []).length > (url.match(/\[/g) || []).length) {
      url = url.slice(0, -1); continue;
    }
    break;
  }
  return url;
}

function linkHtml(url) {
  const clean = trimUrl(url);
  const tail = url.slice(clean.length);
  if (!/^(https?:\/\/|www\.)/i.test(clean)) return esc(url);
  const href = /^www\./i.test(clean) ? 'https://' + clean : clean;
  return `<a class="msg-link" href="${esc(href)}" target="_blank" rel="noopener noreferrer nofollow">${esc(clean)}</a>${esc(tail)}`;
}

function textHtml(text) {
  return esc(text).replace(MENTION_RE, '$1<span class="mention">@$2</span>');
}

function inlineHtml(text) {
  let out = '';
  let last = 0;
  TOKEN_RE.lastIndex = 0;
  let m;
  while ((m = TOKEN_RE.exec(text))) {
    if (m.index > last) out += textHtml(text.slice(last, m.index));
    const tok = m[0];
    if (tok.startsWith('`')) {
      out += `<code>${esc(tok.slice(1, -1))}</code>`;
    } else if (tok.startsWith('**')) {
      out += `<strong>${esc(tok.slice(2, -2))}</strong>`;
    } else if (tok.startsWith('~~')) {
      out += `<del>${esc(tok.slice(2, -2))}</del>`;
    } else if (tok.startsWith('*')) {
      out += `<em>${esc(tok.slice(1, -1))}</em>`;
    } else {
      out += linkHtml(tok);
    }
    last = m.index + tok.length;
  }
  if (last < text.length) out += textHtml(text.slice(last));
  return out;
}

/* Block-level Markdown: code fences, quotes, unordered/ordered lists.
   Всё остальное — обычный текст с inline-разметкой. */
function blocksHtml(raw) {
  const lines = String(raw).replace(/\r\n?/g, '\n').split('\n');
  const out = [];
  let i = 0;

  const isFence = (line) => /^\s*```/.test(line);
  const isQuote = (line) => /^\s*>/.test(line);
  const isUl = (line) => /^\s*[-*]\s+/.test(line);
  const isOl = (line) => /^\s*\d+[.)]\s+/.test(line);

  while (i < lines.length) {
    const line = lines[i];

    if (isFence(line)) {
      i++;
      const code = [];
      while (i < lines.length && !isFence(lines[i])) code.push(lines[i++]);
      if (i < lines.length) i++;
      out.push(`<pre class="msg-code"><code>${esc(code.join('\n'))}</code></pre>`);
      continue;
    }

    if (isQuote(line)) {
      const quote = [];
      while (i < lines.length && isQuote(lines[i])) {
        quote.push(lines[i].replace(/^\s*>\s?/, ''));
        i++;
      }
      out.push(`<blockquote class="msg-quote">${inlineHtml(quote.join('\n'))}</blockquote>`);
      continue;
    }

    if (isUl(line) || isOl(line)) {
      const ordered = isOl(line);
      const items = [];
      while (i < lines.length) {
        const m = ordered
          ? /^\s*\d+[.)]\s+(.*)$/.exec(lines[i])
          : /^\s*[-*]\s+(.*)$/.exec(lines[i]);
        if (!m) break;
        items.push(`<li>${inlineHtml(m[1])}</li>`);
        i++;
      }
      const tag = ordered ? 'ol' : 'ul';
      out.push(`<${tag} class="msg-list">${items.join('')}</${tag}>`);
      continue;
    }

    const buf = [];
    while (i < lines.length && !isFence(lines[i]) && !isQuote(lines[i]) && !isUl(lines[i]) && !isOl(lines[i])) {
      buf.push(lines[i++]);
    }
    out.push(inlineHtml(buf.join('\n')));
  }

  return out.join('');
}

/* Основное: сырой текст → безопасный HTML. */
export function formatText(raw) {
  const text = String(raw ?? '');
  if (!text) return '';
  return blocksHtml(text);
}

/* Сообщение из одних эмодзи — показываем крупно. */
export function isEmojiOnly(raw) {
  const s = String(raw ?? '').trim();
  if (!s || s.length > 24) return false;
  if (/[0-9A-Za-zА-Яа-яЁё]/.test(s)) return false;
  if (!/\p{Extended_Pictographic}/u.test(s)) return false;
  return s.replace(/\s/g, '').length <= 12;
}

/* Допустимые источники медиа: data-URL нужного типа, blob и https. */
export function safeMediaSrc(src, kind = 'image') {
  const s = String(src || '').trim();
  if (!s) return '';
  if (/^blob:/i.test(s)) return s;
  if (/^https:\/\//i.test(s)) return s;
  const mime = kind === 'image'
    ? /^data:image\/[a-z0-9.+-]+[;,]/i
    : kind === 'audio'
      ? /^data:(audio|video)\/[a-z0-9.+-]+[;,]/i
      : /^data:[a-z0-9.+-]+\/[a-z0-9.+-]+[;,]/i;
  return mime.test(s) ? s : '';
}

export function isSafeHref(href) {
  return /^(https?:\/\/|mailto:)/i.test(String(href || '').trim());
}
