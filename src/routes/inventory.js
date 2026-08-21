import { db } from '../db.js';
import { sendJSON, bad, readJSON, num } from '../util.js';

const REASONS = ['restock', 'spoilage', 'adjustment'];

export function registerInventoryRoutes(router) {
  router.post('/inventory/adjust', async ({ req, res }) => {
    const b = await readJSON(req);
    const qty = num(b.changeQty);
    if (Number.isNaN(qty) || qty === 0) return bad(res, 'Change quantity must be a non-zero number');
    if (!REASONS.includes(b.reason)) return bad(res, 'Invalid reason');

    const product = db.prepare('SELECT * FROM products WHERE id = ?').get(b.productId);
    if (!product) return bad(res, 'Product not found', 404);
    const newQty = product.stock_qty + qty;
    if (newQty < 0) return bad(res, `Adjustment would make stock negative (current: ${product.stock_qty} ${product.unit})`);

    db.exec('BEGIN');
    try {
      db.prepare('UPDATE products SET stock_qty = ? WHERE id = ?').run(newQty, b.productId);
      db.prepare('INSERT INTO inventory_log (product_id, change_qty, reason, note, created_at) VALUES (?, ?, ?, ?, ?)')
        .run(b.productId, qty, b.reason, b.note?.slice(0, 300) || '', new Date().toISOString());
      db.exec('COMMIT');
    } catch (e) {
      db.exec('ROLLBACK');
      throw e;
    }
    sendJSON(res, 200, { ok: true, stockQty: newQty });
  });

  router.get('/inventory/log', ({ res, query }) => {
    const where = [];
    const args = [];
    if (query.get('product_id')) { where.push('l.product_id = ?'); args.push(query.get('product_id')); }
    const limit = Math.min(parseInt(query.get('limit') || '30', 10) || 30, 200);
    const rows = db.prepare(`
      SELECT l.id, l.product_id AS productId, l.change_qty AS changeQty,
             l.reason, l.note, l.created_at AS createdAt,
             p.name AS productName, p.unit, p.emoji
      FROM inventory_log l JOIN products p ON p.id = l.product_id
      ${where.length ? 'WHERE ' + where.join(' AND ') : ''}
      ORDER BY l.created_at DESC, l.id DESC LIMIT ?`).all(...args, limit);
    sendJSON(res, 200, rows);
  });
}
