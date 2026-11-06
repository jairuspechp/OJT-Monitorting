/*
 * app.js  (loader only)
 *
 * The app code lives in the js/ folder. This file loads those files in the
 * right order, so the page only needs:   <script src="app.js"></script>
 *
 * IMPORTANT for a live server: the whole js/ folder must be uploaded next to
 * this file. If any file is missing, a red message appears on the page saying
 * which one. (No folder? Use app.bundle.js instead - it is the same app in
 * one file.)
 *
 * Order matters: core -> link-slots -> buttons -> shortcuts -> dialogs -> main
 */
(function () {
  var FILES = ['core', 'link-slots', 'buttons', 'shortcuts', 'dialogs', 'main'];

  // Folder this file was loaded from, so js/ is found on any URL path.
  var base = document.currentScript
    ? document.currentScript.src.replace(/[^\/?#]*([?#].*)?$/, '')
    : '';

  function showProblem(url) {
    console.error('Link Layouts: could not load ' + url);
    var box = document.createElement('div');
    box.style.cssText = 'position:fixed;left:16px;right:16px;bottom:16px;z-index:2147483647;' +
      'padding:14px 18px;border-radius:10px;background:#b00020;color:#fff;' +
      'font:600 14px/1.4 system-ui,sans-serif;box-shadow:0 6px 24px rgba(0,0,0,.5)';
    box.textContent = 'Could not load ' + url + ' \u2014 upload the whole js/ folder next to app.js ' +
      '(or use app.bundle.js), then refresh with Ctrl+F5.';
    (document.body || document.documentElement).appendChild(box);
  }

  function loadAll() {
    var parent = document.body || document.documentElement;
    FILES.forEach(function (name) {
      var script = document.createElement('script');
      script.src = base + 'js/' + name + '.js';
      script.async = false; // keep the order above
      script.onerror = function () { showProblem(script.src); };
      parent.appendChild(script);
    });
  }

  // The page's #topbar / #content must exist before the app starts.
  if (document.body) loadAll();
  else document.addEventListener('DOMContentLoaded', loadAll);
})();
