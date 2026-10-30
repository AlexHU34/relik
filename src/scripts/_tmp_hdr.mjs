import fs from 'node:fs';

const p = 'js/ui/modals.js';
const L = fs.readFileSync(p, 'utf8').split('\n');

const header = `/* Relik — модальные окна: новый чат, группа, люди, поиск, лайтбокс.
   Настройки — в ./modals/settings.js, просмотр медиа — в ./modals/lightbox.js. */
import { S, user, emit, chatById, chatTitle } from './state.js';
import { $, esc, avatarHtml, fmtTime } from './utils.js';
import { icon } from './icons.js';
import { t, setLang } from '../i18n/i18n.js';
import { idb, newId } from '../db/idb.js';
import { SUPABASE } from '../config.js';
import { toast } from './toast.js';
import { renderSidebar, loadChats } from './sidebar.js';
import { signOutAll, deleteAccount } from '../backend/auth.js';
import { searchUsers, createDmChat, profilesByIds } from '../backend/chats.js';
import { listRequests, sendRequest, respondRequest, cancelRequest, removeContact, contactsReady, subscribeRequests, seedDemoRequests } from '../backend/contacts.js';
import { pushState, enablePush, disablePush } from '../backend/push.js';
import { openKeyPanel } from './keyRecovery.js';
import { createGroup, addMemberToGroup, removeMemberFromGroup, updateGroupTitle, leaveGroup } from '../backend/groups.js';
import { applyTheme, currentTheme } from './themes.js';
import { applyFont, applyFontStack, saveCustomFont } from './fonts.js';
import { setSounds } from './sounds.js';
import { setNotifications } from './notify.js';
import { prefs, setTextSize, setWallpaper, setMotion, setEnterToSend, setAccent, setCustomWall, clearChatPrefs, setHideOnline } from './prefs.js';
import { confirmAction } from './dialog.js';
import { canInstall, promptInstall } from './install.js';
import { exportChats } from './export.js';
import { enablePin, disablePin, changePin, lockNow } from './pin.js';
import { hasGroupKeysTable } from '../backend/groupKeys.js';
import { openLightbox, stepLightbox, closeLightbox, downloadLightbox } from './modals/lightbox.js';
import {
  openSettings, saveProfile, paintSecNav, paintProfileDirty, paintLangSeg,
  paintThemes, paintFonts, paintTextSize, paintWalls, paintAccents, wallToDataUrl,
  paintPinSettings, paintStorage, clearStorageCache,
  compactHistory, askPersistentStorage, handleAvatar, clearLocalCache,
} from './modals/settings.js';

export { openLightbox, openSettings };
`;

L.splice(0, 38, ...header.split('\n'));
fs.writeFileSync(p, L.join('\n'));
console.log('modals header rewritten; lines now', L.length);
