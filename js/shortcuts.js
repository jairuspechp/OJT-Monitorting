/*
 * shortcuts.js
 *
 * All keyboard shortcuts in one place:
 *   F  full screen      G  graph only      E  zoom in / out
 *   C  change link      M  open the menu       Q  exit (asks first)
 *   L  Grid Layouts page (same as the menu's "Grid Layouts")
 *   ?  list of shortcuts    Esc  close the menu / a window
 *
 * Only plain letter keys are used (no Ctrl / Alt / F-keys), and Tab / Esc are
 * left to the browser, so nothing here clashes with the browser's own
 * shortcuts (Ctrl+F find, Ctrl+G, Ctrl+E search, Ctrl+C copy, F11, Tab focus,
 * Esc leave full screen ...). Every handler ignores a key pressed together
 * with Ctrl / Alt / Meta / Shift, and while typing in a field.
 *
 * Debug tip: every shortcut is its own document.addEventListener('keydown')
 * block with a comment above it, so a broken key is easy to find here.
 */
(function () {
  const LG = window.LinkGrid;
  const { state, storage, expandedByBoard, ui } = LG;
  const topbarEl = document.getElementById('topbar');
  const contentEl = document.getElementById('content');

  // All shortcuts listen in the capture phase, so they run before the page
  // (or a focused element) can swallow the key.
  function addKey(handler) {
    document.addEventListener('keydown', handler, true);
  }

  // True when the pressed key is this letter. A Latin letter is matched by what
  // is typed (so AZERTY / Dvorak users get the letter printed on the key). The
  // physical key position is only used when the layout types a non-Latin
  // character (e.g. Cyrillic), so a different letter never fires by accident.
  function isKey(event, letter) {
    const typed = event.key;
    if (typed && typed.length === 1 && /[a-z]/i.test(typed)) return typed.toLowerCase() === letter;
    return event.code === 'Key' + letter.toUpperCase();
  }

  addKey((event) => {
    const key = isKey(event, 'f') ? 'f' : isKey(event, 'g') ? 'g' : '';
    if (!key) return;
    if (event.ctrlKey || event.metaKey || event.altKey || event.shiftKey || event.repeat) return;

    const target = event.target;
    const tag = target && target.tagName;
    if (tag === 'INPUT' || tag === 'TEXTAREA' || tag === 'SELECT' || (target && target.isContentEditable)) return;
    if (document.querySelector('.settings-backdrop')) return; // a dialog is open

    if (key === 'f') {
      event.preventDefault();
      LG.toggleFullscreen();
      return;
    }

    // G: graph only. Only meaningful while a layout is open (or to leave
    // graph-only mode if it is already on).
    const inBoard = contentEl.classList.contains('mode-board');
    if (inBoard || document.body.classList.contains('graph-only-mode')) {
      event.preventDefault();
      LG.toggleGraphOnly();
    }
  });

  addKey((event) => {
    if (event.ctrlKey || event.altKey || event.metaKey || event.shiftKey) return;

    // A menu left over from a previous render is not really open.
    if (ui.activeMenuWrap && !document.contains(ui.activeMenuWrap)) ui.activeMenuWrap = null;

    // Up / Down move through the open menu.
    if (ui.activeMenuWrap && (event.key === 'ArrowDown' || event.key === 'ArrowUp')) {
      event.preventDefault();
      const items = Array.from(ui.activeMenuWrap.querySelectorAll('.board-menu-item'));
      const at = items.indexOf(document.activeElement);
      const step = event.key === 'ArrowDown' ? 1 : -1;
      items[(at + step + items.length) % items.length].focus();
      return;
    }

    if (!isKey(event, 'm') || event.repeat) return;

    const target = event.target;
    const tag = target && target.tagName;
    if (tag === 'INPUT' || tag === 'TEXTAREA' || tag === 'SELECT' || (target && target.isContentEditable)) return;
    if (document.querySelector('.settings-backdrop')) return; // a dialog is open

    // The menu lives in the layout toolbar, so it only exists on an open layout.
    const menuBtn = topbarEl.querySelector('.board-menu-btn');
    const board = LG.findBoard(state.currentBoardId);
    if (!menuBtn || !board || !contentEl.classList.contains('mode-board')) return;

    event.preventDefault();

    if (ui.activeMenuWrap) { // already open: close it
      menuBtn.click();
      return;
    }

    const expandedIndex = expandedByBoard[board.id];
    ui.menuChangeIndex = Number.isInteger(expandedIndex) ? expandedIndex : ui.hoveredSlotIndex;

    const toolbarHidden = document.body.classList.contains('graph-only-mode') || !topbarEl.classList.contains('is-visible');

    menuBtn.click(); // opens the existing menu
    if (toolbarHidden) topbarEl.classList.add('menu-peek');

    const first = topbarEl.querySelector('.board-menu-item');
    if (first) first.focus();
  });

  // Q: exit (close the window), e.g. to leave kiosk / app mode.
  // Esc is NOT used for this any more: the browser already uses Esc (leave
  // full screen, stop loading), so hijacking it clashed. Asks first, because a
  // stray key press must not close the dashboard: Enter confirms, Esc cancels.
  // A page can only close its own window when the browser allows it; if it
  // refuses, show the Alt+F4 fallback.
  let exitDialogOpen = false;

  function exitApp() {
    window.close();

    setTimeout(() => {
      LG.showHint('Could not close from the page &mdash; press <kbd>Alt</kbd>+<kbd>F4</kbd>');
    }, 400);
  }

  function requestExit() {
    if (exitDialogOpen) return;
    exitDialogOpen = true;

    LG.openConfirmDialog({
      title: 'Exit?',
      message: 'Close the monitoring dashboard? Press Enter to exit or Esc to stay.',
      confirmLabel: 'Exit',
    }).then((confirmed) => {
      exitDialogOpen = false;
      if (confirmed) exitApp();
    });
  }

  addKey((event) => {
    if (!isKey(event, 'q')) return;
    if (event.ctrlKey || event.altKey || event.shiftKey || event.metaKey || event.repeat) return;

    const target = event.target;
    const tag = target && target.tagName;
    if (tag === 'INPUT' || tag === 'TEXTAREA' || tag === 'SELECT' || (target && target.isContentEditable)) return;
    if (document.querySelector('.settings-backdrop')) return; // a dialog is open

    event.preventDefault();
    requestExit();
  });

  // L: go to the Grid Layouts page (same as the menu's "Grid Layouts").
  // Plain L only: Ctrl+L / Alt+L etc. are ignored so the browser's own
  // address-bar shortcuts (Ctrl+L, Alt+D) keep working in Chrome and Edge.
  addKey((event) => {
    if (!isKey(event, 'l')) return;
    if (event.ctrlKey || event.altKey || event.metaKey || event.shiftKey || event.repeat) return;

    const target = event.target;
    const tag = target && target.tagName;
    if (tag === 'INPUT' || tag === 'TEXTAREA' || tag === 'SELECT' || (target && target.isContentEditable)) return;
    if (document.querySelector('.settings-backdrop')) return; // a dialog is open
    if (!contentEl.classList.contains('mode-board')) return;  // already on the layouts page

    event.preventDefault();
    LG.goHome();
  });

  // Esc only closes the app's own menu. Windows handle their own Esc, and
  // everything else (leaving full screen, ...) is left to the browser.
  addKey((event) => {
    if (event.key !== 'Escape') return;
    if (event.ctrlKey || event.altKey || event.shiftKey || event.metaKey) return;

    if (ui.activeMenuWrap && document.contains(ui.activeMenuWrap)) {
      event.preventDefault();
      const menuBtn = ui.activeMenuWrap.querySelector('.board-menu-btn');
      if (menuBtn) menuBtn.click();
    }
  });

  // ----------------------------------------------------------------------
  // Shortcut keys list (menu item, or press ?).
  // ----------------------------------------------------------------------

  // Smaller shortcut-keys window (window, cards, key caps and text).
  const shortcutsStyle = document.createElement('style');
  shortcutsStyle.textContent = [
    '.settings-modal.shortcuts-modal{width:460px;padding:14px;gap:6px}',
    '.shortcuts-modal h3{font-size:14px}',
    '.shortcuts-modal .shortcut-list{gap:6px;margin:6px 0 8px}',
    '.shortcuts-modal .shortcut-item{gap:8px;padding:6px 9px;border-radius:8px}',
    '.shortcuts-modal .shortcut-item .sc-keys{min-width:40px}',
    '.shortcuts-modal .shortcut-item kbd{min-width:28px;height:26px;padding:0 7px;font-size:13px;',
    'border-bottom-width:3px;border-radius:6px;box-shadow:0 2px 4px rgba(0,0,0,.25),inset 0 1px 0 rgba(255,255,255,.08)}',
    '.shortcuts-modal .shortcut-item .sc-plus{margin:0 3px;font-size:12px}',
    '.shortcuts-modal .shortcut-item .sc-text{font-size:12px;line-height:1.3}',
    '.shortcuts-modal .shortcuts-tip{font-size:11px;line-height:1.3}',
    '.shortcuts-modal .settings-row-buttons button{padding:6px 0;font-size:12px}',
  ].join('');
  document.head.appendChild(shortcutsStyle);

  function openShortcutsDialog() {
    if (document.querySelector('.settings-backdrop')) return;

    const backdrop = document.createElement('div');
    backdrop.className = 'settings-backdrop';
    backdrop.addEventListener('click', (event) => {
      if (event.target === backdrop) close();
    });

    const modal = document.createElement('div');
    modal.className = 'settings-modal shortcuts-modal';

    const heading = document.createElement('h3');
    heading.textContent = 'Shortcut keys';
    modal.appendChild(heading);

    const rows = [
      [['M'], 'Open or close the menu. Inside it, use \u2191 \u2193 and Enter.'],
      [['E'], 'Zoom in on the link under the mouse (full screen + graph only), or zoom back out.'],
      [['L'], 'Go to the Grid Layouts page.'],
      [['C'], 'Change the link under the mouse (or add one if the slot is empty).'],
      [['F'], 'Turn full screen on or off.'],
      [['G'], 'Graph only: hide the toolbar and headings. Press again to bring them back. Point at the top edge to show the toolbar.'],
      [['Q'], 'Exit the dashboard (asks first: Enter to confirm, Esc to stay).'],
      [['Esc'], 'Close the menu or a window. (Leaving full screen is left to the browser.)'],
      [['?'], 'Show this list.'],
      [['Alt', 'F4'], 'Close the window if Q cannot.'],
    ];

    const list = document.createElement('div');
    list.className = 'shortcut-list';
   rows.forEach(([keys, text]) => {
  const item = document.createElement('div');
  item.className = 'shortcut-item';

  const keyCell = document.createElement('div');
  keyCell.className = 'sc-keys';

  keys.forEach((name, i) => {
    if (i > 0) {
      const plus = document.createElement('span');
      plus.className = 'sc-plus';
      plus.textContent = '+';
      keyCell.appendChild(plus);
    }

    const kbd = document.createElement('kbd');
    kbd.textContent = name;
    keyCell.appendChild(kbd);
  });

  const textCell = document.createElement('div');
  textCell.className = 'sc-text';
  textCell.textContent = text;

  item.appendChild(keyCell);
  item.appendChild(textCell);

  list.appendChild(item);
});
    modal.appendChild(list);

    const tip = document.createElement('div');
    tip.className = 'shortcuts-tip';
    tip.textContent = 'If a key does nothing, click an empty part of the dashboard first. Keys cannot reach a ' +
      'page while you are clicked inside it, and focus returns to the dashboard when you switch back to this tab ' +
      'or move the mouse off a link.';
    modal.appendChild(tip);

    const row = document.createElement('div');
    row.className = 'settings-row-buttons';
    const closeBtn = document.createElement('button');
    closeBtn.className = 'save';
    closeBtn.textContent = 'Close';
    closeBtn.addEventListener('click', close);
    row.appendChild(closeBtn);
    modal.appendChild(row);

    backdrop.appendChild(modal);
    document.body.appendChild(backdrop);
    closeBtn.focus();

    document.addEventListener('keydown', onKeydown);

    function onKeydown(event) {
      if (event.key === 'Escape') close();
    }

    function close() {
      document.removeEventListener('keydown', onKeydown);
      if (backdrop.parentNode) backdrop.parentNode.removeChild(backdrop);
    }
  }

  addKey((event) => {
    if (event.key !== '?' || event.ctrlKey || event.altKey || event.metaKey) return;

    const target = event.target;
    const tag = target && target.tagName;
    if (tag === 'INPUT' || tag === 'TEXTAREA' || tag === 'SELECT' || (target && target.isContentEditable)) return;
    if (document.querySelector('.settings-backdrop')) return;

    event.preventDefault();
    openShortcutsDialog();
  });

  // ----------------------------------------------------------------------
  // E: expand / collapse a link (same as the arrow button on its holder).
  // Collapses the expanded slot, otherwise expands the slot under the mouse.
  // If the mouse is over an empty slot, tell the user there's no link and
  // let them add one on the spot.
  // ----------------------------------------------------------------------


  addKey((event) => {
    if (!isKey(event, 'e')) return;
    if (event.ctrlKey || event.altKey || event.metaKey || event.shiftKey) return;

    const target = event.target;
    const tag = target && target.tagName;
    if (tag === 'INPUT' || tag === 'TEXTAREA' || tag === 'SELECT' || (target && target.isContentEditable)) return;
    if (document.querySelector('.settings-backdrop')) return; // a dialog is open
    if (!contentEl.querySelector('.grid-stage')) return; // no layout open

    const board = LG.findBoard(state.currentBoardId);
    if (!board) return;

    const expandedIndex = expandedByBoard[board.id];
    let index;
    if (Number.isInteger(expandedIndex) && board.slots[expandedIndex]) {
      index = expandedIndex;
    } else if (ui.hoveredSlotIndex !== null && board.slots[ui.hoveredSlotIndex]) {
      index = ui.hoveredSlotIndex;
    } else if (ui.hoveredSlotIndex !== null && !board.slots[ui.hoveredSlotIndex]) {
      // Hovering an empty slot: nothing to expand, so say so and offer to add a link.
      event.preventDefault();
      LG.showHint('<b>' + LG.escapeHtml(LG.slotName(board, ui.hoveredSlotIndex)) + '</b> has no link yet &mdash; add one');
      LG.openSettings(board, ui.hoveredSlotIndex);
      return;
    } else {
      LG.showHint('Point at a link and press <kbd>E</kbd> to expand it');
      return;
    }

    event.preventDefault();
    LG.toggleExpand(board, index); // shows its own zoomed in / closed message
  });

  // ----------------------------------------------------------------------
  // C: change the link of the slot under the mouse (same dialog as the
  // menu's "Change link"). Falls back to the expanded slot if the mouse
  // isn't over any slot. Works on empty slots too (opens "Add link").
  // ----------------------------------------------------------------------

  addKey((event) => {
    if (!isKey(event, 'c')) return;
    if (event.ctrlKey || event.altKey || event.metaKey || event.shiftKey || event.repeat) return;

    const target = event.target;
    const tag = target && target.tagName;
    if (tag === 'INPUT' || tag === 'TEXTAREA' || tag === 'SELECT' || (target && target.isContentEditable)) return;
    if (document.querySelector('.settings-backdrop')) return; // a dialog is open
    if (!contentEl.classList.contains('mode-board')) return;

    const board = LG.findBoard(state.currentBoardId);
    if (!board) return;

    const expandedIndex = expandedByBoard[board.id];
    let index = null;
    if (ui.hoveredSlotIndex !== null) {
      index = ui.hoveredSlotIndex;
    } else if (Number.isInteger(expandedIndex)) {
      index = expandedIndex;
    }

    if (index === null) {
      LG.showHint('Point at a link and press <kbd>C</kbd> to change it');
      return;
    }

    // Stops the "c" from being typed into the dialog's input as it gets focus.
    event.preventDefault();
    LG.openSettings(board, index);
  });


Object.assign(LG, {
    isKey,
    exitApp,
    requestExit,
    openShortcutsDialog,
  });
})();