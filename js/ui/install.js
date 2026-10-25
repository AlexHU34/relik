/* Relik — установка PWA: ловим beforeinstallprompt и показываем кнопку в настройках */

let deferred = null;

if (typeof window !== 'undefined') {
  window.addEventListener('beforeinstallprompt', (e) => {
    e.preventDefault();
    deferred = e;
    document.dispatchEvent(new CustomEvent('relik:install-available'));
  });
}

export function canInstall() {
  return !!deferred;
}

export async function promptInstall() {
  if (!deferred) return false;
  const evt = deferred;
  deferred = null;
  try {
    await evt.prompt();
    const choice = await evt.userChoice;
    return choice?.outcome === 'accepted';
  } catch (e) {
    return false;
  }
}
