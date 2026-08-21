import { db } from '../db.js';
import { sendJSON, bad, readJSON, num } from '../util.js';
import { lifeState, daysLeft, WASTE_REASONS, gradeFromScores } from '../domain.js';

const BATCH_SELECT = `
  SELECT b.*, p.name AS productName, p.emoji, p.unit, p.price_cents AS priceCents,
         p.shelf_life_days AS shelfLifeDays,
         s.name AS supplierName, z.name AS zoneName, z.type AS zoneType
  FROM batches b
  JOIN products p ON p.id = b.product_id
  LEFT JOIN suppliers s ON s.id = b.supplier_id
  LEFT JOIN zones z ON z.id = b.storage_zone_id`;

function decorate(rows) {
  const now = Date.now();
  return rows.map((b) => ({
    ...b,
    state: lifeState(b, now),
    daysLeft: Math.ceil((new Date(b.expiry_date).getTime() - now) / 86400000),
    valueCents: Math.round(b.qty_remaining * b.unit_cost_cents),
  }));
}

export function registerOperationsRoutes(router) {
  router.get('/batches', ({ res, query }) => {
    const where = [];
    const args = [];
    if (query.get('product_id')) { where.push('b.product_id = ?'); args.push(query.get('product_id')); }
    if (query.get('status')) { where.push('b.status = ?'); args.push(query.get('status')); }
    else if (query.get('open') !== '0') { where.push("b.status IN ('available','quarantined')"); }
    if (query.get('q')) {
      where.push('(p.name LIKE ? OR b.code LIKE ? OR b.origin LIKE ?)');
      const q = `%${query.get('q')}%`;
      args.push(q, q, q);
    }
    const rows = db.prepare(`${BATCH_SELECT} ${where.length ? 'WHERE ' + where.join(' AND ') : ''}
      ORDER BY b.expiry_date ASC, b.id ASC`).all(...args);
    let list = decorate(rows);
    const state = query.get('state');
    if (state) list = list.filter((b) => b.state === state);
    sendJSON(res, 200, list);
  });

  router.get('/batches/:id', ({ res, params }) => {
    const row = db.prepare(`${BATCH_SELECT} WHERE b.id = ?`).get(params.id);
    if (!row) return bad(res, 'Batch not found', 404);
    const [batch] = decorate([row]);
    batch.inspections = db.prepare('SELECT * FROM inspections WHERE batch_id = ? ORDER BY created_at DESC').all(params.id);
    batch.wasteRecords = db.prepare('SELECT * FROM waste WHERE batch_id = ? ORDER BY created_at DESC').all(params.id);
    sendJSON(res, 200, batch);
  });

  router.post('/batches/:id/discount', async ({ req, res, params }) => {
    const b = await readJSON(req);
    const pct = Math.min(Math.max(Math.round(Number(b.discountPct)) || 0, 0), 100);
    db.prepare('UPDATE batches SET discount_pct = ? WHERE id = ?').run(pct, params.id);
    sendJSON(res, 200, { ok: true, discountPct: pct });
  });

  router.post('/batches/:id/quarantine', async ({ req, res, params }) => {
    const b = await readJSON(req).catch(() => ({}));
    const status = b.release ? 'available' : 'quarantined';
    db.prepare('UPDATE batches SET status = ? WHERE id = ?').run(status, params.id);
    sendJSON(res, 200, { ok: true, status });
  });

  router.post('/batches/:id/inspect', async ({ req, res, params }) => {
    const body = await readJSON(req);
    const batch = db.prepare('SELECT * FROM batches WHERE id = ?').get(params.id);
    if (!batch) return bad(res, 'Batch not found', 404);
    const score = (v) => Math.min(Math.max(Math.round(num(v)) || 0, 1), 5);
    const appearance = score(body.appearance);
    const firmness = score(body.firmness);
    const ripeness = score(body.ripeness);
    const damage = score(body.damage);
    const grade = ['A', 'B', 'C'].includes(body.grade)
      ? body.grade
      : gradeFromScores(appearance, firmness, ripeness, damage);
    const result = ['pass', 'partial', 'reject', 'quarantine'].includes(body.result) ? body.result : 'pass';
    let rejectedQty = Math.max(num(body.rejectedQty) || 0, 0);
    if (Number.isNaN(rejectedQty)) return bad(res, 'Invalid rejected quantity');
    if (rejectedQty > batch.qty_remaining + 1e-9) return bad(res, `Rejected qty exceeds remaining (${batch.qty_remaining})`);
    if (result === 'reject') rejectedQty = batch.qty_remaining;

    db.exec('BEGIN');
    try {
      let newRemaining = batch.qty_remaining;
      if (rejectedQty > 0) {
        newRemaining -= rejectedQty;
        db.prepare('UPDATE products SET stock_qty = MAX(0, stock_qty - ?) WHERE id = ?').run(rejectedQty, batch.product_id);
        db.prepare(`INSERT INTO waste (product_id, batch_id, supplier_id, qty, reason, value_cents, note, created_at)
          VALUES (?, ?, ?, ?, 'quality_rejection', ?, ?, ?)`)
          .run(batch.product_id, batch.id, batch.supplier_id, rejectedQty,
            Math.round(rejectedQty * batch.unit_cost_cents), body.notes || '', new Date().toISOString());
      }
      const status =
        result === 'reject' ? 'disposed'
          : result === 'quarantine' ? 'quarantined'
            : newRemaining <= 1e-9 ? 'depleted'
              : batch.status;
      db.prepare('UPDATE batches SET grade = ?, qty_remaining = ?, status = ? WHERE id = ?')
        .run(grade, newRemaining, status, params.id);

      db.prepare(`INSERT INTO inspections
        (batch_id, inspector, appearance, firmness, ripeness, damage, temp_c, result, accepted_qty, rejected_qty, notes, created_at)
        VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`)
        .run(batch.id, body.inspector || 'Quality Desk', appearance, firmness, ripeness, damage,
          body.tempC ?? null, result, Math.max(newRemaining, 0), rejectedQty, body.notes || '', new Date().toISOString());
      db.exec('COMMIT');
    } catch (e) {
      db.exec('ROLLBACK');
      throw e;
    }
    sendJSON(res, 200, { ok: true });
  });

  router.post('/batches/:id/dispose', async ({ req, res, params }) => {
    const body = await readJSON(req);
    const qty = num(body.qty);
    const reason = WASTE_REASONS.includes(body.reason) ? body.reason : 'unknown';
    const batch = db.prepare('SELECT * FROM batches WHERE id = ?').get(params.id);
    if (!batch) return bad(res, 'Batch not found', 404);
    if (Number.isNaN(qty) || qty <= 0) return bad(res, 'Invalid quantity');
    if (qty > batch.qty_remaining + 1e-9) return bad(res, `Only ${batch.qty_remaining} left in batch`);

    db.exec('BEGIN');
    try {
      const newRemaining = batch.qty_remaining - qty;
      db.prepare('UPDATE batches SET qty_remaining = ?, status = ? WHERE id = ?')
        .run(newRemaining, newRemaining <= 1e-9 ? 'disposed' : batch.status, params.id);
      db.prepare('UPDATE products SET stock_qty = MAX(0, stock_qty - ?) WHERE id = ?').run(qty, batch.product_id);
      db.prepare(`INSERT INTO waste (product_id, batch_id, supplier_id, qty, reason, value_cents, note, created_at)
        VALUES (?, ?, ?, ?, ?, ?, ?, ?)`)
        .run(batch.product_id, batch.id, batch.supplier_id, qty, reason,
          Math.round(qty * batch.unit_cost_cents), body.note || '', new Date().toISOString());
      db.exec('COMMIT');
    } catch (e) {
      db.exec('ROLLBACK');
      throw e;
    }
    sendJSON(res, 200, { ok: true, remaining: batch.qty_remaining - qty });
  });

  router.get('/zones', ({ res }) => {
    const zones = db.prepare(`
      SELECT z.*,
        (SELECT temp_c FROM temperature_readings r WHERE r.zone_id = z.id ORDER BY recorded_at DESC LIMIT 1) AS lastTemp,
        (SELECT recorded_at FROM temperature_readings r WHERE r.zone_id = z.id ORDER BY recorded_at DESC LIMIT 1) AS lastReadingAt,
        (SELECT COUNT(*) FROM batches b WHERE b.storage_zone_id = z.id AND b.status IN ('available','quarantined')) AS batchCount
      FROM zones z ORDER BY z.id`).all();
    for (const z of zones) {
      z.breach = z.min_temp != null && ((z.lastTemp != null && z.lastTemp < z.min_temp) || (z.lastTemp != null && z.lastTemp > z.max_temp));
    }
    sendJSON(res, 200, zones);
  });

  router.post('/zones/:id/readings', async ({ req, res, params }) => {
    const b = await readJSON(req);
    const temp = num(b.tempC);
    if (Number.isNaN(temp)) return bad(res, 'Invalid temperature');
    const zone = db.prepare('SELECT * FROM zones WHERE id = ?').get(params.id);
    if (!zone) return bad(res, 'Zone not found', 404);
    const breach = (zone.min_temp != null && temp < zone.min_temp) || (zone.max_temp != null && temp > zone.max_temp);
    db.prepare('INSERT INTO temperature_readings (zone_id, temp_c, status, recorded_at) VALUES (?, ?, ?, ?)')
      .run(zone.id, temp, breach ? 'breach' : 'ok', new Date().toISOString());
    sendJSON(res, 201, { ok: true, breach });
  });

  router.get('/waste', ({ res, query }) => {
    const days = Math.min(parseInt(query.get('days') || '30', 10) || 30, 365);
    const since = new Date(Date.now() - days * 86400000).toISOString();
    const rows = db.prepare(`
      SELECT w.*, p.name AS productName, p.emoji, p.unit, s.name AS supplierName
      FROM waste w
      JOIN products p ON p.id = w.product_id
      LEFT JOIN suppliers s ON s.id = w.supplier_id
      WHERE w.created_at >= ? ORDER BY w.created_at DESC LIMIT 100`).all(since);
    sendJSON(res, 200, rows);
  });

  router.get('/waste/analytics', ({ res, query }) => {
    const days = Math.min(parseInt(query.get('days') || '30', 10) || 30, 365);
    const since = new Date(Date.now() - days * 86400000).toISOString();
    const totals = db.prepare(
      'SELECT COUNT(*) AS events, COALESCE(SUM(qty),0) AS qty, COALESCE(SUM(value_cents),0) AS valueCents FROM waste WHERE created_at >= ?'
    ).get(since);
    const byReason = db.prepare('SELECT reason, SUM(qty) AS qty, SUM(value_cents) AS valueCents FROM waste WHERE created_at >= ? GROUP BY reason ORDER BY valueCents DESC').all(since);
    const byProduct = db.prepare(`
      SELECT w.product_id, p.name AS productName, p.emoji, p.unit, SUM(w.qty) AS qty, SUM(w.value_cents) AS valueCents
      FROM waste w JOIN products p ON p.id = w.product_id
      WHERE w.created_at >= ? GROUP BY w.product_id ORDER BY valueCents DESC LIMIT 10`).all(since);
    const bySupplier = db.prepare(`
      SELECT COALESCE(s.name,'Unknown') AS supplierName, SUM(w.qty) AS qty, SUM(w.value_cents) AS valueCents
      FROM waste w LEFT JOIN suppliers s ON s.id = w.supplier_id
      WHERE w.created_at >= ? GROUP BY w.supplier_id ORDER BY valueCents DESC LIMIT 8`).all(since);
    const purchases = db.prepare(`
      SELECT COALESCE(SUM(qty_accepted * unit_cost_cents),0) AS v FROM po_items poi
      JOIN purchase_orders po ON po.id = poi.po_id
      WHERE po.status='completed' AND po.received_at >= ?`).get(since).v;
    sendJSON(res, 200, {
      days,
      events: totals.events,
      totalQty: totals.qty,
      wasteValueCents: totals.valueCents,
      purchaseValueCents: purchases,
      wastePctOfPurchases: purchases > 0 ? Math.round((totals.valueCents / purchases) * 1000) / 10 : null,
      byReason,
      byProduct,
      bySupplier,
    });
  });

  router.get('/meta/waste-reasons', ({ res }) => sendJSON(res, 200, WASTE_REASONS));
}
