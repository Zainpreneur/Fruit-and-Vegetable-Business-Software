import { db } from '../db.js';
import { sendJSON, bad, readJSON } from '../util.js';

export function registerPeopleRoutes(router) {
  router.get('/customers', ({ res }) => {
    const rows = db.prepare(`
      SELECT c.id, c.name, c.phone, c.email, c.notes, c.created_at AS createdAt,
        (SELECT COUNT(*) FROM sales s WHERE s.customer_id = c.id AND s.status = 'completed') AS orderCount,
        (SELECT COALESCE(SUM(s.total_cents), 0) FROM sales s WHERE s.customer_id = c.id AND s.status = 'completed') AS totalSpentCents
      FROM customers c ORDER BY totalSpentCents DESC, c.name`).all();
    sendJSON(res, 200, rows);
  });

  router.post('/customers', async ({ req, res }) => {
    const b = await readJSON(req);
    if (!b.name?.trim()) return bad(res, 'Customer name is required');
    const r = db.prepare('INSERT INTO customers (name, phone, email, notes, created_at) VALUES (?, ?, ?, ?, ?)')
      .run(b.name.trim(), b.phone || '', b.email || '', b.notes || '', new Date().toISOString());
    sendJSON(res, 201, { id: Number(r.lastInsertRowid) });
  });

  router.put('/customers/:id', async ({ req, res, params }) => {
    const b = await readJSON(req);
    if (!b.name?.trim()) return bad(res, 'Customer name is required');
    const r = db.prepare('UPDATE customers SET name = ?, phone = ?, email = ?, notes = ? WHERE id = ?')
      .run(b.name.trim(), b.phone || '', b.email || '', b.notes || '', params.id);
    if (!r.changes) return bad(res, 'Customer not found', 404);
    sendJSON(res, 200, { ok: true });
  });

  router.del('/customers/:id', ({ res, params }) => {
    const orders = db.prepare("SELECT COUNT(*) AS c FROM sales WHERE customer_id = ?").get(params.id).c;
    if (orders > 0) return bad(res, `Cannot delete: customer has ${orders} order(s) on file`);
    const r = db.prepare('DELETE FROM customers WHERE id = ?').run(params.id);
    if (!r.changes) return bad(res, 'Customer not found', 404);
    sendJSON(res, 200, { ok: true });
  });

  router.get('/suppliers', ({ res }) => {
    const rows = db.prepare(`
      SELECT s.id, s.name, s.contact_name AS contactName, s.phone, s.email, s.created_at AS createdAt,
        (SELECT COUNT(*) FROM products p WHERE p.supplier_id = s.id AND p.active = 1) AS productCount
      FROM suppliers s ORDER BY s.name`).all();
    sendJSON(res, 200, rows);
  });

  router.post('/suppliers', async ({ req, res }) => {
    const b = await readJSON(req);
    if (!b.name?.trim()) return bad(res, 'Supplier name is required');
    try {
      const r = db.prepare('INSERT INTO suppliers (name, contact_name, phone, email, created_at) VALUES (?, ?, ?, ?, ?)')
        .run(b.name.trim(), b.contactName || '', b.phone || '', b.email || '', new Date().toISOString());
      sendJSON(res, 201, { id: Number(r.lastInsertRowid) });
    } catch {
      bad(res, 'Supplier name already exists', 409);
    }
  });

  router.put('/suppliers/:id', async ({ req, res, params }) => {
    const b = await readJSON(req);
    if (!b.name?.trim()) return bad(res, 'Supplier name is required');
    const r = db.prepare('UPDATE suppliers SET name = ?, contact_name = ?, phone = ?, email = ? WHERE id = ?')
      .run(b.name.trim(), b.contactName || '', b.phone || '', b.email || '', params.id);
    if (!r.changes) return bad(res, 'Supplier not found', 404);
    sendJSON(res, 200, { ok: true });
  });

  router.del('/suppliers/:id', ({ res, params }) => {
    const linked = db.prepare('SELECT COUNT(*) AS c FROM products WHERE supplier_id = ?').get(params.id).c;
    if (linked > 0) return bad(res, `Cannot delete: ${linked} product(s) are supplied by them`);
    const r = db.prepare('DELETE FROM suppliers WHERE id = ?').run(params.id);
    if (!r.changes) return bad(res, 'Supplier not found', 404);
    sendJSON(res, 200, { ok: true });
  });
}
