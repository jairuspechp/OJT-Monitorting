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
      description: description || '',
      slots: Array.from({ length: slotCount || 4 }, () => null),
      refreshInterval: 0,
    };
  }

  function findBoard(id) {
    return state.boards.find((board) => board.id === id) || null;
  }

  // ----------------------------------------------------------------------
  // SQLite storage. The database lives in a file on disk, managed by the
  // desktop shell (main.js) and reached through window.linkDB (preload.js).
  // ----------------------------------------------------------------------

  const db = window.linkDB;

  // The UI is updated first; the write happens right after. A failure is
  // logged to devtools console only (no on-screen banner).
  function save(task) {
    return Promise.resolve()
      .then(task)
      .catch((error) => {
        console.error('Link Layouts: could not save to the database.', error);
      });
  }

  async function initStorage() {
    readNav();

    try {
      const status = await db.status();
      if (!status || !status.ok) {
        console.error('Link Layouts: database status not ok.', (status && status.error) || 'the database file could not be opened');
      }

      state.boards = await db.listBoards();

      if (!state.boards.length) {
        const board = blankBoard('Layout 1');
        state.boards.push(board);
        await db.createBoard({ id: board.id, name: board.name, slotCount: 4, layoutMode: board.layoutMode });
      }
    } catch (error) {
      console.error('Link Layouts: could not open the database.', error);
      state.boards = [blankBoard('Layout 1')];
    }

    state.loaded = true;
    render();
  }

  const storage = {
    createBoard(name, slotCount, layoutMode, description) {
      const board = blankBoard(name, slotCount, layoutMode, description);
      state.boards.push(board);
      save(() => db.createBoard({
        id: board.id,
        name: board.name,
        slotCount: board.slots.length,
        layoutMode: board.layoutMode,
        description: board.description,
      }));

      render();
      return Promise.resolve(board.id);
    },

    renameBoard(board, name) {
      board.name = name;
      save(() => db.renameBoard(board.id, name));
    },

    deleteBoard(board) {
      state.boards = state.boards.filter((item) => item.id !== board.id);
      save(() => db.deleteBoard(board.id));

      if (!state.boards.length) {
        const fresh = blankBoard('Layout 1');
        state.boards.push(fresh);
        save(() => db.createBoard({ id: fresh.id, name: fresh.name, slotCount: 4, layoutMode: fresh.layoutMode }));
      }
    },

    resizeBoard(board, slotCount, layoutMode, refreshInterval) {
      const newSlots = board.slots.slice(0, slotCount);
      while (newSlots.length < slotCount) newSlots.push(null);

      board.slots = newSlots;
      board.layoutMode = layoutMode;
      board.refreshInterval = Number.parseInt(refreshInterval || '0', 10) || 0;
      expandedByBoard[board.id] = null;
      save(() => db.setLayout(board.id, slotCount, layoutMode, board.refreshInterval));

      render();
    },

    saveSlot(board, index, dataOrNull) {
      const newSlots = board.slots.slice();
      newSlots[index] = dataOrNull;
      board.slots = newSlots;

      if (dataOrNull) {
        save(() => db.saveSlot(board.id, index, { label: dataOrNull.label || '', url: dataOrNull.url }));
      } else {
        save(() => db.clearSlot(board.id, index));
      }

      if (state.currentBoardId === board.id) {
        refreshCell(board, index);
      } else {
        render();
      }
    },

    async recordCheck(url, boardId, status, error, refreshInterval) {
      await db.recordCheck(url, boardId, status, error, refreshInterval);
    },

    async getCheck(url) {
      return db.getCheck(url);
    },

    async listChecks() {
      return db.listChecks();
    },

    async deleteChecksForBoard(boardId) {
      await db.deleteChecksForBoard(boardId);
    },

    async exportData() {
      return db.exportData();
    },

    async importData(json) {
      await db.importData(json);
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

  function openBoard(id) {
    state.currentBoardId = id;
    writeNav();
    render();
    const board = findBoard(id);
    if (board && board.refreshInterval > 0) {
      startHealthChecks(board, board.refreshInterval * 1000);
      runBoardHealthChecks(board);
    }
  }

  function goHome() {
    stopHealthChecks();
    state.currentBoardId = null;
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
    status.title = 'Saved on this computer — your links are stored in a local SQLite file, not in the browser';
    topbarEl.appendChild(status);
  }

  // Logo mark, shared between the home and board toolbars.
  function buildBrand() {
    const brand = document.createElement('div');
    brand.className = 'brand';

    const logo = document.createElement('img');
    logo.className = 'brand-icon';
    logo.src = '/img/RTdbX.png';
    logo.alt = '/img/RTdbX';

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
      const currentIndex = expandedByBoard[board.id];
      if (Number.isInteger(currentIndex)) openSettings(board, currentIndex);
    });

    const exportItem = document.createElement('button');
    exportItem.type = 'button';
    exportItem.className = 'board-menu-item';
    exportItem.innerHTML = '<span class="board-menu-item-icon">📤</span><span>Export layouts</span>';
    exportItem.addEventListener('click', (event) => {
      event.stopPropagation();
      closeMenu();
      openExportDialog(board);
    });

    const importItem = document.createElement('button');
    importItem.type = 'button';
    importItem.className = 'board-menu-item';
    importItem.innerHTML = '<span class="board-menu-item-icon">📥</span><span>Import layouts</span>';
    importItem.addEventListener('click', (event) => {
      event.stopPropagation();
      closeMenu();
      openImportDialog(board);
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

    menuPanel.appendChild(settingsItem);
    menuPanel.appendChild(changeLinkItem);
    menuPanel.appendChild(exportItem);
    menuPanel.appendChild(importItem);
    menuPanel.appendChild(returnItem);
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
    fullscreenBtn.setAttribute('aria-label', 'Enter full screen');
    fullscreenBtn.title = 'Enter full screen';
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
    graphOnlyBtn.title = 'Graph only';
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

  function toggleGraphOnly() {
    const enabled = document.body.classList.toggle('graph-only-mode');

    document.querySelectorAll('.graph-only-btn').forEach((button) => {
      button.textContent = enabled ? '↩' : '▣';
      button.setAttribute('aria-label', enabled ? 'Show dashboard controls' : 'Hide dashboard controls');
      button.title = enabled ? 'Show controls' : 'Graph only';
    });

    showFullscreenGridBtn();
    scheduleFullscreenGridBtnHide();
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
    gridFullscreenBtn.setAttribute('aria-label', 'Enter full screen');
    gridFullscreenBtn.title = 'Enter full screen';
    gridFullscreenBtn.addEventListener('click', toggleFullscreen);
    grid.appendChild(gridFullscreenBtn);

    const exitGraphOnlyBtn = document.createElement('button');
    exitGraphOnlyBtn.type = 'button';
    exitGraphOnlyBtn.className = 'exit-graph-only-btn';
    exitGraphOnlyBtn.textContent = '↩';
    exitGraphOnlyBtn.setAttribute('aria-label', 'Show dashboard controls');
    exitGraphOnlyBtn.title = 'Show controls';
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

    const topbar = document.createElement('div');
    topbar.className = 'cell-topbar';

    if (slot) {
      if (slot.label) {
        const label = document.createElement('div');
        label.className = 'slot-label';
        label.textContent = slot.label;
        topbar.appendChild(label);
      }

      const statusDot = document.createElement('div');
      statusDot.className = 'slot-status-dot status-unknown';
      statusDot.title = 'Link status: not checked yet';
      topbar.appendChild(statusDot);

      const isExpanded = expandedByBoard[board.id] === index;
      const expandBtn = document.createElement('button');
      expandBtn.className = 'expand-btn';
      expandBtn.textContent = isExpanded ? '↙' : '↗';
      expandBtn.setAttribute('aria-label', (isExpanded ? 'Collapse slot ' : 'Expand slot ') + (index + 1));
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
  async function performHealthCheck(url) {
    const controller = new AbortController();
    const timeout = setTimeout(() => controller.abort(), 8000);

    try {
      const response = await fetch(url, {
        method: 'HEAD',
        mode: 'no-cors',
        signal: controller.signal,
      });
      clearTimeout(timeout);
      await storage.recordCheck(url, state.currentBoardId, 'ok', '', 0);
      return { status: 'ok', error: '' };
    } catch (error) {
      clearTimeout(timeout);
      await storage.recordCheck(url, state.currentBoardId, 'error', error.message || 'Request failed', 0);
      return { status: 'error', error: error.message || 'Request failed' };
    }
  }

  async function runBoardHealthChecks(board) {
    const slots = board.slots.filter(Boolean);
    const checks = slots.map((slot) => performHealthCheck(slot.url));

    try {
      await Promise.allSettled(checks);
    } catch (error) {
      console.error('Link Layouts: health check batch failed.', error);
    }
  }

  let healthCheckInterval = null;

  function startHealthChecks(board, intervalMs) {
    if (healthCheckInterval) {
      clearInterval(healthCheckInterval);
      healthCheckInterval = null;
    }

    if (!board || intervalMs <= 0) return;

    healthCheckInterval = setInterval(() => {
      if (state.currentBoardId !== board.id) {
        clearInterval(healthCheckInterval);
        healthCheckInterval = null;
        return;
      }
      runBoardHealthChecks(board);
    }, intervalMs);
  }

  function stopHealthChecks() {
    if (healthCheckInterval) {
      clearInterval(healthCheckInterval);
      healthCheckInterval = null;
    }
  }

  async function updateStatusDot(board, index) {
    const slot = board.slots[index];
    if (!slot) return;

    const cell = activeCellEls[index];
    if (!cell) return;

    const dot = cell.querySelector('.slot-status-dot');
    if (!dot) return;

    const check = await storage.getCheck(slot.url);
    if (!check) {
      dot.className = 'slot-status-dot status-unknown';
      dot.title = 'Link status: not checked yet';
      return;
    }

    dot.className = 'slot-status-dot status-' + (check.last_status === 'ok' ? 'ok' : 'err');
    dot.title = 'Status: ' + check.last_status + (check.last_error ? ' — ' + check.last_error : '') + '\nChecked: ' + new Date(check.last_checked_at).toLocaleString();
  }

  async function refreshAllStatusDots(board) {
    board.slots.forEach((_, index) => updateStatusDot(board, index));
  }

  function openExportDialog(board) {
    const backdrop = document.createElement('div');
    backdrop.className = 'settings-backdrop';
    backdrop.addEventListener('click', (event) => {
      if (event.target === backdrop) close();
    });

    const modal = document.createElement('div');
    modal.className = 'settings-modal';

    const heading = document.createElement('h3');
    heading.textContent = 'Export layouts';
    modal.appendChild(heading);

    const message = document.createElement('div');
    message.className = 'settings-message';
    message.textContent = 'Copy the JSON below to save your layouts outside the app.';
    modal.appendChild(message);

    const textarea = document.createElement('textarea');
    textarea.readOnly = true;
    textarea.rows = 10;
    textarea.addEventListener('focus', () => textarea.select());
    modal.appendChild(textarea);

    const row = document.createElement('div');
    row.className = 'settings-row-buttons';

    const copyBtn = document.createElement('button');
    copyBtn.className = 'save';
    copyBtn.textContent = 'Copy to clipboard';
    copyBtn.addEventListener('click', async () => {
      try {
        await navigator.clipboard.writeText(textarea.value);
        copyBtn.textContent = 'Copied!';
        setTimeout(() => { copyBtn.textContent = 'Copy to clipboard'; }, 1200);
      } catch (error) {
        textarea.select();
        document.execCommand('copy');
        copyBtn.textContent = 'Copied!';
        setTimeout(() => { copyBtn.textContent = 'Copy to clipboard'; }, 1200);
      }
    });
    row.appendChild(copyBtn);

    const closeBtn = document.createElement('button');
    closeBtn.textContent = 'Close';
    closeBtn.addEventListener('click', close);
    row.appendChild(closeBtn);

    modal.appendChild(row);
    backdrop.appendChild(modal);
    document.body.appendChild(backdrop);

    storage.exportData().then((json) => {
      textarea.value = json;
    });

    function close() {
      if (backdrop.parentNode) backdrop.parentNode.removeChild(backdrop);
    }
  }

  function openImportDialog(board) {
    const backdrop = document.createElement('div');
    backdrop.className = 'settings-backdrop';
    backdrop.addEventListener('click', (event) => {
      if (event.target === backdrop) close();
    });

    const modal = document.createElement('div');
    modal.className = 'settings-modal';

    const heading = document.createElement('h3');
    heading.textContent = 'Import layouts';
    modal.appendChild(heading);

    const message = document.createElement('div');
    message.className = 'settings-message';
    message.textContent = 'Paste a previously exported JSON below. This merges with existing layouts.';
    modal.appendChild(message);

    const textarea = document.createElement('textarea');
    textarea.placeholder = 'Paste exported JSON here...';
    textarea.rows = 10;
    modal.appendChild(textarea);

    const errorEl = document.createElement('div');
    errorEl.className = 'settings-message';
    errorEl.style.color = 'var(--danger)';
    modal.appendChild(errorEl);

    const row = document.createElement('div');
    row.className = 'settings-row-buttons';

    const cancelBtn = document.createElement('button');
    cancelBtn.textContent = 'Cancel';
    cancelBtn.addEventListener('click', close);
    row.appendChild(cancelBtn);

    const importBtn = document.createElement('button');
    importBtn.className = 'save';
    importBtn.textContent = 'Import';
    importBtn.addEventListener('click', async () => {
      try {
        await storage.importData(textarea.value);
        close();
        render();
      } catch (error) {
        errorEl.textContent = error.message || 'Invalid JSON.';
      }
    });
    row.appendChild(importBtn);

    modal.appendChild(row);
    backdrop.appendChild(modal);
    document.body.appendChild(backdrop);
    textarea.focus();

    function close() {
      if (backdrop.parentNode) backdrop.parentNode.removeChild(backdrop);
    }
  }
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

    const refreshLabel = document.createElement('div');
    refreshLabel.className = 'settings-field-label';
    refreshLabel.textContent = 'Auto-refresh interval (seconds, 0 = off)';
    modal.appendChild(refreshLabel);

    const refreshInput = document.createElement('input');
    refreshInput.type = 'number';
    refreshInput.min = '0';
    refreshInput.max = '3600';
    refreshInput.value = String(board.refreshInterval || 0);
    modal.appendChild(refreshInput);

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

      storage.resizeBoard(board, slotCount, modeSelect.value, Number.parseInt(refreshInput.value, 10) || 0);
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
        expandBtn.setAttribute('aria-label', (isExpanded ? 'Collapse slot ' : 'Expand slot ') + (cellIndex + 1));
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
    heading.textContent = (slot ? 'Edit link' : 'Add link') + ' - slot ' + (index + 1);
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