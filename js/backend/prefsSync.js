/* Relik — синхронизация закрепов/мьютов и оформления между устройствами.
   Таблица: supabase/user_prefs.sql. Если её нет — тихий локальный режим. */
import { sb } from './supabaseClient.js';

let enabled = false;
let lastJson = '';
let timer = 0;

export function enablePrefsSync() {
  enabled = true;
}

export async function loadRemotePrefs() {
  if (!sb) return null;
  try {
    const { data: { user } } = await sb.auth.getUser();
    if (!user) return null;
    const { data, error } = await sb
      .from('user_prefs')
      .select('prefs')
      .eq('user_id', user.id)
      .maybeSingle();
    if (error) return null;
    return data?.prefs && typeof data.prefs === 'object' ? data.prefs : null;
  } catch (e) {
    return null;
  }
}

export function saveRemotePrefs(prefs) {
  if (!enabled || !sb) return;
  const payload = {
    pinned: prefs.pinned || {},
    muted: prefs.muted || {},
    textSize: prefs.textSize,
    wallpaper: prefs.wallpaper === 'custom' ? 'none' : prefs.wallpaper,
    accent: prefs.accent,
    enterToSend: prefs.enterToSend,
    motion: prefs.motion,
  };
  let json;
  try { json = JSON.stringify(payload); } catch (e) { return; }
  if (json === lastJson) return;
  lastJson = json;
  clearTimeout(timer);
  timer = setTimeout(async () => {
    try {
      const { data: { user } } = await sb.auth.getUser();
      if (!user) return;
      await sb.from('user_prefs').upsert({
        user_id: user.id,
        prefs: payload,
        updated_at: new Date().toISOString(),
      });
    } catch (e) { /* нет таблицы/сети — локальный режим */ }
  }, 1200);
}
