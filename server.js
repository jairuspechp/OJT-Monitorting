// Link Layouts backend: Express + MySQL.
// Config via environment variables (defaults shown):
//   DB_HOST=localhost  DB_PORT=3306  DB_USER=root  DB_PASSWORD=""  DB_NAME=link_layouts  PORT=3000

const path = require('path');
const fs = require('fs');
const express = require('express');
const mysql = require('mysql2/promise');

const cfg = {
  host: process.env.DB_HOST || 'localhost',
  port: Number(process.env.DB_PORT || 3306),
  user: process.env.DB_USER || 'root',
  password: process.env.DB_PASSWORD || '',
  database: process.env.DB_NAME || 'link_layouts',
};

let pool;

async function initDatabase() {
  const boot = await mysql.createConnection({
    host: cfg.host, port: cfg.port, user: cfg.user, password: cfg.password,
  });
  await boot.query('CREATE DATABASE IF NOT EXISTS `' + cfg.database.replace(/`/g, '') + '` CHARACTER SET utf8mb4');
  await boot.end();

  pool = mysql.createPool({ ...cfg, waitForConnections: true, connectionLimit: 10, multipleStatements: true });
  const schema = fs.readFileSync(path.join(__dirname, 'schema.sql'), 'utf8');
  await pool.query(schema);
}

const app = express();
app.use(express.json({ limit: '1mb' }));
app.use(express.static(path.join(__dirname, 'public')));

const wrap = (fn) => (req, res) => fn(req, res).catch((err) => {
  console.error(err);
  res.status(500).json({ error: 'Database error' });
});

const MODES = ['standard', 'horizontal', 'solo', 'three'];
const clampCount = (n) => Math.min(20, Math.max(1, Number.parseInt(n, 10) || 4));

// List all boards, each with a slots array (null for empty slots).
app.get('/api/boards', wrap(async (req, res) => {
  const [boards] = await pool.query('SELECT * FROM boards ORDER BY created_at ASC');
  const [slots] = await pool.query('SELECT * FROM slots');

  const byBoard = {};
  slots.forEach((s) => {
    (byBoard[s.board_id] = byBoard[s.board_id] || {})[s.slot_index] = { label: s.label, url: s.url };
  });

  res.json({
    boards: boards.map((b) => ({
      id: b.id,
      name: b.name,
      layoutMode: b.layout_mode,
      slots: Array.from({ length: b.slot_count }, (_, i) => (byBoard[b.id] && byBoard[b.id][i]) || null),
    })),
  });
}));

// Create a board.
app.post('/api/boards', wrap(async (req, res) => {
  const { id, name, slotCount, layoutMode } = req.body || {};
  if (!id || typeof id !== 'string' || id.length > 40) return res.status(400).json({ error: 'Invalid id' });
  await pool.query(
    'INSERT INTO boards (id, name, layout_mode, slot_count, created_at) VALUES (?, ?, ?, ?, ?)',
    [id, String(name || 'Untitled').slice(0, 255), MODES.includes(layoutMode) ? layoutMode : 'standard', clampCount(slotCount), Date.now()]
  );
  res.json({ ok: true });
}));

// Rename a board.
app.patch('/api/boards/:id', wrap(async (req, res) => {
  const name = String((req.body && req.body.name) || '').trim().slice(0, 255);
  if (!name) return res.status(400).json({ error: 'Name required' });
  await pool.query('UPDATE boards SET name = ? WHERE id = ?', [name, req.params.id]);
  res.json({ ok: true });
}));

// Delete a board (its slots are removed by ON DELETE CASCADE).
app.delete('/api/boards/:id', wrap(async (req, res) => {
  await pool.query('DELETE FROM boards WHERE id = ?', [req.params.id]);
  res.json({ ok: true });
}));

// Change slot count / layout style.
app.put('/api/boards/:id/layout', wrap(async (req, res) => {
  const { slotCount, layoutMode } = req.body || {};
  const count = clampCount(slotCount);
  const conn = await pool.getConnection();
  try {
    await conn.beginTransaction();
    await conn.query(
      'UPDATE boards SET slot_count = ?, layout_mode = ? WHERE id = ?',
      [count, MODES.includes(layoutMode) ? layoutMode : 'standard', req.params.id]
    );
    await conn.query('DELETE FROM slots WHERE board_id = ? AND slot_index >= ?', [req.params.id, count]);
    await conn.commit();
    res.json({ ok: true });
  } catch (err) {
    await conn.rollback();
    throw err;
  } finally {
    conn.release();
  }
}));

// Save (upsert) one slot.
app.put('/api/boards/:id/slots/:index', wrap(async (req, res) => {
  const index = Number.parseInt(req.params.index, 10);
  const { label, url } = req.body || {};
  if (!Number.isInteger(index) || index < 0 || !url) return res.status(400).json({ error: 'Invalid slot' });
  await pool.query(
    `INSERT INTO slots (board_id, slot_index, label, url) VALUES (?, ?, ?, ?)
     ON DUPLICATE KEY UPDATE label = VALUES(label), url = VALUES(url)`,
    [req.params.id, index, String(label || '').slice(0, 255), String(url).slice(0, 2048)]
  );
  res.json({ ok: true });
}));

// Clear one slot.
app.delete('/api/boards/:id/slots/:index', wrap(async (req, res) => {
  await pool.query('DELETE FROM slots WHERE board_id = ? AND slot_index = ?', [req.params.id, Number.parseInt(req.params.index, 10)]);
  res.json({ ok: true });
}));

const port = Number(process.env.PORT || 3000);
initDatabase()
  .then(() => app.listen(port, () => console.log('Link Layouts running at http://localhost:' + port)))
  .catch((err) => {
    console.error('Could not connect to MySQL:', err.message);
    process.exit(1);
  });
