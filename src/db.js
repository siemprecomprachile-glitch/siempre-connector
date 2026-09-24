import fs from 'node:fs';
import path from 'node:path';
import Database from 'better-sqlite3';
import { config } from './config.js';

fs.mkdirSync(config.dataDir, { recursive: true });
const db = new Database(path.join(config.dataDir, 'connector.db'));
db.pragma('journal_mode = WAL');

db.exec(`
CREATE TABLE IF NOT EXISTS orders (
  id                INTEGER PRIMARY KEY AUTOINCREMENT,
  channel           TEXT NOT NULL,
  external_id       TEXT NOT NULL,
  status            TEXT NOT NULL DEFAULT 'pending',
  doc_kind          TEXT,
  bsale_document_id INTEGER,
  bsale_number      TEXT,
  bsale_url         TEXT,
  customer_name     TEXT,
  customer_rut      TEXT,
  total             REAL,
  attempts          INTEGER NOT NULL DEFAULT 0,
  last_error        TEXT,
  next_attempt_at   INTEGER,
  raw_order         TEXT,
  bsale_payload     TEXT,
  created_at        INTEGER NOT NULL,
  updated_at        INTEGER NOT NULL,
  UNIQUE (channel, external_id)
);

CREATE INDEX IF NOT EXISTS idx_orders_status ON orders (status, next_attempt_at);

CREATE TABLE IF NOT EXISTS tokens (
  channel       TEXT PRIMARY KEY,
  access_token  TEXT NOT NULL,
  refresh_token TEXT,
  expires_at    INTEGER,
  meta          TEXT,
  updated_at    INTEGER NOT NULL
);

CREATE TABLE IF NOT EXISTS events (
  id         INTEGER PRIMARY KEY AUTOINCREMENT,
  channel    TEXT,
  order_ref  TEXT,
  level      TEXT NOT NULL,
  message    TEXT NOT NULL,
  detail     TEXT,
  created_at INTEGER NOT NULL
);

CREATE INDEX IF NOT EXISTS idx_events_created ON events (created_at DESC);
`);

/**
 * Migraciones: las tablas de arriba solo se crean si no existen, asi que las
 * columnas nuevas hay que agregarlas a mano en las bases que ya estan andando.
 */
function agregarColumna(tabla, columna, definicion) {
  const existe = db
    .prepare(`SELECT COUNT(*) AS n FROM pragma_table_info(?) WHERE name = ?`)
    .get(tabla, columna).n;
  if (!existe) db.exec(`ALTER TABLE ${tabla} ADD COLUMN ${columna} ${definicion}`);
}

// Notas de credito por devolucion o cancelacion posterior a la venta.
agregarColumna('orders', 'nc_document_id', 'INTEGER');
agregarColumna('orders', 'nc_number', 'TEXT');
agregarColumna('orders', 'nc_url', 'TEXT');
agregarColumna('orders', 'nc_motive', 'TEXT');
agregarColumna('orders', 'credited_at', 'INTEGER');
agregarColumna('orders', 'last_refund_check', 'INTEGER');

const now = () => Date.now();

// --- ordenes -----------------------------------------------------------------

export const orders = {
  /** Inserta la orden si no existe. Devuelve null si ya estaba (idempotencia). */
  claim(channel, externalId) {
    const res = db
      .prepare(
        `INSERT OR IGNORE INTO orders (channel, external_id, status, created_at, updated_at)
         VALUES (?, ?, 'pending', ?, ?)`
      )
      .run(channel, String(externalId), now(), now());
    if (res.changes === 0) return null;
    return this.find(channel, externalId);
  },

  find(channel, externalId) {
    return db
      .prepare('SELECT * FROM orders WHERE channel = ? AND external_id = ?')
      .get(channel, String(externalId));
  },

  get(id) {
    return db.prepare('SELECT * FROM orders WHERE id = ?').get(id);
  },

  update(id, fields) {
    const keys = Object.keys(fields);
    if (!keys.length) return;
    const sets = keys.map((k) => `${k} = ?`).join(', ');
    db.prepare(`UPDATE orders SET ${sets}, updated_at = ? WHERE id = ?`).run(
      ...keys.map((k) => fields[k]),
      now(),
      id
    );
  },

  /** Ordenes listas para reintentar. */
  dueForRetry(limit = 20) {
    return db
      .prepare(
        `SELECT * FROM orders
         WHERE status IN ('pending', 'retry', 'credit_retry')
           AND (next_attempt_at IS NULL OR next_attempt_at <= ?)
         ORDER BY id ASC LIMIT ?`
      )
      .all(now(), limit);
  },

  recent(limit = 100) {
    return db.prepare('SELECT * FROM orders ORDER BY id DESC LIMIT ?').all(limit);
  },

  /**
   * Ordenes ya facturadas que hay que revisar por si el comprador se arrepintio.
   * Se revisan las mas antiguas sin revisar primero, y solo dentro de la ventana
   * en que una devolucion es posible.
   */
  pendingRefundCheck({ channel, days = 30, limit = 25 }) {
    const desde = Date.now() - days * 24 * 3600 * 1000;
    return db
      .prepare(
        `SELECT * FROM orders
         WHERE channel = ? AND status = 'done' AND created_at >= ?
         ORDER BY COALESCE(last_refund_check, 0) ASC
         LIMIT ?`
      )
      .all(channel, desde, limit);
  },

  counts() {
    const rows = db.prepare('SELECT status, COUNT(*) AS n FROM orders GROUP BY status').all();
    return Object.fromEntries(rows.map((r) => [r.status, r.n]));
  },
};

// --- tokens ------------------------------------------------------------------

export const tokens = {
  save(channel, { accessToken, refreshToken, expiresAt, meta }) {
    db.prepare(
      `INSERT INTO tokens (channel, access_token, refresh_token, expires_at, meta, updated_at)
       VALUES (?, ?, ?, ?, ?, ?)
       ON CONFLICT(channel) DO UPDATE SET
         access_token = excluded.access_token,
         refresh_token = COALESCE(excluded.refresh_token, tokens.refresh_token),
         expires_at = excluded.expires_at,
         meta = excluded.meta,
         updated_at = excluded.updated_at`
    ).run(
      channel,
      accessToken,
      refreshToken ?? null,
      expiresAt ?? null,
      meta ? JSON.stringify(meta) : null,
      now()
    );
  },

  get(channel) {
    return db.prepare('SELECT * FROM tokens WHERE channel = ?').get(channel);
  },
};

// --- eventos -----------------------------------------------------------------

export const events = {
  add(level, message, { channel, orderRef, detail } = {}) {
    db.prepare(
      `INSERT INTO events (channel, order_ref, level, message, detail, created_at)
       VALUES (?, ?, ?, ?, ?, ?)`
    ).run(
      channel ?? null,
      orderRef ? String(orderRef) : null,
      level,
      message,
      detail ? (typeof detail === 'string' ? detail : JSON.stringify(detail)) : null,
      now()
    );
  },

  recent(limit = 100) {
    return db.prepare('SELECT * FROM events ORDER BY id DESC LIMIT ?').all(limit);
  },
};

export default db;
