import { db, getSetting, setSetting } from '../db.js';
import { sendJSON, bad, readJSON, csvEscape } from '../util.js';

function dayKey(iso) {
  const d = new Date(iso);
  return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}-${String(d.getDate()).padStart(2, '0')}`;
}

export function registerReportRoutes(router) {
  router.get('/settings', ({ res }) => {
    sendJSON(res, 200, {
      taxRate: parseFloat(getSetting('tax_rate', '5')) || 0,
      storeName: getSetting('store_name', 'GreenBasket'),
    });
  });

  router.put('/settings', async ({ req, res }) => {
    const b = await readJSON(req);
    if (b.taxRate != null) {
      const r = Number(b.taxRate);
      if (!Number.isFinite(r) || r < 0 || r > 50) return bad(res, 'Tax rate must be between 0 and 50');
      setSetting('tax_rate', r);
    }
    if (b.storeName != null) setSetting('store_name', String(b.storeName).slice(0, 60));
    sendJSON(res, 200, { ok: true });
  });

  router.get('/reports/dashboard', ({ res }) => {
    const now = new Date();
    const startOfToday = new Date(now); startOfToday.setHours(0, 0, 0, 0);
    const startOfMonth = new Date(now.getFullYear(), now.getMonth(), 1);

    const sumBetween = (from) =>
      db.prepare("SELECT COALESCE(SUM(total_cents),0) AS total, COUNT(*) AS orders FROM sales WHERE status='completed' AND created_at >= ?")
        .get(from.toISOString());

    const today = sumBetween(startOfToday);
    const month = sumBetween(startOfMonth);

    const chartStart = new Date(startOfToday);
    chartStart.setDate(chartStart.getDate() - 13);
    const recentSales = db.prepare(
      "SELECT created_at AS createdAt, total_cents AS totalCents FROM sales WHERE status='completed' AND created_at >= ?"
    ).all(chartStart.toISOString());
    const byDay = {};
    for (const s of recentSales) byDay[dayKey(s.createdAt)] = (byDay[dayKey(s.createdAt)] || 0) + s.totalCents;
    const series = [];
    for (let i = 0; i < 14; i++) {
      const d = new Date(startOfToday);
      d.setDate(d.getDate() - 13 + i);
      const key = dayKey(d.toISOString ? d : d);
      series.push({
        date: key,
        label: d.toLocaleDateString(undefined, { weekday: 'short' }),
        revenueCents: byDay[key] || 0,
      });
    }

    const lowStock = db.prepare(`
      SELECT id, name, emoji, stock_qty AS stockQty, reorder_level AS reorderLevel, unit
      FROM products WHERE active = 1 AND stock_qty <= reorder_level
      ORDER BY CASE WHEN stock_qty <= 0 THEN 0 ELSE 1 END, stock_qty LIMIT 8`).all();
    const lowStockCount = db.prepare(
      'SELECT COUNT(*) AS c FROM products WHERE active = 1 AND stock_qty <= reorder_level'
    ).get().c;

    const recentOrders = db.prepare(`
      SELECT s.id, s.total_cents AS totalCents, s.status, s.payment_method AS paymentMethod,
             s.created_at AS createdAt, c.name AS customerName,
             (SELECT COUNT(*) FROM sale_items si WHERE si.sale_id = s.id) AS itemCount
      FROM sales s LEFT JOIN customers c ON c.id = s.customer_id
      ORDER BY s.created_at DESC, s.id DESC LIMIT 8`).all();

    sendJSON(res, 200, {
      todayRevenueCents: today.total,
      todayOrders: today.orders,
      monthRevenueCents: month.total,
      monthOrders: month.orders,
      avgOrderCents: month.orders ? Math.round(month.total / month.orders) : 0,
      productCount: db.prepare('SELECT COUNT(*) AS c FROM products WHERE active=1').get().c,
      customerCount: db.prepare('SELECT COUNT(*) AS c FROM customers').get().c,
      lowStockCount,
      lowStock,
      series,
      recentOrders,
    });
  });

  router.get('/reports/top-products', ({ res, query }) => {
    const days = Math.min(parseInt(query.get('days') || '30', 10) || 30, 365);
    const since = new Date(Date.now() - days * 86400000).toISOString();
    const rows = db.prepare(`
      SELECT si.product_name AS productName, MAX(p.emoji) AS emoji,
             SUM(si.qty) AS qtySold, SUM(si.line_total_cents) AS revenueCents,
             CAST(ROUND(SUM(si.line_total_cents - si.qty * si.cost_cents)) AS INTEGER) AS profitCents
      FROM sale_items si JOIN sales s ON s.id = si.sale_id
      LEFT JOIN products p ON p.id = si.product_id
      WHERE s.status = 'completed' AND s.created_at >= ?
      GROUP BY si.product_name ORDER BY revenueCents DESC LIMIT 10`).all(since);
    sendJSON(res, 200, rows);
  });

  router.get('/reports/sales-by-category', ({ res, query }) => {
    const days = Math.min(parseInt(query.get('days') || '30', 10) || 30, 365);
    const since = new Date(Date.now() - days * 86400000).toISOString();
    const rows = db.prepare(`
      SELECT COALESCE(c.name, 'Other') AS category, COALESCE(MAX(c.emoji), '') AS emoji,
             SUM(si.line_total_cents) AS revenueCents
      FROM sale_items si JOIN sales s ON s.id = si.sale_id
      LEFT JOIN products p ON p.id = si.product_id
      LEFT JOIN categories c ON c.id = p.category_id
      WHERE s.status = 'completed' AND s.created_at >= ?
      GROUP BY c.name ORDER BY revenueCents DESC`).all(since);
    sendJSON(res, 200, rows);
  });

  router.get('/reports/summary', ({ res, query }) => {
    const days = Math.min(parseInt(query.get('days') || '30', 10) || 30, 365);
    const since = new Date(Date.now() - days * 86400000).toISOString();
    const totals = db.prepare(`
      SELECT COUNT(*) AS orders, COALESCE(SUM(total_cents),0) AS revenueCents
      FROM sales WHERE status='completed' AND created_at >= ?`).get(since);
    const refunds = db.prepare(
      "SELECT COUNT(*) AS count, COALESCE(SUM(total_cents),0) AS amountCents FROM sales WHERE status='refunded' AND created_at >= ?"
    ).get(since);
    const profitRow = db.prepare(`
      SELECT CAST(ROUND(COALESCE(SUM(si.line_total_cents - si.qty * si.cost_cents), 0)) AS INTEGER) AS profitCents
      FROM sale_items si JOIN sales s ON s.id = si.sale_id
      WHERE s.status='completed' AND s.created_at >= ?`).get(since);
    sendJSON(res, 200, {
      days,
      orders: totals.orders,
      revenueCents: totals.revenueCents,
      profitCents: profitRow.profitCents,
      refunds: refunds.count,
      refundAmountCents: refunds.amountCents,
      avgOrderCents: totals.orders ? Math.round(totals.revenueCents / totals.orders) : 0,
    });
  });

  router.get('/export/orders.csv', ({ res, query }) => {
    const where = [];
    const args = [];
    if (query.get('from')) { where.push('s.created_at >= ?'); args.push(query.get('from')); }
    if (query.get('to')) { where.push('s.created_at <= ?'); args.push(query.get('to')); }
    const rows = db.prepare(`
      SELECT s.id, s.created_at AS createdAt, COALESCE(c.name,'Walk-in') AS customer,
        (SELECT COUNT(*) FROM sale_items si WHERE si.sale_id = s.id) AS items,
        s.subtotal_cents AS subtotal, s.discount_pct AS discountPct,
        s.tax_cents AS tax, s.total_cents AS total, s.payment_method AS payment, s.status
      FROM sales s LEFT JOIN customers c ON c.id = s.customer_id
      ${where.length ? 'WHERE ' + where.join(' AND ') : ''}
      ORDER BY s.created_at DESC`).all(...args);

    const header = ['OrderID', 'Date', 'Customer', 'Items', 'Subtotal', 'DiscountPct', 'Tax', 'Total', 'Payment', 'Status'];
    const lines = [header.join(',')];
    for (const r of rows) {
      lines.push([r.id, r.createdAt, csvEscape(r.customer), r.items, r.subtotal, r.discountPct, r.tax, r.total, r.payment, r.status].join(','));
    }
    const stamp = new Date().toISOString().slice(0, 10);
    res.writeHead(200, {
      'Content-Type': 'text/csv; charset=utf-8',
      'Content-Disposition': `attachment; filename="orders-${stamp}.csv"`,
    });
    res.end(lines.join('\n'));
  });
}
