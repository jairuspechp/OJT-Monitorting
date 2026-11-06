/*
 * core.js  (load FIRST)
 *
 * State, browser storage, page rendering (home screen, layout list),
 * zoom / full screen / graph-only, auto-return timer and the hint bubble.
 * Everything other files need is published on window.LinkGrid at the bottom.
 *
 * Start-up: no layout is created automatically. If a saved layout has links
 * the app opens straight into it; otherwise the layouts page is shown with an
 * "Add layout" tile. Layouts can be removed from the layouts page (the X on
 * a tile) or from the menu inside a layout. See initStorage().
 *
 * Debug tip: in the console, LinkGrid.state.boards shows every saved layout.
 */
(function () {
  const LG = (window.LinkGrid = window.LinkGrid || {});

  const NAV_KEY = 'link-grid-nav-v1';

  // Shared data. Other files read these through LinkGrid.
  const state = {
    boards: [],
    currentBoardId: null,  // null = the layouts page (home)
    lastBoardId: null,     // the last layout that was opened (kept when you go home)
    loaded: false,
  };

  // board id -> index of the zoomed-in slot (or null)
  const expandedByBoard = {};

  // board id -> page being shown (0 = first). Every layout starts with 4 slots;
  // each page holds 4, so a 5th slot (Add slot) starts page 2, and so on.
  // Only the page being shown is rendered; the other pages' links are not loaded.
  const SLOTS_PER_PAGE = 4;
  const pageByBoard = {};

  // Small bits of UI state that several files need to see.
  const ui = {
    activeMenuWrap: null,   // the open ☰ menu (buttons.js)
    menuChangeIndex: null,  // slot "Change link" applies to when the menu was opened with M
    hoveredSlotIndex: null, // slot under the mouse (link-slots.js)
  };

  // Auto-return timer: after 15s zoomed in on a link, revert to the grid.
  // It does NOT apply to plain full screen or graph-only mode: those stay on
  // until you turn them off yourself (F or G).
  let autoReturnTimer = null;
  const AUTO_RETURN_DELAY = 90000;

  const topbarEl = document.getElementById('topbar');
  const contentEl = document.getElementById('content');

  function clearAutoReturnTimer() {
    if (autoReturnTimer) {
      clearTimeout(autoReturnTimer);
      autoReturnTimer = null;
    }
  }

  function scheduleAutoReturn(board) {
    clearAutoReturnTimer();
    autoReturnTimer = setTimeout(() => {
      if (board && Number.isInteger(expandedByBoard[board.id])) {
        toggleExpand(board, expandedByBoard[board.id]);
      }
      autoReturnTimer = null;
    }, AUTO_RETURN_DELAY);
  }

  function readNav() {
    try {
      const raw = localStorage.getItem(NAV_KEY);
      if (!raw) return;

      const parsed = JSON.parse(raw);
      if (parsed && parsed.currentBoardId) {
        state.currentBoardId = parsed.currentBoardId;
      }
      if (parsed && parsed.lastBoardId) {
        state.lastBoardId = parsed.lastBoardId;
      }
    } catch (error) {
      // Ignore unreadable saved navigation state.
    }
  }

  function writeNav() {
    try {
      localStorage.setItem(NAV_KEY, JSON.stringify({
        currentBoardId: state.currentBoardId,
        lastBoardId: state.lastBoardId,
      }));
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
      nextPage: '',
      slots: Array.from({ length: slotCount || SLOTS_PER_PAGE }, () => null),
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

  // Links are saved in THREE places so they survive a restart / shutdown:
  //   1. localStorage          (fast, read synchronously)
  //   2. IndexedDB             (second copy, survives cases where one of the two is wiped)
  //   3. an optional backup file on disk (Chrome / Edge "Auto-save file" button)
  // On start-up all copies are read and the NEWEST one wins. If the browser is
  // set to "clear site data when closed" (or runs in a private/guest window),
  // 1 and 2 are wiped on exit; only the backup file (3) survives that.
  const DB_NAME = 'link-grid-db';
  const DB_STORE = 'kv';
  const HANDLE_KEY = 'backup-file-handle';

  // file: 'off' | 'on' | 'needs-permission' | 'error'
  const storageStatus = { local: true, idb: true, file: 'off' };
  let backupHandle = null;
  let currentSavedAt = 0;
  let fileWriteTimer = null;
  let warnedAboutStorage = false;

  // Ask the browser not to evict this site's data when disk space is low.
  function requestPersistence() {
    if (navigator.storage && navigator.storage.persist) {
      navigator.storage.persist().catch(() => {});
    }
  }
  requestPersistence();

  function sanitizeBoards(list) {
    // Layouts saved while the two-page version was in use keep their links
    // under "pages". Page 1 stays the layout; any other page becomes its own
    // layout ("Name (page 2)") so no link is lost.
    const flat = [];
    list.forEach((board) => {
      if (!board || typeof board.id !== 'string') return;
      if (Array.isArray(board.pages) && board.pages.length) {
        board.pages.forEach((page, i) => {
          flat.push({
            id: i === 0 ? board.id : board.id + '-p' + (i + 1),
            name: i === 0 ? board.name : String(board.name || 'Untitled') + ' (page ' + (i + 1) + ')',
            description: board.description,
            layoutMode: page && page.layoutMode,
            nextPage: page && page.nextPage,
            slots: page && page.slots,
          });
        });
      } else {
        flat.push(board);
      }
    });

    return flat
      .map((board) => ({
        id: board.id,
        name: String(board.name || 'Untitled'),
        layoutMode: MODES.includes(board.layoutMode) ? board.layoutMode : 'standard',
        description: board.description || '',
        nextPage: typeof board.nextPage === 'string'
          ? board.nextPage
          : board.nextPage && typeof board.nextPage.url === 'string'
            ? board.nextPage.url
            : '',
        slots: Array.isArray(board.slots)
          ? board.slots.map((s) => (s && s.url ? { label: s.label || '', url: s.url } : null))
          : [],
      }))
      .map((board) => {
        // Every layout has at least the 4 starting link placeholders.
        while (board.slots.length < SLOTS_PER_PAGE) board.slots.push(null);
        board.layoutMode = 'standard';
        return board;
      });
  }

  // Accepts the new { savedAt, boards } format and the old plain-array format.
  function parseEnvelope(raw) {
    try {
      const parsed = typeof raw === 'string' ? JSON.parse(raw) : raw;
      if (Array.isArray(parsed)) return { savedAt: 0, boards: sanitizeBoards(parsed) };
      if (parsed && Array.isArray(parsed.boards)) {
        return { savedAt: Number(parsed.savedAt) || 0, boards: sanitizeBoards(parsed.boards) };
      }
    } catch (error) {
      // fall through
    }
    return null;
  }

  function readLocal() {
    try {
      const raw = localStorage.getItem(BOARDS_KEY);
      return raw ? parseEnvelope(raw) : null;
    } catch (error) {
      console.error('Link Layouts: saved layouts could not be read.', error);
      return null;
    }
  }

  function loadBoards() {
    const env = readLocal();
    return env ? env.boards : [];
  }

  // ---- IndexedDB (second copy) ----
  let dbPromise = null;

  function idb() {
    if (!dbPromise) {
      dbPromise = new Promise((resolve, reject) => {
        if (!window.indexedDB) { reject(new Error('IndexedDB not available')); return; }
        const request = indexedDB.open(DB_NAME, 1);
        request.onupgradeneeded = () => request.result.createObjectStore(DB_STORE);
        request.onsuccess = () => resolve(request.result);
        request.onerror = () => reject(request.error);
      });
    }
    return dbPromise;
  }

  function idbGet(key) {
    return idb().then((db) => new Promise((resolve, reject) => {
      const req = db.transaction(DB_STORE, 'readonly').objectStore(DB_STORE).get(key);
      req.onsuccess = () => resolve(req.result);
      req.onerror = () => reject(req.error);
    }));
  }

  function idbSet(key, value) {
    return idb().then((db) => new Promise((resolve, reject) => {
      const tx = db.transaction(DB_STORE, 'readwrite');
      tx.objectStore(DB_STORE).put(value, key);
      tx.oncomplete = () => resolve();
      tx.onerror = () => reject(tx.error);
      tx.onabort = () => reject(tx.error);
    }));
  }

  function withTimeout(promise, ms, fallback) {
    return new Promise((resolve) => {
      const timer = setTimeout(() => resolve(fallback), ms);
      promise.then(
        (value) => { clearTimeout(timer); resolve(value); },
        () => { clearTimeout(timer); resolve(fallback); }
      );
    });
  }

  // ---- Backup file on disk (File System Access API: Chrome / Edge) ----
  const fileBackupSupported = typeof window.showSaveFilePicker === 'function';

  async function readBackupFile() {
    try {
      const file = await backupHandle.getFile();
      const text = await file.text();
      return text.trim() ? parseEnvelope(text) : null;
    } catch (error) {
      return null;
    }
  }

  function scheduleFileWrite(payload) {
    if (!backupHandle || storageStatus.file !== 'on') return;
    clearTimeout(fileWriteTimer);
    fileWriteTimer = setTimeout(async () => {
      try {
        const writable = await backupHandle.createWritable();
        await writable.write(JSON.stringify(payload, null, 2));
        await writable.close();
      } catch (error) {
        console.error('Link Layouts: could not write the backup file.', error);
        storageStatus.file = 'error';
        refreshStatus();
      }
    }, 300);
  }

  function statusInfo() {
    if (!storageStatus.local && !storageStatus.idb) {
      return { icon: '⚠', title: 'Could not save: browser storage is blocked or full. Use Backup / Auto-save file to keep your links.', ok: false };
    }
    if (storageStatus.file === 'needs-permission') {
      return { icon: '💾', title: 'Saved in this browser. Click "Reconnect backup file" to resume saving to your backup file.', ok: true };
    }
    if (storageStatus.file === 'error') {
      return { icon: '⚠', title: 'Saved in this browser, but writing the backup file failed.', ok: false };
    }
    if (storageStatus.file === 'on') {
      return { icon: '💾', title: 'Saved in this browser and in your backup file', ok: true };
    }
    return { icon: '💾', title: 'Saved in this browser. Tip: use "Auto-save file" so your links survive if the browser clears its data.', ok: true };
  }

  function refreshStatus() {
    const info = statusInfo();
    document.querySelectorAll('[data-lg-status]').forEach((el) => {
      el.textContent = info.icon;
      el.title = info.title;
      el.classList.toggle('db-status-ok', info.ok);
    });

    if (!info.ok && !warnedAboutStorage && state.loaded) {
      warnedAboutStorage = true;
      showHint('Could not save your links in this browser &mdash; use <b>Backup</b> on the home screen');
    }
  }

  // Writes the whole list of boards to every store. Called after every change.
  function persist() {
    const payload = { savedAt: Date.now(), boards: state.boards };
    currentSavedAt = payload.savedAt;

    try {
      localStorage.setItem(BOARDS_KEY, JSON.stringify(payload));
      storageStatus.local = true;
    } catch (error) {
      storageStatus.local = false;
      console.error('Link Layouts: could not save to localStorage.', error);
    }

    idbSet(BOARDS_KEY, payload)
      .then(() => { storageStatus.idb = true; })
      .catch((error) => {
        storageStatus.idb = false;
        console.error('Link Layouts: could not save to IndexedDB.', error);
      })
      .then(refreshStatus);

    scheduleFileWrite(payload);
    refreshStatus();
  }

  // Last-chance save when the tab is hidden / closed / the PC is shutting down.
  function flushNow() {
    if (!state.loaded) return;
    try {
      localStorage.setItem(BOARDS_KEY, JSON.stringify({ savedAt: currentSavedAt || Date.now(), boards: state.boards }));
    } catch (error) {
      // nothing more we can do here
    }
  }
  window.addEventListener('pagehide', flushNow);
  window.addEventListener('beforeunload', flushNow);
  document.addEventListener('visibilitychange', () => {
    if (document.visibilityState === 'hidden') flushNow();
  });

  // Reads every store and returns the newest copy that has layouts in it.
  async function loadAll() {
    const candidates = [];

    const local = readLocal();
    if (local) candidates.push(local);

    try {
      const fromIdb = await withTimeout(idbGet(BOARDS_KEY), 1500, null);
      const env = fromIdb ? parseEnvelope(fromIdb) : null;
      if (env) candidates.push(env);
    } catch (error) {
      storageStatus.idb = false;
    }

    try {
      const handle = await withTimeout(idbGet(HANDLE_KEY), 1500, null);
      if (handle && typeof handle.queryPermission === 'function') {
        backupHandle = handle;
        const permission = await withTimeout(handle.queryPermission({ mode: 'readwrite' }), 1500, 'prompt');
        if (permission === 'granted') {
          storageStatus.file = 'on';
          const env = await readBackupFile();
          if (env) candidates.push(env);
        } else {
          storageStatus.file = 'needs-permission';
        }
      }
    } catch (error) {
      // no backup file configured
    }

    let best = null;
    candidates.forEach((env) => {
      if (env.boards.length && (!best || env.savedAt > best.savedAt)) best = env;
    });
    return best;
  }

  // The layout the app opens on at start-up (null = the layouts page): the one
  // that was open, else the last one opened, else the first layout that has a
  // link. Used by initStorage() and to mark that layout on the layouts page.
  function pickStartBoard() {
    const hasLinks = (board) => Boolean(board) && linkCount(board) > 0;
    return [findBoard(state.currentBoardId), findBoard(state.lastBoardId)]
      .find(hasLinks) || state.boards.find(hasLinks) || null;
  }

  function initStorage() {
    readNav();
    state.loaded = false;
    render(); // "Loading your layouts…" while the stores are read

    loadAll()
      .catch((error) => {
        console.error('Link Layouts: loading failed.', error);
        return null;
      })
      .then((best) => {
        state.boards = best ? best.boards : [];
        currentSavedAt = best ? best.savedAt : 0;

        // START-UP RULE: no layout is created automatically. If a saved layout
        // has links, the app opens on it first (the one that was open, else the
        // last one opened, else the first layout that has a link). If nothing
        // has a link yet, the layouts page is shown with "Add layout".
        const startBoard = pickStartBoard();
        state.currentBoardId = startBoard ? startBoard.id : null;
        state.lastBoardId = startBoard ? startBoard.id : null;
        writeNav();

        state.loaded = true;
        persist(); // heals every store with the newest copy
        render();
      });
  }

  // ---- Manual backup / restore, and the auto-save file ----
  function exportBackup() {
    const data = { app: 'link-grid', savedAt: Date.now(), boards: state.boards };
    const blob = new Blob([JSON.stringify(data, null, 2)], { type: 'application/json' });
    const link = document.createElement('a');
    link.href = URL.createObjectURL(blob);
    link.download = 'multiview-backup-' + new Date().toISOString().slice(0, 10) + '.json';
    document.body.appendChild(link);
    link.click();
    link.remove();
    setTimeout(() => URL.revokeObjectURL(link.href), 2000);
    showHint('Backup file downloaded');
  }

  function importBackup() {
    const input = document.createElement('input');
    input.type = 'file';
    input.accept = '.json,application/json';
    input.addEventListener('change', async () => {
      const file = input.files && input.files[0];
      if (!file) return;

      const env = parseEnvelope(await file.text());
      if (!env || !env.boards.length) {
        showHint('That file is not a valid backup');
        return;
      }

      const confirmed = await LG.openConfirmDialog({
        title: 'Restore backup?',
        message: 'This replaces your current layouts with the ' + env.boards.length + ' layout(s) in the file.',
        confirmLabel: 'Restore',
      });
      if (!confirmed) return;

      state.boards = env.boards;
      if (!findBoard(state.currentBoardId)) state.currentBoardId = null;
      if (!findBoard(state.lastBoardId)) state.lastBoardId = null;
      persist();
      render();
      showHint('Backup restored');
    });
    input.click();
  }

  async function chooseBackupFile() {
    if (!fileBackupSupported) {
      showHint('Auto-save file needs Chrome or Edge &mdash; use <b>Backup</b> instead');
      return;
    }

    try {
      const handle = await window.showSaveFilePicker({
        suggestedName: 'multiview-links.json',
        types: [{ description: 'JSON file', accept: { 'application/json': ['.json'] } }],
      });

      backupHandle = handle;
      storageStatus.file = 'on';
      idbSet(HANDLE_KEY, handle).catch(() => {});

      // Picked a file that already has links, and nothing is set up here yet: load them.
      const existing = await readBackupFile();
      const hasLinks = state.boards.some((board) => board.slots.some(Boolean));
      if (existing && existing.boards.length && !hasLinks) {
        state.boards = existing.boards;
        if (!findBoard(state.currentBoardId)) state.currentBoardId = null;
        if (!findBoard(state.lastBoardId)) state.lastBoardId = null;
      }

      persist();
      render();
      showHint('Auto-save file is on &mdash; links are also saved to that file');
    } catch (error) {
      // cancelled by the user
    }
  }

  async function reconnectBackupFile() {
    if (!backupHandle) return;

    try {
      const permission = await backupHandle.requestPermission({ mode: 'readwrite' });
      if (permission !== 'granted') return;

      storageStatus.file = 'on';
      const existing = await readBackupFile();
      if (existing && existing.boards.length && existing.savedAt > currentSavedAt) {
        state.boards = existing.boards;
        if (!findBoard(state.currentBoardId)) state.currentBoardId = null;
        if (!findBoard(state.lastBoardId)) state.lastBoardId = null;
      }

      persist();
      render();
      showHint('Backup file reconnected');
    } catch (error) {
      console.error('Link Layouts: could not reconnect the backup file.', error);
    }
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
      delete expandedByBoard[board.id];
      delete pageByBoard[board.id];

      if (state.currentBoardId === board.id) {
        clearAutoReturnTimer();
        leaveZoomView();
        state.currentBoardId = null;
      }
      if (state.lastBoardId === board.id) state.lastBoardId = null;
      writeNav();

      persist();
      render();
    },

    resizeBoard(board, slotCount, layoutMode) {
      const newSlots = board.slots.slice(0, slotCount);
      while (newSlots.length < slotCount) newSlots.push(null);

      board.slots = newSlots;
      board.layoutMode = layoutMode;
      expandedByBoard[board.id] = null;
      leaveZoomView();
      persist();

      render();
    },

    saveSlot(board, index, dataOrNull) {
      const newSlots = board.slots.slice();
      newSlots[index] = dataOrNull;
      board.slots = newSlots;
      persist();

      if (state.currentBoardId === board.id) {
        LG.refreshCell(board, index);
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

  // Balanced grid for a given number of slots (4 -> 2 x 2).
  function columnsForCount(count) {
    return Math.min(4, Math.max(1, Math.ceil(Math.sqrt(count))));
  }

  function columnsFor(board) {
    return columnsForCount(board.slots.length);
  }

  // ---- Pages: 4 slots per page, only the shown page is rendered ----
  function pageCount(board) {
    return Math.max(1, Math.ceil(board.slots.length / SLOTS_PER_PAGE));
  }

  function currentPage(board) {
    const saved = Number.isInteger(pageByBoard[board.id]) ? pageByBoard[board.id] : 0;
    return Math.min(pageCount(board) - 1, Math.max(0, saved));
  }

  function goToPage(board, page) {
    const target = Math.min(pageCount(board) - 1, Math.max(0, page));
    if (target === currentPage(board)) return;

    // Zoom back out first; the zoomed slot belongs to the page being left.
    const open = expandedByBoard[board.id];
    if (Number.isInteger(open)) toggleExpand(board, open);

    pageByBoard[board.id] = target;
    LG.renderBoardContent(board); // drops the old page's frames, loads the new page's
    LG.refreshPagers(board);
  }

  // One more empty link placeholder at the end, then jump to the page it is on.
  function addSlot(board) {
    const open = expandedByBoard[board.id];
    if (Number.isInteger(open)) toggleExpand(board, open);

    board.slots = board.slots.concat([null]);
    pageByBoard[board.id] = pageCount(board) - 1;
    persist();

    LG.renderBoardContent(board);
    LG.refreshPagers(board);
    showHint('<b>Slot ' + board.slots.length + '</b> added');
  }

  // Go to the layouts page. The last-opened layout is remembered
  // (state.lastBoardId) so the next start-up still opens it.
  function goHome() {
    const current = findBoard(state.currentBoardId);
    if (current) {
      expandedByBoard[current.id] = null;
      state.lastBoardId = current.id;
    }
    leaveZoomView();
    state.currentBoardId = null;
    writeNav();
    clearAutoReturnTimer();
    render();
  }

  function openBoard(id) {
    state.currentBoardId = id;
    state.lastBoardId = id;
    writeNav();
    clearAutoReturnTimer();
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
        LG.renderBoardTopbar(board);
        LG.renderBoardContent(board);
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
    LG.setHoverZoneActive(false);
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

    // Backup / restore / auto-save file buttons.
    function homeButton(text, tip, run) {
      const button = document.createElement('button');
      button.type = 'button';
      button.textContent = text;
      button.title = tip;
      button.style.cssText = 'margin-right:8px;padding:5px 10px;border-radius:6px;cursor:pointer;' +
        'font:600 12px system-ui,sans-serif;color:inherit;background:rgba(255,255,255,.08);' +
        'border:1px solid rgba(255,255,255,.25)';
      button.addEventListener('click', run);
      return button;
    }

    if (fileBackupSupported) {
      if (storageStatus.file === 'needs-permission') {
        topbarEl.appendChild(homeButton('📁 Reconnect backup file', 'Allow saving to your backup file again', reconnectBackupFile));
      } else if (storageStatus.file === 'on') {
        topbarEl.appendChild(homeButton('📁 Auto-save: on', 'Links are also saved to your backup file. Click to choose a different file.', chooseBackupFile));
      } else {
        topbarEl.appendChild(homeButton('📁 Auto-save file', 'Also save your links to a file on disk, so they survive even if the browser clears its data', chooseBackupFile));
      }
    }
    topbarEl.appendChild(homeButton('⬇ Backup', 'Download your layouts and links as a file', exportBackup));
    topbarEl.appendChild(homeButton('⬆ Restore', 'Load layouts and links from a backup file', importBackup));

    const status = document.createElement('div');
    status.className = 'db-status-btn db-status-ok';
    status.setAttribute('data-lg-status', '');
    topbarEl.appendChild(status);
    refreshStatus();
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
    LG.setHoverZoneActive(false);
    contentEl.innerHTML = '';

    const intro = document.createElement('div');
    intro.className = 'home-intro';
    intro.textContent = state.boards.length
      ? 'Pick a layout to open.'
      : 'No layouts yet. Add a layout to get started.';
    contentEl.appendChild(intro);

    const list = document.createElement('div');
    list.className = 'board-list';

    const startBoard = pickStartBoard();

    state.boards.forEach((board) => {
      const tile = document.createElement('div');
      tile.className = 'board-tile' + (startBoard && startBoard.id === board.id ? ' start-tile' : '');

      if (startBoard && startBoard.id === board.id) {
        const badge = document.createElement('div');
        badge.className = 'start-badge';
        badge.textContent = '\u25B6 Opens first at start-up';
        badge.title = 'This layout opens first after the app is restarted or the PC is shut down and started again';
        tile.appendChild(badge);
      }

      const mini = document.createElement('div');
      mini.className = 'mini-grid';
      const miniColumns = Math.min(columnsFor(board), board.slots.length);
      mini.style.gridTemplateColumns = 'repeat(' + miniColumns + ', 1fr)';
      mini.style.gridTemplateRows = 'repeat(' + Math.ceil(board.slots.length / miniColumns) + ', 1fr)';

      // Each DIFFERENT link in a layout gets its own colour from a fixed
      // palette (same link = same colour), so links on the same website no
      // longer look alike. The slot number is printed on every filled cell.
      const palette = [210, 130, 35, 290, 0, 170, 60, 330];
      const seen = [];

      board.slots.forEach((slot, slotIndex) => {
        const miniCell = document.createElement('div');
        miniCell.className = 'mini-cell' + (slot ? ' filled' : '');

        if (slot) {
          let colorIndex = seen.indexOf(slot.url);
          if (colorIndex === -1) { seen.push(slot.url); colorIndex = seen.length - 1; }
          const hue = palette[colorIndex % palette.length];
          miniCell.style.background = 'hsl(' + hue + ', 60%, 40%)';
          miniCell.style.borderColor = 'hsl(' + hue + ', 60%, 60%)';
          miniCell.style.display = 'flex';
          miniCell.style.alignItems = 'center';
          miniCell.style.justifyContent = 'center';
          miniCell.style.color = '#fff';
          miniCell.style.font = '700 12px system-ui,sans-serif';
          miniCell.textContent = String(slotIndex + 1);
          miniCell.title = (slot.label ? slot.label + ' - ' : '') + slot.url;
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

      // Remove layout (asks first).
      const removeBtn = document.createElement('button');
      removeBtn.type = 'button';
      removeBtn.className = 'tile-remove-btn';
      removeBtn.textContent = '\u2715';
      removeBtn.title = 'Remove layout';
      removeBtn.setAttribute('aria-label', 'Remove layout ' + board.name);
      removeBtn.addEventListener('click', (event) => {
        event.stopPropagation();
        LG.confirmRemoveBoard(board);
      });
      tile.appendChild(removeBtn);

      tile.addEventListener('click', () => openBoard(board.id));
      list.appendChild(tile);
    });

    // "Add layout" is always the last tile.
    const addTile = document.createElement('div');
    addTile.className = 'add-tile';
    addTile.setAttribute('role', 'button');
    addTile.setAttribute('tabindex', '0');
    addTile.innerHTML = '<div class="plus">+</div><div class="label">Add layout</div>';
    addTile.addEventListener('click', () => LG.openNewGridDialog());
    addTile.addEventListener('keydown', (event) => {
      if (event.key === 'Enter' || event.key === ' ') {
        event.preventDefault();
        LG.openNewGridDialog();
      }
    });
    list.appendChild(addTile);

    contentEl.appendChild(list);
    contentEl.appendChild(buildBoardFooter());
  }

  function toggleFullscreen() {
    if (document.fullscreenElement) {
      document.exitFullscreen();
      clearAutoReturnTimer();
      return;
    }

    if (document.documentElement.requestFullscreen) {
      document.documentElement.requestFullscreen();
    }
  }

  document.addEventListener('fullscreenchange', () => {
    if (document.fullscreenElement) return;
    clearAutoReturnTimer();

    // The browser's own Esc left full screen: zoom back out too, otherwise the
    // dashboard is left stuck in graph-only mode with a link still zoomed.
    const board = findBoard(state.currentBoardId);
    const openIndex = board ? expandedByBoard[board.id] : null;
    if (board && Number.isInteger(openIndex)) toggleExpand(board, openIndex);
  });

  const fsHintStyle = document.createElement('style');
  fsHintStyle.textContent = [
    '.fs-hint{position:fixed;bottom:24px;left:50%;transform:translate(-50%,8px);',
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

  // Notifications show instantly. A new one replaces whatever is on screen
  // right away, so fast opening / closing never leaves a message waiting.
  //   showHint(html, tag)  show a message now (tag is optional, used to withdraw it)
  //   hideHint(tag)        take down the message if it is the one showing
  const HINT_MS = 3000; // how long a message stays

  let hintCurrent = null;
  let hintTimer = null;

  function finishHint() {
    clearTimeout(hintTimer);
    hintTimer = null;
    fsHintEl.classList.remove('show');
    hintCurrent = null;
  }

  function showHint(html, tag) {
    clearTimeout(hintTimer);

    // Same message already up: just keep it up a little longer.
    if (!(hintCurrent && hintCurrent.html === html)) {
      hintCurrent = { html, tag: tag || '' };
      fsHintEl.innerHTML = html;
    }

    fsHintEl.classList.add('show');
    hintTimer = setTimeout(finishHint, HINT_MS);
  }

  function hideHint(tag) {
    if (hintCurrent && hintCurrent.tag === tag) finishHint();
  }

  // { quiet: true } skips the notification (used when zooming in / out).
  function toggleGraphOnly(options) {
    const quiet = Boolean(options && options.quiet === true);
    const enabled = document.body.classList.toggle('graph-only-mode');

    document.querySelectorAll('.graph-only-btn').forEach((button) => {
      button.textContent = enabled ? '↩' : '▣';
      button.setAttribute('aria-label', enabled ? 'Show dashboard controls' : 'Hide dashboard controls');
      button.title = enabled ? 'Show controls (G)' : 'Graph only (G)';
    });

    if (enabled) {
      if (!quiet) showHint('Graph only &mdash; press <kbd>G</kbd> to show the controls again', 'graph');
    } else {
      hideHint('graph');
    }
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

  // Zooming in also asks the browser for real full screen, which is the slowest
  // part (the window resizes and the embedded page redraws at the new size).
  // Set to false for a faster zoom; the F key still gives full screen on demand.
  const ZOOM_USES_FULLSCREEN = true;

  // What zooming in switched on, so zooming out only undoes that.
  let zoomSetGraphOnly = false;
  let zoomSetFullscreen = false;

  function enterZoomView() {
    if (!document.body.classList.contains('graph-only-mode')) {
      toggleGraphOnly({ quiet: true });
      zoomSetGraphOnly = true;
    }

    if (ZOOM_USES_FULLSCREEN && !document.fullscreenElement && document.documentElement.requestFullscreen) {
      const request = document.documentElement.requestFullscreen();
      if (request && request.catch) request.catch(() => {});
      zoomSetFullscreen = true;
    }
  }

  function leaveZoomView() {
    if (zoomSetGraphOnly && document.body.classList.contains('graph-only-mode')) toggleGraphOnly({ quiet: true });

    if (zoomSetFullscreen && document.fullscreenElement) {
      const exit = document.exitFullscreen();
      if (exit && exit.catch) exit.catch(() => {});
    }

    zoomSetGraphOnly = false;
    zoomSetFullscreen = false;
  }

  function toggleExpand(board, index) {
    const current = expandedByBoard[board.id];
    const next = current === index ? null : index;
    expandedByBoard[board.id] = next;
    topbarEl.classList.toggle('is-visible', next !== null);

    // Mark the zoomed cell first so it is already in place when the layout changes.
    LG.applyExpandedState(board, next);

    // Zooming in also turns on full screen + graph only; zooming out undoes them.
    if (next !== null && !Number.isInteger(current)) enterZoomView();
    if (next === null) leaveZoomView();

    if (next !== null) {
      scheduleAutoReturn(board);
    } else {
      clearAutoReturnTimer();
    }

    const name = '<b>' + escapeHtml(slotName(board, next !== null ? next : index)) + '</b>';
    hideHint('graph');
    showHint(next !== null
      ? name + ' zoomed in &mdash; press <kbd>E</kbd> or click &#10005; to close'
      : name + ' closed', 'zoom');
  }

  Object.assign(LG, {
    state,
    storage,
    expandedByBoard,
    ui,
    SLOTS_PER_PAGE,
    pageByBoard,
    MODES,
    clearAutoReturnTimer,
    scheduleAutoReturn,
    readNav,
    writeNav,
    makeLocalId,
    blankBoard,
    findBoard,
    slotName,
    escapeHtml,
    loadBoards,
    persist,
    initStorage,
    exportBackup,
    importBackup,
    chooseBackupFile,
    reconnectBackupFile,
    fileBackupSupported,
    storageStatus,
    domainOf,
    normalizeUrl,
    hashString,
    avatarFor,
    linkCount,
    columnsFor,
    columnsForCount,
    pageCount,
    currentPage,
    goToPage,
    addSlot,
    goHome,
    openBoard,
    render,
    renderLoading,
    renderHomeTopbar,
    buildBrand,
    formatClock,
    buildLiveClock,
    startLiveClock,
    renderHomeContent,
    toggleFullscreen,
    showHint,
    hideHint,
    toggleGraphOnly,
    buildBoardFooter,
    enterZoomView,
    leaveZoomView,
    toggleExpand,
  });
})();