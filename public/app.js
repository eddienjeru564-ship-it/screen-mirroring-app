// app.js — shared app shell behaviour, loaded on every page:
//   * registers the service worker so ScreenView can be installed as an app
//   * shows an "Install app" button when the browser offers installation
//   * provides toast notifications

// Service workers only run in secure contexts (HTTPS or localhost). Viewers on
// plain-HTTP LAN addresses simply use ScreenView as a normal web page.
if ('serviceWorker' in navigator && window.isSecureContext) {
  window.addEventListener('load', () => {
    navigator.serviceWorker.register('/sw.js').catch(() => {
      /* installation is optional; the app works without it */
    });
  });
}

// "Install app" button: hidden until the browser says installation is possible.
let installPrompt = null;
window.addEventListener('beforeinstallprompt', (e) => {
  e.preventDefault();
  installPrompt = e;
  document.querySelectorAll('[data-install]').forEach((b) => b.classList.remove('hidden'));
});
window.addEventListener('appinstalled', () => {
  installPrompt = null;
  document.querySelectorAll('[data-install]').forEach((b) => b.classList.add('hidden'));
  toast('ScreenView installed — find it in your apps.', 'ok');
});
document.addEventListener('click', async (e) => {
  const btn = e.target.closest('[data-install]');
  if (!btn || !installPrompt) return;
  installPrompt.prompt();
  await installPrompt.userChoice;
  installPrompt = null;
  btn.classList.add('hidden');
});

/**
 * Show a short notification in the corner.
 * @param {string} message
 * @param {'ok'|'warn'|'err'|''} [kind]
 */
export function toast(message, kind = '') {
  let host = document.getElementById('toasts');
  if (!host) {
    host = document.createElement('div');
    host.id = 'toasts';
    host.setAttribute('role', 'status');
    host.setAttribute('aria-live', 'polite');
    document.body.append(host);
  }
  const el = document.createElement('div');
  el.className = `toast ${kind}`;
  el.textContent = message;
  host.append(el);
  setTimeout(() => {
    el.classList.add('out');
    setTimeout(() => el.remove(), 300);
  }, 3200);
}
