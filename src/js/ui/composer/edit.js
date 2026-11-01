/* Relik — редактирование своего сообщения.
   Вынесено из composer.js: там жёсткий лимит строк, а правка сообщения —
   отдельный сценарий (сервер в реальном режиме, IndexedDB в демо). */
import { S, chatById } from '../state.js';
import { t } from '../../i18n/i18n.js';
import { idb } from '../../db/idb.js';
import { SUPABASE } from '../../config.js';
import { toast } from '../toast.js';
import { renderSidebar } from '../sidebar.js';
import { editMessage } from '../../backend/messages.js';

/* renderMessages приходит хуком: прямой импорт chatView создал бы цикл
   (chatView → composer → edit). */
let hooks = { clearReplyEdit: () => {}, renderMessages: () => {} };
export function bindEditHooks(h) { hooks = { ...hooks, ...h }; }

export async function saveEdit(text) {
  const m = (S.messages[S.active] || []).find((x) => x.id === S.editing);
  const chat = chatById(S.active);
  const wasEditing = S.editing;
  hooks.clearReplyEdit();
  if (!m || !wasEditing || !chat) return;

  if (SUPABASE.url && SUPABASE.anonKey) {
    try {
      await editMessage(m.id, text, chat.kind, chat.publicKey);
      m.text = text;
      m.edited = true;
      await idb.put('messages', m);
    } catch (err) {
      console.error('Edit message error:', err);
      toast(err.message || t('toast.error'));
    }
  } else if (text) {
    m.text = text;
    m.edited = true;
    await idb.put('messages', m);
  }

  if (S.active) hooks.renderMessages();
  const chat2 = chatById(S.active);
  if (chat2) {
    const last = (S.messages[S.active] || []).filter((x) => !x.hidden).pop();
    if (last && last.id === m.id) {
      chat2.last = { ts: last.ts, from: last.sender, type: last.type, text: last.text || '' };
      await idb.put('chats', chat2);
    }
  }
  renderSidebar();
}
