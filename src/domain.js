import { db, nextCode } from './db.js';

export const DAY = 86400000;
export const GRADE_MULT = { A: 1, B: 0.85, C: 0.7 };
export const WASTE_REASONS = [
  'overripe', 'bruised', 'rotten', 'temp_damage', 'handling_damage',
  'pest_damage', 'expired', 'quality_rejection', 'processing_loss', 'unknown',
];

export function lifeState(batch, now = Date.now()) {
  if (batch.status === 'quarantined') return 'quarantined';
  if (batch.status === 'disposed') return 'disposed';
  if (batch.status === 'depleted') return 'depleted';
  const exp = new Date(batch.expiry_date).getTime();
  const rec = new Date(batch.received_at).getTime();
  const left = exp - now;
  if (left <= 0) return 'expired';
  const total = Math.max(exp - rec, DAY);
  const pct = left / total;
  if (pct < 0.25 || left <= 2 * DAY) return 'urgent';
  if (pct < 0.55) return 'aging';
  return 'fresh';
}

export function daysLeft(batch, now = Date.now()) {
  return Math.ceil((new Date(batch.expiry_date).getTime() - now) / DAY);
}

export function gradeFromScores(appearance, firmness, ripeness, damage) {
  const avg = (appearance + firmness + ripeness + (5 - damage)) / 4;
  if (avg >= 4.2) return 'A';
  if (avg >= 3) return 'B';
  return 'C';
}

function zoneIdForType(type) {
  if (!type) return null;
  const row = db.prepare('SELECT id FROM zones WHERE type = ? ORDER BY id LIMIT 1').get(type);
  return row ? row.id : null;
}

export function createBatch({ product, supplierId = null, poId = null, origin = '', harvestDate = null, receivedAt = new Date(), qty, unitCostCents, grade = 'A' }) {
  const receivedIso = new Date(receivedAt).toISOString();
  const expiryIso = new Date(new Date(receivedAt).getTime() + (product.shelf_life_days || 7) * DAY).toISOString();
  const code = nextCode('BT', 'batches');
  const res = db.prepare(`INSERT INTO batches
    (code, product_id, supplier_id, po_id, origin, harvest_date, received_at, expiry_date, storage_zone_id, grade, qty_initial, qty_remaining, unit_cost_cents, status, created_at)
    VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, 'available', ?)`)
    .run(code, product.id, supplierId, poId, origin, harvestDate, receivedIso, expiryIso,
      zoneIdForType(product.storage_req), grade, qty, qty, unitCostCents, receivedIso);
  return { id: Number(res.lastInsertRowid), code };
}

export function allocateFEFO(productId, qty) {
  const now = Date.now();
  const rows = pickableBatches(productId, now);
  let need = qty;
  const picks = [];
  for (const b of rows) {
    if (need <= 1e-9) break;
    const take = Math.min(b.qty_remaining, need);
    picks.push({ batch: b, qty: Math.round(take * 100) / 100 });
    need -= take;
  }
  return { picks, shortfall: Math.round(need * 100) / 100 };
}

function pickableBatches(productId, now) {
  return db
    .prepare(`SELECT * FROM batches
      WHERE product_id = ? AND status = 'available' AND qty_remaining > 0
      ORDER BY expiry_date ASC, id ASC`)
    .all(productId)
    .filter((b) => new Date(b.expiry_date).getTime() > now);
}

export function consumeFEFO(productId, qty) {
  const { picks, shortfall } = allocateFEFO(productId, qty);
  if (shortfall > 1e-9) return { picks, shortfall };
  const decBatch = db.prepare(
    `UPDATE batches SET qty_remaining = qty_remaining - ?,
       status = CASE WHEN qty_remaining - ? <= 0.0001 THEN 'depleted' ELSE status END
     WHERE id = ?`
  );
  for (const p of picks) decBatch.run(p.qty, p.qty, p.batch.id);
  db.prepare('UPDATE products SET stock_qty = MAX(0, stock_qty - ?) WHERE id = ?').run(qty, productId);
  return { picks, shortfall: 0 };
}
