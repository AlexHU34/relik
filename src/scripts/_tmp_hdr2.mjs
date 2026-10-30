import fs from 'node:fs';

const p = 'js/ui/modals/settings.js';
const L = fs.readFileSync(p, 'utf8').split('\n');
const end = L.findIndex((l) => l.startsWith('function closeOv('));
if (end < 0) throw new Error('closeOv not found');

const header = `/* Relik — окно настроек: профиль, темы, шрифты, обои, данные, PIN.
   Вынесено из modals.js: свой импорт-лист и локальный closeOv. */
import { S } from '../state.js';
import { $, esc, fmtSize, safeImgSrc } from '../utils.js';
import { t, lang } from '../../i18n/i18n.js';
import { idb } from '../../db/idb.js';
import { APP, SUPABASE } from '../../config.js';
import { toast } from '../toast.js';
import { renderSidebar, loadChats } from '../sidebar.js';
import { updateProfile, saveAvatar, normalizeUsername, isValidUsername, isUsernameTaken, hasUsernameColumn } from '../../backend/auth.js';
import { THEMES } from '../themes.js';
import { FONTS, currentFontId } from '../fonts.js';
import { soundsEnabled } from '../sounds.js';
import { notificationsEnabled } from '../notify.js';
import { prefs, WALLPAPERS, ACCENTS } from '../prefs.js';
import { confirmAction } from '../dialog.js';
import { canInstall } from '../install.js';
import { hasPin } from '../pin.js';
import { hasGroupKeysTable } from '../../backend/groupKeys.js';
import { storageAvailable, clearMediaObjectUrls } from '../../backend/storage.js';
import { mediaStats, storageEstimate, persistedStorage, ensurePersistentStorage, clearMediaCache, MEDIA_MAX_BYTES } from '../../db/mediaCache.js';

`;

L.splice(0, end, ...header.split('\n'));
fs.writeFileSync(p, L.join('\n'));
console.log('settings header trimmed; closeOv was at', end + 1);
