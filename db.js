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
      refresh_interval INTEGER NOT NULL DEFAULT 0,
      created_at  INTEGER NOT NULL
    );

    CREATE TABLE IF NOT EXISTS slots (
      board_id   TEXT    NOT NULL REFERENCES boards(id) ON DELETE CASCADE,
      slot_index INTEGER NOT NULL,
      label      TEXT    NOT NULL DEFAULT '',
      url        TEXT    NOT NULL,
      PRIMARY KEY (board_id, slot_index)
    );

    CREATE TABLE IF NOT EXISTS link_checks (
      url                TEXT PRIMARY KEY,
      board_id            TEXT    NOT NULL REFERENCES boards(id) ON DELETE CASCADE,
      last_status         TEXT    NOT NULL DEFAULT 'unknown',
      last_checked_at     INTEGER NOT NULL DEFAULT 0,
      last_error          TEXT    NOT NULL DEFAULT '',
      consecutive_fails   INTEGER NOT NULL DEFAULT 0,
      refresh_interval    INTEGER NOT NULL DEFAULT 0
    );
  `);

  try { db.exec(`ALTER TABLE boards ADD COLUMN refresh_interval INTEGER NOT NULL DEFAULT 0`); } catch {}

  const q = {
    boards: db.prepare('SELECT * FROM boards ORDER BY created_at ASC'),
    slots: db.prepare('SELECT * FROM slots'),
    insertBoard: db.prepare('INSERT INTO boards (id, name, layout_mode, slot_count, refresh_interval, created_at) VALUES (?, ?, ?, ?, ?, ?)'),
    rename: db.prepare('UPDATE boards SET name = ? WHERE id = ?'),
    deleteBoard: db.prepare('DELETE FROM boards WHERE id = ?'),
    setLayout: db.prepare('UPDATE boards SET slot_count = ?, layout_mode = ?, refresh_interval = ? WHERE id = ?'),
    trimSlots: db.prepare('DELETE FROM slots WHERE board_id = ? AND slot_index >= ?'),
    upsertSlot: db.prepare(`
      INSERT INTO slots (board_id, slot_index, label, url) VALUES (?, ?, ?, ?)
      ON CONFLICT(board_id, slot_index) DO UPDATE SET label = excluded.label, url = excluded.url`),
    clearSlot: db.prepare('DELETE FROM slots WHERE board_id = ? AND slot_index = ?'),
    upsertCheck: db.prepare(`
      INSERT INTO link_checks (url, board_id, last_status, last_checked_at, last_error, consecutive_fails, refresh_interval)
      VALUES (?, ?, ?, ?, ?, ?, ?)
      ON CONFLICT(url) DO UPDATE SET
        board_id = excluded.board_id,
        last_status = excluded.last_status,
        last_checked_at = excluded.last_checked_at,
        last_error = excluded.last_error,
        consecutive_fails = excluded.consecutive_fails,
        refresh_interval = excluded.refresh_interval`),
    getCheck: db.prepare('SELECT * FROM link_checks WHERE url = ?'),
    deleteChecksForBoard: db.prepare('DELETE FROM link_checks WHERE board_id = ?'),
    allChecks: db.prepare('SELECT * FROM link_checks'),
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
        refreshInterval: b.refresh_interval || 0,
      }));
    },

    createBoard({ id, name, slotCount, layoutMode }) {
      if (!id || typeof id !== 'string' || id.length > 40) throw new Error('Invalid id');
      q.insertBoard.run(
        id,
        String(name || 'Untitled').slice(0, 255),
        MODES.includes(layoutMode) ? layoutMode : 'standard',
        clampCount(slotCount),
        0,
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

    setLayout(id, slotCount, layoutMode, refreshInterval) {
      applyLayout(id, clampCount(slotCount), MODES.includes(layoutMode) ? layoutMode : 'standard');
      db.exec('UPDATE boards SET refresh_interval = ? WHERE id = ?', [Number.parseInt(refreshInterval || '0', 10) || 0, id]);
    },

    saveSlot(id, index, { label, url }) {
      const i = Number.parseInt(index, 10);
      if (!Number.isInteger(i) || i < 0 || !url) throw new Error('Invalid slot');
      q.upsertSlot.run(id, i, String(label || '').slice(0, 255), String(url).slice(0, 2048));
    },

    clearSlot(id, index) {
      q.clearSlot.run(id, Number.parseInt(index, 10));
    },

    recordCheck(url, boardId, status, error, refreshInterval) {
      const current = q.getCheck.all(url)[0] || {};
      const now = Date.now();
      const wasOk = current.last_status === 'ok';
      const isOk = status === 'ok';
      let consecutiveFails = current.consecutive_fails || 0;

      if (!isOk) {
        consecutiveFails = wasOk ? 1 : consecutiveFails + 1;
      } else {
        consecutiveFails = 0;
      }

      q.upsertCheck.run(
        url,
        boardId,
        status,
        now,
        String(error || '').slice(0, 500),
        consecutiveFails,
        Number.parseInt(refreshInterval || '0', 10) || 0
      );
    },

    getCheck(url) {
      return q.getCheck.all(url)[0] || null;
    },

    listChecks() {
      return q.allChecks.all();
    },

    deleteChecksForBoard(boardId) {
      q.deleteChecksForBoard.run(boardId);
    },

    exportData() {
      const boards = q.boards.all();
      const slots = q.slots.all();
      const checks = q.allChecks.all();
      return JSON.stringify({ boards, slots, checks }, null, 2);
    },

    importData(json) {
      const data = JSON.parse(json);
      if (!data.boards || !Array.isArray(data.boards)) throw new Error('Invalid export format');
      db.exec('BEGIN');
      try {
        q.deleteBoard.run.bind(q.deleteBoard);
        data.boards.forEach((b) => q.insertBoard.run(b.id, b.name, b.layout_mode, b.slot_count, b.created_at));
        if (data.slots) {
          data.slots.forEach((s) => q.upsertSlot.run(s.board_id, s.slot_index, s.label, s.url));
        }
        if (data.checks) {
          data.checks.forEach((c) => q.upsertCheck.run(c.url, c.board_id, c.last_status, c.last_checked_at, c.last_error, c.consecutive_fails, c.refresh_interval));
        }
        db.exec('COMMIT');
      } catch (error) {
        db.exec('ROLLBACK');
        throw error;
      }
    },

    close() {
      db.close();
    },
  };
}

module.exports = { openDatabase };