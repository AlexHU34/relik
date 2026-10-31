/* Relik — переключение экранов «вход / приложение».
   Вынесено из router.js, чтобы main.js мог показать экран входа,
   не загружая весь код чата. */
import { $ } from './utils.js';

export function showAuth(on = true) {
  $('#authView').hidden = !on;
  $('#appView').hidden = on;
}

export function showApp() {
  $('#authView').hidden = true;
  $('#appView').hidden = false;
}
