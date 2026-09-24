// Monitoring Tool desktop shell: opens index.html in a window and stores
// everything in db.sqlite, kept right inside this project folder (next to
// main.js) rather than the OS-level userData folder. That's deliberate: it
// lets the database travel with the project when you commit and push it to
// GitHub, so pulling the repo on another machine brings your links with it.
//
// Caveat: this only works reliably when running from source (npm start).
// A packaged/portable .exe usually runs from a temporary extraction
// folder, so this path would not persist between launches once built —
// worth revisiting if you ever ship a packaged build to someone else.

const path = require('path');
const { app, BrowserWindow, ipcMain, session, shell } = require('electron');

let store = null;   // the open database, or null if it could not be opened
let dbFile = '';
let dbError = '';
let win;

// Counts database calls that have been sent from the renderer but haven't
// finished yet. The window is not allowed to actually close while this is
// above zero, so quitting right after saving a link can't lose the write.
let pendingWrites = 0;
let readyToClose = false;

const fs = require('fs');

function getDbPath() {
  // Running from source (npm start): keep it in the project folder (git-friendly)
  if (!app.isPackaged) return path.join(__dirname, 'db.sqlite');

  // Portable .exe: store the data next to the .exe so it travels with it
  if (process.env.PORTABLE_EXECUTABLE_DIR) {
    return path.join(process.env.PORTABLE_EXECUTABLE_DIR, 'LinkLayouts-data', 'db.sqlite');
  }

  // Installer build: the normal per-user app data folder
  return path.join(app.getPath('userData'), 'db.sqlite');
}

function openStore() {
  try {
    dbFile = getDbPath();
    fs.mkdirSync(path.dirname(dbFile), { recursive: true });

     // First run only: start from the bundled seed if there's no database yet
    const seed = path.join(process.resourcesPath, 'seed.sqlite');
    if (app.isPackaged && !fs.existsSync(dbFile) && fs.existsSync(seed)) {
      fs.copyFileSync(seed, dbFile);
    }

    const { openDatabase } = require('./db');
    store = openDatabase(dbFile);
    console.log('Link Layouts: database ready at', dbFile);
  } catch (error) {
    store = null;
    dbError = error && error.message ? error.message : String(error);
    console.error('Link Layouts: could not open the database at', dbFile, error);
  }
}

function registerIpc() {
  ipcMain.on('write-pending', (_event, delta) => {
    pendingWrites = Math.max(0, pendingWrites + delta);
  });

  ipcMain.handle('db:status', () => ({ ok: Boolean(store), file: dbFile, error: dbError }));

  const handlers = ['listBoards', 'createBoard', 'renameBoard', 'deleteBoard', 'setLayout', 'saveSlot', 'clearSlot'];
  handlers.forEach((name) => {
    ipcMain.handle('db:' + name, (_event, ...args) => {
      if (!store) throw new Error(dbError || 'The database is not available');
      return store[name](...args);
    });
  });
}

// Many sites forbid being shown inside an iframe. In your own desktop app
// that restriction isn't needed, so remove it for embedded frames only.
function allowEmbedding() {
  session.defaultSession.webRequest.onHeadersReceived((details, callback) => {
    if (details.resourceType !== 'subFrame') return callback({ responseHeaders: details.responseHeaders });

    const headers = { ...details.responseHeaders };
    Object.keys(headers).forEach((key) => {
      const lower = key.toLowerCase();
      if (lower === 'x-frame-options') {
        delete headers[key];
      } else if (lower === 'content-security-policy') {
        headers[key] = headers[key].map((v) => v.replace(/frame-ancestors[^;]*;?/gi, ''));
      }
    });
    callback({ responseHeaders: headers });
  });
}

function createWindow() {
  win = new BrowserWindow({
    width: 1280,
    height: 800,
    backgroundColor: '#0f1115',
    autoHideMenuBar: true,
    icon: path.join(__dirname, 'RTdbX.ico'),
    webPreferences: {
      preload: path.join(__dirname, 'preload.js'),
      contextIsolation: true,
      nodeIntegration: false,
    },
  });

  // Links that try to open a new window go to the normal browser instead.
  win.webContents.setWindowOpenHandler(({ url }) => {
    if (/^https?:/i.test(url)) shell.openExternal(url);
    return { action: 'deny' };
  });

  win.loadFile('index.html');

  // Hold the window open until any in-flight database write has finished.
  // A hard 3s cap guards against ever leaving the app unclosable if
  // something hangs.
  win.on('close', (event) => {
    if (readyToClose || pendingWrites <= 0) return;
    event.preventDefault();

    const deadline = Date.now() + 3000;
    const check = () => {
      if (pendingWrites <= 0 || Date.now() > deadline) {
        readyToClose = true;
        win.close();
      } else {
        setTimeout(check, 25);
      }
    };
    check();
  });
}

if (!app.requestSingleInstanceLock()) {
  app.quit(); // only one copy may use the database at a time
} else {
  app.on('second-instance', () => {
    if (win) {
      if (win.isMinimized()) win.restore();
      win.focus();
    }
  });

  app.whenReady().then(() => {
    openStore();
    registerIpc();
    allowEmbedding();
    createWindow();
  });

  app.on('window-all-closed', () => app.quit());
  app.on('will-quit', () => {
    if (store) {
      try { store.close(); } catch (error) { console.error(error); }
    }
  });
}