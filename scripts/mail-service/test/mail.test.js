'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const crypto = require('node:crypto');

const secretB64 = crypto.randomBytes(32).toString('base64');
process.env.SEND_EMAIL_HOOK_SECRET = 'v1,whsec_' + secretB64;
process.env.MAIL_FROM = 'Relik <relik.support@yandex.ru>';
process.env.SUPABASE_URL = 'https://example.supabase.co';
process.env.DRY_RUN = '1';
process.env.MAIL_PROVIDER = 'brevo';

const mail = require('../index.js');

function sign(body, id, ts, secret = secretB64) {
  const key = Buffer.from(secret, 'base64');
  return crypto.createHmac('sha256', key).update(`${id}.${ts}.${body}`).digest('base64');
}

test('formatCode formats six digits as 234-098', () => {
  assert.equal(mail.formatCode('234098'), '234-098');
  assert.equal(mail.formatCode('123456'), '123-456');
  assert.equal(mail.formatCode(''), '');
  assert.equal(mail.formatCode('12345'), '12345');
});

test('parseSender handles name, bare email and quotes', () => {
  assert.deepEqual(mail.parseSender('Relik <relik.support@yandex.ru>'), {
    name: 'Relik', email: 'relik.support@yandex.ru',
  });
  assert.deepEqual(mail.parseSender('"Relik" <a@b.co>'), { name: 'Relik', email: 'a@b.co' });
  assert.deepEqual(mail.parseSender('a@b.co'), { name: 'Relik', email: 'a@b.co' });
});

test('Standard Webhooks signature accepts valid and rejects invalid', () => {
  const body = JSON.stringify({ hello: 'world' });
  const id = 'msg_test_1';
  const ts = String(Math.floor(Date.now() / 1000));
  const headers = {
    'webhook-id': id,
    'webhook-timestamp': ts,
    'webhook-signature': 'v1,' + sign(body, id, ts),
  };
  assert.equal(mail.verifySignature(Buffer.from(body), headers), true);

  const bad = { ...headers, 'webhook-signature': 'v1,' + sign(body, id, ts, crypto.randomBytes(32).toString('base64')) };
  assert.equal(mail.verifySignature(Buffer.from(body), bad), false);

  const oldTs = String(Math.floor(Date.now() / 1000) - 3600);
  const old = {
    'webhook-id': id,
    'webhook-timestamp': oldTs,
    'webhook-signature': 'v1,' + sign(body, id, oldTs),
  };
  assert.equal(mail.verifySignature(Buffer.from(body), old), false);
});

test('buildJobs signup produces one code email', () => {
  const jobs = mail.buildJobs({
    user: { email: 'user@example.com' },
    email_data: {
      token: '123456',
      token_hash: 'hash',
      email_action_type: 'signup',
      redirect_to: 'https://alexhu34.github.io/relik/',
      site_url: 'https://alexhu34.github.io/relik/',
    },
  });
  assert.equal(jobs.length, 1);
  assert.equal(jobs[0].to, 'user@example.com');
  assert.equal(jobs[0].action, 'signup');
  assert.equal(jobs[0].token, '123456');
  assert.match(jobs[0].link, /token=hash/);
});

test('buildJobs email_change produces two codes and maps hashes correctly', () => {
  const jobs = mail.buildJobs({
    user: { email: 'old@example.com', new_email: 'new@example.com' },
    email_data: {
      token: '111111',
      token_new: '222222',
      token_hash: 'hash_new_email',
      token_hash_new: 'hash_current_email',
      email_action_type: 'email_change',
    },
  });
  assert.equal(jobs.length, 2);
  assert.equal(jobs[0].to, 'old@example.com');
  assert.equal(jobs[0].token, '111111');
  assert.match(jobs[0].link, /token=hash_current_email/);
  assert.equal(jobs[1].to, 'new@example.com');
  assert.equal(jobs[1].token, '222222');
  assert.match(jobs[1].link, /token=hash_new_email/);
});

test('renderEmail includes formatted code and no raw HTML injection', () => {
  const out = mail.renderEmail({
    action: 'signup',
    token: '234098',
    link: 'https://example.com/?a=1&b=2',
  });
  assert.match(out.subject, /Relik/);
  assert.match(out.text, /234-098/);
  assert.match(out.html, /234-098/);
  assert.match(out.html, /a=1&amp;b=2/);
  assert.equal(out.html.includes('<script>'), false);
});

test('renderEmail notifications contain no code block', () => {
  const out = mail.renderEmail({
    action: 'password_changed_notification',
    token: '',
    link: '',
  });
  assert.match(out.subject, /Пароль/);
  assert.equal(out.text.includes('Код:'), false);
  assert.equal(out.html.includes('letter-spacing:6px'), false);
});
