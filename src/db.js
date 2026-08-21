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
  type TEXT DEFAULT 'wholesaler',
  lead_time_days INTEGER DEFAULT 2,
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
  variety TEXT DEFAULT '',
  origin TEXT DEFAULT '',
  shelf_life_days INTEGER NOT NULL DEFAULT 7,
  storage_req TEXT NOT NULL DEFAULT 'ambient',
  wholesale_price_cents INTEGER NOT NULL DEFAULT 0,
  created_at TEXT NOT NULL
);
CREATE TABLE IF NOT EXISTS customers (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  name TEXT NOT NULL,
  phone TEXT DEFAULT '',
  email TEXT DEFAULT '',
  notes TEXT DEFAULT '',
  segment TEXT NOT NULL DEFAULT 'retail',
  payment_terms TEXT DEFAULT '',
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
  channel TEXT NOT NULL DEFAULT 'retail',
  due_date TEXT,
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

CREATE TABLE IF NOT EXISTS zones (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  name TEXT NOT NULL UNIQUE,
  type TEXT NOT NULL DEFAULT 'ambient',
  min_temp REAL,
  max_temp REAL
);
CREATE TABLE IF NOT EXISTS temperature_readings (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  zone_id INTEGER NOT NULL REFERENCES zones(id) ON DELETE CASCADE,
  temp_c REAL NOT NULL,
  status TEXT NOT NULL DEFAULT 'ok',
  recorded_at TEXT NOT NULL
);
CREATE TABLE IF NOT EXISTS batches (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  code TEXT NOT NULL UNIQUE,
  product_id INTEGER NOT NULL REFERENCES products(id),
  supplier_id INTEGER REFERENCES suppliers(id),
  po_id INTEGER REFERENCES purchase_orders(id),
  origin TEXT DEFAULT '',
  harvest_date TEXT,
  received_at TEXT NOT NULL,
  expiry_date TEXT NOT NULL,
  storage_zone_id INTEGER REFERENCES zones(id),
  grade TEXT NOT NULL DEFAULT 'A',
  qty_initial REAL NOT NULL,
  qty_remaining REAL NOT NULL,
  unit_cost_cents INTEGER NOT NULL DEFAULT 0,
  discount_pct INTEGER NOT NULL DEFAULT 0,
  status TEXT NOT NULL DEFAULT 'available',
  created_at TEXT NOT NULL
);
CREATE TABLE IF NOT EXISTS inspections (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  batch_id INTEGER NOT NULL REFERENCES batches(id) ON DELETE CASCADE,
  inspector TEXT DEFAULT '',
  appearance INTEGER DEFAULT 0,
  firmness INTEGER DEFAULT 0,
  ripeness INTEGER DEFAULT 0,
  damage INTEGER DEFAULT 0,
  temp_c REAL,
  result TEXT NOT NULL DEFAULT 'pass',
  accepted_qty REAL NOT NULL DEFAULT 0,
  rejected_qty REAL NOT NULL DEFAULT 0,
  notes TEXT DEFAULT '',
  created_at TEXT NOT NULL
);
CREATE TABLE IF NOT EXISTS purchase_orders (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  code TEXT NOT NULL UNIQUE,
  supplier_id INTEGER NOT NULL REFERENCES suppliers(id),
  status TEXT NOT NULL DEFAULT 'draft',
  expected_date TEXT,
  est_total_cents INTEGER NOT NULL DEFAULT 0,
  notes TEXT DEFAULT '',
  received_at TEXT,
  created_at TEXT NOT NULL
);
CREATE TABLE IF NOT EXISTS po_items (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  po_id INTEGER NOT NULL REFERENCES purchase_orders(id) ON DELETE CASCADE,
  product_id INTEGER NOT NULL REFERENCES products(id),
  qty REAL NOT NULL,
  unit_cost_cents INTEGER NOT NULL DEFAULT 0,
  qty_received REAL NOT NULL DEFAULT 0,
  qty_accepted REAL NOT NULL DEFAULT 0,
  qty_rejected REAL NOT NULL DEFAULT 0
);
CREATE TABLE IF NOT EXISTS waste (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  product_id INTEGER NOT NULL REFERENCES products(id),
  batch_id INTEGER REFERENCES batches(id) ON DELETE SET NULL,
  supplier_id INTEGER REFERENCES suppliers(id),
  qty REAL NOT NULL,
  reason TEXT NOT NULL,
  value_cents INTEGER NOT NULL DEFAULT 0,
  note TEXT DEFAULT '',
  created_at TEXT NOT NULL
);
CREATE TABLE IF NOT EXISTS subscriptions (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  customer_id INTEGER NOT NULL REFERENCES customers(id),
  title TEXT NOT NULL,
  items_json TEXT NOT NULL DEFAULT '[]',
  freq_days INTEGER NOT NULL DEFAULT 7,
  next_run TEXT NOT NULL,
  active INTEGER NOT NULL DEFAULT 1,
  created_at TEXT NOT NULL
);
CREATE TABLE IF NOT EXISTS payments (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  sale_id INTEGER NOT NULL REFERENCES sales(id) ON DELETE CASCADE,
  amount_cents INTEGER NOT NULL,
  method TEXT DEFAULT 'cash',
  paid_at TEXT NOT NULL
);
CREATE TABLE IF NOT EXISTS sale_allocations (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  sale_id INTEGER NOT NULL REFERENCES sales(id) ON DELETE CASCADE,
  sale_item_id INTEGER NOT NULL REFERENCES sale_items(id) ON DELETE CASCADE,
  batch_id INTEGER NOT NULL REFERENCES batches(id),
  qty REAL NOT NULL,
  unit_price_cents INTEGER NOT NULL
);
CREATE INDEX IF NOT EXISTS idx_batches_product ON batches(product_id);
CREATE INDEX IF NOT EXISTS idx_batches_expiry ON batches(expiry_date);
CREATE INDEX IF NOT EXISTS idx_po_supplier ON purchase_orders(supplier_id);
CREATE INDEX IF NOT EXISTS idx_waste_created ON waste(created_at);
`);

function addColumn(table, colDef) {
  const colName = colDef.match(/^\s*(\w+)/)[1];
  const cols = db.prepare(`PRAGMA table_info(${table})`).all().map((c) => c.name);
  if (!cols.includes(colName)) {
    db.exec(`ALTER TABLE ${table} ADD COLUMN ${colDef}`);
    console.log(`[db] migrated: ${table}.${colName}`);
  }
}

addColumn('products', 'variety TEXT DEFAULT ""');
addColumn('products', 'origin TEXT DEFAULT ""');
addColumn('products', 'shelf_life_days INTEGER NOT NULL DEFAULT 7');
addColumn('products', 'storage_req TEXT NOT NULL DEFAULT "ambient"');
addColumn('products', 'wholesale_price_cents INTEGER NOT NULL DEFAULT 0');
addColumn('customers', 'segment TEXT NOT NULL DEFAULT "retail"');
addColumn('customers', 'payment_terms TEXT DEFAULT ""');
addColumn('suppliers', 'type TEXT DEFAULT "wholesaler"');
addColumn('suppliers', 'lead_time_days INTEGER DEFAULT 2');
addColumn('sales', 'channel TEXT NOT NULL DEFAULT "retail"');
addColumn('sales', 'due_date TEXT');

export function getSetting(key, fallback = null) {
  const row = db.prepare('SELECT value FROM settings WHERE key = ?').get(key);
  return row ? row.value : fallback;
}

export function setSetting(key, value) {
  db.prepare(
    'INSERT INTO settings (key, value) VALUES (?, ?) ON CONFLICT(key) DO UPDATE SET value = excluded.value'
  ).run(key, String(value));
}

export function nextCode(prefix, table) {
  const n = db.prepare(`SELECT COUNT(*) AS c FROM ${table}`).get().c + 1;
  return `${prefix}-${String(n).padStart(4, '0')}`;
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

const DAY = 86400000;

function seed() {
  const now = Date.now();
  const iso = (ms) => new Date(ms).toISOString();

  const insCat = db.prepare('INSERT INTO categories (name, emoji) VALUES (?, ?)');
  for (const [name, emoji] of [
    ['Fruits', '🍎'],
    ['Vegetables', '🥕'],
    ['Herbs', '🌿'],
    ['Exotic', '🥑'],
  ])
    insCat.run(name, emoji);

  const insSup = db.prepare(
    'INSERT INTO suppliers (name, contact_name, phone, email, type, lead_time_days, created_at) VALUES (?, ?, ?, ?, ?, ?, ?)'
  );
  insSup.run('Green Valley Farms', 'Marco Diaz', '+1 555-0101', 'orders@greenvalley.example', 'farm', 1, iso(now - DAY * 60));
  insSup.run('Sunrise Produce Co.', 'Priya Nair', '+1 555-0102', 'supply@sunriseproduce.example', 'wholesaler', 2, iso(now - DAY * 60));
  insSup.run('Organic Roots Ltd.', 'Tom Becker', '+1 555-0103', 'hello@organicroots.example', 'organic', 3, iso(now - DAY * 60));

  const insCust = db.prepare(
    'INSERT INTO customers (name, phone, email, notes, segment, payment_terms, created_at) VALUES (?, ?, ?, ?, ?, ?, ?)'
  );
  insCust.run('Alice Johnson', '+1 555-0201', 'alice@example.com', 'Weekly veggie box subscriber', 'retail', '', iso(now - DAY * 45));
  insCust.run('Bob Smith', '+1 555-0202', 'bob@example.com', '', 'retail', '', iso(now - DAY * 45));
  insCust.run('Carla Mendez', '+1 555-0203', '', 'Prefers ripe fruit', 'retail', '', iso(now - DAY * 44));
  insCust.run('David Chen', '+1 555-0204', 'dchen@example.com', '', 'reseller', 'net7', iso(now - DAY * 43));
  insCust.run('Emma Wilson', '+1 555-0205', '', 'Buys in bulk for kitchen', 'restaurant', 'net14', iso(now - DAY * 42));

  const P = [
    ['Apples', '🍎', 'Fruits', 'kg', 180, 249, 120, 30, 'Gala', 'Local Farm', 21, 'ambient'],
    ['Bananas', '🍌', 'Fruits', 'kg', 90, 149, 150, 40, 'Cavendish', 'Imported', 6, 'ambient'],
    ['Oranges', '🍊', 'Fruits', 'kg', 160, 219, 95, 25, 'Navel', 'Regional', 14, 'ambient'],
    ['Grapes', '🍇', 'Fruits', 'kg', 280, 389, 45, 15, 'Thompson', 'Imported', 8, 'chilled'],
    ['Strawberries', '🍓', 'Fruits', 'pack', 320, 449, 18, 10, 'Albion', 'Local Farm', 3, 'chilled'],
    ['Mangoes', '🥭', 'Fruits', 'kg', 350, 489, 38, 12, 'Kent', 'Imported', 5, 'ambient'],
    ['Pineapple', '🍍', 'Fruits', 'pcs', 180, 279, 22, 8, 'Smooth Cayenne', 'Imported', 7, 'ambient'],
    ['Watermelon', '🍉', 'Fruits', 'pcs', 400, 589, 9, 6, 'Sugar Baby', 'Local Farm', 12, 'ambient'],
    ['Lemons', '🍋', 'Fruits', 'kg', 220, 299, 30, 10, 'Eureka', 'Regional', 18, 'ambient'],
    ['Pears', '🍐', 'Fruits', 'kg', 210, 289, 26, 10, 'Bartlett', 'Regional', 12, 'chilled'],
    ['Tomatoes', '🍅', 'Vegetables', 'kg', 120, 189, 88, 25, 'Roma', 'Green Valley Farms', 7, 'ambient'],
    ['Potatoes', '🥔', 'Vegetables', 'kg', 70, 119, 140, 40, 'Russet', 'Regional', 30, 'dry'],
    ['Onions', '🧅', 'Vegetables', 'kg', 80, 129, 110, 35, 'Yellow', 'Regional', 30, 'dry'],
    ['Carrots', '🥕', 'Vegetables', 'kg', 90, 139, 75, 20, 'Nantes', 'Green Valley Farms', 21, 'chilled'],
    ['Broccoli', '🥦', 'Vegetables', 'kg', 240, 339, 24, 10, 'Calabrese', 'Regional', 5, 'chilled'],
    ['Spinach', '🥬', 'Vegetables', 'bunch', 40, 79, 30, 12, 'Bloomsdale', 'Green Valley Farms', 4, 'chilled'],
    ['Bell Peppers', '🫑', 'Vegetables', 'kg', 260, 349, 28, 10, 'California Wonder', 'Regional', 10, 'chilled'],
    ['Cucumbers', '🥒', 'Vegetables', 'kg', 100, 159, 42, 15, 'English', 'Green Valley Farms', 8, 'chilled'],
    ['Sweet Corn', '🌽', 'Vegetables', 'pcs', 50, 89, 36, 12, 'Golden Bantam', 'Local Farm', 4, 'chilled'],
    ['Eggplant', '🍆', 'Vegetables', 'kg', 150, 219, 26, 9, 'Black Beauty', 'Regional', 8, 'ambient'],
    ['Fresh Basil', '🌿', 'Herbs', 'bunch', 60, 119, 14, 6, 'Genovese', 'Green Valley Farms', 5, 'chilled'],
    ['Cilantro', '🌱', 'Herbs', 'bunch', 40, 89, 16, 6, 'Santo', 'Green Valley Farms', 4, 'chilled'],
    ['Mint', '🍃', 'Herbs', 'bunch', 45, 99, 3, 6, 'Spearmint', 'Green Valley Farms', 5, 'chilled'],
    ['Avocado', '🥑', 'Exotic', 'pcs', 190, 289, 19, 8, 'Hass', 'Imported', 7, 'ambient'],
    ['Kiwi', '🥝', 'Exotic', 'pcs', 90, 149, 30, 10, 'Hayward', 'Imported', 12, 'chilled'],
    ['Dragon Fruit', '🐉', 'Exotic', 'pcs', 480, 689, 0, 4, 'White Flesh', 'Imported', 6, 'chilled'],
  ];

  const catIds = {};
  for (const row of db.prepare('SELECT id, name FROM categories').all()) catIds[row.name] = row.id;

  const prefixMap = { Fruits: 'FRU', Vegetables: 'VEG', Herbs: 'HRB', Exotic: 'EXO' };
  const insProd = db.prepare(`INSERT INTO products
    (sku, name, emoji, category_id, supplier_id, unit, cost_cents, price_cents, stock_qty, reorder_level, variety, origin, shelf_life_days, storage_req, wholesale_price_cents, active, created_at)
    VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, 1, ?)`);
  const insLog = db.prepare(
    'INSERT INTO inventory_log (product_id, change_qty, reason, note, created_at) VALUES (?, ?, ?, ?, ?)'
  );
  const counters = {};
  const prodIds = [];
  P.forEach((p, i) => {
    const prefix = prefixMap[p[2]] || 'GEN';
    counters[prefix] = (counters[prefix] || 0) + 1;
    const sku = `${prefix}-${String(counters[prefix]).padStart(3, '0')}`;
    const res = insProd.run(
      sku, p[0], p[1], catIds[p[2]], (i % 3) + 1, p[3], p[4], p[5], p[6], p[7],
      p[8], p[9], p[10], p[11], Math.round(p[5] * 0.82), iso(now - DAY * 31)
    );
    prodIds.push({ id: Number(res.lastInsertRowid), name: p[0], unit: p[3], price: p[5], cost: p[4] });
    insLog.run(Number(res.lastInsertRowid), p[6], 'restock', 'Initial stock delivery', iso(now - DAY * 31));
  });
  const pidByName = Object.fromEntries(prodIds.map((p) => [p.name, p]));

  setSetting('tax_rate', '5');

  const rand = mulberry32(42);
  const methods = ['cash', 'cash', 'card', 'card', 'mobile'];
  const insSale = db.prepare(`INSERT INTO sales
    (customer_id, subtotal_cents, discount_pct, discount_cents, tax_cents, total_cents, payment_method, status, channel, note, created_at)
    VALUES (?, ?, ?, ?, ?, ?, ?, 'completed', 'retail', '', ?)`);
  const insItem = db.prepare(`INSERT INTO sale_items
    (sale_id, product_id, product_name, qty, unit_label, cost_cents, unit_price_cents, line_total_cents)
    VALUES (?, ?, ?, ?, ?, ?, ?, ?)`);

  db.exec('BEGIN');
  try {
    for (let d = 30; d >= 0; d--) {
      const dayStart = new Date(now - d * DAY);
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
            p.unit === 'kg' ? Math.round((0.5 + rand() * 2.5) * 4) / 4 : 1 + Math.floor(rand() * 4);
          const lineTotal = Math.round(qty * p.price);
          subtotal += lineTotal;
          return { p, qty, lineTotal };
        });
        const pct = rand() < 0.15 ? 5 : 0;
        const disc = Math.round((subtotal * pct) / 100);
        const tax = Math.round(((subtotal - disc) * 5) / 100);
        const cust = rand() < 0.4 ? 1 + Math.floor(rand() * 5) : null;
        const res = insSale.run(
          cust, subtotal, pct, disc, tax, subtotal - disc + tax,
          methods[Math.floor(rand() * methods.length)], iso(when)
        );
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

  const unpaid = db.prepare(`INSERT INTO sales
    (customer_id, subtotal_cents, discount_pct, discount_cents, tax_cents, total_cents, payment_method, status, channel, due_date, note, created_at)
    VALUES (5, ?, 0, 0, ?, ?, 'invoice', 'completed', 'b2b', ?, 'Standing weekly order', ?)`);
  const sub = 24 * 189 + 6 * 349 + 10 * 89;
  const stax = Math.round(sub * 0.05);
  const resU = unpaid.run(sub, stax, sub + stax, iso(now + DAY * 8), iso(new Date(now - DAY * 6)));
  const uid = Number(resU.lastInsertRowid);
  const uItems = [
    [pidByName['Tomatoes'].id, 'Tomatoes', 24, 'kg', 120, 189],
    [pidByName['Bell Peppers'].id, 'Bell Peppers', 6, 'kg', 260, 349],
    [pidByName['Sweet Corn'].id, 'Sweet Corn', 10, 'pcs', 50, 89],
  ];
  for (const [pid, name, qty, unitLabel, cost, price] of uItems) {
    insItem.run(uid, pid, name, qty, unitLabel, cost, price, Math.round(qty * price));
  }

  const insSub = db.prepare(
    'INSERT INTO subscriptions (customer_id, title, items_json, freq_days, next_run, active, created_at) VALUES (?, ?, ?, ?, ?, 1, ?)'
  );
  const boxItems = [
    { productId: pidByName['Tomatoes'].id, qty: 2 },
    { productId: pidByName['Carrots'].id, qty: 1 },
    { productId: pidByName['Spinach'].id, qty: 2 },
  ];
  const nextRun = new Date(now + DAY);
  insSub.run(1, 'Weekly Vegetable Box', JSON.stringify(boxItems), 7, nextRun.toISOString().slice(0, 10), iso(now - DAY * 20));

  ensureOpsSeed();
}

function ensureOpsSeed() {
  if (db.prepare('SELECT COUNT(*) AS c FROM zones').get().c === 0) {
    const insZone = db.prepare('INSERT INTO zones (name, type, min_temp, max_temp) VALUES (?, ?, ?, ?)');
    insZone.run('Ambient Store', 'ambient', 10, 28);
    insZone.run('Chilled Room', 'chilled', 2, 8);
    insZone.run('Dry Storage', 'dry', 8, 30);
  }
  if (db.prepare('SELECT COUNT(*) AS c FROM temperature_readings').get().c === 0) {
    const now = Date.now();
    const insR = db.prepare('INSERT INTO temperature_readings (zone_id, temp_c, status, recorded_at) VALUES (?, ?, ?, ?)');
    const z = {};
    for (const row of db.prepare('SELECT * FROM zones').all()) z[row.name] = row.id;
    insR.run(z['Ambient Store'], 22.4, 'ok', new Date(now - 26 * 3600000).toISOString());
    insR.run(z['Chilled Room'], 12.5, 'breach', new Date(now - 24 * 3600000).toISOString());
    insR.run(z['Chilled Room'], 4.8, 'ok', new Date(now - 20 * 3600000).toISOString());
    insR.run(z['Dry Storage'], 19.1, 'ok', new Date(now - 6 * 3600000).toISOString());
    insR.run(z['Ambient Store'], 23.7, 'ok', new Date(now - 3 * 3600000).toISOString());
    insR.run(z['Chilled Room'], 5.2, 'ok', new Date(now - 3600000).toISOString());
  }
  if (db.prepare('SELECT COUNT(*) AS c FROM batches').get().c > 0) return;

  const now = Date.now();
  const iso = (ms) => new Date(ms).toISOString();
  const zoneByType = {};
  for (const row of db.prepare('SELECT * FROM zones').all()) zoneByType[row.type] = row.id;
  const supByName = {};
  for (const row of db.prepare('SELECT * FROM suppliers').all()) supByName[row.name] = row.id;

  const insBatch = db.prepare(`INSERT INTO batches
    (code, product_id, supplier_id, origin, harvest_date, received_at, expiry_date, storage_zone_id, grade, qty_initial, qty_remaining, unit_cost_cents, status, created_at)
    VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, 'available', ?)`);
  const updStock = db.prepare('UPDATE products SET stock_qty = ? WHERE id = ?');

  const prods = db.prepare('SELECT * FROM products WHERE active = 1').all();
  let bc = 0;
  for (const p of prods) {
    if (p.stock_qty <= 0) continue;
    bc += 1;
    const received = now - DAY * 5;
    insBatch.run(
      `BT-${String(bc).padStart(4, '0')}`, p.id, p.supplier_id, p.origin || '',
      iso(received - DAY), iso(received), iso(received + p.shelf_life_days * DAY),
      zoneByType[p.storage_req] || null, bc % 7 === 0 ? 'B' : 'A',
      p.stock_qty, p.stock_qty, p.cost_cents, iso(received)
    );
  }

  const spinach = db.prepare("SELECT * FROM products WHERE name = 'Spinach'").get();
  if (spinach && spinach.stock_qty >= 4) {
    bc += 1;
    insBatch.run(
      `BT-${String(bc).padStart(4, '0')}`, spinach.id, supByName['Green Valley Farms'] || null,
      'Green Valley Farms', iso(now - DAY * 5), iso(now - DAY * 5), iso(now - DAY),
      zoneByType['chilled'] || null, 'B', 4, 4, spinach.cost_cents, iso(now - DAY * 5)
    );
  }

  const grapes = db.prepare("SELECT * FROM products WHERE name = 'Grapes'").get();
  const apples = db.prepare("SELECT * FROM products WHERE name = 'Apples'").get();
  const insWaste = db.prepare(
    'INSERT INTO waste (product_id, batch_id, supplier_id, qty, reason, value_cents, note, created_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?)'
  );
  const findBatch = db.prepare('SELECT * FROM batches WHERE product_id = ? ORDER BY id LIMIT 1');
  for (const [p, qty, reason, when] of [
    [grapes, 3, 'bruised', now - DAY * 2],
    [apples, 4, 'overripe', now - DAY],
  ]) {
    if (!p) continue;
    const b = findBatch.get(p.id);
    if (!b || b.qty_remaining < qty) continue;
    db.prepare('UPDATE batches SET qty_remaining = qty_remaining - ? WHERE id = ?').run(qty, b.id);
    updStock.run(Math.max(0, p.stock_qty - qty), p.id);
    insWaste.run(p.id, b.id, b.supplier_id, qty, reason, Math.round(qty * p.cost_cents), 'Spotted during morning check', iso(when));
  }

  const insPO = db.prepare(`INSERT INTO purchase_orders
    (code, supplier_id, status, expected_date, est_total_cents, notes, received_at, created_at)
    VALUES (?, ?, ?, ?, ?, '', ?, ?)`);
  const insPOI = db.prepare(
    'INSERT INTO po_items (po_id, product_id, qty, unit_cost_cents) VALUES (?, ?, ?, ?)'
  );

  const tomato = db.prepare("SELECT * FROM products WHERE name = 'Tomatoes'").get();
  const pepper = db.prepare("SELECT * FROM products WHERE name = 'Bell Peppers'").get();
  const r1 = insPO.run(nextCode('PO', 'purchase_orders'), supByName['Green Valley Farms'], 'draft', iso(now + DAY * 2), 50 * 120 + 20 * 260, null, iso(now - DAY));
  insPOI.run(Number(r1.lastInsertRowid), tomato.id, 50, 120);
  insPOI.run(Number(r1.lastInsertRowid), pepper.id, 20, 260);

  const banana = db.prepare("SELECT * FROM products WHERE name = 'Bananas'").get();
  const mango = db.prepare("SELECT * FROM products WHERE name = 'Mangoes'").get();
  const r2 = insPO.run(nextCode('PO', 'purchase_orders'), supByName['Sunrise Produce Co.'], 'ordered', iso(now + DAY * 2), 80 * 90 + 25 * 350, null, iso(now - DAY));
  insPOI.run(Number(r2.lastInsertRowid), banana.id, 80, 90);
  insPOI.run(Number(r2.lastInsertRowid), mango.id, 25, 350);

  const kiwi = db.prepare("SELECT * FROM products WHERE name = 'Kiwi'").get();
  const straw = db.prepare("SELECT * FROM products WHERE name = 'Strawberries'").get();
  const recvAt = now - DAY * 2;
  const r3 = insPO.run(nextCode('PO', 'purchase_orders'), supByName['Organic Roots Ltd.'], 'completed', iso(recvAt), 30 * 95 + 15 * 330, iso(recvAt), iso(now - DAY * 3));
  const po3 = Number(r3.lastInsertRowid);
  insPOI.run(po3, kiwi.id, 30, 95);
  insPOI.run(po3, straw.id, 15, 330);
  const upPOI = db.prepare('UPDATE po_items SET qty_received = ?, qty_accepted = ?, qty_rejected = ? WHERE po_id = ? AND product_id = ?');

  bc += 1;
  const rb1 = insBatch.run(
    `BT-${String(bc).padStart(4, '0')}`, kiwi.id, supByName['Organic Roots Ltd.'], 'Imported',
    iso(recvAt - DAY * 3), iso(recvAt), iso(recvAt + kiwi.shelf_life_days * DAY),
    zoneByType['chilled'], 'B', 28, 28, 95, iso(recvAt)
  );
  upPOI.run(30, 28, 2, po3, kiwi.id);
  const insInsp = db.prepare(`INSERT INTO inspections
    (batch_id, inspector, appearance, firmness, ripeness, damage, temp_c, result, accepted_qty, rejected_qty, notes, created_at)
    VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`);
  insInsp.run(Number(rb1.lastInsertRowid), 'Receiving Bay 1', 3, 4, 4, 3, 4.2, 'partial', 28, 2, 'Two punnets crushed in transit', iso(recvAt));

  bc += 1;
  const rb2 = insBatch.run(
    `BT-${String(bc).padStart(4, '0')}`, straw.id, supByName['Organic Roots Ltd.'], 'Local Farm',
    iso(recvAt), iso(recvAt), iso(recvAt + straw.shelf_life_days * DAY),
    zoneByType['chilled'], 'A', 15, 15, 330, iso(recvAt)
  );
  upPOI.run(15, 15, 0, po3, straw.id);
  insInsp.run(Number(rb2.lastInsertRowid), 'Receiving Bay 1', 5, 5, 5, 5, 3.8, 'pass', 15, 0, 'Excellent condition', iso(recvAt));

  console.log('[db] operations data seeded (zones, batches, POs, cold-chain).');
}

try {
  const count = db.prepare('SELECT COUNT(*) AS c FROM products').get().c;
  if (count === 0) {
    console.log('[db] Empty database detected, seeding sample data...');
    seed();
    console.log('[db] Seed complete.');
  } else {
    ensureOpsSeed();
  }
} catch (e) {
  console.error('[db] init error', e);
  throw e;
}
