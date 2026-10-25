/* Relik — Web Push: подписка устройства и хранение её в Supabase.
   Отправку делает сервис на VPS (scripts/push-service), клиент только
   регистрирует подписку и сообщает серверу о новом сообщении. */

import { sb } from './supabaseClient.js';
import { SUPABASE, PUSH } from '../config.js';
import { S } from '../ui/state.js';

const real = () => !!(SUPABASE.url && SUPABASE.anonKey && sb && S.me?.id);

export function pushSupported() {
  return typeof navigator !== 'undefined'
    && 'serviceWorker' in navigator
    && 'PushManager' in window
    && 'Notification' in window;
}

function urlB64ToUint8Array(base64String) {
  const padding = '='.repeat((4 - (base64String.length % 4)) % 4);
  const base64 = (base64String + padding).replace(/-/g, '+').replace(/_/g, '/');
  const raw = atob(base64);
  const out = new Uint8Array(raw.length);
  for (let i = 0; i < raw.length; i += 1) out[i] = raw.charCodeAt(i);
  return out;
}

export async function pushState() {
  if (!pushSupported()) return 'unsupported';
  if (Notification.permission === 'denied') return 'denied';
  try {
    const reg = await navigator.serviceWorker.ready;
    const sub = await reg.pushManager.getSubscription();
    return sub ? 'on' : 'off';
  } catch (e) {
    return 'off';
  }
}

export async function enablePush() {
  if (!pushSupported()) throw new Error('push_unsupported');
  if (!real()) throw new Error('push_no_backend');
  if (!PUSH?.publicKey) throw new Error('push_not_configured');

  const perm = await Notification.requestPermission();
  if (perm !== 'granted') throw new Error('push_denied');

  const reg = await navigator.serviceWorker.ready;
  let sub = await reg.pushManager.getSubscription();
  if (!sub) {
    sub = await reg.pushManager.subscribe({
      userVisibleOnly: true,
      applicationServerKey: urlB64ToUint8Array(PUSH.publicKey),
    });
  }

  const json = sub.toJSON();
  const { error } = await sb.from('push_subs').upsert({
    user_id: S.me.id,
    endpoint: json.endpoint,
    p256dh: json.keys.p256dh,
    auth: json.keys.auth,
    ua: String(navigator.userAgent || '').slice(0, 160),
  }, { onConflict: 'endpoint' });
  if (error) {
    if (/42P01|does not exist|schema cache|relation/i.test(error.message || '')) throw new Error('push_need_sql');
    throw error;
  }
  return true;
}

export async function disablePush() {
  try {
    const reg = await navigator.serviceWorker.ready;
    const sub = await reg.pushManager.getSubscription();
    if (sub) {
      const endpoint = sub.endpoint;
      await sub.unsubscribe().catch(() => {});
      if (real()) {
        await sb.from('push_subs').delete().eq('endpoint', endpoint).catch?.(() => {});
      }
    }
  } catch (e) { /* игнорируем */ }
}

/* Сообщить сервису на VPS, что в чате новое сообщение.
   Текст не передаётся: сервис шлёт беззвучное «Новое сообщение». */
export async function notifyPush(chat) {
  if (!PUSH?.endpoint || !chat || !real()) return;
  try {
    const { data: { session } } = await sb.auth.getSession();
    if (!session?.access_token) return;
    await fetch(PUSH.endpoint, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        Authorization: 'Bearer ' + session.access_token,
      },
      body: JSON.stringify({ chatId: chat.id, kind: chat.kind }),
      keepalive: true,
    });
  } catch (e) { /* push — не критичный путь */ }
}
