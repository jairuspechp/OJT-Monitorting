// SQLite storage for Link Layouts (runs in Electron's main process).
// Uses Node's built-in node:sqlite instead of better-sqlite3, so there's
// no native module to compile (no Python / Visual Studio build step needed).
const { DatabaseSync } = require('node:sqlite');

const MODES = ['standard', 'horizontal', 'solo', 'three'];
const clampCount = (n) => Math.min(20, Math.max(1, Number.parseInt(n, 10) || 4));

function openDatabase(file) {
  const db = new DatabaseSync(file);
  db.exec('PRAGMA foreign_keys = ON');

  db.exec(`
    CREATE TABLE IF NOT EXISTS boards (
      id          TEXT PRIMARY KEY,
      name        TEXT    NOT NULL,
      layout_mode TEXT    NOT NULL DEFAULT 'standard',
      slot_count  INTEGER NOT NULL DEFAULT 4,
      created_at  INTEGER NOT NULL
    );

    CREATE TABLE IF NOT EXISTS slots (
      board_id   TEXT    NOT NULL REFERENCES boards(id) ON DELETE CASCADE,
      slot_index INTEGER NOT NULL,
      label      TEXT    NOT NULL DEFAULT '',
      url        TEXT    NOT NULL,
      PRIMARY KEY (board_id, slot_index)
    );
  `);

  const q = {
    boards: db.prepare('SELECT * FROM boards ORDER BY created_at ASC'),
    slots: db.prepare('SELECT * FROM slots'),
    insertBoard: db.prepare('INSERT INTO boards (id, name, layout_mode, slot_count, created_at) VALUES (?, ?, ?, ?, ?)'),
    rename: db.prepare('UPDATE boards SET name = ? WHERE id = ?'),
    deleteBoard: db.prepare('DELETE FROM boards WHERE id = ?'),
    setLayout: db.prepare('UPDATE boards SET slot_count = ?, layout_mode = ? WHERE id = ?'),
    trimSlots: db.prepare('DELETE FROM slots WHERE board_id = ? AND slot_index >= ?'),
    upsertSlot: db.prepare(`
      INSERT INTO slots (board_id, slot_index, label, url) VALUES (?, ?, ?, ?)
      ON CONFLICT(board_id, slot_index) DO UPDATE SET label = excluded.label, url = excluded.url`),
    clearSlot: db.prepare('DELETE FROM slots WHERE board_id = ? AND slot_index = ?'),
  };

  // node:sqlite has no built-in db.transaction() helper like better-sqlite3,
  // so the BEGIN/COMMIT/ROLLBACK is done by hand here.
  function applyLayout(id, count, mode) {
    db.exec('BEGIN');
    try {
      q.setLayout.run(count, mode, id);
      q.trimSlots.run(id, count);
      db.exec('COMMIT');
    } catch (error) {
      db.exec('ROLLBACK');
      throw error;
    }
  }

  return {
    listBoards() {
      const byBoard = {};
      q.slots.all().forEach((s) => {
        (byBoard[s.board_id] = byBoard[s.board_id] || {})[s.slot_index] = { label: s.label, url: s.url };
      });
      return q.boards.all().map((b) => ({
        id: b.id,
        name: b.name,
        layoutMode: b.layout_mode,
        slots: Array.from({ length: b.slot_count }, (_, i) => (byBoard[b.id] && byBoard[b.id][i]) || null),
      }));
    },

    createBoard({ id, name, slotCount, layoutMode }) {
      if (!id || typeof id !== 'string' || id.length > 40) throw new Error('Invalid id');
      q.insertBoard.run(
        id,
        String(name || 'Untitled').slice(0, 255),
        MODES.includes(layoutMode) ? layoutMode : 'standard',
        clampCount(slotCount),
        Date.now()
      );
    },

    renameBoard(id, name) {
      const clean = String(name || '').trim().slice(0, 255);
      if (!clean) throw new Error('Name required');
      q.rename.run(clean, id);
    },

    deleteBoard(id) {
      q.deleteBoard.run(id);
    },

    setLayout(id, slotCount, layoutMode) {
      applyLayout(id, clampCount(slotCount), MODES.includes(layoutMode) ? layoutMode : 'standard');
    },

    saveSlot(id, index, { label, url }) {
      const i = Number.parseInt(index, 10);
      if (!Number.isInteger(i) || i < 0 || !url) throw new Error('Invalid slot');
      q.upsertSlot.run(id, i, String(label || '').slice(0, 255), String(url).slice(0, 2048));
    },

    clearSlot(id, index) {
      q.clearSlot.run(id, Number.parseInt(index, 10));
    },

    close() {
      db.close();
    },
  };
}

module.exports = { openDatabase };