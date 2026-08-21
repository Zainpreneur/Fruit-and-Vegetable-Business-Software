import { db } from '../db.js';
import { sendJSON, bad, readJSON } from '../util.js';
import { createSale, loadSaleFull } from '../sale-core.js';

export function registerSalesRoutes(router) {
  router.post('/sales', async ({ req, res }) => {
    const b = await readJSON(req);
    const channel = ['retail', 'wholesale', 'b2b', 'subscription', 'online'].includes(b.channel) ? b.channel : 'retail';
    if (channel !== 'retail' && !b.customerId) return bad(res, `${channel} sales require a customer`);
    try {
      const sale = createSale({
        items: Array.isArray(b.items) ? b.items : [],
        customerId: b.customerId || null,
        discountPct: b.discountPct || 0,
        paymentMethod: b.paymentMethod || 'cash',
        channel,
        note: b.note || '',
      });
      sendJSON(res, 201, sale);
    } catch (e) {
      bad(res, e.message, e.status || 500);
    }
  });

  router.get('/sales', ({ res, query }) => {
    const where = [];
    const args = [];
    if (query.get('from')) { where.push('s.created_at >= ?'); args.push(query.get('from')); }
    if (query.get('to')) { where.push('s.created_at <= ?'); args.push(query.get('to')); }
    if (query.get('status')) { where.push('s.status = ?'); args.push(query.get('status')); }
    if (query.get('customer_id')) { where.push('s.customer_id = ?'); args.push(query.get('customer_id')); }
    if (query.get('channel')) { where.push('s.channel = ?'); args.push(query.get('channel')); }
    const limit = Math.min(parseInt(query.get('limit') || '50', 10) || 50, 500);
    const offset = Math.max(parseInt(query.get('offset') || '0', 10) || 0, 0);

    const rows = db.prepare(`
      SELECT s.id, s.total_cents AS totalCents, s.subtotal_cents AS subtotalCents,
             s.discount_pct AS discountPct, s.tax_cents AS taxCents,
             s.payment_method AS paymentMethod, s.status, s.channel, s.due_date AS dueDate,
             s.created_at AS createdAt,
             c.name AS customerName,
             (SELECT COUNT(*) FROM sale_items si WHERE si.sale_id = s.id) AS itemCount
      FROM sales s LEFT JOIN customers c ON c.id = s.customer_id
      ${where.length ? 'WHERE ' + where.join(' AND ') : ''}
      ORDER BY s.created_at DESC, s.id DESC
      LIMIT ? OFFSET ?`).all(...args, limit, offset);
    sendJSON(res, 200, rows);
  });

  router.get('/sales/:id', ({ res, params }) => {
    const sale = loadSaleFull(params.id);
    if (!sale) return bad(res, 'Sale not found', 404);
    sendJSON(res, 200, sale);
  });

  router.post('/sales/:id/refund', ({ res, params }) => {
    const sale = loadSaleFull(params.id);
    if (!sale) return bad(res, 'Sale not found', 404);
    if (sale.status === 'refunded') return bad(res, 'Sale is already refunded');

    db.exec('BEGIN');
    try {
      db.prepare("UPDATE sales SET status = 'refunded' WHERE id = ?").run(params.id);
      const restockBatch = db.prepare(`UPDATE batches SET
        qty_remaining = qty_remaining + ?,
        status = CASE WHEN status = 'depleted' THEN 'available' ELSE status END
        WHERE id = ?`);
      const restockProduct = db.prepare('UPDATE products SET stock_qty = stock_qty + ? WHERE id = ?');
      const logMove = db.prepare('INSERT INTO inventory_log (product_id, change_qty, reason, note, created_at) VALUES (?, ?, ?, ?, ?)');
      for (const item of sale.items) {
        if (!item.productId) continue;
        const allocQty = sale.allocations.filter((a) => a.saleItemId === item.id).reduce((a, x) => a + x.qty, 0);
        for (const a of sale.allocations.filter((x) => x.saleItemId === item.id)) {
          restockBatch.run(a.qty, a.batchId);
        }
        const qtyBack = allocQty > 0 ? allocQty : item.qty;
        restockProduct.run(qtyBack, item.productId);
        logMove.run(item.productId, qtyBack, 'refund', `Refund of sale #${params.id}`, new Date().toISOString());
      }
      db.exec('COMMIT');
    } catch (e) {
      db.exec('ROLLBACK');
      throw e;
    }
    sendJSON(res, 200, loadSaleFull(params.id));
  });
}
