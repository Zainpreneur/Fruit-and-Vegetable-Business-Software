import { db, getSetting } from '../db.js';
import { sendJSON, bad, readJSON, num } from '../util.js';

function loadSale(id) {
  const sale = db.prepare(`
    SELECT s.*, c.name AS customerName,
      (SELECT COALESCE(SUM(qty * cost_cents), 0) FROM sale_items WHERE sale_id = s.id) AS cogsCents
    FROM sales s LEFT JOIN customers c ON c.id = s.customer_id
    WHERE s.id = ?`).get(id);
  if (!sale) return null;
  sale.items = db.prepare(`
    SELECT id, product_id AS productId, product_name AS productName,
           qty, unit_label AS unitLabel, unit_price_cents AS unitPriceCents,
           cost_cents AS costCents, line_total_cents AS lineTotalCents
    FROM sale_items WHERE sale_id = ? ORDER BY id`).all(id);
  return sale;
}

export function registerSalesRoutes(router) {
  router.post('/sales', async ({ req, res }) => {
    const b = await readJSON(req);
    const items = Array.isArray(b.items) ? b.items : [];
    if (!items.length) return bad(res, 'Cart is empty');
    if (items.length > 200) return bad(res, 'Too many items');

    const discountPct = Math.min(Math.max(num(b.discountPct ?? 0) || 0, 0), 100);
    if (Number.isNaN(discountPct)) return bad(res, 'Invalid discount');
    const method = ['cash', 'card', 'mobile'].includes(b.paymentMethod) ? b.paymentMethod : 'cash';
    const taxRate = parseFloat(getSetting('tax_rate', '5')) || 0;

    const stmt = db.prepare('SELECT * FROM products WHERE id = ?');
    const lines = [];
    for (const it of items) {
      const qty = num(it.qty);
      const product = stmt.get(it.productId);
      if (!product) return bad(res, `Product #${it.productId} not found`);
      if (!product.active) return bad(res, `${product.name} is no longer available`);
      if (Number.isNaN(qty) || qty <= 0) return bad(res, `Invalid quantity for ${product.name}`);
      if (qty > product.stock_qty + 1e-9) {
        return bad(res, `Insufficient stock for ${product.name} (available: ${product.stock_qty} ${product.unit})`);
      }
      lines.push({
        product,
        qty,
        lineTotal: Math.round(qty * product.price_cents),
      });
    }

    const subtotal = lines.reduce((a, l) => a + l.lineTotal, 0);
    const discountCents = Math.round((subtotal * discountPct) / 100);
    const taxable = subtotal - discountCents;
    const taxCents = Math.round((taxable * taxRate) / 100);
    const total = taxable + taxCents;

    let saleId;
    db.exec('BEGIN');
    try {
      const r = db.prepare(`INSERT INTO sales
        (customer_id, subtotal_cents, discount_pct, discount_cents, tax_cents, total_cents, payment_method, status, note, created_at)
        VALUES (?, ?, ?, ?, ?, ?, ?, 'completed', ?, ?)`)
        .run(b.customerId || null, subtotal, discountPct, discountCents, taxCents, total,
          method, b.note?.slice(0, 500) || '', new Date().toISOString());
      saleId = Number(r.lastInsertRowid);

      const insItem = db.prepare(`INSERT INTO sale_items
        (sale_id, product_id, product_name, qty, unit_label, cost_cents, unit_price_cents, line_total_cents)
        VALUES (?, ?, ?, ?, ?, ?, ?, ?)`);
      const decStock = db.prepare('UPDATE products SET stock_qty = stock_qty - ? WHERE id = ?');
      const logMove = db.prepare('INSERT INTO inventory_log (product_id, change_qty, reason, note, created_at) VALUES (?, ?, ?, ?, ?)');
      for (const l of lines) {
        insItem.run(saleId, l.product.id, l.product.name, l.qty, l.product.unit,
          l.product.cost_cents, l.product.price_cents, l.lineTotal);
        decStock.run(l.qty, l.product.id);
        logMove.run(l.product.id, -l.qty, 'sale', `Sale #${saleId}`, new Date().toISOString());
      }
      db.exec('COMMIT');
    } catch (e) {
      db.exec('ROLLBACK');
      throw e;
    }
    sendJSON(res, 201, loadSale(saleId));
  });

  router.get('/sales', ({ res, query }) => {
    const where = [];
    const args = [];
    if (query.get('from')) { where.push('s.created_at >= ?'); args.push(query.get('from')); }
    if (query.get('to')) { where.push('s.created_at <= ?'); args.push(query.get('to')); }
    if (query.get('status')) { where.push('s.status = ?'); args.push(query.get('status')); }
    if (query.get('customer_id')) { where.push('s.customer_id = ?'); args.push(query.get('customer_id')); }
    const limit = Math.min(parseInt(query.get('limit') || '50', 10) || 50, 500);
    const offset = Math.max(parseInt(query.get('offset') || '0', 10) || 0, 0);

    const rows = db.prepare(`
      SELECT s.id, s.total_cents AS totalCents, s.subtotal_cents AS subtotalCents,
             s.discount_pct AS discountPct, s.tax_cents AS taxCents,
             s.payment_method AS paymentMethod, s.status, s.created_at AS createdAt,
             c.name AS customerName,
             (SELECT COUNT(*) FROM sale_items si WHERE si.sale_id = s.id) AS itemCount
      FROM sales s LEFT JOIN customers c ON c.id = s.customer_id
      ${where.length ? 'WHERE ' + where.join(' AND ') : ''}
      ORDER BY s.created_at DESC, s.id DESC
      LIMIT ? OFFSET ?`).all(...args, limit, offset);
    sendJSON(res, 200, rows);
  });

  router.get('/sales/:id', ({ res, params }) => {
    const sale = loadSale(params.id);
    if (!sale) return bad(res, 'Sale not found', 404);
    sendJSON(res, 200, sale);
  });

  router.post('/sales/:id/refund', ({ res, params }) => {
    const sale = loadSale(params.id);
    if (!sale) return bad(res, 'Sale not found', 404);
    if (sale.status === 'refunded') return bad(res, 'Sale is already refunded');

    db.exec('BEGIN');
    try {
      db.prepare("UPDATE sales SET status = 'refunded' WHERE id = ?").run(params.id);
      const restock = db.prepare('UPDATE products SET stock_qty = stock_qty + ? WHERE id = ?');
      const logMove = db.prepare('INSERT INTO inventory_log (product_id, change_qty, reason, note, created_at) VALUES (?, ?, ?, ?, ?)');
      for (const item of sale.items) {
        if (item.productId) {
          restock.run(item.qty, item.productId);
          logMove.run(item.productId, item.qty, 'refund', `Refund of sale #${params.id}`, new Date().toISOString());
        }
      }
      db.exec('COMMIT');
    } catch (e) {
      db.exec('ROLLBACK');
      throw e;
    }
    sendJSON(res, 200, loadSale(params.id));
  });
}
