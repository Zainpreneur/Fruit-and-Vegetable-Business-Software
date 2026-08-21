import { db, getSetting } from './db.js';
import { allocateFEFO, GRADE_MULT } from './domain.js';

export function refPriceFor(product, channel) {
  if (channel === 'retail' || channel === 'online') return product.price_cents;
  return product.wholesale_price_cents > 0 ? product.wholesale_price_cents : Math.round(product.price_cents * 0.8);
}

export function createSale({ items, customerId = null, discountPct = 0, paymentMethod = 'cash', channel = 'retail', note = '' }) {
  const taxRate = parseFloat(getSetting('tax_rate', '5')) || 0;
  const prodStmt = db.prepare('SELECT * FROM products WHERE id = ?');

  if (!items.length) throw Object.assign(new Error('Cart is empty'), { status: 400 });
  const pct = Math.min(Math.max(Number(discountPct) || 0, 0), 100);

  const plan = [];
  for (const it of items) {
    const qty = Number(it.qty);
    const product = prodStmt.get(it.productId);
    if (!product) throw Object.assign(new Error(`Product #${it.productId} not found`), { status: 400 });
    if (!product.active) throw Object.assign(new Error(`${product.name} is no longer available`), { status: 400 });
    if (!Number.isFinite(qty) || qty <= 0) throw Object.assign(new Error(`Invalid quantity for ${product.name}`), { status: 400 });
    const { picks, shortfall } = allocateFEFO(product.id, qty);
    if (shortfall > 1e-9) {
      throw Object.assign(
        new Error(picks.length ? `Insufficient stock for ${product.name} (only ${(qty - shortfall).toFixed(2)} available)` : `Insufficient stock for ${product.name}`),
        { status: 400 }
      );
    }
    const refPrice = refPriceFor(product, channel);
    let lineTotal = 0;
    const allocs = picks.map((p) => {
      const unit = Math.round(refPrice * (GRADE_MULT[p.batch.grade] || 1) * (1 - p.batch.discount_pct / 100));
      const amt = Math.round(p.qty * unit);
      lineTotal += amt;
      return { batchId: p.batch.id, batchCode: p.batch.code, qty: p.qty, unit };
    });
    plan.push({ product, qty, lineTotal, allocs });
  }

  const subtotal = plan.reduce((a, l) => a + l.lineTotal, 0);
  const discountCents = Math.round((subtotal * pct) / 100);
  const taxable = subtotal - discountCents;
  const taxCents = Math.round((taxable * taxRate) / 100);
  const total = taxable + taxCents;

  let termsDays = null;
  if (customerId && channel !== 'retail') {
    const cust = db.prepare('SELECT payment_terms FROM customers WHERE id = ?').get(customerId);
    const m = cust?.payment_terms?.match(/net\s*(\d+)/i);
    termsDays = m ? parseInt(m[1], 10) : 7;
  }
  const dueDate = termsDays != null ? new Date(Date.now() + termsDays * 86400000).toISOString() : null;

  let saleId;
  db.exec('BEGIN');
  try {
    const r = db.prepare(`INSERT INTO sales
      (customer_id, subtotal_cents, discount_pct, discount_cents, tax_cents, total_cents, payment_method, status, channel, due_date, note, created_at)
      VALUES (?, ?, ?, ?, ?, ?, ?, 'completed', ?, ?, ?, ?)`)
      .run(customerId, subtotal, pct, discountCents, taxCents, total, paymentMethod, channel, dueDate,
        String(note || '').slice(0, 500), new Date().toISOString());
    saleId = Number(r.lastInsertRowid);
    const insItem = db.prepare(`INSERT INTO sale_items
      (sale_id, product_id, product_name, qty, unit_label, cost_cents, unit_price_cents, line_total_cents)
      VALUES (?, ?, ?, ?, ?, ?, ?, ?)`);
    const insAlloc = db.prepare(`INSERT INTO sale_allocations
      (sale_id, sale_item_id, batch_id, qty, unit_price_cents) VALUES (?, ?, ?, ?, ?)`);
    const decStock = db.prepare('UPDATE products SET stock_qty = stock_qty - ? WHERE id = ?');
    const decBatch = db.prepare('UPDATE batches SET qty_remaining = qty_remaining - ?, status = CASE WHEN qty_remaining - ? <= 0.0001 THEN \'depleted\' ELSE status END WHERE id = ?');
    const logMove = db.prepare('INSERT INTO inventory_log (product_id, change_qty, reason, note, created_at) VALUES (?, ?, ?, ?, ?)');
    for (const l of plan) {
      const ir = insItem.run(saleId, l.product.id, l.product.name, l.qty, l.product.unit,
        l.product.cost_cents, Math.round(l.lineTotal / l.qty), l.lineTotal);
      const itemId = Number(ir.lastInsertRowid);
      for (const a of l.allocs) {
        insAlloc.run(saleId, itemId, a.batchId, a.qty, a.unit);
        decBatch.run(a.qty, a.qty, a.batchId);
      }
      decStock.run(l.qty, l.product.id);
      logMove.run(l.product.id, -l.qty, 'sale', `Sale #${saleId}`, new Date().toISOString());
    }
    db.exec('COMMIT');
  } catch (e) {
    db.exec('ROLLBACK');
    throw e;
  }
  return loadSaleFull(saleId);
}

export function loadSaleFull(id) {
  const sale = db.prepare(`
    SELECT s.*, c.name AS customerName, c.segment AS customerSegment,
      (SELECT COALESCE(SUM(qty * cost_cents),0) FROM sale_items WHERE sale_id = s.id) AS cogsCents
    FROM sales s LEFT JOIN customers c ON c.id = s.customer_id WHERE s.id = ?`).get(id);
  if (!sale) return null;
  sale.items = db.prepare(`
    SELECT si.id, si.product_id AS productId, si.product_name AS productName, si.qty,
           si.unit_label AS unitLabel, si.unit_price_cents AS unitPriceCents,
           si.cost_cents AS costCents, si.line_total_cents AS lineTotalCents
    FROM sale_items si WHERE si.sale_id = ? ORDER BY si.id`).all(id);
  sale.allocations = db.prepare(`
    SELECT sa.sale_item_id AS saleItemId, sa.batch_id AS batchId, sa.qty, sa.unit_price_cents AS unitPriceCents,
           b.code AS batchCode, b.grade, b.expiry_date AS expiryDate, p.name AS productName, s.name AS supplierName
    FROM sale_allocations sa
    JOIN batches b ON b.id = sa.batch_id
    JOIN products p ON p.id = b.product_id
    LEFT JOIN suppliers s ON s.id = b.supplier_id
    WHERE sa.sale_id = ? ORDER BY sa.id`).all(id);
  const paid = db.prepare('SELECT COALESCE(SUM(amount_cents),0) AS v FROM payments WHERE sale_id = ?').get(id).v;
  sale.paidCents = paid;
  sale.balanceCents = sale.total_cents - paid;
  return sale;
}
