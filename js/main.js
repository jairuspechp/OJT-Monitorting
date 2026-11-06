/*
 * main.js  (load LAST)
 *
 * Starts the app once every other file has loaded.
 */

(function () {
  const LG = window.LinkGrid;

  // Make the dashboard itself focusable.
  if (!document.body.hasAttribute('tabindex')) {
    document.body.setAttribute('tabindex', '-1');
  }

  function focusDashboard() {
    // Do not steal focus while the user is typing.
    const active = document.activeElement;

    if (active) {
      const tag = active.tagName;

      if (
        tag === 'INPUT' ||
        tag === 'TEXTAREA' ||
        tag === 'SELECT' ||
        active.isContentEditable
      ) {
        return;
      }
    }

    window.focus();

    try {
      document.body.focus({
        preventScroll: true
      });
    } catch (error) {
      document.body.focus();
    }
  }

  // Start the normal application.
  LG.startLiveClock();
  LG.initStorage();

  // Give the dashboard keyboard focus as soon as possible.
  focusDashboard();

  // Run again after the rest of the page has settled.
  requestAnimationFrame(() => {
    focusDashboard();

    requestAnimationFrame(() => {
      focusDashboard();
    });
  });

  // Recover shortcut focus whenever the user returns to this tab/window.
  window.addEventListener('focus', () => {
    setTimeout(focusDashboard, 0);
  });

  document.addEventListener('visibilitychange', () => {
    if (!document.hidden) {
      setTimeout(focusDashboard, 0);
    }
  });

  // Also recover focus after the page completely loads.
  window.addEventListener('load', () => {
    setTimeout(focusDashboard, 0);
  });
})();