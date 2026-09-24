(function () {
  const NAV_KEY = 'link-grid-nav-v1';

  const state = {
    boards: [],
    currentBoardId: null,
    loaded: false,
  };

  let expandedByBoard = {};

  // Tracks the currently-mounted board grid so a single slot can be
  // refreshed in place (without rebuilding every cell / reloading every
  // iframe) whenever just one link changes.
  let activeGrid = null;
  let activeBoardId = null;
  let activeCellEls = [];

  // Tracks the currently-open board-menu flyout (if any) so a single
  // document-level click listener can close it when the user clicks
  // elsewhere, without stacking a new listener on every re-render.
  let activeMenuWrap = null;

  document.addEventListener('click', (event) => {
    if (activeMenuWrap && !activeMenuWrap.contains(event.target)) {
      activeMenuWrap.classList.remove('open');
      activeMenuWrap = null;
    }
  });

  const topbarEl = document.getElementById('topbar');
  const contentEl = document.getElementById('content');

  function readNav() {
    try {
      const raw = localStorage.getItem(NAV_KEY);
      if (!raw) return;

      const parsed = JSON.parse(raw);
      if (parsed && parsed.currentBoardId) {
        state.currentBoardId = parsed.currentBoardId;
      }
    } catch (error) {
      // Ignore unreadable saved navigation state.
    }
  }

  function writeNav() {
    try {
      localStorage.setItem(NAV_KEY, JSON.stringify({ currentBoardId: state.currentBoardId }));
    } catch (error) {
      // Ignore storage write failures.
    }
  }

  function makeLocalId() {
    return 'b' + Date.now() + Math.floor(Math.random() * 1000);
  }

  function blankBoard(name, slotCount, layoutMode, description) {
    return {
      id: makeLocalId(),
      name,
      layoutMode: layoutMode || 'standard',
      // Only ever shown back to the user in the "Create new layout" dialog
      // itself — a note for their own reference, not displayed on tiles
      // or in Grid settings.
      description: description || '',
      slots: Array.from({ length: slotCount || 4 }, () => null),
    };
  }

  function findBoard(id) {
    return state.boards.find((board) => board.id === id) || null;
  }

  // What to call a link in messages: its title when it has one, else "Slot N".
  function slotName(board, index) {
    const slot = board && board.slots[index];
    return slot && slot.label ? slot.label : 'Slot ' + (index + 1);
  }

  function escapeHtml(text) {
    return String(text).replace(/[&<>"']/g, (ch) => ({
      '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;',
    }[ch]));
  }

  // ----------------------------------------------------------------------
  // Browser storage. Every layout and link is saved in the browser's
  // localStorage, so the UI comes back exactly as you left it next time you
  // open the page. It stays until the browser's site data is cleared.
  // ----------------------------------------------------------------------

  const BOARDS_KEY = 'link-grid-boards-v1';
  const MODES = ['standard', 'horizontal', 'solo', 'three'];

  // Ask the browser not to evict this site's data when disk space is low.
  if (navigator.storage && navigator.storage.persist) {
    navigator.storage.persist().catch(() => {});
  }

  function loadBoards() {
    try {
      const raw = localStorage.getItem(BOARDS_KEY);
      if (!raw) return [];

      const parsed = JSON.parse(raw);
      if (!Array.isArray(parsed)) return [];

      return parsed
        .filter((board) => board && typeof board.id === 'string')
        .map((board) => ({
          id: board.id,
          name: String(board.name || 'Untitled'),
          layoutMode: MODES.includes(board.layoutMode) ? board.layoutMode : 'standard',
          description: board.description || '',
          slots: Array.isArray(board.slots)
            ? board.slots.map((s) => (s && s.url ? { label: s.label || '', url: s.url } : null))
            : [null, null, null, null],
        }));
    } catch (error) {
      console.error('Link Layouts: saved layouts could not be read.', error);
      return [];
    }
  }

  // Writes the whole list of boards. Called after every change.
  function persist() {
    try {
      localStorage.setItem(BOARDS_KEY, JSON.stringify(state.boards));
    } catch (error) {
      console.error('Link Layouts: could not save to browser storage.', error);
    }
  }

  function initStorage() {
    readNav();
    state.boards = loadBoards();

    if (!state.boards.length) {
      state.boards.push(blankBoard('Layout 1'));
      persist();
    }

    state.loaded = true;
    render();
  }

  const storage = {
    createBoard(name, slotCount, layoutMode, description) {
      const board = blankBoard(name, slotCount, layoutMode, description);
      state.boards.push(board);
      persist();

      render();
      return Promise.resolve(board.id);
    },

    renameBoard(board, name) {
      board.name = name;
      persist();
    },

    deleteBoard(board) {
      state.boards = state.boards.filter((item) => item.id !== board.id);

      if (!state.boards.length) {
        state.boards.push(blankBoard('Layout 1'));
      }
      persist();
    },

    resizeBoard(board, slotCount, layoutMode) {
      const newSlots = board.slots.slice(0, slotCount);
      while (newSlots.length < slotCount) newSlots.push(null);

      board.slots = newSlots;
      board.layoutMode = layoutMode;
      expandedByBoard[board.id] = null;
      persist();

      render();
    },

    saveSlot(board, index, dataOrNull) {
      const newSlots = board.slots.slice();
      newSlots[index] = dataOrNull;
      board.slots = newSlots;
      persist();

      if (state.currentBoardId === board.id) {
        refreshCell(board, index);
      } else {
        render();
      }
    },
  };

  function domainOf(url) {
    try {
      return new URL(url).hostname.replace(/^www\./, '');
    } catch (error) {
      return url;
    }
  }

  function normalizeUrl(raw) {
    const value = raw.trim();
    if (!value) return '';
    if (/^(?:https?|file):\/\//i.test(value)) return value;

    // Accept pasted Windows paths as local file URLs.
    if (/^[a-z]:[\\/]/i.test(value)) {
      return 'file:///' + value.replace(/\\/g, '/');
    }

    // Resolve relative files from the folder containing this app.
    if (/^(?:\.\.?[\\/]|\/)/.test(value)) {
      return new URL(value.replace(/\\/g, '/'), document.baseURI).href;
    }

    return 'https://' + value;
  }

  function hashString(str) {
    let hash = 0;
    for (let index = 0; index < str.length; index += 1) {
      hash = (hash << 5) - hash + str.charCodeAt(index);
      hash |= 0;
    }
    return Math.abs(hash);
  }

  function avatarFor(slot) {
    const basis = slot.label || domainOf(slot.url);
    return hashString(basis) % 360;
  }

  function linkCount(board) {
    return board.slots.filter(Boolean).length;
  }

  function fitMonitorFrame(viewport, frame) {
    const canvasWidth = 960;
    const canvasHeight = 720;
    const scaleX = viewport.clientWidth / canvasWidth;
    const scaleY = viewport.clientHeight / canvasHeight;

    if (scaleX > 0 && scaleY > 0) {
      frame.style.transform = 'scale(' + scaleX + ', ' + scaleY + ')';
    }
  }

  function setEmbeddedChromeHidden(frame, hidden) {
    try {
      const document = frame.contentDocument;
      if (!document) return;

      let style = document.getElementById('link-layouts-monitor-style');
      if (!style) {
        style = document.createElement('style');
        style.id = 'link-layouts-monitor-style';
        style.textContent = [
          'header',
          'nav',
          '[role="banner"]',
          '.navbar',
          '.topbar',
          '.header',
          '.logo',
          '.brand',
          'h1',
          'h2',
          '[class*="logo"]',
          '[class*="brand"]',
          '[class*="title"]',
          '[id*="logo"]',
          '[id*="brand"]',
          '[id*="title"]'
        ].map((selector) => selector + ' { display: none !important; }').join('\n');
        document.head.appendChild(style);
      }

      style.disabled = !hidden;
    } catch (error) {
      // Cross-origin frames cannot be styled by the dashboard.
    }
  }

  function columnsFor(board) {
    if (board.layoutMode === 'horizontal') return Math.max(1, board.slots.length);
    if (board.layoutMode === 'solo') return 1;
    if (board.layoutMode === 'three') return 3;
    return Math.min(4, Math.max(1, Math.ceil(Math.sqrt(board.slots.length))));
  }

  function goHome() {
    state.currentBoardId = null;
    writeNav();
    render();
  }

  function openBoard(id) {
    state.currentBoardId = id;
    writeNav();
    render();
  }

  function render() {
    if (!state.loaded) {
      renderLoading();
      return;
    }

    if (state.currentBoardId) {
      const board = findBoard(state.currentBoardId);
      if (board) {
        renderBoardTopbar(board);
        renderBoardContent(board);
        return;
      }
    }

    renderHomeTopbar();
    renderHomeContent();
  }

  function renderLoading() {
    topbarEl.innerHTML = '';
    topbarEl.classList.remove('board-toolbar', 'is-visible');

    topbarEl.appendChild(buildBrand());

    contentEl.className = 'content mode-home';
    contentEl.innerHTML = '<div class="home-intro">Loading your layouts…</div>';
  }

  function renderHomeTopbar() {
    topbarEl.innerHTML = '';
    topbarEl.classList.remove('board-toolbar', 'is-visible');

    topbarEl.appendChild(buildBrand());

    const title = document.createElement('div');
    title.className = 'title';
    title.textContent = '· ' + state.boards.length + (state.boards.length === 1 ? ' layout' : ' layouts');
    topbarEl.appendChild(title);

    const spacer = document.createElement('div');
    spacer.className = 'topbar-spacer';
    topbarEl.appendChild(spacer);

    topbarEl.appendChild(buildLiveClock());

    const status = document.createElement('div');
    status.className = 'db-status-btn db-status-ok';
    status.textContent = '💾';
    status.title = 'Saved in this browser — your layouts stay until the browser\'s site data is cleared';
    topbarEl.appendChild(status);
  }

  // Logo mark, shared between the home and board toolbars.
  function buildBrand() {
    const brand = document.createElement('div');
    brand.className = 'brand';

    const logo = document.createElement('img');
    logo.className = 'brand-icon';
    logo.src = 'RTdbX.png';
    logo.alt = 'RTdbX';

    brand.appendChild(logo);
    return brand;
  }

  function formatClock() {
    const now = new Date();
    const date = now.toLocaleDateString(undefined, { month: 'short', day: 'numeric', year: 'numeric' });
    const time = now.toLocaleTimeString();
    return date + ' · ' + time;
  }

  // A clock (with date) that ticks once a second. Every element with this
  // class gets updated together, so a fresh one keeps working after re-render.
  function buildLiveClock() {
    const clock = document.createElement('div');
    clock.className = 'live-clock';
    clock.textContent = formatClock();
    return clock;
  }

  function startLiveClock() {
    setInterval(() => {
      const text = formatClock();
      document.querySelectorAll('.live-clock').forEach((el) => {
        el.textContent = text;
      });
    }, 1000);
  }

  function renderHomeContent() {
    contentEl.className = 'content mode-home';
    contentEl.innerHTML = '';

    const intro = document.createElement('div');
    intro.className = 'home-intro';
    intro.textContent = 'Pick a layout to open, or start a new one.';
    contentEl.appendChild(intro);

    const list = document.createElement('div');
    list.className = 'board-list';

    state.boards.forEach((board) => {
      const tile = document.createElement('div');
      tile.className = 'board-tile';

      const mini = document.createElement('div');
      mini.className = 'mini-grid';
      const miniColumns = Math.min(columnsFor(board), board.slots.length);
      mini.style.gridTemplateColumns = 'repeat(' + miniColumns + ', 1fr)';
      mini.style.gridTemplateRows = 'repeat(' + Math.ceil(board.slots.length / miniColumns) + ', 1fr)';

      board.slots.forEach((slot) => {
        const miniCell = document.createElement('div');
        miniCell.className = 'mini-cell' + (slot ? ' filled' : '');

        if (slot) {
          const hue = avatarFor(slot);
          miniCell.style.background = 'hsl(' + hue + ', 60%, 40%)';
          miniCell.style.borderColor = 'hsl(' + hue + ', 60%, 55%)';
        }

        mini.appendChild(miniCell);
      });

      tile.appendChild(mini);

      const footer = document.createElement('div');
      footer.className = 'board-tile-footer';

      const nameWrap = document.createElement('div');
      nameWrap.style.flex = '1';

      const name = document.createElement('div');
      name.className = 'board-name';
      name.textContent = board.name;

      const meta = document.createElement('div');
      meta.className = 'board-meta';
      meta.textContent = linkCount(board) + ' / ' + board.slots.length + ' links';

      nameWrap.appendChild(name);
      nameWrap.appendChild(meta);
      footer.appendChild(nameWrap);
      tile.appendChild(footer);

      tile.addEventListener('click', () => openBoard(board.id));
      list.appendChild(tile);
    });

    const addTile = document.createElement('div');
    addTile.className = 'add-tile';
    addTile.innerHTML = '<div class="plus">+</div><div class="label">New layout</div>';
    addTile.addEventListener('click', () => {
      openNewGridDialog();
    });
    list.appendChild(addTile);

    contentEl.appendChild(list);
    contentEl.appendChild(buildBoardFooter());
  }

  function renderBoardTopbar(board) {
    topbarEl.innerHTML = '';
    topbarEl.className = 'topbar board-toolbar';
    topbarEl.classList.toggle('is-visible', Number.isInteger(expandedByBoard[board.id]));

    const heading = document.createElement('div');
    heading.className = 'board-heading';

    const brandRow = document.createElement('div');
    brandRow.className = 'board-brand-row';

    // Menu flyout: houses "Grid settings", "Change link" (for whichever
    // slot is currently expanded) and "Grid Layouts". Sits to
    // the left of the brand icon.
    const menuWrap = document.createElement('div');
    menuWrap.className = 'board-menu-wrap';

    const menuBtn = document.createElement('button');
    menuBtn.type = 'button';
    menuBtn.className = 'board-menu-btn';
    menuBtn.innerHTML = '☰';
    menuBtn.setAttribute('aria-label', 'Open menu');
    menuBtn.setAttribute('aria-expanded', 'false');
    menuBtn.title = 'Menu';

    const menuPanel = document.createElement('div');
    menuPanel.className = 'board-menu-panel';

    function closeMenu() {
      menuWrap.classList.remove('open');
      menuBtn.setAttribute('aria-expanded', 'false');
      if (activeMenuWrap === menuWrap) activeMenuWrap = null;
    }

    menuBtn.addEventListener('click', (event) => {
      event.stopPropagation();
      const isOpen = menuWrap.classList.toggle('open');
      menuBtn.setAttribute('aria-expanded', String(isOpen));
      activeMenuWrap = isOpen ? menuWrap : null;
    });

    const settingsItem = document.createElement('button');
    settingsItem.type = 'button';
    settingsItem.className = 'board-menu-item';
    settingsItem.innerHTML = '<span class="board-menu-item-icon">⚙</span><span>grid setting</span>';
    settingsItem.addEventListener('click', (event) => {
      event.stopPropagation();
      closeMenu();
      openGridSettings(board);
    });

    const changeLinkItem = document.createElement('button');
    changeLinkItem.type = 'button';
    changeLinkItem.className = 'board-menu-item';
    changeLinkItem.innerHTML = '<span class="board-menu-item-icon">🔗</span><span>Change link</span>';
    changeLinkItem.addEventListener('click', (event) => {
      event.stopPropagation();
      closeMenu();
      // The expanded slot, else the slot that was under the mouse when the
      // menu was opened with Tab.
      const currentIndex = Number.isInteger(expandedByBoard[board.id])
        ? expandedByBoard[board.id]
        : menuChangeIndex;
      if (Number.isInteger(currentIndex)) openSettings(board, currentIndex);
    });

    const returnItem = document.createElement('button');
    returnItem.type = 'button';
    returnItem.className = 'board-menu-item';
    returnItem.innerHTML = '<span class="board-menu-item-icon">⌂</span><span>Grid Layouts</span>';
    returnItem.addEventListener('click', (event) => {
      event.stopPropagation();
      closeMenu();
      goHome();
    });

    // Extra entries (same look as the items above).
    function extraItem(icon, text, run) {
      const item = document.createElement('button');
      item.type = 'button';
      item.className = 'board-menu-item';
      item.innerHTML = '<span class="board-menu-item-icon">' + icon + '</span><span>' + text + '</span>';
      item.addEventListener('click', (event) => {
        event.stopPropagation();
        closeMenu();
        run();
      });
      return item;
    }

    menuPanel.appendChild(settingsItem);
    menuPanel.appendChild(changeLinkItem);
    menuPanel.appendChild(returnItem);
    menuPanel.appendChild(extraItem('\u2328', 'Shortcut keys', openShortcutsDialog));
    menuWrap.appendChild(menuBtn);
    menuWrap.appendChild(menuPanel);
    brandRow.appendChild(menuWrap);

    brandRow.appendChild(buildBrand());

    const nameDisplay = document.createElement('div');
    nameDisplay.className = 'board-title-display';
    nameDisplay.textContent = board.name;
    nameDisplay.setAttribute('title', 'Rename from grid setting');
    brandRow.appendChild(nameDisplay);

    heading.appendChild(brandRow);

    topbarEl.appendChild(heading);

    const actions = document.createElement('div');
    actions.className = 'board-actions';
    topbarEl.appendChild(actions);

    actions.appendChild(buildLiveClock());

    const clockDivider = document.createElement('span');
    clockDivider.className = 'toolbar-divider';
    actions.appendChild(clockDivider);

    const fullscreenBtn = document.createElement('button');
    fullscreenBtn.type = 'button';
    fullscreenBtn.className = 'toolbar-icon-btn fullscreen-btn';
    fullscreenBtn.textContent = '⛶';
    fullscreenBtn.setAttribute('aria-label', 'Toggle full screen');
    fullscreenBtn.title = 'Toggle full screen (F)';
    fullscreenBtn.addEventListener('click', toggleFullscreen);
    actions.appendChild(fullscreenBtn);

    const fullscreenDivider = document.createElement('span');
    fullscreenDivider.className = 'toolbar-divider';
    actions.appendChild(fullscreenDivider);

    const graphOnlyBtn = document.createElement('button');
    graphOnlyBtn.type = 'button';
    graphOnlyBtn.className = 'toolbar-icon-btn graph-only-btn';
    graphOnlyBtn.textContent = '▣';
    graphOnlyBtn.setAttribute('aria-label', 'Hide dashboard controls');
    graphOnlyBtn.title = 'Graph only (G)';
    graphOnlyBtn.addEventListener('click', toggleGraphOnly);
    actions.appendChild(graphOnlyBtn);

    const graphOnlyDivider = document.createElement('span');
    graphOnlyDivider.className = 'toolbar-divider';
    actions.appendChild(graphOnlyDivider);

    const deleteBoardBtn = document.createElement('button');
    deleteBoardBtn.type = 'button';
    deleteBoardBtn.className = 'toolbar-icon-btn delete-board-btn';
    deleteBoardBtn.textContent = '✕';
    deleteBoardBtn.setAttribute('aria-label', 'Delete layout');
    deleteBoardBtn.title = 'Delete layout';
    deleteBoardBtn.addEventListener('click', async () => {
      const linkTotal = linkCount(board);
      const warning = linkTotal
        ? 'This will permanently remove ' + linkTotal + ' link' + (linkTotal === 1 ? '' : 's') + '. This cannot be undone.'
        : 'This cannot be undone.';

      const confirmed = await openConfirmDialog({
        title: 'Delete "' + board.name + '"?',
        message: warning,
        confirmLabel: 'Delete',
      });
      if (!confirmed) return;

      storage.deleteBoard(board);
      goHome();
    });
    actions.appendChild(deleteBoardBtn);
  }

  function toggleFullscreen() {
    if (document.fullscreenElement) {
      document.exitFullscreen();
      return;
    }

    if (document.documentElement.requestFullscreen) {
      document.documentElement.requestFullscreen();
    }
  }

  // Auto-hides the bottom (⛶) button after a few seconds of no mouse
  // activity — in the normal windowed view, in real browser full screen,
  // and in Graph Only mode alike. Moving the mouse brings it back and
  // restarts the idle countdown.
  let fsIdleHideTimer = null;

  function clearFsIdleHideTimer() {
    if (fsIdleHideTimer) {
      clearTimeout(fsIdleHideTimer);
      fsIdleHideTimer = null;
    }
  }

  function showFullscreenGridBtn() {
    document.querySelectorAll('.fullscreen-grid-btn').forEach((button) => {
      button.classList.remove('idle-hide');
    });
  }

  function scheduleFullscreenGridBtnHide() {
    clearFsIdleHideTimer();
    fsIdleHideTimer = setTimeout(() => {
      document.querySelectorAll('.fullscreen-grid-btn').forEach((button) => {
        button.classList.add('idle-hide');
      });
    }, 3000);
  }

  document.addEventListener('mousemove', () => {
    showFullscreenGridBtn();
    scheduleFullscreenGridBtnHide();
  });

  document.addEventListener('fullscreenchange', () => {
    showFullscreenGridBtn();
    scheduleFullscreenGridBtnHide();
  });

  // ----------------------------------------------------------------------
  // Full-screen shortcut + exit instructions.
  //   F            - enter / leave full screen (ignored while typing)
  //   Esc          - leaves full screen (handled by the browser itself)
  // A short hint appears whenever the page goes full screen, including
  // F11 and kiosk mode, telling the user how to get out.
  // ----------------------------------------------------------------------

  const fsHintStyle = document.createElement('style');
  fsHintStyle.textContent = [
    '.fs-hint{position:fixed;top:16px;left:50%;transform:translate(-50%,-8px);',
    'z-index:2147483000;padding:10px 18px;border-radius:10px;',
    'background:rgba(15,17,21,.92);color:#fff;font:600 14px/1.3 system-ui,sans-serif;',
    'border:1px solid rgba(255,255,255,.25);box-shadow:0 6px 24px rgba(0,0,0,.45);',
    'opacity:0;pointer-events:none;transition:opacity .3s,transform .3s;white-space:nowrap}',
    '.fs-hint.show{opacity:1;transform:translate(-50%,0)}',
    '.fs-hint kbd{display:inline-block;padding:1px 7px;margin:0 2px;border-radius:5px;',
    'background:#fff;color:#0f1115;font:700 12px/1.6 system-ui,sans-serif}',
  ].join('');
  document.head.appendChild(fsHintStyle);

  const fsHintEl = document.createElement('div');
  fsHintEl.className = 'fs-hint';
  fsHintEl.setAttribute('role', 'status');
  document.body.appendChild(fsHintEl);

  let fsHintTimer = null;

  function isFullScreenNow() {
    return Boolean(document.fullscreenElement) ||
      (window.matchMedia && window.matchMedia('(display-mode: fullscreen)').matches);
  }

  function showHint(html) {
    fsHintEl.innerHTML = html;
    fsHintEl.classList.add('show');
    clearTimeout(fsHintTimer);
    fsHintTimer = setTimeout(() => fsHintEl.classList.remove('show'), 6000);
  }

  function showFullscreenHint() {
    // Entered through the button / F key: Esc or F leaves.
    // Entered through F11 or --kiosk: F11 leaves (kiosk: Alt+F4 closes).
    showHint(document.fullscreenElement
      ? 'Full screen &mdash; press <kbd>Esc</kbd> or <kbd>F</kbd> to exit'
      : 'Full screen &mdash; press <kbd>F11</kbd> to exit &middot; <kbd>Esc</kbd> closes the app');
  }

  function hideFullscreenHint() {
    clearTimeout(fsHintTimer);
    fsHintEl.classList.remove('show');
  }

  function onFullscreenStateChange() {
    if (isFullScreenNow()) showFullscreenHint();
    else hideFullscreenHint();
  }

  document.addEventListener('fullscreenchange', onFullscreenStateChange);

  if (window.matchMedia) {
    const displayModeQuery = window.matchMedia('(display-mode: fullscreen)');
    if (displayModeQuery.addEventListener) {
      displayModeQuery.addEventListener('change', onFullscreenStateChange);
    }
  }

  // Already full screen when the page opens (kiosk launch).
  if (isFullScreenNow()) showFullscreenHint();

  // True when the pressed key is this letter, on any keyboard layout.
  function isKey(event, letter) {
    return event.key.toLowerCase() === letter || event.code === 'Key' + letter.toUpperCase();
  }

  document.addEventListener('keydown', (event) => {
    const key = isKey(event, 'f') ? 'f' : isKey(event, 'g') ? 'g' : '';
    if (!key) return;
    if (event.ctrlKey || event.metaKey || event.altKey || event.repeat) return;

    const target = event.target;
    const tag = target && target.tagName;
    if (tag === 'INPUT' || tag === 'TEXTAREA' || tag === 'SELECT' || (target && target.isContentEditable)) return;
    if (document.querySelector('.settings-backdrop')) return; // a dialog is open

    if (key === 'f') {
      event.preventDefault();
      toggleFullscreen();
      return;
    }

    // G: graph only. Only meaningful while a layout is open (or to leave
    // graph-only mode if it is already on).
    const inBoard = contentEl.classList.contains('mode-board');
    if (inBoard || document.body.classList.contains('graph-only-mode')) {
      event.preventDefault();
      toggleGraphOnly();
    }
  });

  // ----------------------------------------------------------------------
  // Tab: open / close the existing ☰ menu (the one in the layout toolbar).
  // The toolbar is normally hidden, so it is shown as an overlay while the
  // menu is open (also in graph-only mode). Up / Down move between items,
  // Enter picks one, Tab or Esc closes it.
  // ----------------------------------------------------------------------

  const menuShortcutStyle = document.createElement('style');
  menuShortcutStyle.textContent = [
    /* toolbar shown as an overlay while the menu is open */
    '.topbar.board-toolbar.menu-peek,body.graph-only-mode #topbar.menu-peek{display:flex !important;',
    'position:fixed;top:0;left:0;right:0;z-index:9500;box-shadow:0 10px 30px rgba(0,0,0,.5)}',

    /* shortcut keys dialog */
    '.shortcut-list{display:grid;grid-template-columns:auto 1fr;gap:12px 18px;align-items:center;margin:10px 0 14px;text-align:left}',
    '.shortcut-list .sc-keys{white-space:nowrap}',
    '.shortcut-list kbd{display:inline-block;min-width:26px;padding:3px 9px;border-radius:6px;background:#fff;',
    'color:#0f1115;font:700 12px/1.4 system-ui,sans-serif;text-align:center;box-shadow:0 2px 0 rgba(0,0,0,.35)}',
    '.shortcut-list .sc-plus{margin:0 4px;opacity:.7}',
    '.shortcut-list .sc-text{font-size:14px;line-height:1.4}',
    '.shortcuts-tip{font-size:13px;line-height:1.5;opacity:.8;margin-bottom:14px;text-align:left}',
  ].join('');
  document.head.appendChild(menuShortcutStyle);

  let menuChangeIndex = null; // slot "Change link" applies to when opened with Tab

  // When the menu closes (any way), put the toolbar back the way it was.
  new MutationObserver((records) => {
    const touchedMenu = records.some((r) => r.target.classList && r.target.classList.contains('board-menu-wrap'));
    if (!touchedMenu) return;
    if (!topbarEl.querySelector('.board-menu-wrap.open')) {
      topbarEl.classList.remove('menu-peek');
      menuChangeIndex = null;
    }
  }).observe(topbarEl, { subtree: true, attributes: true, attributeFilter: ['class'] });

  document.addEventListener('keydown', (event) => {
    if (event.ctrlKey || event.altKey || event.metaKey || event.shiftKey) return;

    // A menu left over from a previous render is not really open.
    if (activeMenuWrap && !document.contains(activeMenuWrap)) activeMenuWrap = null;

    // Up / Down move through the open menu.
    if (activeMenuWrap && (event.key === 'ArrowDown' || event.key === 'ArrowUp')) {
      event.preventDefault();
      const items = Array.from(activeMenuWrap.querySelectorAll('.board-menu-item'));
      const at = items.indexOf(document.activeElement);
      const step = event.key === 'ArrowDown' ? 1 : -1;
      items[(at + step + items.length) % items.length].focus();
      return;
    }

    if (event.key !== 'Tab') return;

    const target = event.target;
    const tag = target && target.tagName;
    if (tag === 'INPUT' || tag === 'TEXTAREA' || tag === 'SELECT' || (target && target.isContentEditable)) return;
    if (document.querySelector('.settings-backdrop')) return; // a dialog is open

    // The menu lives in the layout toolbar, so it only exists on an open layout.
    const menuBtn = topbarEl.querySelector('.board-menu-btn');
    const board = findBoard(state.currentBoardId);
    if (!menuBtn || !board || !contentEl.classList.contains('mode-board')) return;

    event.preventDefault(); // stop Tab from moving keyboard focus around

    if (activeMenuWrap) { // already open: close it
      menuBtn.click();
      return;
    }

    const expandedIndex = expandedByBoard[board.id];
    menuChangeIndex = Number.isInteger(expandedIndex) ? expandedIndex : hoveredSlotIndex;

    const toolbarHidden = document.body.classList.contains('graph-only-mode') || !topbarEl.classList.contains('is-visible');

    menuBtn.click(); // opens the existing menu
    if (toolbarHidden) topbarEl.classList.add('menu-peek');

    const first = topbarEl.querySelector('.board-menu-item');
    if (first) first.focus();
  });

  // Esc: exit (close the window). This is how you leave kiosk / app mode.
  // Asks first, because Esc is easy to hit by accident: press Enter to
  // confirm or Esc again to cancel. A page can only close its own window
  // when the browser allows it; if it refuses, show the Alt+F4 fallback.
  let exitDialogOpen = false;

  function exitApp() {
    window.close();

    setTimeout(() => {
      showHint('Could not close from the page &mdash; press <kbd>Alt</kbd>+<kbd>F4</kbd>');
    }, 400);
  }

  function requestExit() {
    if (exitDialogOpen) return;
    exitDialogOpen = true;

    openConfirmDialog({
      title: 'Exit?',
      message: 'Close the monitoring dashboard? Press Enter to exit or Esc to stay.',
      confirmLabel: 'Exit',
    }).then((confirmed) => {
      exitDialogOpen = false;
      if (confirmed) exitApp();
    });
  }

  // Capture phase, so this runs before a dialog's own Esc handler removes
  // the dialog (otherwise closing a dialog with Esc would also exit).
  document.addEventListener('keydown', (event) => {
    if (event.key !== 'Escape') return;
    if (event.ctrlKey || event.altKey || event.shiftKey || event.metaKey) return;

    if (activeMenuWrap && document.contains(activeMenuWrap)) { // Esc closes the menu first
      event.preventDefault();
      const menuBtn = activeMenuWrap.querySelector('.board-menu-btn');
      if (menuBtn) menuBtn.click();
      return;
    }

    if (document.querySelector('.settings-backdrop')) return; // a dialog is open
    if (document.fullscreenElement) return; // the browser uses Esc to leave full screen
    requestExit();
  }, true);

  // ----------------------------------------------------------------------
  // Shortcut keys list (menu item, or press ?).
  // ----------------------------------------------------------------------

  function openShortcutsDialog() {
    if (document.querySelector('.settings-backdrop')) return;

    const backdrop = document.createElement('div');
    backdrop.className = 'settings-backdrop';
    backdrop.addEventListener('click', (event) => {
      if (event.target === backdrop) close();
    });

    const modal = document.createElement('div');
    modal.className = 'settings-modal';

    const heading = document.createElement('h3');
    heading.textContent = 'Shortcut keys';
    modal.appendChild(heading);

    const rows = [
      [['Tab'], 'Open or close this menu. Inside it, use \u2191 \u2193 and Enter.'],
      [['E'], 'Expand or collapse the link under the mouse (or collapse the one that is expanded).'],
      [['F'], 'Turn full screen on or off.'],
      [['G'], 'Graph only: hide the toolbar and headings. Press again to bring them back.'],
      [['Esc'], 'Close the menu or a window. With nothing open, it asks to exit (Enter to confirm).'],
      [['?'], 'Show this list.'],
      [['Alt', 'F4'], 'Close the window if Esc cannot.'],
    ];

    const list = document.createElement('div');
    list.className = 'shortcut-list';
    rows.forEach(([keys, text]) => {
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

      list.appendChild(keyCell);
      list.appendChild(textCell);
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

  document.addEventListener('keydown', (event) => {
    if (event.key !== '?' || event.ctrlKey || event.altKey || event.metaKey) return;

    const target = event.target;
    const tag = target && target.tagName;
    if (tag === 'INPUT' || tag === 'TEXTAREA' || tag === 'SELECT' || (target && target.isContentEditable)) return;
    if (document.querySelector('.settings-backdrop')) return;

    event.preventDefault();
    openShortcutsDialog();
  });

  // ----------------------------------------------------------------------
  // Keeping the keys working.
  // Key presses go to whatever has focus. After you click inside an embedded
  // page, or come back to this tab, focus can still be sitting inside that
  // page, so the shortcuts never see the key. These hand focus back to the
  // dashboard when you click the dashboard, return to the tab, or move the
  // mouse off a link.
  // ----------------------------------------------------------------------

  function reclaimFocus() {
    const active = document.activeElement;
    if (active && active.tagName === 'IFRAME') active.blur();
  }

  window.addEventListener('focus', reclaimFocus);
  document.addEventListener('visibilitychange', () => {
    if (!document.hidden) reclaimFocus();
  });
  document.addEventListener('mousedown', reclaimFocus, true);

  // Pages that share this page's origin can be reached, so their key presses
  // are passed on to the shortcuts (except while typing in a field there).
  function forwardFrameKeys(frame) {
    let frameDoc = null;
    try { frameDoc = frame.contentDocument; } catch (error) { return; }
    if (!frameDoc) return; // other websites cannot be reached by the browser's rules

    frameDoc.addEventListener('keydown', (event) => {
      const tag = event.target && event.target.tagName;
      if (tag === 'INPUT' || tag === 'TEXTAREA' || tag === 'SELECT' || (event.target && event.target.isContentEditable)) return;

      const copy = new KeyboardEvent('keydown', {
        key: event.key,
        code: event.code,
        ctrlKey: event.ctrlKey,
        shiftKey: event.shiftKey,
        altKey: event.altKey,
        metaKey: event.metaKey,
        repeat: event.repeat,
        bubbles: true,
        cancelable: true,
      });
      document.dispatchEvent(copy);
      if (copy.defaultPrevented) event.preventDefault();
    });
  }

  // ----------------------------------------------------------------------
  // E: expand / collapse a link (same as the arrow button on its holder).
  // Collapses the expanded slot, otherwise expands the slot under the mouse.
  // If the mouse is over an empty slot, tell the user there's no link and
  // let them add one on the spot.
  // ----------------------------------------------------------------------

  let hoveredSlotIndex = null;

  document.addEventListener('keydown', (event) => {
    if (!isKey(event, 'e')) return;
    if (event.ctrlKey || event.altKey || event.metaKey || event.shiftKey) return;

    const target = event.target;
    const tag = target && target.tagName;
    if (tag === 'INPUT' || tag === 'TEXTAREA' || tag === 'SELECT' || (target && target.isContentEditable)) return;
    if (document.querySelector('.settings-backdrop')) return; // a dialog is open
    if (!contentEl.classList.contains('mode-board')) return;

    const board = findBoard(state.currentBoardId);
    if (!board) return;

    const expandedIndex = expandedByBoard[board.id];
    let index;
    if (Number.isInteger(expandedIndex) && board.slots[expandedIndex]) {
      index = expandedIndex;
    } else if (hoveredSlotIndex !== null && board.slots[hoveredSlotIndex]) {
      index = hoveredSlotIndex;
    } else if (hoveredSlotIndex !== null && !board.slots[hoveredSlotIndex]) {
      // Hovering an empty slot: nothing to expand, so say so and offer to add a link.
      event.preventDefault();
      showHint('<b>' + escapeHtml(slotName(board, hoveredSlotIndex)) + '</b> has no link yet &mdash; add one');
      openSettings(board, hoveredSlotIndex);
      return;
    } else {
      showHint('Point at a link and press <kbd>E</kbd> to expand it');
      return;
    }

    event.preventDefault();
    toggleExpand(board, index);

    showHint(expandedByBoard[board.id] === index
      ? '<b>' + escapeHtml(slotName(board, index)) + '</b> expanded &mdash; press <kbd>E</kbd> to collapse'
      : '<b>' + escapeHtml(slotName(board, index)) + '</b> collapsed');
  });

  function toggleGraphOnly() {
    const enabled = document.body.classList.toggle('graph-only-mode');

    document.querySelectorAll('.graph-only-btn').forEach((button) => {
      button.textContent = enabled ? '↩' : '▣';
      button.setAttribute('aria-label', enabled ? 'Show dashboard controls' : 'Hide dashboard controls');
      button.title = enabled ? 'Show controls (G)' : 'Graph only (G)';
    });

    showFullscreenGridBtn();
    scheduleFullscreenGridBtnHide();

    if (enabled) showHint('Graph only &mdash; press <kbd>G</kbd> to show the controls again');
    else hideFullscreenHint();
  }

  function renderBoardContent(board) {
    contentEl.className = 'content mode-board';
    contentEl.innerHTML = '';

    if (!(board.id in expandedByBoard)) {
      expandedByBoard[board.id] = null;
    }

    const grid = document.createElement('div');
    grid.className = 'grid-stage';
    const columns = columnsFor(board);
    grid.style.gridTemplateColumns = 'repeat(' + columns + ', minmax(0, 1fr))';
    grid.style.gridTemplateRows = 'repeat(' + Math.ceil(board.slots.length / columns) + ', minmax(0, 1fr))';

    const gridFullscreenBtn = document.createElement('button');
    gridFullscreenBtn.className = 'fullscreen-grid-btn';
    gridFullscreenBtn.textContent = '⛶';
    gridFullscreenBtn.setAttribute('aria-label', 'Toggle full screen');
    gridFullscreenBtn.title = 'Toggle full screen (F)';
    gridFullscreenBtn.addEventListener('click', toggleFullscreen);
    grid.appendChild(gridFullscreenBtn);

    const exitGraphOnlyBtn = document.createElement('button');
    exitGraphOnlyBtn.type = 'button';
    exitGraphOnlyBtn.className = 'exit-graph-only-btn';
    exitGraphOnlyBtn.textContent = '↩';
    exitGraphOnlyBtn.setAttribute('aria-label', 'Show dashboard controls');
    exitGraphOnlyBtn.title = 'Show controls (G)';
    exitGraphOnlyBtn.addEventListener('click', toggleGraphOnly);
    grid.appendChild(exitGraphOnlyBtn);

    activeGrid = grid;
    activeBoardId = board.id;
    activeCellEls = [];

    board.slots.forEach((slot, index) => {
      const cell = buildCell(board, index);
      activeCellEls.push(cell);
      grid.appendChild(cell);
    });

    contentEl.appendChild(grid);
    showFullscreenGridBtn();
    scheduleFullscreenGridBtnHide();
  }

  function buildBoardFooter() {
    const footer = document.createElement('div');
    footer.className = 'board-footer';

    const left = document.createElement('div');
    left.className = 'board-footer-left';
    left.textContent = 'RTdbX Traceability Web Application © 2025 Tsukiden Electronics Philippines, Inc.';
    footer.appendChild(left);

    const right = document.createElement('div');
    right.className = 'board-footer-right';

    const emailLink = document.createElement('a');
    emailLink.href = 'mailto:engg-sysdev@tsukiden-ph.com';
    emailLink.textContent = 'engg-sysdev@tsukiden-ph.com';
    right.appendChild(emailLink);

    right.appendChild(document.createTextNode(' | Local: 134/115'));
    footer.appendChild(right);

    return footer;
  }

  function buildCell(board, index) {
    const slot = board.slots[index];

    const cell = document.createElement('div');
    cell.className = 'cell' + (slot ? ' filled' : '') + (expandedByBoard[board.id] === index ? ' expanded' : '');

    // Remember which slot the mouse is over (used by the E and Tab shortcuts).
    cell.addEventListener('mouseenter', () => { hoveredSlotIndex = index; });
    cell.addEventListener('mouseleave', () => {
      if (hoveredSlotIndex === index) hoveredSlotIndex = null;
      reclaimFocus(); // so the shortcut keys work again after clicking inside a page
    });

    const topbar = document.createElement('div');
    topbar.className = 'cell-topbar';

    if (slot) {
      if (slot.label) {
        const label = document.createElement('div');
        label.className = 'slot-label';
        label.textContent = slot.label;
        topbar.appendChild(label);
      }

      const isExpanded = expandedByBoard[board.id] === index;
      const expandBtn = document.createElement('button');
      expandBtn.className = 'expand-btn';
      expandBtn.textContent = isExpanded ? '↙' : '↗';
      expandBtn.setAttribute('aria-label', (isExpanded ? 'Collapse ' : 'Expand ') + slotName(board, index));
      expandBtn.title = (isExpanded ? 'Collapse' : 'Expand') + ' (E)';
      expandBtn.addEventListener('click', (event) => {
        event.stopPropagation();
        toggleExpand(board, index);
      });
      topbar.appendChild(expandBtn);
    } else {
      const indexLabel = document.createElement('div');
      indexLabel.className = 'slot-index';
      indexLabel.textContent = 'SLOT ' + (index + 1);
      topbar.appendChild(indexLabel);
    }

    cell.appendChild(topbar);

    const viewport = document.createElement('div');
    viewport.className = 'cell-viewport';

    if (slot) {
      const frame = document.createElement('iframe');
      frame.className = 'live-frame fixed-monitor-frame';
      frame.src = slot.url;
      frame.setAttribute('sandbox', 'allow-scripts allow-same-origin allow-forms allow-popups allow-popups-to-escape-sandbox allow-top-navigation-by-user-activation');
      frame.setAttribute('referrerpolicy', 'no-referrer-when-downgrade');
      frame.setAttribute('loading', 'lazy');
      viewport.appendChild(frame);

      const resizeMonitor = () => fitMonitorFrame(viewport, frame);
      resizeMonitor();
      frame.addEventListener('load', () => {
        setEmbeddedChromeHidden(frame, expandedByBoard[board.id] !== index);
        resizeMonitor();
        forwardFrameKeys(frame);
      });
      if (typeof ResizeObserver !== 'undefined') {
        const observer = new ResizeObserver(resizeMonitor);
        observer.observe(viewport);
      }
    } else {
      const empty = document.createElement('div');
      empty.className = 'empty-state';
      empty.innerHTML = '<div class="empty-plus">+</div><div class="empty-label">Add a link</div>';
      empty.addEventListener('click', () => openSettings(board, index));
      viewport.appendChild(empty);
    }

    cell.appendChild(viewport);
    return cell;
  }

  // Rebuilds just one cell (used when a single link is added/edited) so the
  // other slots' iframes are left untouched and don't reload.
  function refreshCell(board, index) {
    if (activeBoardId !== board.id || !activeGrid) {
      render();
      return;
    }

    const newCell = buildCell(board, index);
    const oldCell = activeCellEls[index];

    if (oldCell && oldCell.parentNode === activeGrid) {
      activeGrid.replaceChild(newCell, oldCell);
    } else {
      activeGrid.appendChild(newCell);
    }

    activeCellEls[index] = newCell;
  }

  function openGridSettings(board) {
    const backdrop = document.createElement('div');
    backdrop.className = 'settings-backdrop';
    backdrop.addEventListener('click', (event) => {
      if (event.target === backdrop) close();
    });

    const modal = document.createElement('div');
    modal.className = 'settings-modal';

    const heading = document.createElement('h3');
    heading.textContent = 'grid setting';
    modal.appendChild(heading);

    const nameLabel = document.createElement('div');
    nameLabel.className = 'settings-field-label';
    nameLabel.textContent = 'Layout name';
    modal.appendChild(nameLabel);

    const nameInput = document.createElement('input');
    nameInput.value = board.name;
    nameInput.setAttribute('aria-label', 'Layout name');
    modal.appendChild(nameInput);

    const countLabel = document.createElement('div');
    countLabel.className = 'settings-field-label';
    countLabel.textContent = 'Number of slots';
    modal.appendChild(countLabel);

    const countInput = document.createElement('input');
    countInput.type = 'number';
    countInput.min = '1';
    countInput.max = '20';
    countInput.value = board.slots.length;
    modal.appendChild(countInput);

    const modeLabel = document.createElement('div');
    modeLabel.className = 'settings-field-label';
    modeLabel.textContent = 'Layout style';
    modal.appendChild(modeLabel);

    const modeSelect = document.createElement('select');
    modeSelect.className = 'settings-select';
    [
      ['standard', 'Balanced (auto-fit)'],
      ['horizontal', 'Horizontal (one row)'],
      ['solo', 'Solo (one full-space slot)'],
      ['three', 'Three across'],
    ].forEach(([value, label]) => {
      const option = document.createElement('option');
      option.value = value;
      option.textContent = label;
      option.selected = value === board.layoutMode;
      modeSelect.appendChild(option);
    });
    modeSelect.addEventListener('change', () => {
      if (modeSelect.value === 'solo') countInput.value = '1';
    });
    modal.appendChild(modeSelect);

    const hint = document.createElement('div');
    hint.className = 'settings-hint';
    hint.textContent = 'Existing links are kept when the grid grows.';
    modal.appendChild(hint);

    const row = document.createElement('div');
    row.className = 'settings-row-buttons';

    const cancelBtn = document.createElement('button');
    cancelBtn.textContent = 'Cancel';
    cancelBtn.addEventListener('click', close);
    row.appendChild(cancelBtn);

    const saveBtn = document.createElement('button');
    saveBtn.className = 'save';
    saveBtn.textContent = 'Apply';
    saveBtn.addEventListener('click', async () => {
      const slotCount = modeSelect.value === 'solo'
        ? 1
        : Math.min(20, Math.max(1, Number.parseInt(countInput.value, 10) || board.slots.length));
      const removedLinks = board.slots.slice(slotCount).filter(Boolean).length;

      if (removedLinks) {
        const confirmed = await openConfirmDialog({
          title: 'Reduce the grid?',
          message: 'This will remove ' + removedLinks + ' link' + (removedLinks === 1 ? '' : 's') + '. This cannot be undone.',
          confirmLabel: 'Reduce',
        });
        if (!confirmed) return;
      }

      const newName = nameInput.value.trim();
      if (newName && newName !== board.name) {
        storage.renameBoard(board, newName);
      }

      storage.resizeBoard(board, slotCount, modeSelect.value);
      close();
    });
    row.appendChild(saveBtn);

    modal.appendChild(row);
    backdrop.appendChild(modal);
    document.body.appendChild(backdrop);
    nameInput.focus();
    nameInput.select();

    function close() {
      if (backdrop.parentNode) backdrop.parentNode.removeChild(backdrop);
    }
  }

  // In-app confirmation dialog, styled the same as the settings/notify
  // modals used elsewhere (add link, grid setting) instead of the
  // browser's native window.confirm() popup.
  function openConfirmDialog({ title, message, confirmLabel }) {
    return new Promise((resolve) => {
      const backdrop = document.createElement('div');
      backdrop.className = 'settings-backdrop';
      backdrop.addEventListener('click', (event) => {
        if (event.target === backdrop) finish(false);
      });

      const modal = document.createElement('div');
      modal.className = 'settings-modal';

      const heading = document.createElement('h3');
      heading.textContent = title || 'Are you sure?';
      modal.appendChild(heading);

      const body = document.createElement('div');
      body.className = 'settings-message';
      body.textContent = message || '';
      modal.appendChild(body);

      const row = document.createElement('div');
      row.className = 'settings-row-buttons';

      const cancelBtn = document.createElement('button');
      cancelBtn.textContent = 'Cancel';
      cancelBtn.addEventListener('click', () => finish(false));
      row.appendChild(cancelBtn);

      const confirmBtn = document.createElement('button');
      confirmBtn.className = 'danger';
      confirmBtn.textContent = confirmLabel || 'Confirm';
      confirmBtn.addEventListener('click', () => finish(true));
      row.appendChild(confirmBtn);

      modal.appendChild(row);
      backdrop.appendChild(modal);
      document.body.appendChild(backdrop);
      confirmBtn.focus();

      document.addEventListener('keydown', onKeydown);

      function onKeydown(event) {
        if (event.key === 'Escape') finish(false);
      }

      function finish(result) {
        document.removeEventListener('keydown', onKeydown);
        if (backdrop.parentNode) backdrop.parentNode.removeChild(backdrop);
        resolve(result);
      }
    });
  }

  function toggleExpand(board, index) {
    const current = expandedByBoard[board.id];
    const next = current === index ? null : index;
    expandedByBoard[board.id] = next;
    topbarEl.classList.toggle('is-visible', next !== null);

    activeCellEls.forEach((cell, cellIndex) => {
      if (!cell) return;
      const isExpanded = cellIndex === next;
      cell.classList.toggle('expanded', isExpanded);

      const expandBtn = cell.querySelector('.expand-btn');
      if (expandBtn) {
        expandBtn.textContent = isExpanded ? '↙' : '↗';
        expandBtn.setAttribute('aria-label', (isExpanded ? 'Collapse ' : 'Expand ') + slotName(board, cellIndex));
        expandBtn.title = (isExpanded ? 'Collapse' : 'Expand') + ' (E)';
      }

      const frame = cell.querySelector('.live-frame');
      if (frame) setEmbeddedChromeHidden(frame, next !== cellIndex);
    });
  }

  function openSettings(board, index) {
    const slot = board.slots[index];
    const backdrop = document.createElement('div');
    backdrop.className = 'settings-backdrop';
    backdrop.addEventListener('click', (event) => {
      if (event.target === backdrop) close();
    });

    const modal = document.createElement('div');
    modal.className = 'settings-modal';

    const heading = document.createElement('h3');
    heading.textContent = (slot ? 'Edit link' : 'Add link') + ' - ' + slotName(board, index);
    modal.appendChild(heading);

    const urlLabel = document.createElement('div');
    urlLabel.className = 'settings-field-label';
    urlLabel.textContent = 'URL';
    modal.appendChild(urlLabel);

    const urlInput = document.createElement('input');
    urlInput.placeholder = 'example.com or C:\\path\\file.html';
    urlInput.value = slot ? slot.url : '';
    modal.appendChild(urlInput);

    const titleLabel = document.createElement('div');
    titleLabel.className = 'settings-field-label';
    titleLabel.textContent = 'Title (optional)';
    modal.appendChild(titleLabel);

    const labelInput = document.createElement('input');
    labelInput.placeholder = 'Title';
    labelInput.value = slot ? slot.label || '' : '';
    modal.appendChild(labelInput);

    const row = document.createElement('div');
    row.className = 'settings-row-buttons';

    const cancelBtn = document.createElement('button');
    cancelBtn.textContent = 'Cancel';
    cancelBtn.addEventListener('click', close);
    row.appendChild(cancelBtn);

    const saveBtn = document.createElement('button');
    saveBtn.className = 'save';
    saveBtn.textContent = 'Save';
    saveBtn.addEventListener('click', () => {
      const url = normalizeUrl(urlInput.value);
      if (!url) {
        urlInput.focus();
        return;
      }
      storage.saveSlot(board, index, { label: labelInput.value.trim(), url });
      close();
    });
    row.appendChild(saveBtn);

    modal.appendChild(row);
    backdrop.appendChild(modal);
    document.body.appendChild(backdrop);
    urlInput.focus();

    urlInput.addEventListener('keydown', (event) => {
      if (event.key === 'Enter') saveBtn.click();
      if (event.key === 'Escape') close();
    });

    function close() {
      if (backdrop.parentNode) backdrop.parentNode.removeChild(backdrop);
    }
  }

  function openNewGridDialog() {
    const backdrop = document.createElement('div');
    backdrop.className = 'settings-backdrop';
    backdrop.addEventListener('click', (event) => {
      if (event.target === backdrop) close();
    });

    const modal = document.createElement('div');
    modal.className = 'settings-modal';

    const heading = document.createElement('h3');
    heading.textContent = 'Create new layout';
    modal.appendChild(heading);

    const nameLabel = document.createElement('div');
    nameLabel.className = 'settings-field-label';
    nameLabel.textContent = 'Layout name';
    modal.appendChild(nameLabel);

    const nameInput = document.createElement('input');
    nameInput.placeholder = 'Layout ' + (state.boards.length + 1);
    nameInput.value = 'Layout ' + (state.boards.length + 1);
    modal.appendChild(nameInput);

    const countLabel = document.createElement('div');
    countLabel.className = 'settings-field-label';
    countLabel.textContent = 'Number of slots';
    modal.appendChild(countLabel);

    const countInput = document.createElement('input');
    countInput.type = 'number';
    countInput.min = '1';
    countInput.max = '8';
    countInput.value = '4';
    modal.appendChild(countInput);

    const modeLabel = document.createElement('div');
    modeLabel.className = 'settings-field-label';
    modeLabel.textContent = 'Layout style';
    modal.appendChild(modeLabel);

    const modeSelect = document.createElement('select');
    modeSelect.className = 'settings-select';
    [
      ['standard', 'Balanced (auto-fit)'],
      ['horizontal', 'Horizontal (one row)'],
      ['solo', 'Solo (one full-space slot)'],
      ['three', 'Three across'],
    ].forEach(([value, label]) => {
      const option = document.createElement('option');
      option.value = value;
      option.textContent = label;
      modeSelect.appendChild(option);
    });
    modeSelect.addEventListener('change', () => {
      if (modeSelect.value === 'solo') countInput.value = '1';
    });
    modal.appendChild(modeSelect);

    const row = document.createElement('div');
    row.className = 'settings-row-buttons';

    const cancelBtn = document.createElement('button');
    cancelBtn.textContent = 'Cancel';
    cancelBtn.addEventListener('click', close);
    row.appendChild(cancelBtn);

    const createBtn = document.createElement('button');
    createBtn.className = 'save';
    createBtn.textContent = 'Create';
    createBtn.addEventListener('click', () => {
      const slotCount = modeSelect.value === 'solo'
        ? 1
        : Math.min(20, Math.max(1, Number.parseInt(countInput.value, 10) || 4));
      const name = nameInput.value.trim() || 'Layout ' + (state.boards.length + 1);
      storage.createBoard(name, slotCount, modeSelect.value).then((id) => {
        close();
        if (id) openBoard(id);
      });
    });
    row.appendChild(createBtn);

    modal.appendChild(row);
    backdrop.appendChild(modal);
    document.body.appendChild(backdrop);
    nameInput.focus();

    function close() {
      if (backdrop.parentNode) backdrop.parentNode.removeChild(backdrop);
    }
  }

  startLiveClock();
  initStorage();
})();