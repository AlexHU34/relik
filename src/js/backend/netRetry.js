/* Relik — устойчивость к обрывам транспорта.
   В РФ-сети запросы к Supabase периодически падают с `ERR_CONNECTION_RESET`,
   `Failed to fetch` и таймаутами — это не ошибка данных, а сеть. Раньше любой
   такой сбой сразу показывался человеку («не удалось загрузить») или оставлял
   пустой список чатов. Теперь идемпотентные чтения повторяются с паузой.

   Правила:
   - повторяем только чтения (никаких insert/update — иначе дубли);
   - не повторяем 4xx: это наши ошибки (RLS, битый запрос), ждать бессмысленно;
   - пауза растёт 0.7 → 1.4 → 2.8 с (с джиттером), максимум 8 с;
   - 429/5xx тоже повторяем: сервер мог просто не ответить.

   Чистые функции без сети — покрыты scripts/tests/net-retry.test.mjs. */

const NET_RE = /failed to fetch|load failed|network ?error|econnreset|err_connection_reset|err_internet_disconnected|socket hang up|timeout|timed out|fetch failed|aborted|offline|connection (?:closed|reset)/i;

export const RETRY_CODES = new Set(['429', '500', '502', '503', '504']);

export function isRetryableError(err) {
  if (!err) return false;
  const msg = String(err.message || err);
  if (NET_RE.test(msg)) return true;

  const code = String(err.code ?? '').trim();
  if (RETRY_CODES.has(code)) return true;

  const status = Number(err.status || err.statusCode || 0);
  if (status === 429) return true;
  return status >= 500 && status < 600;
}

/* Пауза перед повтором: растёт, но не больше cap, и всегда с джиттером,
   чтобы десять вкладок не били синхронно. */
export function retryDelay(attempt, random = Math.random, { base = 700, cap = 8000 } = {}) {
  const n = Math.max(0, Math.min(10, Number(attempt) || 0));
  const raw = Math.min(cap, base * 2 ** n);
  return Math.round(raw * (0.6 + random() * 0.8));
}

const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

/* Обёртка для идемпотентной операции. onRetry — для телеметрии
   (только номер попытки и пауза, без содержимого запроса).
   timeoutMs ограничивает попытку: без него «залипший» запрос к Supabase висит
   десятки секунд (наблюдали 14 с на одном запросе), и повтор не наступает. */
export async function withRetry(fn, {
  attempts = 3,
  base = 700,
  cap = 8000,
  random = Math.random,
  onRetry = null,
  wait = sleep,
  timeoutMs = 0,
} = {}) {
  const total = Math.max(1, Number(attempts) || 1);
  const attempt = (i) => {
    if (!timeoutMs) return fn(i);
    return Promise.race([
      fn(i),
      new Promise((_, rej) => setTimeout(() => rej(new Error('timeout')), timeoutMs)),
    ]);
  };

  let lastErr = null;
  for (let i = 0; i < total; i += 1) {
    try {
      return await attempt(i);
    } catch (err) {
      lastErr = err;
      if (i >= total - 1 || !isRetryableError(err)) throw err;
      const delay = retryDelay(i, random, { base, cap });
      try { onRetry?.(i + 1, delay, err); } catch (e) { /* телеметрия не важнее запроса */ }
      await wait(delay);
    }
  }
  throw lastErr;
}
