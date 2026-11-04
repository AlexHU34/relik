/* Relik — упоминания в тексте: @ + 2…32 буквы/цифры/подчёркивания.
   Перед @ не должно быть буквы/цифры/_/@ — иначе «a@demo.ru» было бы упоминанием. */

const TOKEN_RE = /(^|[^\p{L}\p{N}_@/])(@[\p{L}\p{N}_]{2,32})/gu;

/* Все упоминания в тексте, без @ и в нижнем регистре. */
export function mentionTokens(text) {
  const src = String(text == null ? '' : text);
  if (!src) return [];
  const out = [];
  TOKEN_RE.lastIndex = 0;
  let m = TOKEN_RE.exec(src);
  while (m) {
    out.push(m[2].slice(1).toLowerCase());
    m = TOKEN_RE.exec(src);
  }
  return out;
}

/* По каким именам узнавать «меня»: @username, а если имени нет — однословное
   отображаемое имя (двухсловное «Анна Мария» упоминанием быть не может:
   пробел обрывает токен). */
export function myHandles(me) {
  const src = me || {};
  const out = [];
  const uname = String(src.username || '').trim().replace(/^@/, '');
  if (uname) out.push(uname.toLowerCase());
  const name = String(src.name || '').trim().replace(/^@/, '');
  if (name && !/\s/.test(name) && name.length >= 2) out.push(name.toLowerCase());
  return [...new Set(out)];
}

/* Упомянули ли меня в этом тексте. */
export function mentionsMe(text, me) {
  const handles = myHandles(me);
  if (!handles.length) return false;
  const tokens = mentionTokens(text);
  if (!tokens.length) return false;
  return tokens.some((t) => handles.includes(t));
}
