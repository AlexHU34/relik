/* Relik — маленькие общие помощники модальных окон. */
import { S } from '../state.js';

/* Спрятать оверлей (все окна закрываются одинаково). */
export function closeOv(ov) {
  if (ov) ov.hidden = true;
}

/* Дополнить S.users профилями из ответа сервера (по id, без дублей). */
export function mergeUsers(list) {
  for (const u of list) {
    const i = S.users.findIndex((x) => x.id === u.id);
    if (i >= 0) S.users[i] = { ...S.users[i], ...u };
    else S.users.push(u);
  }
}
