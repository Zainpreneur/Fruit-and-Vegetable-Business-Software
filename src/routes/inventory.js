import { db } from '../db.js';
import { sendJSON, bad, readJSON, num } from '../util.js';
import { createBatch, consumeFEFO } from '../domain.js';

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
    const note = b.note?.slice(0, 300) || '';
    const now = new Date().toISOString();

    db.exec('BEGIN');
    try {
      if (qty > 0) {
        createBatch({
          product,
          supplierId: product.supplier_id || null,
          origin: product.origin || '',
          receivedAt: now,
          qty,
          unitCostCents: product.cost_cents,
          grade: 'A',
        });
        db.prepare(`INSERT INTO inventory_log (product_id, change_qty, reason, note, created_at)
          VALUES (?, ?, ?, ?, ?)`).run(b.productId, qty, b.reason, note, now);
      } else {
        const { picks, shortfall } = consumeFEFO(b.productId, -qty);
        if (shortfall > 1e-9) {
          db.exec('ROLLBACK');
          const batchStock = db.prepare(`
            SELECT COALESCE(SUM(qty_remaining),0) AS s FROM batches
            WHERE product_id = ? AND status='available'`).get(b.productId).s;
          return bad(res, `Only ${batchStock} ${product.unit} exists in dated batches — cannot remove ${-qty}`);
        }
        for (const p of picks) {
          if (b.reason === 'spoilage') {
            db.prepare(`INSERT INTO waste (product_id, batch_id, supplier_id, qty, reason, value_cents, note, created_at)
              VALUES (?, ?, ?, ?, 'unknown', ?, ?, ?)`)
              .run(b.productId, p.batch.id, p.batch.supplier_id, p.qty,
                Math.round(p.qty * p.batch.unit_cost_cents), note || 'Manual spoilage adjustment', now);
          }
        }
        db.prepare(`INSERT INTO inventory_log (product_id, change_qty, reason, note, created_at)
          VALUES (?, ?, ?, ?, ?)`).run(b.productId, qty, b.reason, note, now);
      }
      db.prepare('UPDATE products SET stock_qty = ? WHERE id = ?').run(newQty, b.productId);
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
