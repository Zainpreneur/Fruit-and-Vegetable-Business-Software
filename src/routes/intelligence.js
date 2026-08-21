import { db } from '../db.js';
import { sendJSON } from '../util.js';
import { lifeState, daysLeft } from '../domain.js';

export function registerIntelligenceRoutes(router) {
  router.get('/reports/kpis', ({ res, query }) => {
    const days = Math.min(parseInt(query.get('days') || '30', 10) || 30, 365);
    const sinceISO = new Date(Date.now() - days * 86400000).toISOString();
    const sinceDT = sinceISO.slice(0, 19).replace('T', ' ');

    const sales = db.prepare(`
      SELECT COALESCE(SUM(total_cents),0) AS revenueCents, COUNT(*) AS orders
      FROM sales WHERE status='completed' AND created_at >= ?`).get(sinceISO);
    const byChannel = db.prepare(`
      SELECT channel, SUM(total_cents) AS revenueCents, COUNT(*) AS orders
      FROM sales WHERE status='completed' AND created_at >= ? GROUP BY channel`).all(sinceISO);
    const profitRow = db.prepare(`
      SELECT CAST(ROUND(COALESCE(SUM(si.line_total_cents - si.qty * si.cost_cents),0)) AS INTEGER) AS v
      FROM sale_items si JOIN sales s ON s.id = si.sale_id
      WHERE s.status='completed' AND s.created_at >= ?`).get(sinceISO).v;
    const wasteAgg = db.prepare(
      'SELECT COALESCE(SUM(value_cents),0) AS v, COALESCE(SUM(qty),0) AS q, COUNT(*) AS events FROM waste WHERE created_at >= ?'
    ).get(sinceISO);
    const purchases = db.prepare(`
      SELECT COALESCE(SUM(i.qty_accepted * i.unit_cost_cents),0) AS v,
             COALESCE(SUM(i.qty_accepted),0) AS q
      FROM po_items i JOIN purchase_orders po ON po.id = i.po_id
      WHERE po.status='completed' AND po.received_at >= ?`).get(sinceDT);
    const stockValue = db.prepare("SELECT COALESCE(SUM(qty_remaining*unit_cost_cents),0) AS v FROM batches WHERE status IN ('available','quarantined')").get().v;
    const expSoon = db.prepare(`
      SELECT COUNT(*) AS n, COALESCE(SUM(qty_remaining*unit_cost_cents),0) AS v FROM batches
      WHERE status IN ('available','quarantined') AND expiry_date <= datetime('now', '+3 days')`).get();
    const expiredStock = db.prepare(`
      SELECT COUNT(*) AS n, COALESCE(SUM(qty_remaining*unit_cost_cents),0) AS v FROM batches
      WHERE status='available' AND expiry_date < datetime('now')`).get();

    sendJSON(res, 200, {
      days,
      revenueCents: sales.revenueCents,
      orders: sales.orders,
      grossProfitCents: profitRow.v,
      marginPct: sales.revenueCents ? Math.round((profitRow.v / sales.revenueCents) * 1000) / 10 : null,
      byChannel,
      wasteValueCents: wasteAgg.v,
      wasteQty: wasteAgg.q,
      wasteEvents: wasteAgg.events,
      spoilageRatePct: purchases.q > 0 ? Math.round((wasteAgg.q / purchases.q) * 1000) / 10 : null,
      purchaseValueCents: purchases.v,
      stockValueCents: stockValue,
      expiringSoonCount: expSoon.n,
      expiringSoonValueCents: expSoon.v,
      expiredStillInStockCount: expiredStock.n,
      expiredStillInStockValueCents: expiredStock.v,
      freshYieldPct: purchases.v > 0 ? Math.round(((purchases.v - wasteAgg.v) / purchases.v) * 1000) / 10 : null,
    });
  });

  router.get('/agents/executive-brief', ({ res }) => {
    const now = Date.now();
    const startOfToday = new Date(); startOfToday.setHours(0, 0, 0, 0);
    const today = db.prepare("SELECT COALESCE(SUM(total_cents),0) AS v, COUNT(*) AS n FROM sales WHERE status='completed' AND created_at >= ?")
      .get(startOfToday.toISOString());
    const weekAvg = db.prepare(`
      SELECT AVG(daily) AS v FROM (
        SELECT date(created_at) AS d, SUM(total_cents) AS daily FROM sales
        WHERE status='completed' AND created_at >= datetime('now','-7 days') GROUP BY d)`).get().v;
    const urgent = db.prepare(`
      SELECT b.code, p.name, p.emoji, b.qty_remaining, p.unit, b.expiry_date
      FROM batches b JOIN products p ON p.id=b.product_id
      WHERE b.status='available' AND b.expiry_date <= datetime('now','+2 days')
      ORDER BY b.expiry_date ASC LIMIT 5`).all();
    const lowStock = db.prepare(`
      SELECT name, emoji, stock_qty AS stockQty, reorder_level AS reorderLevel, unit
      FROM products WHERE active=1 AND stock_qty <= reorder_level ORDER BY stock_qty LIMIT 5`).all();
    const wasteTop = db.prepare(`
      SELECT p.name, SUM(w.value_cents) AS v FROM waste w JOIN products p ON p.id=w.product_id
      WHERE w.created_at >= datetime('now','-7 days') GROUP BY w.product_id ORDER BY v DESC LIMIT 1`).get();
    const breachZones = db.prepare(`SELECT z.name, z.min_temp, z.max_temp,
      (SELECT temp_c FROM temperature_readings r WHERE r.zone_id=z.id ORDER BY recorded_at DESC LIMIT 1) AS lastTemp
      FROM zones z WHERE z.min_temp IS NOT NULL AND (
        (SELECT temp_c FROM temperature_readings r WHERE r.zone_id=z.id ORDER BY recorded_at DESC LIMIT 1) > z.max_temp OR
        (SELECT temp_c FROM temperature_readings r WHERE r.zone_id=z.id ORDER BY recorded_at DESC LIMIT 1) < z.min_temp)`).all();
    const receivable = db.prepare(`
      SELECT COALESCE(SUM(s.total_cents),0) - COALESCE((SELECT SUM(amount_cents) FROM payments),0) AS v
      FROM sales s WHERE s.status='completed' AND s.payment_method='invoice' AND s.channel IN ('b2b','subscription')`).get().v;
    const paidTotal = db.prepare('SELECT COALESCE(SUM(amount_cents),0) AS v FROM payments').get().v;

    const actions = [];
    if (urgent.length) actions.push(`Prioritize or discount ${urgent.length} urgent batch(es): ${urgent.map((u) => u.name).join(', ')}.`);
    if (lowStock.length) actions.push(`Reorder ${lowStock.length} item(s) at/below reorder level.`);
    if (breachZones.length) actions.push(`Cold-chain breach in ${breachZones.map((b) => b.name).join(', ')} — inspect immediately.`);
    if (wasteTop && wasteTop.v > 0) actions.push(`${wasteTop.name} generated the most waste this week (${(wasteTop.v / 100).toFixed(2)} USD) — review purchase frequency.`);

    sendJSON(res, 200, {
      generatedAt: new Date(now).toISOString(),
      todayRevenueCents: today.v,
      todayOrders: today.n,
      weekAvgDailyCents: weekAvg ? Math.round(weekAvg) : 0,
      receivableCents: receivable - paidTotal,
      urgentBatches: urgent,
      lowStock,
      coldChainBreaches: breachZones,
      recommendedActions: actions,
    });
  });

  router.get('/agents/procurement', ({ res }) => {
    const rows = db.prepare(`
      SELECT p.*, c.name AS categoryName FROM products p LEFT JOIN categories c ON c.id=p.category_id
      WHERE p.active = 1 ORDER BY (p.stock_qty - p.reorder_level) ASC`).all();
    const suggestions = [];
    for (const p of rows) {
      const subDemand = db.prepare(`
        SELECT COALESCE(SUM(json_extract(j.value,'$.qty')),0) AS q FROM subscriptions su, json_each(su.items_json) j
        WHERE su.active=1 AND CAST(json_extract(j.value,'$.productId') AS INTEGER)=?
          AND su.next_run <= date('now','+' || ? || ' days')`).get(p.id, Math.min(p.shelf_life_days, 14)).q;
      const need = p.stock_qty + subDemand < p.reorder_level * 1.5;
      if (!need || p.reorder_level <= 0) continue;
      const suggestQty = Math.max(Math.ceil((p.reorder_level * 2 - p.stock_qty - subDemand) * 10) / 10, 1);
      let lastCost = p.cost_cents;
      let supplierId = p.supplier_id;
      const lastBuy = db.prepare(`
        SELECT i.unit_cost_cents AS c, po.supplier_id AS sid, s.name AS supplierName
        FROM po_items i JOIN purchase_orders po ON po.id=i.po_id JOIN suppliers s ON s.id=po.supplier_id
        WHERE i.product_id=? AND po.status='completed' ORDER BY po.received_at DESC LIMIT 1`).get(p.id);
      if (lastBuy) { lastCost = lastBuy.c; supplierId = lastBuy.sid; }
      suggestions.push({
        productId: p.id,
        productName: p.name,
        emoji: p.emoji,
        unit: p.unit,
        stockQty: p.stock_qty,
        reorderLevel: p.reorder_level,
        subscriptionDemand: subDemand,
        suggestQty,
        unitCostCents: lastCost,
        supplierId,
        reason: subDemand > 0 ? `Low stock plus ${subDemand} ${p.unit} subscribed demand` : 'Below reorder threshold',
      });
    }
    sendJSON(res, 200, { suggestions });
  });

  router.get('/agents/perishability', ({ res }) => {
    const rows = db.prepare(`
      SELECT b.*, p.name AS productName, p.emoji, p.unit
      FROM batches b JOIN products p ON p.id=b.product_id
      WHERE b.status='available' AND b.expiry_date <= datetime('now', '+4 days')
      ORDER BY b.expiry_date ASC`).all();
    const now = Date.now();
    const items = rows.map((b) => {
      const state = lifeState(b, now);
      const dl = Math.ceil((new Date(b.expiry_date).getTime() - now) / 86400000);
      let action = 'monitor';
      let suggestedDiscount = 0;
      if (state === 'expired') action = 'dispose';
      else if (dl <= 1) { action = 'discount'; suggestedDiscount = 50; }
      else if (dl <= 2) { action = 'discount'; suggestedDiscount = 35; }
      else if (state === 'urgent') { action = 'discount'; suggestedDiscount = 25; }
      else action = 'bundle';
      return {
        batchId: b.id, code: b.code, productName: b.productName, emoji: b.emoji, unit: b.unit,
        qtyRemaining: b.qty_remaining, expiryDate: b.expiry_date, daysLeft: dl, state,
        valueCents: Math.round(b.qty_remaining * b.unit_cost_cents),
        currentDiscountPct: b.discount_pct,
        action,
        suggestedDiscountPct: suggestedDiscount,
        rationale:
          state === 'expired' ? 'Past best-use date; dispose to protect quality reputation.'
            : dl <= 1 ? 'Expires within a day; steep markdown to move stock.'
              : dl <= 2 ? 'Approaching expiry; meaningful markdown recommended.'
                : state === 'urgent' ? 'Shelf life mostly consumed; prioritize in picking.'
                  : 'Slower mover nearing mid-life; bundle with fast movers.',
      };
    });
    sendJSON(res, 200, { recommendations: items });
  });
}
