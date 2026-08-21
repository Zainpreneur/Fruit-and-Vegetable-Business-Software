import { db, nextCode } from '../db.js';
import { sendJSON, bad, readJSON, num } from '../util.js';
import { createBatch, gradeFromScores } from '../domain.js';

export function registerPurchasingRoutes(router) {
  router.get('/purchase-orders', ({ res }) => {
    const rows = db.prepare(`
      SELECT po.*, s.name AS supplierName,
        (SELECT COUNT(*) FROM po_items i WHERE i.po_id = po.id) AS itemCount,
        (SELECT COALESCE(SUM(qty),0) FROM po_items i WHERE i.po_id = po.id) AS totalQty,
        (SELECT COALESCE(SUM(qty_received),0) FROM po_items i WHERE i.po_id = po.id) AS receivedQty,
        (SELECT COALESCE(SUM(qty_accepted * unit_cost_cents),0) FROM po_items i WHERE i.po_id = po.id) AS acceptedValueCents
      FROM purchase_orders po JOIN suppliers s ON s.id = po.supplier_id
      ORDER BY CASE po.status WHEN 'draft' THEN 0 WHEN 'ordered' THEN 1 WHEN 'receiving' THEN 2 ELSE 3 END,
               po.expected_date ASC, po.id DESC LIMIT 100`).all();
    sendJSON(res, 200, rows);
  });

  router.get('/purchase-orders/:id', ({ res, params }) => {
    const po = db.prepare(`
      SELECT po.*, s.name AS supplierName, s.contact_name AS supplierContact
      FROM purchase_orders po JOIN suppliers s ON s.id = po.supplier_id WHERE po.id = ?`).get(params.id);
    if (!po) return bad(res, 'Purchase order not found', 404);
    po.items = db.prepare(`
      SELECT i.*, p.name AS productName, p.emoji, p.unit, p.shelf_life_days AS shelfLifeDays
      FROM po_items i JOIN products p ON p.id = i.product_id WHERE i.po_id = ? ORDER BY i.id`).all(params.id);
    sendJSON(res, 200, po);
  });

  router.post('/purchase-orders', async ({ req, res }) => {
    const b = await readJSON(req);
    if (!b.supplierId) return bad(res, 'Supplier is required');
    const items = Array.isArray(b.items) ? b.items.filter((i) => i.productId) : [];
    if (!items.length) return bad(res, 'Add at least one item');
    const sup = db.prepare('SELECT id FROM suppliers WHERE id = ?').get(b.supplierId);
    if (!sup) return bad(res, 'Supplier not found', 404);
    let est = 0;
    for (const it of items) {
      const qty = num(it.qty);
      const cost = Math.round(Number(it.unitCostCents));
      if (!(qty > 0)) return bad(res, 'Invalid quantity');
      if (!Number.isFinite(cost) || cost < 0) return bad(res, 'Invalid unit cost');
      est += Math.round(qty * cost);
    }
    db.exec('BEGIN');
    try {
      const r = db.prepare(`INSERT INTO purchase_orders
        (code, supplier_id, status, expected_date, est_total_cents, notes, created_at)
        VALUES (?, ?, 'draft', ?, ?, ?, ?)`)
        .run(nextCode('PO', 'purchase_orders'), b.supplierId, b.expectedDate || null, est,
          (b.notes || '').slice(0, 300), new Date().toISOString());
      const poId = Number(r.lastInsertRowid);
      const insItem = db.prepare('INSERT INTO po_items (po_id, product_id, qty, unit_cost_cents) VALUES (?, ?, ?, ?)');
      for (const it of items) insItem.run(poId, it.productId, num(it.qty), Math.round(Number(it.unitCostCents)));
      db.exec('COMMIT');
      sendJSON(res, 201, { id: poId });
    } catch (e) {
      db.exec('ROLLBACK');
      throw e;
    }
  });

  router.post('/purchase-orders/:id/order', ({ res, params }) => {
    const po = db.prepare('SELECT status FROM purchase_orders WHERE id = ?').get(params.id);
    if (!po) return bad(res, 'Purchase order not found', 404);
    if (po.status !== 'draft') return bad(res, `Cannot order a PO that is ${po.status}`);
    db.prepare("UPDATE purchase_orders SET status = 'ordered' WHERE id = ?").run(params.id);
    sendJSON(res, 200, { ok: true });
  });

  router.post('/purchase-orders/:id/cancel', ({ res, params }) => {
    const po = db.prepare('SELECT status FROM purchase_orders WHERE id = ?').get(params.id);
    if (!po) return bad(res, 'Purchase order not found', 404);
    if (!['draft', 'ordered'].includes(po.status)) return bad(res, `Cannot cancel a PO that is ${po.status}`);
    db.prepare("UPDATE purchase_orders SET status = 'cancelled' WHERE id = ?").run(params.id);
    sendJSON(res, 200, { ok: true });
  });

  router.del('/purchase-orders/:id', ({ res, params }) => {
    const po = db.prepare('SELECT status FROM purchase_orders WHERE id = ?').get(params.id);
    if (!po) return bad(res, 'Purchase order not found', 404);
    if (po.status !== 'draft') return bad(res, 'Only draft POs can be deleted');
    db.prepare('DELETE FROM po_items WHERE po_id = ?').run(params.id);
    db.prepare('DELETE FROM purchase_orders WHERE id = ?').run(params.id);
    sendJSON(res, 200, { ok: true });
  });

  router.post('/purchase-orders/:id/receive', async ({ req, res, params }) => {
    const body = await readJSON(req);
    const po = db.prepare('SELECT * FROM purchase_orders WHERE id = ?').get(params.id);
    if (!po) return bad(res, 'Purchase order not found', 404);
    if (!['ordered', 'receiving'].includes(po.status)) return bad(res, `PO is ${po.status}; only ordered POs can be received`);
    const lines = Array.isArray(body.lines) ? body.lines : [];
    if (!lines.length) return bad(res, 'No receiving lines provided');

    const items = db.prepare('SELECT * FROM po_items WHERE po_id = ?').all(params.id);
    const byId = Object.fromEntries(items.map((i) => [i.id, i]));
    const now = new Date().toISOString();
    const created = [];

    const plan = [];
    for (const ln of lines) {
      const item = byId[ln.itemId];
      if (!item) return bad(res, `Unknown PO line ${ln.itemId}`);
      const accepted = Math.max(num(ln.acceptedQty) || 0, 0);
      const rejected = Math.max(num(ln.rejectedQty) || 0, 0);
      const arrived = accepted + rejected;
      if (arrived <= 0) continue;
      const remaining = item.qty - item.qty_received;
      if (arrived > remaining + item.qty * 0.1 + 1e-9) {
        return bad(res, `Line ${item.product_id}: arrived ${arrived} exceeds ordered remaining (${remaining})`);
      }
      plan.push({ item, accepted, rejected, ln });
    }

    db.exec('BEGIN');
    let done = false;
    try {
      for (const { item, accepted, rejected, ln } of plan) {
        const arrived = accepted + rejected;
        const score = (v) => Math.min(Math.max(Math.round(num(v)) || 3, 1), 5);
        const appearance = score(ln.appearance ?? 4);
        const firmness = score(ln.firmness ?? 4);
        const ripeness = score(ln.ripeness ?? 4);
        const damage = score(ln.damage ?? 2);
        const grade = ['A', 'B', 'C'].includes(ln.grade) ? ln.grade : gradeFromScores(appearance, firmness, ripeness, damage);

        if (accepted > 0) {
          const product = db.prepare('SELECT * FROM products WHERE id = ?').get(item.product_id);
          const batch = createBatch({
            product,
            supplierId: po.supplier_id,
            poId: po.id,
            origin: product.origin || '',
            receivedAt: now,
            qty: accepted,
            unitCostCents: item.unit_cost_cents,
            grade,
          });
          created.push(batch.code);
          db.prepare('UPDATE products SET stock_qty = stock_qty + ?, cost_cents = ? WHERE id = ?')
            .run(accepted, item.unit_cost_cents, product.id);
          db.prepare(`INSERT INTO inventory_log (product_id, change_qty, reason, note, created_at)
            VALUES (?, ?, 'restock', ?, ?)`).run(product.id, accepted, `Received against ${po.code}`, now);
          db.prepare(`INSERT INTO inspections
            (batch_id, inspector, appearance, firmness, ripeness, damage, temp_c, result, accepted_qty, rejected_qty, notes, created_at)
            VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`)
            .run(batch.id, body.inspector || 'Receiving Bay 1', appearance, firmness, ripeness, damage,
              ln.tempC ?? null, rejected > 0 ? 'partial' : 'pass', accepted, rejected, ln.notes || '', now);
        }
        db.prepare(`UPDATE po_items SET qty_received = qty_received + ?, qty_accepted = qty_accepted + ?, qty_rejected = qty_rejected + ?
          WHERE id = ?`).run(arrived, accepted, rejected, item.id);
      }

      const after = db.prepare('SELECT COUNT(*) AS open FROM po_items WHERE po_id = ? AND qty_received < qty * 0.999').get(params.id).open;
      done = after === 0;
      db.prepare('UPDATE purchase_orders SET status = ?, received_at = ? WHERE id = ?')
        .run(done ? 'completed' : 'receiving', done ? now : po.received_at, params.id);
      db.exec('COMMIT');
    } catch (e) {
      db.exec('ROLLBACK');
      throw e;
    }
    sendJSON(res, 200, { ok: true, batchesCreated: created, completed: done });
  });

  router.get('/suppliers/:id/performance', ({ res, params }) => {
    const sup = db.prepare('SELECT * FROM suppliers WHERE id = ?').get(params.id);
    if (!sup) return bad(res, 'Supplier not found', 404);
    const deliveries = db.prepare("SELECT COUNT(*) AS c FROM purchase_orders WHERE supplier_id = ? AND status = 'completed'").get(params.id).c;
    const onTimeRow = db.prepare(`
      SELECT COUNT(*) AS c FROM purchase_orders
      WHERE supplier_id = ? AND status='completed' AND received_at IS NOT NULL AND expected_date IS NOT NULL AND date(received_at) <= expected_date`).get(params.id).c;
    const vals = db.prepare(`
      SELECT COALESCE(SUM(qty_accepted),0) AS acc, COALESCE(SUM(qty_rejected),0) AS rej, COALESCE(SUM(qty_accepted * unit_cost_cents),0) AS valueCents
      FROM po_items poi JOIN purchase_orders po ON po.id = poi.po_id
      WHERE po.supplier_id = ? AND po.status IN ('completed','receiving')`).get(params.id);
    const quality = db.prepare(`
      SELECT AVG((i.appearance + i.firmness + i.ripeness + (5 - i.damage)) / 4.0) AS avgScore
      FROM inspections i JOIN batches b ON b.id = i.batch_id WHERE b.supplier_id = ?`).get(params.id).avgScore;
    const openPOs = db.prepare("SELECT COUNT(*) AS c FROM purchase_orders WHERE supplier_id = ? AND status = 'ordered'").get(params.id).c;
    const totalPOs = db.prepare('SELECT COUNT(*) AS c FROM purchase_orders WHERE supplier_id = ?').get(params.id).c;
    const since30 = new Date(Date.now() - 30 * 86400000).toISOString().slice(0, 19).replace('T', ' ');
    const w30 = db.prepare(`
      SELECT COALESCE(SUM(w.value_cents),0) AS v, COUNT(*) AS n
      FROM waste w JOIN batches b ON b.id = w.batch_id
      WHERE b.supplier_id = ? AND w.created_at >= ?`).get(params.id, since30);
    const recentPOs = db.prepare(`
      SELECT po.code, po.status,
        (SELECT COALESCE(SUM(qty),0) FROM po_items WHERE po_id = po.id) AS orderedQty,
        (SELECT COALESCE(SUM(qty_accepted),0) FROM po_items WHERE po_id = po.id) AS acceptedQty,
        (SELECT COALESCE(SUM(qty_rejected),0) FROM po_items WHERE po_id = po.id) AS rejectedQty,
        (SELECT COALESCE(SUM(qty_accepted*unit_cost_cents),0) FROM po_items WHERE po_id = po.id) AS valueCents
      FROM purchase_orders po WHERE po.supplier_id = ? ORDER BY po.id DESC LIMIT 8`).all(params.id);
    const worstProducts = db.prepare(`
      SELECT p.name AS productName, SUM(w.value_cents) AS valueCents
      FROM waste w JOIN batches b ON b.id = w.batch_id JOIN products p ON p.id = w.product_id
      WHERE b.supplier_id = ? AND w.created_at >= ? GROUP BY p.id ORDER BY valueCents DESC LIMIT 5`).all(params.id, since30);
    sendJSON(res, 200, {
      deliveries,
      onTimeDeliveries: onTimeRow,
      onTimePct: deliveries ? Math.round((onTimeRow / deliveries) * 100) : null,
      acceptedQty: vals.acc,
      rejectedQty: vals.rej,
      rejectionRatePct: vals.acc + vals.rej > 0 ? Math.round((vals.rej / (vals.acc + vals.rej)) * 1000) / 10 : null,
      acceptedValueCents: vals.valueCents,
      avgQualityPct: quality != null ? Math.round(quality * 20) : null,
      openPOs,
      totalPOs,
      completedPOs: deliveries,
      acceptanceRatePct: vals.acc + vals.rej > 0 ? Math.round((vals.acc / (vals.acc + vals.rej)) * 100) : 100,
      totalValueCents: vals.valueCents,
      wasteValueCents30d: w30.v,
      wasteEvents30d: w30.n,
      recentPOs,
      worstProducts,
    });
  });
}
