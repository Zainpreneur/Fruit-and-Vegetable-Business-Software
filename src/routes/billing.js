import { db } from '../db.js';
import { sendJSON, bad, readJSON, num, intCents } from '../util.js';
import { createSale, loadSaleFull } from '../sale-core.js';

function todayStr() {
  return new Date().toISOString().slice(0, 10);
}

export function registerBillingRoutes(router) {
  router.get('/subscriptions', ({ res }) => {
    const rows = db.prepare(`
      SELECT su.*, c.name AS customerName
      FROM subscriptions su JOIN customers c ON c.id = su.customer_id
      ORDER BY su.active DESC, su.next_run ASC`).all();
    const priceStmt = db.prepare('SELECT price_cents AS p FROM products WHERE id = ?');
    for (const s of rows) {
      s.items = JSON.parse(s.items_json || '[]').map((i) => {
        const prod = db.prepare('SELECT name, emoji, unit FROM products WHERE id = ?').get(i.productId);
        return { ...i, productName: prod?.name || '?', emoji: prod?.emoji || '', unit: prod?.unit || '' };
      });
      s.estPriceCents = s.items.reduce((a, i) => a + Math.round(i.qty * (priceStmt.get(i.productId)?.p || 0)), 0);
      delete s.items_json;
    }
    sendJSON(res, 200, rows);
  });

  function validateSub(b) {
    if (!b.customerId) throw Object.assign(new Error('Customer is required'), { status: 400 });
    if (!b.title?.trim()) throw Object.assign(new Error('Title is required'), { status: 400 });
    const freq = parseInt(b.freqDays, 10);
    if (!Number.isFinite(freq) || freq < 1 || freq > 90) throw Object.assign(new Error('Frequency must be 1-90 days'), { status: 400 });
    if (!/^\d{4}-\d{2}-\d{2}$/.test(b.nextRun || '')) throw Object.assign(new Error('Next run date required'), { status: 400 });
    const items = Array.isArray(b.items) ? b.items.filter((i) => num(i.qty) > 0) : [];
    if (!items.length) throw Object.assign(new Error('At least one item required'), { status: 400 });
    return { customerId: b.customerId, title: b.title.trim(), freqDays: freq, nextRun: b.nextRun, items };
  }

  router.post('/subscriptions', async ({ req, res }) => {
    try {
      const v = validateSub(await readJSON(req));
      const r = db.prepare(`INSERT INTO subscriptions (customer_id, title, items_json, freq_days, next_run, active, created_at)
        VALUES (?, ?, ?, ?, ?, 1, ?)`)
        .run(v.customerId, v.title, JSON.stringify(v.items), v.freqDays, v.nextRun, new Date().toISOString());
      sendJSON(res, 201, { id: Number(r.lastInsertRowid) });
    } catch (e) {
      bad(res, e.message, e.status || 500);
    }
  });

  router.put('/subscriptions/:id', async ({ req, res, params }) => {
    const existing = db.prepare('SELECT * FROM subscriptions WHERE id = ?').get(params.id);
    if (!existing) return bad(res, 'Subscription not found', 404);
    try {
      const b = await readJSON(req);
      const v = validateSub({
        customerId: b.customerId ?? existing.customer_id,
        title: b.title ?? existing.title,
        freqDays: b.freqDays ?? existing.freq_days,
        nextRun: b.nextRun ?? existing.next_run,
        items: b.items ?? JSON.parse(existing.items_json || '[]'),
      });
      db.prepare('UPDATE subscriptions SET customer_id=?, title=?, items_json=?, freq_days=?, next_run=? WHERE id=?')
        .run(v.customerId, v.title, JSON.stringify(v.items), v.freqDays, v.nextRun, params.id);
      sendJSON(res, 200, { ok: true });
    } catch (e) {
      bad(res, e.message, e.status || 500);
    }
  });

  router.post('/subscriptions/:id/toggle', async ({ req, res, params }) => {
    const existing = db.prepare('SELECT active FROM subscriptions WHERE id = ?').get(params.id);
    if (!existing) return bad(res, 'Subscription not found', 404);
    db.prepare('UPDATE subscriptions SET active = ? WHERE id = ?').run(existing.active ? 0 : 1, params.id);
    sendJSON(res, 200, { ok: true, active: !existing.active });
  });

  router.post('/subscriptions/run-due', ({ res }) => {
    const today = todayStr();
    const due = db.prepare("SELECT * FROM subscriptions WHERE active = 1 AND next_run <= ?").all(today);
    const generated = [];
    const errors = [];
    for (const sub of due) {
      const items = JSON.parse(sub.items_json || '[]');
      try {
        const sale = createSale({
          items,
          customerId: sub.customer_id,
          channel: 'subscription',
          paymentMethod: 'invoice',
          note: `Subscription: ${sub.title}`,
        });
        let next = new Date(sub.next_run + 'T00:00:00Z').getTime() + sub.freq_days * 86400000;
        while (next <= new Date(today + 'T00:00:00Z').getTime()) next += sub.freq_days * 86400000;
        db.prepare('UPDATE subscriptions SET next_run = ? WHERE id = ?')
          .run(new Date(next).toISOString().slice(0, 10), sub.id);
        generated.push({ subscriptionId: sub.id, orderId: sale.id, totalCents: sale.total_cents });
      } catch (e) {
        errors.push({ subscriptionId: sub.id, error: e.message });
      }
    }
    sendJSON(res, 200, { generated, errors });
  });

  router.post('/payments', async ({ req, res }) => {
    const b = await readJSON(req);
    const amount = intCents(b.amountCents);
    const saleId = Number(b.saleId);
    if (Number.isNaN(amount) || amount <= 0) return bad(res, 'Invalid amount');
    const sale = loadSaleFull(saleId);
    if (!sale) return bad(res, 'Sale not found', 404);
    if (sale.status === 'refunded') return bad(res, 'Cannot pay a refunded order');
    if (amount > sale.balanceCents) return bad(res, `Amount exceeds balance (${sale.balanceCents / 100})`);
    db.prepare('INSERT INTO payments (sale_id, amount_cents, method, paid_at) VALUES (?, ?, ?, ?)')
      .run(saleId, amount, ['cash', 'card', 'mobile', 'transfer'].includes(b.method) ? b.method : 'cash', new Date().toISOString());
    sendJSON(res, 201, { ok: true });
  });

  router.get('/finance/receivables', ({ res }) => {
    const rows = db.prepare(`
      SELECT s.id, s.total_cents AS totalCents, s.due_date AS dueDate, s.created_at AS createdAt,
             c.name AS customerName,
             (SELECT COALESCE(SUM(amount_cents),0) FROM payments p WHERE p.sale_id = s.id) AS paidCents
      FROM sales s JOIN customers c ON c.id = s.customer_id
      WHERE s.status = 'completed' AND s.channel IN ('b2b','subscription') AND s.payment_method = 'invoice'
      ORDER BY s.created_at DESC LIMIT 200`).all();
    const open = rows.map((r) => ({
      ...r,
      balanceCents: r.totalCents - r.paidCents,
      overdue: r.due_date != null && r.due_date < new Date().toISOString().slice(0, 10),
    })).filter((r) => r.balanceCents > 0);
    sendJSON(res, 200, {
      invoices: open,
      totalReceivableCents: open.reduce((a, r) => a + r.balanceCents, 0),
      overdueCents: open.filter((r) => r.overdue).reduce((a, r) => a + r.balanceCents, 0),
    });
  });
}
