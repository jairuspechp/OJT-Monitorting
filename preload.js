// Safe bridge: the web page can only call these functions, nothing else.
const { contextBridge, ipcRenderer } = require('electron');

// Every call to the database tells the main process a write is "in flight"
// before it's sent, and clears it once the reply comes back. main.js uses
// this to hold the window open until pending writes land on disk, so
// closing the app right after saving something can never lose it.
const call = (name) => (...args) => {
  ipcRenderer.send('write-pending', 1);
  return ipcRenderer.invoke('db:' + name, ...args).finally(() => {
    ipcRenderer.send('write-pending', -1);
  });
};

contextBridge.exposeInMainWorld('linkDB', {
  status: call('status'),
  listBoards: call('listBoards'),
  createBoard: call('createBoard'),
  renameBoard: call('renameBoard'),
  deleteBoard: call('deleteBoard'),
  setLayout: call('setLayout'),
  saveSlot: call('saveSlot'),
  clearSlot: call('clearSlot'),
  recordCheck: call('recordCheck'),
  getCheck: call('getCheck'),
  listChecks: call('listChecks'),
  deleteChecksForBoard: call('deleteChecksForBoard'),
  exportData: call('exportData'),
  importData: call('importData'),
});
