import { DatabaseSync } from 'node:sqlite';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const DATA_DIR = path.join(__dirname, '..', 'data');
fs.mkdirSync(DATA_DIR, { recursive: true });

export const DB_PATH = path.join(DATA_DIR, 'store.db');
export const db = new DatabaseSync(DB_PATH);

db.exec('PRAGMA foreign_keys = ON;');

db.exec(`
CREATE TABLE IF NOT EXISTS settings (
  key TEXT PRIMARY KEY,
  value TEXT NOT NULL
);
CREATE TABLE IF NOT EXISTS suppliers (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  name TEXT NOT NULL UNIQUE,
  contact_name TEXT DEFAULT '',
  phone TEXT DEFAULT '',
  email TEXT DEFAULT '',
  created_at TEXT NOT NULL
);
CREATE TABLE IF NOT EXISTS categories (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  name TEXT NOT NULL UNIQUE,
  emoji TEXT DEFAULT ''
);
CREATE TABLE IF NOT EXISTS products (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  sku TEXT NOT NULL UNIQUE,
  name TEXT NOT NULL,
  emoji TEXT DEFAULT '',
  category_id INTEGER REFERENCES categories(id),
  supplier_id INTEGER REFERENCES suppliers(id),
  unit TEXT NOT NULL DEFAULT 'kg',
  cost_cents INTEGER NOT NULL DEFAULT 0,
  price_cents INTEGER NOT NULL DEFAULT 0,
  stock_qty REAL NOT NULL DEFAULT 0,
  reorder_level REAL NOT NULL DEFAULT 0,
  active INTEGER NOT NULL DEFAULT 1,
  created_at TEXT NOT NULL
);
CREATE TABLE IF NOT EXISTS customers (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  name TEXT NOT NULL,
  phone TEXT DEFAULT '',
  email TEXT DEFAULT '',
  notes TEXT DEFAULT '',
  created_at TEXT NOT NULL
);
CREATE TABLE IF NOT EXISTS sales (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  customer_id INTEGER REFERENCES customers(id),
  subtotal_cents INTEGER NOT NULL,
  discount_pct REAL NOT NULL DEFAULT 0,
  discount_cents INTEGER NOT NULL DEFAULT 0,
  tax_cents INTEGER NOT NULL DEFAULT 0,
  total_cents INTEGER NOT NULL,
  payment_method TEXT NOT NULL DEFAULT 'cash',
  status TEXT NOT NULL DEFAULT 'completed',
  note TEXT DEFAULT '',
  created_at TEXT NOT NULL
);
CREATE TABLE IF NOT EXISTS sale_items (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  sale_id INTEGER NOT NULL REFERENCES sales(id) ON DELETE CASCADE,
  product_id INTEGER REFERENCES products(id),
  product_name TEXT NOT NULL,
  qty REAL NOT NULL,
  unit_label TEXT DEFAULT '',
  cost_cents INTEGER NOT NULL DEFAULT 0,
  unit_price_cents INTEGER NOT NULL,
  line_total_cents INTEGER NOT NULL
);
CREATE TABLE IF NOT EXISTS inventory_log (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  product_id INTEGER NOT NULL REFERENCES products(id) ON DELETE CASCADE,
  change_qty REAL NOT NULL,
  reason TEXT NOT NULL,
  note TEXT DEFAULT '',
  created_at TEXT NOT NULL
);
CREATE INDEX IF NOT EXISTS idx_sales_created ON sales(created_at);
CREATE INDEX IF NOT EXISTS idx_items_sale ON sale_items(sale_id);
CREATE INDEX IF NOT EXISTS idx_items_product ON sale_items(product_id);
CREATE INDEX IF NOT EXISTS idx_products_name ON products(name);
CREATE INDEX IF NOT EXISTS idx_invlog_product ON inventory_log(product_id);
`);

export function getSetting(key, fallback = null) {
  const row = db.prepare('SELECT value FROM settings WHERE key = ?').get(key);
  return row ? row.value : fallback;
}

export function setSetting(key, value) {
  db.prepare(
    'INSERT INTO settings (key, value) VALUES (?, ?) ON CONFLICT(key) DO UPDATE SET value = excluded.value'
  ).run(key, String(value));
}

function mulberry32(a) {
  return function () {
    a |= 0;
    a = (a + 0x6d2b79f5) | 0;
    let t = Math.imul(a ^ (a >>> 15), 1 | a);
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

function seed() {
  const now = Date.now();
  const iso = (ms) => new Date(ms).toISOString();

  const categories = [
    ['Fruits', '🍎'],
    ['Vegetables', '🥕'],
    ['Herbs', '🌿'],
    ['Exotic', '🥑'],
  ];
  const insCat = db.prepare('INSERT INTO categories (name, emoji) VALUES (?, ?)');
  for (const [name, emoji] of categories) insCat.run(name, emoji);

  const suppliers = [
    ['Green Valley Farms', 'Marco Diaz', '+1 555-0101', 'orders@greenvalley.example'],
    ['Sunrise Produce Co.', 'Priya Nair', '+1 555-0102', 'supply@sunriseproduce.example'],
    ['Organic Roots Ltd.', 'Tom Becker', '+1 555-0103', 'hello@organicroots.example'],
  ];
  const insSup = db.prepare(
    'INSERT INTO suppliers (name, contact_name, phone, email, created_at) VALUES (?, ?, ?, ?, ?)'
  );
  for (const s of suppliers) insSup.run(s[0], s[1], s[2], s[3], iso(now - 86400000 * 60));

  const customers = [
    ['Alice Johnson', '+1 555-0201', 'alice@example.com', 'Weekly veggie box subscriber'],
    ['Bob Smith', '+1 555-0202', 'bob@example.com', ''],
    ['Carla Mendez', '+1 555-0203', '', 'Prefers ripe fruit'],
    ['David Chen', '+1 555-0204', 'dchen@example.com', ''],
    ['Emma Wilson', '+1 555-0205', '', 'Restaurant buyer - bulk orders'],
  ];
  const insCust = db.prepare(
    'INSERT INTO customers (name, phone, email, notes, created_at) VALUES (?, ?, ?, ?, ?)'
  );
  for (const c of customers) insCust.run(c[0], c[1], c[2], c[3], iso(now - 86400000 * 45));

  const P = [
    ['Apples', '🍎', 'Fruits', 'kg', 180, 249, 120, 30],
    ['Bananas', '🍌', 'Fruits', 'kg', 90, 149, 150, 40],
    ['Oranges', '🍊', 'Fruits', 'kg', 160, 219, 95, 25],
    ['Grapes', '🍇', 'Fruits', 'kg', 280, 389, 45, 15],
    ['Strawberries', '🍓', 'Fruits', 'pack', 320, 449, 18, 10],
    ['Mangoes', '🥭', 'Fruits', 'kg', 350, 489, 38, 12],
    ['Pineapple', '🍍', 'Fruits', 'pcs', 180, 279, 22, 8],
    ['Watermelon', '🍉', 'Fruits', 'pcs', 400, 589, 9, 6],
    ['Lemons', '🍋', 'Fruits', 'kg', 220, 299, 30, 10],
    ['Pears', '🍐', 'Fruits', 'kg', 210, 289, 26, 10],
    ['Tomatoes', '🍅', 'Vegetables', 'kg', 120, 189, 88, 25],
    ['Potatoes', '🥔', 'Vegetables', 'kg', 70, 119, 140, 40],
    ['Onions', '🧅', 'Vegetables', 'kg', 80, 129, 110, 35],
    ['Carrots', '🥕', 'Vegetables', 'kg', 90, 139, 75, 20],
    ['Broccoli', '🥦', 'Vegetables', 'kg', 240, 339, 24, 10],
    ['Spinach', '🥬', 'Vegetables', 'bunch', 40, 79, 30, 12],
    ['Bell Peppers', '🫑', 'Vegetables', 'kg', 260, 349, 28, 10],
    ['Cucumbers', '🥒', 'Vegetables', 'kg', 100, 159, 42, 15],
    ['Sweet Corn', '🌽', 'Vegetables', 'pcs', 50, 89, 36, 12],
    ['Eggplant', '🍆', 'Vegetables', 'kg', 150, 219, 26, 9],
    ['Fresh Basil', '🌿', 'Herbs', 'bunch', 60, 119, 14, 6],
    ['Cilantro', '🌱', 'Herbs', 'bunch', 40, 89, 16, 6],
    ['Mint', '🍃', 'Herbs', 'bunch', 45, 99, 3, 6],
    ['Avocado', '🥑', 'Exotic', 'pcs', 190, 289, 19, 8],
    ['Kiwi', '🥝', 'Exotic', 'pcs', 90, 149, 30, 10],
    ['Dragon Fruit', '🐉', 'Exotic', 'pcs', 480, 689, 0, 4],
  ];

  const catIds = {};
  for (const row of db.prepare('SELECT id, name FROM categories').all()) catIds[row.name] = row.id;

  const prefixMap = { Fruits: 'FRU', Vegetables: 'VEG', Herbs: 'HRB', Exotic: 'EXO' };
  const insProd = db.prepare(`INSERT INTO products
    (sku, name, emoji, category_id, supplier_id, unit, cost_cents, price_cents, stock_qty, reorder_level, active, created_at)
    VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, 1, ?)`);
  const insLog = db.prepare(
    'INSERT INTO inventory_log (product_id, change_qty, reason, note, created_at) VALUES (?, ?, ?, ?, ?)'
  );
  let skuCounters = {};
  const prodIds = [];
  P.forEach((p, i) => {
    const prefix = prefixMap[p[2]] || 'GEN';
    skuCounters[prefix] = (skuCounters[prefix] || 0) + 1;
    const sku = `${prefix}-${String(skuCounters[prefix]).padStart(3, '0')}`;
    const res = insProd.run(
      sku, p[0], p[1], catIds[p[2]], (i % 3) + 1, p[3], p[4], p[5], p[6], p[7],
      iso(now - 86400000 * 31)
    );
    const pid = Number(res.lastInsertRowid);
    prodIds.push({ id: pid, name: p[0], unit: p[3], price: p[5], cost: p[4] });
    insLog.run(pid, p[6], 'restock', 'Initial stock delivery', iso(now - 86400000 * 31));
  });

  setSetting('tax_rate', '5');

  const rand = mulberry32(42);
  const methods = ['cash', 'cash', 'card', 'card', 'mobile'];
  const insSale = db.prepare(`INSERT INTO sales
    (customer_id, subtotal_cents, discount_pct, discount_cents, tax_cents, total_cents, payment_method, status, note, created_at)
    VALUES (?, ?, ?, ?, ?, ?, ?, 'completed', '', ?)`);
  const insItem = db.prepare(`INSERT INTO sale_items
    (sale_id, product_id, product_name, qty, unit_label, cost_cents, unit_price_cents, line_total_cents)
    VALUES (?, ?, ?, ?, ?, ?, ?, ?)`);

  db.exec('BEGIN');
  try {
    for (let d = 30; d >= 0; d--) {
      const dayStart = new Date(now - d * 86400000);
      dayStart.setHours(8, 0, 0, 0);
      let start = dayStart.getTime();
      if (start > now) start = now - 3600000;
      const end = Math.min(start + 12 * 3600000, now);
      const n = 3 + Math.floor(rand() * 7);
      for (let s = 0; s < n; s++) {
        const when = start + Math.floor(rand() * Math.max(end - start, 60000));
        const itemCount = 1 + Math.floor(rand() * 4);
        const picked = [...prodIds].sort(() => rand() - 0.5).slice(0, itemCount);
        let subtotal = 0;
        const lines = picked.map((p) => {
          const qty =
            p.unit === 'kg'
              ? Math.round((0.5 + rand() * 2.5) * 4) / 4
              : 1 + Math.floor(rand() * 4);
          const lineTotal = Math.round(qty * p.price);
          subtotal += lineTotal;
          return { p, qty, lineTotal };
        });
        const pct = rand() < 0.15 ? 5 : 0;
        const disc = Math.round((subtotal * pct) / 100);
        const tax = Math.round(((subtotal - disc) * 5) / 100);
        const cust = rand() < 0.4 ? 1 + Math.floor(rand() * customers.length) : null;
        const method = methods[Math.floor(rand() * methods.length)];
        const res = insSale.run(cust, subtotal, pct, disc, tax, subtotal - disc + tax, method, iso(when));
        const sid = Number(res.lastInsertRowid);
        for (const l of lines) {
          insItem.run(sid, l.p.id, l.p.name, l.qty, l.p.unit, l.p.cost, l.p.price, l.lineTotal);
        }
      }
    }
    db.exec('COMMIT');
  } catch (e) {
    db.exec('ROLLBACK');
    throw e;
  }
}

const count = db.prepare('SELECT COUNT(*) AS c FROM products').get().c;
if (count === 0) {
  console.log('[db] Empty database detected, seeding sample data...');
  seed();
  console.log('[db] Seed complete.');
}
