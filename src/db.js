/**
 * SQLite catalogue store (sql.js / WASM — no native compilation required).
 *
 * One table holds the parsed Leader rows. Refreshes replace all rows in a
 * single transaction. Lookups query by stock code, manufacturer SKU, or
 * barcode in a single indexed query.
 *
 * sql.js keeps the database in memory; we persist to a file on every write
 * and load from it on startup.
 */
import initSqlJs from 'sql.js';
import fs from 'fs';
import path from 'path';
import { fileURLToPath } from 'url';

const __dirname = path.dirname(fileURLToPath(import.meta.url));

const dbPath = process.env.DB_PATH
  ? path.resolve(process.cwd(), process.env.DB_PATH)
  : path.join(__dirname, '..', 'data', 'catalogue.db');

fs.mkdirSync(path.dirname(dbPath), { recursive: true });

const SQL = await initSqlJs();

// Load existing database file, or start fresh.
let db;
if (fs.existsSync(dbPath)) {
  db = new SQL.Database(new Uint8Array(fs.readFileSync(dbPath)));
} else {
  db = new SQL.Database();
}

/** Write the in-memory database to disk. Call after any mutating operation. */
function persist() {
  const data = db.export();
  fs.writeFileSync(dbPath, Buffer.from(data));
}

// ─── Schema ────────────────────────────────────────────────────────────────
db.run(`
  CREATE TABLE IF NOT EXISTS catalogue (
    id               INTEGER PRIMARY KEY AUTOINCREMENT,
    stock_code       TEXT NOT NULL,
    manufacturer_sku TEXT NOT NULL DEFAULT '',
    barcode          TEXT NOT NULL DEFAULT '',
    name             TEXT NOT NULL DEFAULT '',
    description      TEXT NOT NULL DEFAULT '',
    image            TEXT NOT NULL DEFAULT '',
    category         TEXT NOT NULL DEFAULT '',
    manufacturer     TEXT NOT NULL DEFAULT '',
    dbp              REAL NOT NULL DEFAULT 0,
    rrp              REAL NOT NULL DEFAULT 0
  );
`);
db.run(`CREATE INDEX IF NOT EXISTS idx_stock_code       ON catalogue(stock_code);`);
db.run(`CREATE INDEX IF NOT EXISTS idx_manufacturer_sku ON catalogue(manufacturer_sku);`);
db.run(`CREATE INDEX IF NOT EXISTS idx_barcode          ON catalogue(barcode);`);
db.run(`
  CREATE TABLE IF NOT EXISTS meta (
    key   TEXT PRIMARY KEY,
    value TEXT
  );
`);

// ─── Helpers (sql.js returns values as $prefixed bind params) ───────────────
function all(sql, params = []) {
  const stmt = db.prepare(sql);
  stmt.bind(params);
  const rows = [];
  while (stmt.step()) rows.push(stmt.getAsObject());
  stmt.free();
  return rows;
}
function run(sql, params = []) {
  db.run(sql, params);
}

// ─── Public API ────────────────────────────────────────────────────────────

/** Look up a product by stock code, manufacturer SKU, or barcode (case-insensitive). */
export function lookupProduct(sku) {
  const q = String(sku || '').trim();
  if (!q) return null;
  const rows = all(
    `SELECT stock_code AS stockCode, manufacturer_sku AS manufacturerSku,
            barcode, name, description, image, category, manufacturer,
            dbp, rrp
     FROM catalogue
     WHERE LOWER(stock_code) = LOWER(?)
        OR LOWER(manufacturer_sku) = LOWER(?)
        OR LOWER(barcode) = LOWER(?)
     LIMIT 1`,
    [q, q, q]
  );
  // Coerce numeric fields (sql.js may return them as numbers already).
  if (!rows.length) return null;
  const r = rows[0];
  r.dbp = Number(r.dbp) || 0;
  r.rrp = Number(r.rrp) || 0;
  return r;
}

/**
 * Look up a product by trying multiple code values against all three fields.
 * Used by the audit report to match Halo items (which may have any of
 * supplier_part_code, default_supplier_part_code, or qbosku populated)
 * against the Leader catalogue.
 * @param {string[]} codes  values to try (e.g. ['U7-LR', 'NHU-U7-LR', '8101...'])
 * @returns {object|null} matched product row or null
 */
export function lookupByAnyCode(codes) {
  for (const code of codes) {
    if (!code) continue;
    const result = lookupProduct(code);
    if (result) return result;
  }
  return null;
}

/**
 * Search the catalogue by substring across all text fields.
 * Used by the autocomplete dropdown on the search box.
 * @param {string} q  search term (at least 2 chars)
 * @param {number} limit  max results (default 15)
 * @returns {Array<object>} matching products
 */
export function searchCatalogue(q, limit = 15) {
  const term = '%' + String(q).trim().toLowerCase() + '%';
  if (term.length < 4) return []; // % + 2 chars + %
  return all(
    `SELECT stock_code AS stockCode, manufacturer_sku AS manufacturerSku,
            barcode, name, dbp
     FROM catalogue
     WHERE LOWER(stock_code) LIKE ?
        OR LOWER(manufacturer_sku) LIKE ?
        OR LOWER(barcode) LIKE ?
        OR LOWER(name) LIKE ?
        OR LOWER(description) LIKE ?
     LIMIT ?`,
    [term, term, term, term, term, limit]
  ).map((r) => ({
    ...r,
    dbp: Number(r.dbp) || 0,
  }));
}

/**
 * Replace the entire catalogue.
 * @param {Array<object>} rows  parsed product rows
 * @returns {{ count: number }} number of rows inserted
 */
export function replaceCatalogue(rows) {
  run('DELETE FROM catalogue');
  const stmt = db.prepare(
    `INSERT INTO catalogue
       (stock_code, manufacturer_sku, barcode, name, description, image,
        category, manufacturer, dbp, rrp)
     VALUES (?,?,?,?,?,?,?,?,?,?)`
  );
  for (const r of rows) {
    stmt.run([
      r.stockCode || '', r.manufacturerSku || '', r.barcode || '',
      r.name || '', r.description || '', r.image || '',
      r.category || '', r.manufacturer || '',
      Number(r.dbp) || 0, Number(r.rrp) || 0,
    ]);
  }
  stmt.free();
  run('INSERT INTO meta (key, value) VALUES (?, ?) ON CONFLICT(key) DO UPDATE SET value = excluded.value',
    ['last_refresh', new Date().toISOString()]);
  persist();
  return { count: rows.length };
}

/** Row count + last refresh timestamp. */
export function getStatus() {
  const row = all('SELECT COUNT(*) AS n FROM catalogue')[0];
  const meta = all("SELECT value FROM meta WHERE key = 'last_refresh'")[0];
  return {
    rowCount: row ? Number(row.n) : 0,
    lastRefresh: meta ? meta.value : null,
  };
}

/** Read a meta key (string), or null if absent. */
export function getMeta(key) {
  const row = all('SELECT value FROM meta WHERE key = ?', [key])[0];
  return row ? row.value : null;
}

/** Write a meta key (upsert) and persist. */
export function setMeta(key, value) {
  run('INSERT INTO meta (key, value) VALUES (?, ?) ON CONFLICT(key) DO UPDATE SET value = excluded.value',
    [key, value]);
  persist();
}
