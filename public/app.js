(function () {
  const NAV_KEY = 'link-grid-nav-v1';
  const LOCAL_KEY = 'link-grid-app-v2';
  const API = '/api';

  const state = {
    boards: [],
    currentBoardId: null,
    loaded: false,
  };

  // 'api'   = boards are stored in the MySQL database through server.js
  // 'local' = server unreachable, boards are kept in browser storage only
  let storageMode = 'local';
  let expandedByBoard = {};

  // Tracks the currently-mounted board grid so a single slot can be
  // refreshed in place (without rebuilding every cell / reloading every
  // iframe) whenever just one link changes.
  let activeGrid = null;
  let activeBoardId = null;
  let activeCellEls = [];

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

  function blankBoard(name, slotCount, layoutMode) {
    return {
      id: makeLocalId(),
      name,
      layoutMode: layoutMode || 'standard',
      slots: Array.from({ length: slotCount || 4 }, () => null),
    };
  }

  function findBoard(id) {
    return state.boards.find((board) => board.id === id) || null;
  }

  // ----------------------------------------------------------------------
  // Browser-storage cache. Used as the fallback when the server is
  // unreachable, and kept in sync as an offline copy otherwise.
  // ----------------------------------------------------------------------

  function persistLocal() {
    try {
      localStorage.setItem(LOCAL_KEY, JSON.stringify({ boards: state.boards }));
    } catch (error) {
      // Ignore storage write failures.
    }
  }

  function loadLocalBoards() {
    try {
      const saved = localStorage.getItem(LOCAL_KEY);
      if (saved) {
        const parsed = JSON.parse(saved);
        if (parsed && Array.isArray(parsed.boards)) return parsed.boards;
      }
    } catch (error) {
      // Ignore malformed saved data.
    }
    return [];
  }

  function localInit() {
    state.boards = loadLocalBoards();
    if (!state.boards.length) {
      state.boards.push(blankBoard('Layout 1'));
    }

    state.loaded = true;
    persistLocal();
    render();
  }

  // ----------------------------------------------------------------------
  // MySQL-backed API (server.js)
  // ----------------------------------------------------------------------

  async function api(method, path, body) {
    const options = { method, headers: {} };
    if (body !== undefined) {
      options.headers['Content-Type'] = 'application/json';
      options.body = JSON.stringify(body);
    }

    const response = await fetch(API + path, options);
    if (!response.ok) throw new Error(method + ' ' + path + ' failed (' + response.status + ')');
    return response.json();
  }

  // Fire-and-forget write to the database. The UI is already updated, so a
  // failure is only logged; the local cache still holds the change.
  function sync(method, path, body) {
    if (storageMode !== 'api') return Promise.resolve();
    return api(method, path, body).catch((error) => {
      console.warn('Link Layouts: database write failed.', error);
    });
  }

  async function initStorage() {
    readNav();

    try {
      const data = await api('GET', '/boards');
      state.boards = Array.isArray(data.boards) ? data.boards : [];
      storageMode = 'api';

      if (!state.boards.length) {
        const board = blankBoard('Layout 1');
        state.boards.push(board);
        await sync('POST', '/boards', { id: board.id, name: board.name, slotCount: 4, layoutMode: board.layoutMode });
      }

      state.loaded = true;
      persistLocal();
      render();
    } catch (error) {
      console.warn('Link Layouts: database server unavailable, using browser storage.', error);
      storageMode = 'local';
      localInit();
    }
  }

  const storage = {
    createBoard(name, slotCount, layoutMode) {
      const board = blankBoard(name, slotCount, layoutMode);
      state.boards.push(board);
      persistLocal();
      sync('POST', '/boards', {
        id: board.id,
        name: board.name,
        slotCount: board.slots.length,
        layoutMode: board.layoutMode,
      });

      render();
      return Promise.resolve(board.id);
    },

    renameBoard(board, name) {
      board.name = name;
      persistLocal();
      sync('PATCH', '/boards/' + encodeURIComponent(board.id), { name });
    },

    deleteBoard(board) {
      state.boards = state.boards.filter((item) => item.id !== board.id);
      sync('DELETE', '/boards/' + encodeURIComponent(board.id));

      if (!state.boards.length) {
        const fresh = blankBoard('Layout 1');
        state.boards.push(fresh);
        sync('POST', '/boards', { id: fresh.id, name: fresh.name, slotCount: 4, layoutMode: fresh.layoutMode });
      }

      persistLocal();
    },

    resizeBoard(board, slotCount, layoutMode) {
      const newSlots = board.slots.slice(0, slotCount);
      while (newSlots.length < slotCount) newSlots.push(null);

      board.slots = newSlots;
      board.layoutMode = layoutMode;
      expandedByBoard[board.id] = null;
      persistLocal();
      sync('PUT', '/boards/' + encodeURIComponent(board.id) + '/layout', { slotCount, layoutMode });

      render();
    },

    saveSlot(board, index, dataOrNull) {
      const newSlots = board.slots.slice();
      newSlots[index] = dataOrNull;

      board.slots = newSlots;
      persistLocal();

      const path = '/boards/' + encodeURIComponent(board.id) + '/slots/' + index;
      if (dataOrNull) {
        sync('PUT', path, { label: dataOrNull.label || '', url: dataOrNull.url });
      } else {
        sync('DELETE', path);
      }

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

    const title = document.createElement('div');
    title.className = 'title';
    title.innerHTML = '<b>Link Layouts</b>';
    topbarEl.appendChild(title);

    contentEl.className = 'content mode-home';
    contentEl.innerHTML = '<div class="home-intro">Loading your layouts…</div>';
  }

  function renderHomeTopbar() {
    topbarEl.innerHTML = '';
    topbarEl.classList.remove('board-toolbar', 'is-visible');

    const title = document.createElement('div');
    title.className = 'title';
    title.innerHTML = '<b>Link Layouts</b>&nbsp;· ' + state.boards.length + (state.boards.length === 1 ? ' layout' : ' layouts');
    topbarEl.appendChild(title);

    const spacer = document.createElement('div');
    spacer.className = 'topbar-spacer';
    topbarEl.appendChild(spacer);

    const status = document.createElement('div');
    if (storageMode === 'api') {
      status.className = 'db-status-btn db-status-ok';
      status.textContent = '🟢 MySQL connected';
    } else {
      status.className = 'db-status-btn db-status-warn';
      status.textContent = '⚠ Offline — using browser storage';
      status.title = 'Start the server (npm start) and reload to save to MySQL';
    }
    topbarEl.appendChild(status);
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
  }

  function renderBoardTopbar(board) {
    topbarEl.innerHTML = '';
    topbarEl.className = 'topbar board-toolbar';
    topbarEl.classList.toggle('is-visible', Number.isInteger(expandedByBoard[board.id]));

    const heading = document.createElement('div');
    heading.className = 'board-heading';

    const back = document.createElement('button');
    back.className = 'back-btn';
    back.innerHTML = '←';
    back.setAttribute('aria-label', 'Back to all layouts');
    back.addEventListener('click', goHome);
    heading.appendChild(back);

    const headingCopy = document.createElement('div');
    headingCopy.className = 'board-heading-copy';

    const appName = document.createElement('div');
    appName.className = 'board-app-name';
    appName.textContent = 'Link Layouts';
    headingCopy.appendChild(appName);

    const nameInput = document.createElement('input');
    nameInput.className = 'board-title-input';
    nameInput.value = board.name;
    nameInput.setAttribute('aria-label', 'Layout name');
    nameInput.addEventListener('change', () => {
      const value = nameInput.value.trim();
      const finalName = value || board.name;
      nameInput.value = finalName;
      storage.renameBoard(board, finalName);
    });
    nameInput.addEventListener('keydown', (event) => {
      if (event.key === 'Enter') nameInput.blur();
    });
    headingCopy.appendChild(nameInput);
    heading.appendChild(headingCopy);
    topbarEl.appendChild(heading);

    const actions = document.createElement('div');
    actions.className = 'board-actions';
    topbarEl.appendChild(actions);

    const settingsBtn = document.createElement('button');
    settingsBtn.type = 'button';
    settingsBtn.className = 'toolbar-icon-btn grid-settings-btn';
    settingsBtn.textContent = '⚙';
    settingsBtn.setAttribute('aria-label', 'Change grid settings');
    settingsBtn.title = 'Grid settings';
    settingsBtn.addEventListener('click', () => openGridSettings(board));
    actions.appendChild(settingsBtn);

    const settingsDivider = document.createElement('span');
    settingsDivider.className = 'toolbar-divider';
    actions.appendChild(settingsDivider);

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

    const deleteBoardBtn = document.createElement('button');
    deleteBoardBtn.type = 'button';
    deleteBoardBtn.className = 'toolbar-icon-btn delete-board-btn';
    deleteBoardBtn.textContent = '✕';
    deleteBoardBtn.setAttribute('aria-label', 'Delete layout');
    deleteBoardBtn.title = 'Delete layout';
    deleteBoardBtn.addEventListener('click', () => {
      storage.deleteBoard(board);
      goHome();
    });
    actions.appendChild(deleteBoardBtn);

    const deleteDivider = document.createElement('span');
    deleteDivider.className = 'toolbar-divider';
    actions.appendChild(deleteDivider);

    const graphOnlyBtn = document.createElement('button');
    graphOnlyBtn.type = 'button';
    graphOnlyBtn.className = 'toolbar-icon-btn graph-only-btn';
    graphOnlyBtn.textContent = '▣';
    graphOnlyBtn.setAttribute('aria-label', 'Hide dashboard controls');
    graphOnlyBtn.title = 'Graph only';
    graphOnlyBtn.addEventListener('click', toggleGraphOnly);
    actions.appendChild(graphOnlyBtn);
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

  function toggleGraphOnly() {
    const enabled = document.body.classList.toggle('graph-only-mode');

    document.querySelectorAll('.graph-only-btn').forEach((button) => {
      button.textContent = enabled ? '↩' : '▣';
      button.setAttribute('aria-label', enabled ? 'Show dashboard controls' : 'Hide dashboard controls');
      button.title = enabled ? 'Show controls' : 'Graph only';
    });
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
  }

  function buildCell(board, index) {
    const slot = board.slots[index];

    const cell = document.createElement('div');
    cell.className = 'cell' + (slot ? ' filled' : '') + (expandedByBoard[board.id] === index ? ' expanded' : '');

    const topbar = document.createElement('div');
    topbar.className = 'cell-topbar';

    if (slot) {
      const label = document.createElement('div');
      label.className = 'slot-label';
      label.textContent = slot.label || domainOf(slot.url);
      topbar.appendChild(label);

      // Link editor: only visible while the slot is zoomed in (see CSS).
      const linkEdit = document.createElement('div');
      linkEdit.className = 'link-edit';

      const linkInput = document.createElement('input');
      linkInput.className = 'link-edit-input';
      linkInput.value = slot.url;
      linkInput.placeholder = 'Paste a new link';
      linkInput.setAttribute('aria-label', 'Link for slot ' + (index + 1));

      const applyLink = () => {
        const url = normalizeUrl(linkInput.value);
        if (!url) {
          linkInput.value = slot.url;
          return;
        }
        if (url === slot.url) return;
        storage.saveSlot(board, index, { label: slot.label || '', url });
      };

      linkInput.addEventListener('keydown', (event) => {
        if (event.key === 'Enter') applyLink();
        if (event.key === 'Escape') {
          linkInput.value = slot.url;
          linkInput.blur();
        }
      });
      linkEdit.appendChild(linkInput);

      const goBtn = document.createElement('button');
      goBtn.type = 'button';
      goBtn.className = 'link-edit-btn';
      goBtn.textContent = 'Go';
      goBtn.setAttribute('aria-label', 'Load this link');
      goBtn.addEventListener('click', (event) => {
        event.stopPropagation();
        applyLink();
      });
      linkEdit.appendChild(goBtn);
      topbar.appendChild(linkEdit);

      const isExpanded = expandedByBoard[board.id] === index;
      const expandBtn = document.createElement('button');
      expandBtn.className = 'expand-btn';
      expandBtn.textContent = isExpanded ? '↓' : '↗';
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

    if (slot) {
      cell.addEventListener('click', (event) => {
        if (event.target.closest('.cell-topbar') && !event.target.closest('button, input, .link-edit')) {
          openSettings(board, index);
        }
      });
    }

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

      const collapseBtn = document.createElement('button');
      collapseBtn.className = 'collapse-btn';
      collapseBtn.innerHTML = '✕';
      collapseBtn.setAttribute('aria-label', 'Collapse back to layout');
      collapseBtn.addEventListener('click', (event) => {
        event.stopPropagation();
        toggleExpand(board, index);
      });
      viewport.appendChild(collapseBtn);
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
    heading.textContent = 'Grid settings';
    modal.appendChild(heading);

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
    saveBtn.addEventListener('click', () => {
      const slotCount = modeSelect.value === 'solo'
        ? 1
        : Math.min(20, Math.max(1, Number.parseInt(countInput.value, 10) || board.slots.length));
      const removedLinks = board.slots.slice(slotCount).filter(Boolean).length;

      if (removedLinks && !window.confirm('Reducing the grid will remove ' + removedLinks + ' link' + (removedLinks === 1 ? '' : 's') + '. Continue?')) {
        return;
      }

      storage.resizeBoard(board, slotCount, modeSelect.value);
      close();
    });
    row.appendChild(saveBtn);

    modal.appendChild(row);
    backdrop.appendChild(modal);
    document.body.appendChild(backdrop);
    countInput.focus();

    function close() {
      if (backdrop.parentNode) backdrop.parentNode.removeChild(backdrop);
    }
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
        expandBtn.textContent = isExpanded ? '↓' : '↗';
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
    countInput.max = '20';
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

  initStorage();
})();