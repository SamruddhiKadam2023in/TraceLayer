/* global localStorage, window, document */
// Apply the persisted theme before first paint to avoid a light/dark flash.
// A separate file (not inline) so the Content-Security-Policy can forbid inline scripts.
(function () {
  try {
    var stored = JSON.parse(localStorage.getItem('tracelayer-theme') || '{}');
    var pref = (stored.state && stored.state.theme) || 'system';
    var dark =
      pref === 'dark' ||
      (pref === 'system' && window.matchMedia('(prefers-color-scheme: dark)').matches);
    document.documentElement.classList.toggle('dark', dark);
  } catch {
    // Storage unavailable (private mode, blocked): the app applies the theme once it loads.
  }
})();
