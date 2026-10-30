import fs from 'node:fs';

const p = 'js/ui/modals.js';
const L = fs.readFileSync(p, 'utf8').split('\n');

const a1 = 467; // line 468: /* ── НАСТРОЙКИ ── */
const b1 = 788; // line 789: empty before closeTransientOverlays
const a2 = 799; // line 800: function paintLangSeg
const b2 = 900; // line 902: end of clearLocalCache

if (!L[a1].includes('НАСТРОЙКИ')) throw new Error('a1');
if (L[799].includes('paintLangSeg') === false) throw new Error('a2');
if (L[b2].trim() !== '}') throw new Error('b2');

let body = L.slice(a1, b1).join('\n') + '\n\n' + L.slice(a2, b2 + 1).join('\n');
body = body.replace(/^(async )?function ([A-Za-z0-9_]+)\(/gm, (m, asyncKw, name) => `${asyncKw || ''}export function ${name}(`);

const header = `/* Relik — окно настроек: профиль, темы, шрифты, обои, данные, PIN.
   Вынесено из modals.js. Оверлеи закрываются локальным closeOv — без импорта modals. */
import { S, user } from '../state.js';
import { $, esc, avatarHtml, fmtSize } from '../utils.js';
import { icon } from '../icons.js';
import { t, lang, setLang } from '../../i18n/i18n.js';
import { idb } from '../../db/idb.js';
import { APP, SUPABASE } from '../../config.js';
import { sb } from '../../backend/supabaseClient.js';
import { toast } from '../toast.js';
import { renderSidebar } from '../sidebar.js';
import { updateProfile, saveAvatar, normalizeUsername, isValidUsername, isUsernameTaken, hasUsernameColumn, signOutAll, deleteAccount } from '../../backend/auth.js';
import { pushState, enablePush, disablePush } from '../../backend/push.js';
import { openKeyPanel, refreshKeyStatus } from '../keyRecovery.js';
import { THEMES, applyTheme, currentTheme } from '../themes.js';
import { FONTS, applyFont, applyFontStack, currentFontId, saveCustomFont } from '../fonts.js';
import { soundsEnabled, setSounds } from '../sounds.js';
import { notificationsEnabled, setNotifications } from '../notify.js';
import { prefs, WALLPAPERS, ACCENTS, setTextSize, setWallpaper, setMotion, setEnterToSend, setAccent, setCustomWall, setClearTheme, setHideOnline, clearChatPrefs } from '../prefs.js';
import { confirmAction } from '../dialog.js';
import { canInstall, promptInstall } from '../install.js';
import { exportChats } from '../export.js';
import { hasPin, enablePin, disablePin, changePin, lockNow } from '../pin.js';
import { storageAvailable, clearMediaObjectUrls } from '../../backend/storage.js';
import { mediaStats, storageEstimate, persistedStorage, ensurePersistentStorage, clearMediaCache, MEDIA_MAX_BYTES } from '../../db/mediaCache.js';

function closeOv(ov) {
  if (ov) ov.hidden = true;
}
`;

fs.writeFileSync('js/ui/modals/settings.js', header + '\n' + body + '\n');

/* вырезаем: сначала правый диапазон, потом левый */
L.splice(a2, b2 - a2 + 1);
L.splice(a1, b1 - a1);
fs.writeFileSync(p, L.join('\n'));
console.log('settings.js:', (header + body).split('\n').length, 'lines; modals now', L.length - 1);
