import { db } from '../db.js';
import { sendJSON, bad, readJSON, num, intCents, UNITS } from '../util.js';

const PRODUCT_SELECT = `
  SELECT p.id, p.sku, p.name, p.emoji, p.unit,
         p.cost_cents AS costCents, p.price_cents AS priceCents,
         p.stock_qty AS stockQty, p.reorder_level AS reorderLevel,
         p.active, p.category_id AS categoryId, p.supplier_id AS supplierId,
         c.name AS category, c.emoji AS categoryEmoji, s.name AS supplier
  FROM products p
  LEFT JOIN categories c ON c.id = p.category_id
  LEFT JOIN suppliers s ON s.id = p.supplier_id`;

function nextSku(categoryName) {
  const prefixMap = { Fruits: 'FRU', Vegetables: 'VEG', Herbs: 'HRB', Exotic: 'EXO' };
  const prefix = prefixMap[categoryName] || 'GEN';
  const row = db.prepare(
    "SELECT COUNT(*) AS c FROM products WHERE sku LIKE ?"
  ).get(`${prefix}-%`);
  return `${prefix}-${String(row.c + 1).padStart(3, '0')}`;
}

export function registerCatalogRoutes(router) {
  router.get('/categories', ({ res }) => {
    const rows = db.prepare(`
      SELECT c.id, c.name, c.emoji, COUNT(p.id) AS productCount
      FROM categories c LEFT JOIN products p ON p.category_id = c.id AND p.active = 1
      GROUP BY c.id ORDER BY c.name`).all();
    sendJSON(res, 200, rows);
  });

  router.post('/categories', async ({ req, res }) => {
    const b = await readJSON(req);
    if (!b.name?.trim()) return bad(res, 'Category name is required');
    try {
      const r = db.prepare('INSERT INTO categories (name, emoji) VALUES (?, ?)')
        .run(b.name.trim(), b.emoji || '');
      sendJSON(res, 201, { id: Number(r.lastInsertRowid) });
    } catch {
      bad(res, 'Category name already exists', 409);
    }
  });

  router.put('/categories/:id', async ({ req, res, params }) => {
    const b = await readJSON(req);
    if (!b.name?.trim()) return bad(res, 'Category name is required');
    const r = db.prepare('UPDATE categories SET name = ?, emoji = ? WHERE id = ?')
      .run(b.name.trim(), b.emoji || '', params.id);
    if (!r.changes) return bad(res, 'Category not found', 404);
    sendJSON(res, 200, { ok: true });
  });

  router.del('/categories/:id', ({ res, params }) => {
    const inUse = db.prepare('SELECT COUNT(*) AS c FROM products WHERE category_id = ?')
      .get(params.id).c;
    if (inUse > 0) return bad(res, `Cannot delete: ${inUse} product(s) use this category`);
    const r = db.prepare('DELETE FROM categories WHERE id = ?').run(params.id);
    if (!r.changes) return bad(res, 'Category not found', 404);
    sendJSON(res, 200, { ok: true });
  });

  router.get('/products', ({ res, query }) => {
    const where = [];
    const args = [];
    const q = query.get('q')?.trim();
    if (q) {
      where.push('(p.name LIKE ? OR p.sku LIKE ?)');
      args.push(`%${q}%`, `%${q}%`);
    }
    if (query.get('category_id')) {
      where.push('p.category_id = ?');
      args.push(query.get('category_id'));
    }
    if (query.get('supplier_id')) {
      where.push('p.supplier_id = ?');
      args.push(query.get('supplier_id'));
    }
    if (query.get('low_stock') === '1') {
      where.push('p.stock_qty <= p.reorder_level');
    }
    const active = query.get('active') ?? '1';
    if (active === '1') where.push('p.active = 1');
    else if (active === '0') where.push('p.active = 0');

    const sql = `${PRODUCT_SELECT}
      ${where.length ? 'WHERE ' + where.join(' AND ') : ''}
      ORDER BY p.active DESC, c.name, p.name`;
    sendJSON(res, 200, db.prepare(sql).all(...args));
  });

  router.get('/products/:id', ({ res, params }) => {
    const row = db.prepare(`${PRODUCT_SELECT} WHERE p.id = ?`).get(params.id);
    if (!row) return bad(res, 'Product not found', 404);
    sendJSON(res, 200, row);
  });

  router.post('/products', async ({ req, res }) => {
    const b = await readJSON(req);
    if (!b.name?.trim()) return bad(res, 'Product name is required');
    const price = intCents(b.priceCents);
    const cost = b.costCents == null ? 0 : intCents(b.costCents);
    if (Number.isNaN(price)) return bad(res, 'Invalid retail price');
    if (Number.isNaN(cost)) return bad(res, 'Invalid cost price');
    const unit = UNITS.includes(b.unit) ? b.unit : 'kg';
    const stockQty = num(b.stockQty ?? 0);
    const reorderLevel = num(b.reorderLevel ?? 0);
    if ([stockQty, reorderLevel].some(Number.isNaN)) return bad(res, 'Invalid stock values');

    let categoryName = null;
    if (b.categoryId) {
      const cat = db.prepare('SELECT name FROM categories WHERE id = ?').get(b.categoryId);
      if (!cat) return bad(res, 'Category not found', 404);
      categoryName = cat.name;
    }

    db.exec('BEGIN');
    try {
      const sku = b.sku?.trim() || nextSku(categoryName);
      const r = db.prepare(`INSERT INTO products
        (sku, name, emoji, category_id, supplier_id, unit, cost_cents, price_cents, stock_qty, reorder_level, active, created_at)
        VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, datetime('now'))`)
        .run(sku, b.name.trim(), b.emoji || '', b.categoryId || null, b.supplierId || null,
          unit, cost, price, stockQty, reorderLevel, b.active === false ? 0 : 1);
      const pid = Number(r.lastInsertRowid);
      if (stockQty !== 0) {
        db.prepare('INSERT INTO inventory_log (product_id, change_qty, reason, note, created_at) VALUES (?, ?, ?, ?, datetime(?))')
          .run(pid, stockQty, 'restock', 'Opening stock', new Date().toISOString());
      }
      db.exec('COMMIT');
      sendJSON(res, 201, { id: pid, sku });
    } catch (e) {
      db.exec('ROLLBACK');
      if (String(e.message).includes('UNIQUE')) return bad(res, 'SKU already exists', 409);
      throw e;
    }
  });

  router.put('/products/:id', async ({ req, res, params }) => {
    const b = await readJSON(req);
    const existing = db.prepare('SELECT * FROM products WHERE id = ?').get(params.id);
    if (!existing) return bad(res, 'Product not found', 404);

    const updates = [];
    const args = [];
    const setNum = (field, col, validator) => {
      if (b[field] != null) {
        const v = validator(b[field]);
        if (Number.isNaN(v)) return bad(res, `Invalid ${field}`);
        updates.push(`${col} = ?`); args.push(v);
      }
    };
    setNum('costCents', 'cost_cents', intCents);
    setNum('priceCents', 'price_cents', intCents);
    setNum('reorderLevel', 'reorder_level', num);

    if (b.name != null) {
      if (!b.name.trim()) return bad(res, 'Product name is required');
      updates.push('name = ?'); args.push(b.name.trim());
    }
    for (const [f, c] of [['sku', 'sku'], ['emoji', 'emoji'], ['unit', 'unit']]) {
      if (b[f] != null) {
        if (c === 'unit' && !UNITS.includes(b[f])) return bad(res, 'Invalid unit');
        updates.push(`${c} = ?`); args.push(b[f]);
      }
    }
    for (const f of ['categoryId', 'supplierId']) {
      if (b[f] != null) { updates.push(`${f.replace('Id', '_id')} = ?`); args.push(b[f] || null); }
    }
    if (b.active != null) { updates.push('active = ?'); args.push(b.active ? 1 : 0); }

    if (!updates.length) return sendJSON(res, 200, { ok: true });
    args.push(params.id);
    const r = db.prepare(`UPDATE products SET ${updates.join(', ')} WHERE id = ?`).run(...args);
    if (!r.changes) return bad(res, 'Product not found', 404);
    sendJSON(res, 200, { ok: true });
  });

  router.del('/products/:id', ({ res, params }) => {
    const sold = db.prepare('SELECT COUNT(*) AS c FROM sale_items WHERE product_id = ?').get(params.id).c;
    if (sold > 0) {
      const r = db.prepare('UPDATE products SET active = 0 WHERE id = ?').run(params.id);
      if (!r.changes) return bad(res, 'Product not found', 404);
      return sendJSON(res, 200, { ok: true, deactivated: true });
    }
    db.exec('BEGIN');
    try {
      db.prepare('DELETE FROM inventory_log WHERE product_id = ?').run(params.id);
      db.prepare('DELETE FROM products WHERE id = ?').run(params.id);
      db.exec('COMMIT');
      sendJSON(res, 200, { ok: true, deleted: true });
    } catch (e) {
      db.exec('ROLLBACK');
      throw e;
    }
  });

  router.post('/products/:id/restock', async ({ req, res, params }) => {
    const b = await readJSON(req);
    const qty = num(b.qty);
    if (Number.isNaN(qty) || qty <= 0) return bad(res, 'Restock quantity must be a positive number');
    const product = db.prepare('SELECT id FROM products WHERE id = ?').get(params.id);
    if (!product) return bad(res, 'Product not found', 404);

    let costUpdated = false;
    if (b.costCents != null) {
      const c = intCents(b.costCents);
      if (Number.isNaN(c)) return bad(res, 'Invalid cost price');
      db.prepare('UPDATE products SET cost_cents = ? WHERE id = ?').run(c, params.id);
      costUpdated = true;
    }
    db.exec('BEGIN');
    try {
      db.prepare('UPDATE products SET stock_qty = stock_qty + ? WHERE id = ?').run(qty, params.id);
      db.prepare('INSERT INTO inventory_log (product_id, change_qty, reason, note, created_at) VALUES (?, ?, ?, ?, ?)')
        .run(params.id, qty, 'restock', b.note || 'Purchase order received', new Date().toISOString());
      db.exec('COMMIT');
    } catch (e) {
      db.exec('ROLLBACK');
      throw e;
    }
    const updated = db.prepare('SELECT stock_qty AS stockQty FROM products WHERE id = ?').get(params.id);
    sendJSON(res, 200, { ok: true, stockQty: updated.stockQty, costUpdated });
  });
}
