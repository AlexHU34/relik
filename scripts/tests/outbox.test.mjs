/* Outbox: юнит-правила + chaos-симуляция доставки.
   Проверяем не «вроде работает», а 10 000 отправок при 30% потерь,
   двойных ответах и рестартах: ноль потерь, ноль дублей. */
import test from 'node:test';
import assert from 'node:assert/strict';

import {
  OUTBOX, backoffMs, canRetry, pickDue, beginAttempt, completeAttempt,
  failAttempt, applyAck, mergeRemote, summarize,
} from '../../js/core/outbox.js';

/* Детерминированный ГПСЧ, чтобы тест не «мигал». */
function mulberry32(seed) {
  let a = seed >>> 0;
  return () => {
    a = (a + 0x6d2b79f5) >>> 0;
    let t = Math.imul(a ^ (a >>> 15), 1 | a);
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

test('outbox: backoff растёт и упирается в потолок', () => {
  const fixed = () => 0.5; /* джиттер 1.0 */
  const seq = [0, 1, 2, 3, 9, 40].map((n) => backoffMs(n, fixed));
  for (let i = 1; i < 5; i++) assert.ok(seq[i] >= seq[i - 1], `шаг ${i} не вырос: ${seq}`);
  assert.equal(seq[4], 60000, 'после 9 попыток — потолок');
  assert.equal(seq[5], 60000);
});

test('outbox: джиттер не даёт синхронных волн', () => {
  const low = backoffMs(3, () => 0);
  const high = backoffMs(3, () => 0.999);
  assert.ok(low < high);
  assert.ok(low >= 4000, 'нижняя граница 8с * 0.5');
  assert.ok(high <= 12000, 'верхняя граница 8с * 1.5');
});

test('outbox: старые и удалённые сообщения не ретраятся', () => {
  const now = 1e12;
  const old = { id: 'a', status: OUTBOX.ERROR, ts: now - 25 * 3600 * 1000, nextAt: 0 };
  const fresh = { id: 'b', status: OUTBOX.ERROR, ts: now - 1000, nextAt: 0 };
  const deleted = { id: 'c', status: OUTBOX.ERROR, ts: now - 1000, nextAt: 0, deleted: true };
  assert.equal(canRetry(old, now), false);
  assert.equal(canRetry(fresh, now), true);
  assert.equal(canRetry(deleted, now), false);
  assert.deepEqual(pickDue([old, fresh, deleted], now).map((m) => m.id), ['b']);
});

test('outbox: ack монотонный, «прочитано» не откатывается', () => {
  const base = { id: 'x', status: OUTBOX.SENT, ack: 'read' };
  assert.equal(applyAck(base, 'delivered', 1).ack, 'read');
  assert.equal(applyAck({ ...base, ack: 'none' }, 'delivered', 1).ack, 'delivered');
  assert.equal(applyAck({ id: 'y', status: OUTBOX.ERROR }, 'sent', 1).status, OUTBOX.SENT);
});

test('outbox: слияние не создаёт дублей', () => {
  const local = [{ id: 'm1', status: OUTBOX.ERROR, text: 'привет', ack: 'none' }];
  const remote = [{ id: 'm1', status: OUTBOX.SENT, text: 'привет', sender: 'u_me' }];
  const { messages, added } = mergeRemote(local, remote);
  assert.equal(messages.length, 1);
  assert.equal(added, 0);
  assert.equal(messages[0].status, OUTBOX.SENT);
  assert.equal(messages[0].text, 'привет');
});

test('outbox chaos: 10 000 отправок, 30% потерь, дубли ответов, рестарты', () => {
  const rnd = mulberry32(20261030);
  const TOTAL = 10000;
  const LOSS = 0.3;
  const DUP_ACK = 0.2;

  let now = 0;
  let records = Array.from({ length: TOTAL }, (_, i) => ({
    id: 'm' + i,
    ts: i + 1,
    status: OUTBOX.QUEUED,
    attempts: 0,
    nextAt: 0,
    ack: 'none',
    text: 'msg ' + i,
  }));

  /* «Сервер»: ключ — client id, поэтому дубль физически невозможен. */
  const server = new Map();

  let steps = 0;
  for (; steps < 500000; steps++) {
    const due = pickDue(records, now, { limit: 50 });
    if (!due.length && !records.some((m) => m.status !== OUTBOX.SENT)) break;

    const byId = new Map(records.map((m) => [m.id, m]));
    for (const msg of due) {
      let m = beginAttempt(byId.get(msg.id), now);
      const lost = rnd() < LOSS;
      if (lost) {
        m = failAttempt(m, now, 'timeout', { random: rnd });
      } else {
        server.set(m.id, 'sent'); /* сервер принял */
        if (rnd() < DUP_ACK) {
          /* ответ потерялся: клиент считает, что не дошло, сервер уже сохранил */
          m = failAttempt(m, now, 'no_ack', { random: rnd });
        } else {
          m = completeAttempt(m, now);
        }
      }
      byId.set(m.id, m);
    }
    records = [...byId.values()];

    /* случайные повторные подтверждения — не должны ничего испортить */
    if (rnd() < 0.1) {
      const sample = records[Math.floor(rnd() * records.length)];
      if (sample && sample.status === OUTBOX.SENT) {
        const idx = records.indexOf(sample);
        records[idx] = applyAck(sample, rnd() < 0.5 ? 'delivered' : 'read', now);
      }
    }

    /* «рестарт вкладки»: состояние переживает сериализацию */
    if (steps % 500 === 0) records = JSON.parse(JSON.stringify(records));
    now += 250;
  }

  const pending = records.filter((m) => m.status !== OUTBOX.SENT);
  assert.equal(pending.length, 0, `не доставлено ${pending.length} из ${TOTAL}`);
  assert.equal(records.length, TOTAL, 'появились лишние записи');
  assert.equal(new Set(records.map((m) => m.id)).size, TOTAL, 'появились дубли по id');
  assert.equal(server.size, TOTAL, `сервер знает ${server.size} из ${TOTAL}`);
  for (let i = 0; i < TOTAL; i++) assert.ok(server.has('m' + i), `потеряно m${i}`);

  const stats = summarize(records);
  assert.equal(stats.sent, TOTAL);
  assert.equal(stats.error, 0);
});
