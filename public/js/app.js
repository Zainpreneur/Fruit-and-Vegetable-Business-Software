const $ = (s, el = document) => el.querySelector(s);
const $$ = (s, el = document) => [...el.querySelectorAll(s)];

let settings = { taxRate: 5, storeName: 'GreenBasket' };
const cart = new Map();
const posFilter = { q: '', categoryId: null };
let prodFilters = { q: '', categoryId: '', status: 'active' };
let invFilters = { q: '', lowOnly: false };
let orderFilters = { from: '', to: '', status: '' };
let reportDays = 30;

const esc = (s) =>
  String(s ?? '').replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
const money = (c) =>
  new Intl.NumberFormat('en-US', { style: 'currency', currency: 'USD' }).format((c || 0) / 100);
const fmtQty = (q) => String(Number(Number(q || 0).toFixed(2)));
const fmtDate = (iso) =>
  new Date(iso).toLocaleString(undefined, { month: 'short', day: 'numeric', hour: '2-digit', minute: '2-digit' });

function debounce(fn, ms = 250) {
  let t;
  return (...a) => {
    clearTimeout(t);
    t = setTimeout(() => fn(...a), ms);
  };
}

async function api(path, opts = {}) {
  const res = await fetch('/api' + path, {
    headers: { 'Content-Type': 'application/json' },
    ...opts,
  });
  if (!res.ok) {
    let msg = res.statusText;
    try {
      msg = (await res.json()).error || msg;
    } catch {}
    throw new Error(msg);
  }
  if (res.status === 204) return null;
  return res.json();
}

function toast(msg, isError = false) {
  const t = document.createElement('div');
  t.className = 'toast' + (isError ? ' error' : '');
  t.textContent = msg;
  $('#toasts').appendChild(t);
  setTimeout(() => t.remove(), 3800);
}

function openModal(html, wide = false) {
  const m = $('#modal');
  $('#modal-content').innerHTML = html;
  m.classList.toggle('wide', wide);
  m.showModal();
}
function closeModal() {
  $('#modal').close();
}

function modalShell(title, body, footHtml = '') {
  return `
    <div class="modal-head"><h2>${title}</h2><button class="modal-close" data-close>✕</button></div>
    <div>${body}</div>
    ${footHtml ? `<div class="modal-actions">${footHtml}</div>` : ''}`;
}

function bindModalClose(root) {
  root.querySelectorAll('[data-close]').forEach((b) => (b.onclick = closeModal));
}

function dayBounds(val, end = false) {
  if (!val) return '';
  return new Date(`${val}T${end ? '23:59:59.999' : '00:00:00'}`).toISOString();
}

function statusBadge(s) {
  return s === 'completed'
    ? '<span class="badge green">Completed</span>'
    : '<span class="badge gray">Refunded</span>';
}
function payBadge(p) {
  const cls = { cash: 'green', card: 'blue', mobile: 'amber' }[p] || 'gray';
  return `<span class="badge ${cls}">${esc(p)}</span>`;
}
function stockBadge(p) {
  if (p.stockQty <= 0) return '<span class="badge red">Out of stock</span>';
  if (p.stockQty <= p.reorderLevel) return '<span class="badge amber">Low · ' + fmtQty(p.stockQty) + '</span>';
  return '<span class="badge green">' + fmtQty(p.stockQty) + ' in stock</span>';
}

function receiptHTML(s) {
  const d = new Date(s.createdAt);
  const rows = (s.items || [])
    .map(
      (i) => `<tr>
        <td>${esc(i.productName)}<br><span class="small muted">${fmtQty(i.qty)} × ${money(i.unitPriceCents)}</span></td>
        <td class="right">${money(i.lineTotalCents)}</td></tr>`
    )
    .join('');
  const cust = s.customerName ? `<div>Customer: ${esc(s.customerName)}</div>` : '<div>Customer: Walk-in</div>';
  return `<div class="receipt">
    <div class="rc-center"><strong>${esc(settings.storeName)}</strong><br>Fresh Fruits &amp; Vegetables<br>${esc(d.toLocaleString())}<br>Order #${s.id}</div>
    <hr>
    ${cust}<div>Cashier: Front counter</div>
    <hr>
    <table>${rows}</table>
    <hr>
    <table>
      <tr><td>Subtotal</td><td class="right">${money(s.subtotal_cents)}</td></tr>
      ${s.discount_cents ? `<tr><td>Discount (${fmtQty(s.discount_pct)}%)</td><td class="right">-${money(s.discount_cents)}</td></tr>` : ''}
      <tr><td>Tax (${settings.taxRate}%)</td><td class="right">${money(s.tax_cents)}</td></tr>
      <tr class="r-total"><td>TOTAL</td><td class="right">${money(s.total_cents)}</td></tr>
      <tr><td>Paid via</td><td class="right">${esc(s.payment_method)}</td></tr>
      ${s.status === 'refunded' ? '<tr><td colspan="2" class="r-total rc-center">*** REFUNDED ***</td></tr>' : ''}
    </table>
    <hr>
    <div class="rc-center small">Thank you for shopping fresh! 🥬</div>
  </div>`;
}

function openReceipt(sale) {
  openModal(
    modalShell(
      `Order #${sale.id}`,
      receiptHTML(sale),
      `<button class="btn" data-close>Close</button><button class="btn primary" id="print-btn">🖨 Print</button>`
    )
  );
  bindModalClose($('#modal-content'));
  $('#print-btn').onclick = () => {
    $('#print-area').innerHTML = receiptHTML(sale);
    window.print();
  };
}
window.addEventListener('afterprint', () => ($('#print-area').innerHTML = ''));

let chartBars = [];
function drawChart(canvas, series) {
  const dpr = window.devicePixelRatio || 1;
  const W = canvas.clientWidth || 600;
  const H = canvas.clientHeight || 240;
  canvas.width = W * dpr;
  canvas.height = H * dpr;
  const ctx = canvas.getContext('2d');
  ctx.scale(dpr, dpr);
  ctx.clearRect(0, 0, W, H);
  const padL = 6, padR = 6, padT = 24, padB = 26;
  const max = Math.max(...series.map((s) => s.revenueCents), 100);
  const n = series.length;
  const slot = (W - padL - padR) / n;
  const bw = Math.min(slot * 0.62, 38);
  chartBars = [];
  series.forEach((s, i) => {
    const h = (H - padT - padB) * (s.revenueCents / max);
    const x = padL + slot * i + (slot - bw) / 2;
    const y = H - padB - h;
    const r = Math.min(5, bw / 2);
    ctx.beginPath();
    ctx.moveTo(x, y + h);
    ctx.lineTo(x, y + r);
    ctx.arcTo(x, y, x + r, y, r);
    ctx.lineTo(x + bw - r, y);
    ctx.arcTo(x + bw, y, x + bw, y + r, r);
    ctx.lineTo(x + bw, y + h);
    ctx.closePath();
    ctx.fillStyle = '#2e7d4f';
    ctx.fill();
    chartBars.push({ x, y, w: bw, h, cx: x + bw / 2, s });
    if (i % 2 === 0 || n <= 10) {
      ctx.fillStyle = '#6b7a70';
      ctx.font = '11px sans-serif';
      ctx.textAlign = 'center';
      ctx.fillText(s.label, x + bw / 2, H - 8);
    }
  });
}

function bindChartHover(canvas) {
  const tip = $('#chart-tip');
  canvas.onmousemove = (e) => {
    const rect = canvas.getBoundingClientRect();
    const mx = e.clientX - rect.left;
    const bar = chartBars.find((b) => mx >= b.x - 4 && mx <= b.x + b.w + 4);
    if (!bar) return void (tip.style.display = 'none');
    tip.style.display = 'block';
    tip.style.left = bar.cx + 'px';
    tip.style.top = bar.y + 'px';
    tip.textContent = `${bar.s.date.slice(5)} · ${money(bar.s.revenueCents)}`;
  };
  canvas.onmouseleave = () => (tip.style.display = 'none');
}

const ROUTES = {};

ROUTES.dashboard = ['Dashboard', async (el) => {
  el.innerHTML = '<div class="empty">Loading…</div>';
  const d = await api('/reports/dashboard');
  el.innerHTML = `
    <div class="grid-cards">
      <div class="card stat"><div class="stat-label">Today's Revenue</div><div class="stat-value">${money(d.todayRevenueCents)}</div><div class="stat-sub">${d.todayOrders} order${d.todayOrders === 1 ? '' : 's'} today</div></div>
      <div class="card stat"><div class="stat-label">This Month</div><div class="stat-value">${money(d.monthRevenueCents)}</div><div class="stat-sub">${d.monthOrders} orders · avg ${money(d.avgOrderCents)}</div></div>
      <div class="card stat"><div class="stat-label">Low Stock</div><div class="stat-value">${d.lowStockCount}</div><div class="stat-sub">items at or below reorder level</div></div>
      <div class="card stat"><div class="stat-label">Catalog</div><div class="stat-value">${d.productCount}</div><div class="stat-sub">${d.customerCount} registered customers</div></div>
    </div>
    <div class="dash-grid">
      <div class="panel-stack">
        <div class="card chart-wrap"><h2>Revenue · last 14 days</h2><canvas id="chart" height="240"></canvas><div id="chart-tip"></div></div>
        <div class="card"><div class="card-head"><h2>Recent Orders</h2><a href="#/orders" class="btn sm">View all</a></div>
          <table class="tbl"><thead><tr><th>#</th><th>When</th><th>Customer</th><th>Items</th><th>Total</th><th>Status</th></tr></thead>
          <tbody>${d.recentOrders.map((o) => `
            <tr style="cursor:pointer" onclick="location.hash='/orders'">
              <td><strong>#${o.id}</strong></td><td class="muted">${fmtDate(o.createdAt)}</td>
              <td>${o.customerName ? esc(o.customerName) : '<span class="muted">Walk-in</span>'}</td>
              <td>${o.itemCount}</td><td class="num"><strong>${money(o.totalCents)}</strong></td><td>${statusBadge(o.status)}</td>
            </tr>`).join('')}</tbody></table>
        </div>
      </div>
      <div class="card">
        <div class="card-head"><h2>⚠️ Low Stock</h2><a href="#/inventory" class="btn sm">Inventory</a></div>
        ${d.lowStock.length ? `<ul class="alert-list">${d.lowStock.map((p) => `
          <li><span style="font-size:22px">${esc(p.emoji) || '📦'}</span>
            <div class="al-name">${esc(p.name)}<div class="al-sub">reorder at ${fmtQty(p.reorderLevel)} ${esc(p.unit)}</div></div>
            ${p.stockQty <= 0 ? '<span class="badge red">Out</span>' : '<span class="badge amber">' + fmtQty(p.stockQty) + ' left</span>'}
          </li>`).join('')}</ul>` : '<p class="muted">Everything is well stocked ✅</p>'}
      </div>
    </div>`;
  drawChart($('#chart'), d.series);
  bindChartHover($('#chart'));
}];

async function posFetch() {
  const qs = posFilter.q ? '?q=' + encodeURIComponent(posFilter.q) : '';
  return api('/products' + qs);
}

function renderPosTiles(products) {
  const wrap = $('#pos-tiles');
  if (!wrap) return;
  let list = products;
  if (posFilter.categoryId) list = list.filter((p) => p.categoryId === posFilter.categoryId);
  wrap.innerHTML =
    list.length === 0
      ? '<p class="muted" style="grid-column:1/-1;text-align:center;padding:24px 0">No products match.</p>'
      : list
          .map((p) => {
            const out = p.stockQty <= 0;
            return `<div class="ptile ${out ? 'out' : ''}" data-add="${p.id}">
              <div class="pemoji">${esc(p.emoji) || '🛒'}</div>
              <div class="pname">${esc(p.name)}</div>
              <div class="pprice">${money(p.priceCents)} / ${esc(p.unit)}</div>
              <div class="pstock ${out ? 'badge red' : p.stockQty <= p.reorderLevel ? 'badge amber' : 'badge green'}">${out ? 'Out of stock' : fmtQty(p.stockQty) + ' available'}</div>
            </div>`;
          })
          .join('');
  $$('#pos-tiles [data-add]').forEach((t) =>
    (t.onclick = () => {
      const p = products.find((x) => x.id === Number(t.dataset.add));
      if (!p || p.stockQty <= 0) return;
      const cur = cart.get(p.id);
      const next = (cur?.qty || 0) + 1;
      if (next > p.stockQty + 1e-9) return toast(`Only ${fmtQty(p.stockQty)} ${p.unit} of ${p.name} left`, true);
      cart.set(p.id, { product: p, qty: next });
      renderCartPanel();
    })
  );
}

function renderCartPanel() {
  const panel = $('#cart-panel');
  if (!panel) return;
  const lines = [...cart.values()];
  const subtotal = lines.reduce((a, l) => a + Math.round(l.qty * l.product.priceCents), 0);
  const pctEl = $('#cart-discount');
  const pct = Math.min(Math.max(Number(pctEl?.value) || 0, 0), 100);
  const disc = Math.round((subtotal * pct) / 100);
  const tax = Math.round(((subtotal - disc) * settings.taxRate) / 100);
  const total = subtotal - disc + tax;

  panel.innerHTML = `
    <div class="flex"><h2 style="margin:0;font-size:16px" class="grow">🛒 Current Sale</h2>
      ${lines.length ? '<button class="btn sm ghost" id="cart-clear">Clear</button>' : ''}</div>
    <div class="cart-items">${
      lines.length === 0
        ? '<div class="cart-empty">Tap products to add them<br>to the sale 👈</div>'
        : lines
            .map(({ product: p, qty }) => `
      <div class="cart-line">
        <div><span class="cl-name">${esc(p.emoji)} ${esc(p.name)}</span><br>
          <span class="cl-price">${money(p.priceCents)} / ${esc(p.unit)}</span></div>
        <div class="cl-total">${money(Math.round(qty * p.priceCents))}</div>
        <div class="qty-controls">
          <button data-dec="${p.id}">−</button>
          <input type="number" data-qty="${p.id}" value="${qty}" min="0" step="${p.unit === 'kg' ? 0.25 : 1}">
          <button data-inc="${p.id}">＋</button>
          <button data-rm="${p.id}" title="Remove">✕</button>
        </div>
      </div>`)
            .join('')
    }</div>
    <div class="form-row"><label>Discount %</label>
      <input type="number" id="cart-discount" class="field" min="0" max="100" value="${pct}"></div>
    <div class="form-row"><label>Customer</label>
      <select id="cart-customer" class="field"><option value="">Walk-in customer</option>${
        (posCustomers || []).map((c) => `<option value="${c.id}">${esc(c.name)}</option>`).join('')
      }</select></div>
    <div class="form-row"><label>Payment</label>
      <select id="cart-pay" class="field">
        <option value="cash">💵 Cash</option><option value="card">💳 Card</option><option value="mobile">📱 Mobile</option>
      </select></div>
    <div class="cart-sums">
      <div class="row"><span>Subtotal</span><span>${money(subtotal)}</span></div>
      <div class="row"><span>Discount</span><span>−${money(disc)}</span></div>
      <div class="row"><span>Tax (${settings.taxRate}%)</span><span>${money(tax)}</span></div>
      <div class="row total"><span>Total</span><span>${money(total)}</span></div>
      <button class="btn primary block mt" id="checkout" ${lines.length ? '' : 'disabled'}>✓ Complete Sale · ${money(total)}</button>
    </div>`;

  panel.querySelector('#cart-clear')?.addEventListener('click', () => {
    cart.clear();
    renderCartPanel();
  });
  panel.querySelector('#cart-discount').addEventListener('input', () => renderCartPanel());
  panel.querySelectorAll('[data-inc]').forEach((b) => (b.onclick = () => bumpQty(Number(b.dataset.inc), 0.5)));
  panel.querySelectorAll('[data-dec]').forEach((b) => (b.onclick = () => bumpQty(Number(b.dataset.dec), -0.5)));
  panel.querySelectorAll('[data-rm]').forEach((b) => (b.onclick = () => {
    cart.delete(Number(b.dataset.rm));
    renderCartPanel();
  }));
  panel.querySelectorAll('[data-qty]').forEach((inp) =>
    (inp.onchange = () => {
      const item = cart.get(Number(inp.dataset.qty));
      let v = Number(inp.value);
      if (!Number.isFinite(v) || v <= 0) v = 1;
      if (v > item.product.stockQty + 1e-9) {
        v = item.product.stockQty;
        toast(`Stock limited to ${fmtQty(v)} ${item.product.unit}`, true);
      }
      item.qty = Math.round(v * 100) / 100;
      renderCartPanel();
    })
  );
  const custSel = panel.querySelector('#cart-customer');
  custSel.value = selectedCustomerId ?? '';
  custSel.onchange = () => (selectedCustomerId = custSel.value ? Number(custSel.value) : null);

  panel.querySelector('#checkout')?.addEventListener('click', async () => {
    const btn = $('#checkout');
    btn.disabled = true;
    btn.textContent = 'Processing…';
    try {
      const payload = {
        items: [...cart.values()].map(({ product, qty }) => ({ productId: product.id, qty })),
        customerId: selectedCustomerId || null,
        discountPct: Number($('#cart-discount').value) || 0,
        paymentMethod: $('#cart-pay').value,
      };
      const sale = await api('/sales', { method: 'POST', body: JSON.stringify(payload) });
      cart.clear();
      selectedCustomerId = null;
      toast(`Order #${sale.id} completed · ${money(sale.total_cents)}`);
      bootPos(true);
      openReceipt({ ...sale, customerName: posCustomers.find((c) => c.id === sale.customer_id)?.name });
    } catch (e) {
      toast(e.message, true);
      renderCartPanel();
      bootPos(true);
    }
  });
}

function bumpQty(pid, delta) {
  const item = cart.get(pid);
  if (!item) return;
  let v = item.qty + delta;
  if (v <= 0) {
    cart.delete(pid);
    return renderCartPanel();
  }
  if (v > item.product.stockQty + 1e-9) {
    v = item.product.stockQty;
    toast(`Stock limited to ${fmtQty(v)} ${item.product.unit}`, true);
  }
  item.qty = Math.round(v * 100) / 100;
  renderCartPanel();
}

let posProducts = [];
let posCategories = [];
let posCustomers = [];
let selectedCustomerId = null;

async function bootPos(skipData = false) {
  const tiles = $('#pos-tiles');
  if (!tiles) return;
  if (!skipData) {
    [posCategories, posCustomers] = await Promise.all([api('/categories'), api('/customers')]);
  }
  posProducts = await posFetch();
  renderPosTiles(posProducts);
  renderCartPanel();
}

ROUTES.pos = ['New Sale', async (el) => {
  el.innerHTML = `
    <div class="pos-layout">
      <div class="pos-products">
        <div class="toolbar">
          <input type="search" id="pos-q" placeholder="🔍 Search products…" value="${esc(posFilter.q)}">
        </div>
        <div class="chips" id="pos-chips"></div>
        <div class="product-tiles" id="pos-tiles"></div>
      </div>
      <aside class="cart-panel" id="cart-panel"></aside>
    </div>`;
  await bootPos(false);
  const chips = $('#pos-chips');
  chips.innerHTML =
    `<button class="chip ${posFilter.categoryId ? '' : 'active'}" data-cat="">All</button>` +
    posCategories
      .map(
        (c) =>
          `<button class="chip ${posFilter.categoryId === c.id ? 'active' : ''}" data-cat="${c.id}">${esc(c.emoji)} ${esc(c.name)}</button>`
      )
      .join('');
  $$('#pos-chips .chip').forEach((ch) =>
    (ch.onclick = () => {
      posFilter.categoryId = ch.dataset.cat ? Number(ch.dataset.cat) : null;
      $$('#pos-chips .chip').forEach((x) => x.classList.toggle('active', x === ch));
      renderPosTiles(posProducts);
    })
  );
  $('#pos-q').addEventListener(
    'input',
    debounce(async (e) => {
      posFilter.q = e.target.value;
      posProducts = await posFetch();
      renderPosTiles(posProducts);
    })
  );
}];

async function productForm(existing) {
  const [cats, sups] = await Promise.all([api('/categories'), api('/suppliers')]);
  const isEdit = !!existing;
  const body = `
    <form id="pf">
      <div class="form-cols">
        <div class="form-row"><label>Name *</label><input name="name" class="field" required value="${esc(existing?.name || '')}" autofocus></div>
        <div class="form-row"><label>Emoji</label><input name="emoji" class="field" maxlength="4" placeholder="🍎" value="${esc(existing?.emoji || '')}"></div>
      </div>
      <div class="form-cols">
        <div class="form-row"><label>Category</label><select name="categoryId" class="field">
          <option value="">— None —</option>
          ${cats.map((c) => `<option value="${c.id}" ${existing?.categoryId === c.id ? 'selected' : ''}>${esc(c.name)}</option>`).join('')}
        </select></div>
        <div class="form-row"><label>Supplier</label><select name="supplierId" class="field">
          <option value="">— None —</option>
          ${sups.map((s) => `<option value="${s.id}" ${existing?.supplierId === s.id ? 'selected' : ''}>${esc(s.name)}</option>`).join('')}
        </select></div>
      </div>
      <div class="form-cols-3">
        <div class="form-row"><label>Sell unit</label><select name="unit" class="field">
          ${['kg', 'pcs', 'bunch', 'pack', 'dozen'].map((u) => `<option ${existing?.unit === u ? 'selected' : ''}>${u}</option>`).join('')}
        </select></div>
        <div class="form-row"><label>Retail price *</label><input name="price" class="field" type="number" step="0.01" min="0" required value="${existing ? (existing.priceCents / 100).toFixed(2) : ''}"></div>
        <div class="form-row"><label>Cost / unit</label><input name="cost" class="field" type="number" step="0.01" min="0" value="${existing ? (existing.costCents / 100).toFixed(2) : ''}"></div>
      </div>
      ${
        isEdit
          ? ''
          : `<div class="form-cols">
              <div class="form-row"><label>Opening stock</label><input name="stockQty" class="field" type="number" step="any" min="0" value="0"></div>
              <div class="form-row"><label>Reorder level</label><input name="reorderLevel" class="field" type="number" step="any" min="0" value="10"></div>
            </div>`
      }
      ${isEdit ? `<div class="form-row"><label>Reorder level</label><input name="reorderLevel" class="field" type="number" step="any" min="0" value="${fmtQty(existing.reorderLevel)}"></div>
      <label class="checkbox-row"><input type="checkbox" name="active" ${existing.active ? 'checked' : ''}> Active (visible in POS)</label>` : ''}
    </form>`;
  openModal(
    modalShell(isEdit ? `Edit · ${esc(existing.name)}` : 'Add Product', body),
    true
  );
  bindModalClose($('#modal-content'));
  $('#pf').onsubmit = async (e) => {
    e.preventDefault();
    const f = new FormData(e.target);
    const payload = {
      name: f.get('name'),
      emoji: f.get('emoji'),
      categoryId: f.get('categoryId') ? Number(f.get('categoryId')) : null,
      supplierId: f.get('supplierId') ? Number(f.get('supplierId')) : null,
      unit: f.get('unit'),
      priceCents: Math.round(parseFloat(f.get('price')) * 100),
      costCents: Math.round(parseFloat(f.get('cost') || 0) * 100),
      reorderLevel: parseFloat(f.get('reorderLevel') || 0),
    };
    if (!isEdit) payload.stockQty = parseFloat(f.get('stockQty') || 0);
    else payload.active = $('#pf input[name=active]').checked;
    try {
      if (isEdit) await api('/products/' + existing.id, { method: 'PUT', body: JSON.stringify(payload) });
      else await api('/products', { method: 'POST', body: JSON.stringify(payload) });
      closeModal();
      toast(isEdit ? 'Product updated' : 'Product added');
      route();
    } catch (err) {
      toast(err.message, true);
    }
  };
}

async function restockForm(p) {
  openModal(
    modalShell(
      `Restock · ${esc(p.emoji)} ${esc(p.name)}`,
      `<form id="rf">
        <p class="muted small" style="margin-top:0">Current stock: <strong>${fmtQty(p.stockQty)} ${esc(p.unit)}</strong></p>
        <div class="form-cols">
          <div class="form-row"><label>Quantity received *</label><input name="qty" class="field" type="number" step="any" min="0.01" required autofocus></div>
          <div class="form-row"><label>New cost / unit (optional)</label><input name="cost" class="field" type="number" step="0.01" min="0" placeholder="${(p.costCents / 100).toFixed(2)}"></div>
        </div>
        <div class="form-row"><label>Note</label><input name="note" class="field" placeholder="e.g. Purchase order #123"></div>
      </form>`,
      `<button class="btn" data-close>Cancel</button><button class="btn primary" id="rf-go">➕ Add stock</button>`
    )
  );
  bindModalClose($('#modal-content'));
  $('#rf-go').onclick = async () => {
    const f = new FormData($('#rf'));
    const qty = parseFloat(f.get('qty'));
    if (!(qty > 0)) return toast('Enter a valid quantity', true);
    const payload = { qty, note: f.get('note') };
    if (f.get('cost')) payload.costCents = Math.round(parseFloat(f.get('cost')) * 100);
    try {
      await api(`/products/${p.id}/restock`, { method: 'POST', body: JSON.stringify(payload) });
      closeModal();
      toast(`Added ${fmtQty(qty)} ${p.unit} to ${p.name}`);
      route();
    } catch (e) {
      toast(e.message, true);
    }
  };
}

async function manageCategories(current) {
  const cats = await api('/categories');
  openModal(
    modalShell(
      'Manage Categories',
      `
      <form id="cf-new" class="flex mb">
        <input name="emoji" class="field" style="width:64px" maxlength="4" placeholder="🥗">
        <input name="name" class="field grow" placeholder="Category name" required>
        <button class="btn primary">Add</button>
      </form>
      <div id="cat-list">
        ${cats.map((c) => `
          <div class="flex mb" data-cat="${c.id}">
            <input class="field" style="width:64px" data-f="emoji" maxlength="4" value="${esc(c.emoji)}">
            <input class="field grow" data-f="name" value="${esc(c.name)}">
            <button class="btn sm" data-save="${c.id}">💾</button>
            <button class="btn sm danger" data-del="${c.id}">🗑</button>
          </div>`).join('')}
      </div>`
    )
  );
  bindModalClose($('#modal-content'));
  $('#cf-new').onsubmit = async (e) => {
    e.preventDefault();
    const f = new FormData(e.target);
    try {
      await api('/categories', { method: 'POST', body: JSON.stringify({ name: f.get('name'), emoji: f.get('emoji') }) });
      toast('Category added');
      manageCategories();
    } catch (err) {
      toast(err.message, true);
    }
  };
  $$('#cat-list [data-save]').forEach((b) =>
    (b.onclick = async () => {
      const row = b.closest('[data-cat]');
      try {
        await api('/categories/' + b.dataset.save, {
          method: 'PUT',
          body: JSON.stringify({
            name: $('[data-f=name]', row).value.trim(),
            emoji: $('[data-f=emoji]', row).value.trim(),
          }),
        });
        toast('Category saved');
        manageCategories();
      } catch (e) {
        toast(e.message, true);
      }
    })
  );
  $$('#cat-list [data-del]').forEach((b) =>
    (b.onclick = async () => {
      if (!confirm('Delete this category?')) return;
      try {
        await api('/categories/' + b.dataset.del, { method: 'DELETE' });
        toast('Category deleted');
        manageCategories();
      } catch (e) {
        toast(e.message, true);
      }
    })
  );
}

ROUTES.products = ['Products', async (el) => {
  el.innerHTML = `
    <div class="toolbar">
      <input type="search" id="pq" placeholder="🔍 Search name or SKU…" value="${esc(prodFilters.q)}">
      <select id="pcat" class="field" style="height:38px;width:auto"><option value="">All categories</option></select>
      <select id="pstatus" class="field" style="height:38px;width:auto">
        <option value="active">Active</option><option value="inactive">Inactive</option><option value="all">All</option>
      </select>
      <div class="spacer"></div>
      <button class="btn" id="manage-cats">🏷 Categories</button>
      <button class="btn primary" id="add-prod">＋ Add Product</button>
    </div>
    <div class="tbl-wrap"><table class="tbl">
      <thead><tr><th>Product</th><th>Category</th><th>Supplier</th><th>Unit</th><th class="num">Cost</th><th class="num">Price</th><th class="num">Margin</th><th>Stock</th><th class="right">Actions</th></tr></thead>
      <tbody id="pbody"><tr><td colspan="9" class="muted">Loading…</td></tr></tbody>
    </table></div>`;

  const cats = await api('/categories');
  $('#pcat').innerHTML += cats.map((c) => `<option value="${c.id}">${esc(c.name)}</option>`).join('');
  $('#pcat').value = prodFilters.categoryId;
  $('#pstatus').value = prodFilters.status;

  async function loadRows() {
    const qs = new URLSearchParams();
    if (prodFilters.q) qs.set('q', prodFilters.q);
    if (prodFilters.categoryId) qs.set('category_id', prodFilters.categoryId);
    qs.set('active', prodFilters.status === 'active' ? '1' : prodFilters.status === 'inactive' ? '0' : 'all');
    const rows = await api('/products?' + qs);
    $('#pbody').innerHTML =
      rows.length === 0
        ? '<tr><td colspan="9" class="empty"><span class="big">🧺</span>No products found.</td></tr>'
        : rows
            .map((p) => {
              const margin = p.priceCents ? (((p.priceCents - p.costCents) / p.priceCents) * 100).toFixed(0) : '—';
              return `<tr style="${p.active ? '' : 'opacity:.55'}">
                <td><strong>${esc(p.emoji) || '📦'} ${esc(p.name)}</strong><br><span class="small muted">${esc(p.sku)}</span></td>
                <td>${p.category ? esc(p.categoryEmoji) + ' ' + esc(p.category) : '<span class="muted">—</span>'}</td>
                <td class="muted">${esc(p.supplier || '—')}</td>
                <td>${esc(p.unit)}</td>
                <td class="num">${money(p.costCents)}</td>
                <td class="num"><strong>${money(p.priceCents)}</strong></td>
                <td class="num ${margin !== '—' && margin < 15 ? 'text-warn' : ''}">${margin}${margin === '—' ? '' : '%'}</td>
                <td>${stockBadge(p)}${p.active ? '' : ' <span class="badge gray">Inactive</span>'}</td>
                <td><div class="actions">
                  <button class="btn xs" data-restock="${p.id}" title="Restock">➕</button>
                  <button class="btn xs" data-edit="${p.id}">Edit</button>
                  <button class="btn xs danger" data-del="${p.id}">${p.active ? 'Disable' : 'Enable'}</button>
                </div></td>
              </tr>`;
            })
            .join('');

    $$('#pbody [data-restock]').forEach((b) => (b.onclick = () => restockForm(rows.find((r) => r.id === Number(b.dataset.restock)))));
    $$('#pbody [data-edit]').forEach((b) => (b.onclick = () => productForm(rows.find((r) => r.id === Number(b.dataset.edit)))));
    $$('#pbody [data-del]').forEach((b) =>
      (b.onclick = async () => {
        const p = rows.find((r) => r.id === Number(b.dataset.del));
        if (!confirm(p.active ? `Disable "${p.name}"? It will disappear from POS.` : `Re-enable "${p.name}"?`)) return;
        try {
          const res = await api('/products/' + p.id, { method: 'DELETE' });
          toast(res.deactivated ? `"${p.name}" disabled` : `"${p.name}" deleted`);
          loadRows();
        } catch (e) {
          toast(e.message, true);
        }
      })
    );
  }

  $('#pq').addEventListener('input', debounce((e) => ((prodFilters.q = e.target.value), loadRows())));
  $('#pcat').onchange = (e) => ((prodFilters.categoryId = e.target.value), loadRows());
  $('#pstatus').onchange = (e) => ((prodFilters.status = e.target.value), loadRows());
  $('#add-prod').onclick = () => productForm(null);
  $('#manage-cats').onclick = () => manageCategories();
  await loadRows();
}];

async function adjustForm(p, onDone) {
  openModal(
    modalShell(
      `Adjust stock · ${esc(p.emoji)} ${esc(p.name)}`,
      `<form id="af">
        <p class="muted small" style="margin-top:0">Current stock: <strong>${fmtQty(p.stockQty)} ${esc(p.unit)}</strong>. Use a negative number to remove (spoilage, damage, count correction).</p>
        <div class="form-row"><label>Change quantity *</label><input name="changeQty" class="field" type="number" step="any" required autofocus placeholder="e.g. 12 or -3"></div>
        <div class="form-row"><label>Reason</label><select name="reason" class="field">
          <option value="restock">Restock</option><option value="spoilage">Spoilage / waste</option><option value="adjustment">Stock count adjustment</option>
        </select></div>
        <div class="form-row"><label>Note</label><input name="note" class="field" placeholder="Optional details"></div>
      </form>`,
      `<button class="btn" data-close>Cancel</button><button class="btn primary" id="af-go">Apply</button>`
    )
  );
  bindModalClose($('#modal-content'));
  $('#af-go').onclick = async () => {
    const f = new FormData($('#af'));
    try {
      await api('/inventory/adjust', {
        method: 'POST',
        body: JSON.stringify({
          productId: p.id,
          changeQty: parseFloat(f.get('changeQty')),
          reason: f.get('reason'),
          note: f.get('note'),
        }),
      });
      closeModal();
      toast('Stock adjusted');
      onDone?.();
    } catch (e) {
      toast(e.message, true);
    }
  };
}

ROUTES.inventory = ['Inventory', async (el) => {
  el.innerHTML = `
    <div class="toolbar">
      <input type="search" id="iq" placeholder="🔍 Search products…" value="${esc(invFilters.q)}">
      <button class="chip ${invFilters.lowOnly ? 'active' : ''}" id="low-toggle">⚠️ Low stock only</button>
    </div>
    <div class="tbl-wrap"><table class="tbl">
      <thead><tr><th>Product</th><th>Category</th><th>In stock</th><th>Reorder at</th><th>Status</th><th class="right">Actions</th></tr></thead>
      <tbody id="ibody"><tr><td colspan="6" class="muted">Loading…</td></tr></tbody>
    </table></div>
    <div class="mt"><table class="tbl">
      <thead><tr><th colspan="5" style="font-size:14px;color:var(--ink)">📜 Recent stock movements</th></tr>
      <tr><th>When</th><th>Product</th><th>Change</th><th>Reason</th><th>Note</th></tr></thead>
      <tbody id="mbody"><tr><td colspan="5" class="muted">Loading…</td></tr></tbody>
    </table></div>`;

  async function loadRows() {
    const qs = new URLSearchParams();
    if (invFilters.q) qs.set('q', invFilters.q);
    if (invFilters.lowOnly) qs.set('low_stock', '1');
    const [rows, moves] = await Promise.all([
      api('/products?' + qs),
      api('/inventory/log?limit=15'),
    ]);
    $('#ibody').innerHTML =
      rows.length === 0
        ? '<tr><td colspan="6" class="empty"><span class="big">📦</span>No products.</td></tr>'
        : rows
            .map((p) => {
              const st = p.stockQty <= 0
                ? '<span class="badge red">OUT</span>'
                : p.stockQty <= p.reorderLevel
                  ? '<span class="badge amber">LOW</span>'
                  : '<span class="badge green">OK</span>';
              return `<tr>
                <td><strong>${esc(p.emoji) || '📦'} ${esc(p.name)}</strong></td>
                <td class="muted">${esc(p.category || '—')}</td>
                <td class="num"><strong>${fmtQty(p.stockQty)}</strong> <span class="muted small">${esc(p.unit)}</span></td>
                <td class="num muted">${fmtQty(p.reorderLevel)}</td>
                <td>${st}</td>
                <td><div class="actions">
                  <button class="btn xs" data-restock="${p.id}">Restock</button>
                  <button class="btn xs" data-adjust="${p.id}">Adjust</button>
                </div></td></tr>`;
            })
            .join('');
    $('#mbody').innerHTML =
      moves.length === 0
        ? '<tr><td colspan="5" class="muted">No movements yet.</td></tr>'
        : moves
            .map((m) => `<tr>
              <td class="muted small">${fmtDate(m.createdAt)}</td>
              <td>${esc(m.emoji) || ''} ${esc(m.productName)}</td>
              <td class="num" style="color:${m.changeQty >= 0 ? 'var(--green)' : 'var(--red)'}"><strong>${m.changeQty >= 0 ? '+' : ''}${fmtQty(m.changeQty)}</strong></td>
              <td><span class="badge ${m.reason === 'sale' ? 'blue' : m.reason === 'refund' ? 'amber' : 'gray'}">${esc(m.reason)}</span></td>
              <td class="muted small">${esc(m.note || '')}</td></tr>`)
            .join('');

    const all = rows;
    $$('#ibody [data-restock]').forEach((b) => (b.onclick = () => restockForm(all.find((r) => r.id === Number(b.dataset.restock))).then(loadRows)));
    $$('#ibody [data-adjust]').forEach((b) => (b.onclick = () => adjustForm(all.find((r) => r.id === Number(b.dataset.adjust)), loadRows)));
  }

  $('#iq').addEventListener('input', debounce((e) => ((invFilters.q = e.target.value), loadRows())));
  $('#low-toggle').onclick = (e) => {
    invFilters.lowOnly = !invFilters.lowOnly;
    e.target.classList.toggle('active', invFilters.lowOnly);
    loadRows();
  };
  await loadRows();
}];

const ORDERS_PAGE = 50;
let orderOffset = 0;

ROUTES.orders = ['Orders', async (el) => {
  el.innerHTML = `
    <div class="toolbar">
      <input type="date" id="of-from" value="${orderFilters.from}">
      <input type="date" id="of-to" value="${orderFilters.to}">
      <select id="of-status" class="field" style="height:38px;width:auto">
        <option value="">Any status</option><option value="completed">Completed</option><option value="refunded">Refunded</option>
      </select>
      <div class="spacer"></div>
      <a class="btn" id="export-csv" href="/api/export/orders.csv" download>⬇ Export CSV</a>
    </div>
    <div class="tbl-wrap"><table class="tbl">
      <thead><tr><th>#</th><th>Date</th><th>Customer</th><th>Items</th><th class="num">Total</th><th>Payment</th><th>Status</th></tr></thead>
      <tbody id="obody"><tr><td colspan="7" class="muted">Loading…</td></tr></tbody>
    </table></div>
    <div class="mt" style="text-align:center"><button class="btn" id="more-btn" style="display:none">Load more</button></div>`;
  $('#of-status').value = orderFilters.status;

  async function load(reset = true) {
    if (reset) orderOffset = 0;
    const qs = new URLSearchParams({ limit: ORDERS_PAGE, offset: orderOffset });
    if (orderFilters.from) qs.set('from', dayBounds(orderFilters.from));
    if (orderFilters.to) qs.set('to', dayBounds(orderFilters.to, true));
    if (orderFilters.status) qs.set('status', orderFilters.status);
    $('#export-csv').href = '/api/export/orders.csv?' +
      (orderFilters.from ? 'from=' + encodeURIComponent(dayBounds(orderFilters.from)) + '&' : '') +
      (orderFilters.to ? 'to=' + encodeURIComponent(dayBounds(orderFilters.to, true)) : '');
    const rows = await api('/sales?' + qs);
    const html = rows.length === 0
      ? '<tr><td colspan="7" class="empty"><span class="big">🧾</span>No orders found.</td></tr>'
      : rows
          .map((o) => `<tr data-id="${o.id}" style="cursor:pointer">
            <td><strong>#${o.id}</strong></td>
            <td class="muted">${fmtDate(o.createdAt)}</td>
            <td>${o.customerName ? esc(o.customerName) : '<span class="muted">Walk-in</span>'}</td>
            <td>${o.itemCount}</td>
            <td class="num"><strong>${money(o.totalCents)}</strong></td>
            <td>${payBadge(o.paymentMethod)}</td>
            <td>${statusBadge(o.status)}</td></tr>`)
          .join('');
    if (reset) $('#obody').innerHTML = html;
    else $('#obody').insertAdjacentHTML('beforeend', html);
    $$('#obody tr[data-id]').forEach((tr) => (tr.onclick = () => orderDetail(Number(tr.dataset.id))));
    $('#more-btn').style.display = rows.length === ORDERS_PAGE ? '' : 'none';
  }

  $('#of-from').onchange = (e) => ((orderFilters.from = e.target.value), load());
  $('#of-to').onchange = (e) => ((orderFilters.to = e.target.value), load());
  $('#of-status').onchange = (e) => ((orderFilters.status = e.target.value), load());
  $('#more-btn').onclick = () => {
    orderOffset += ORDERS_PAGE;
    load(false);
  };
  await load();
}];

async function orderDetail(id) {
  const s = await api('/sales/' + id);
  openModal(
    modalShell(
      `Order #${s.id} · ${new Date(s.created_at).toLocaleString()}`,
      `
      ${receiptHTML({ ...s, createdAt: s.created_at })}
      `,
      `${s.status === 'completed' ? '<button class="btn danger" id="refund-btn">↩ Refund Order</button>' : ''}
       <button class="btn" id="od-print">🖨 Print</button>
       <button class="btn primary" data-close>Done</button>`,
    ),
    false
  );
  bindModalClose($('#modal-content'));
  $('#od-print').onclick = () => {
    $('#print-area').innerHTML = receiptHTML({ ...s, createdAt: s.created_at });
    window.print();
  };
  $('#refund-btn')?.addEventListener('click', async () => {
    if (!confirm(`Refund order #${s.id}? Stock will be returned to inventory.`)) return;
    try {
      await api(`/sales/${s.id}/refund`, { method: 'POST' });
      toast(`Order #${s.id} refunded`);
      closeModal();
      route();
    } catch (e) {
      toast(e.message, true);
    }
  });
}

ROUTES.customers = ['Customers', async (el) => {
  el.innerHTML = `
    <div class="toolbar"><input type="search" id="cq" placeholder="🔍 Search customers…">
    <div class="spacer"></div><button class="btn primary" id="add-cust">＋ Add Customer</button></div>
    <div class="tbl-wrap"><table class="tbl">
      <thead><tr><th>Name</th><th>Phone</th><th>Email</th><th class="num">Orders</th><th class="num">Lifetime Spend</th><th class="right">Actions</th></tr></thead>
      <tbody id="cbody"><tr><td colspan="6" class="muted">Loading…</td></tr></tbody>
    </table></div>`;

  let rows = [];
  async function loadRows() {
    rows = await api('/customers');
    const q = $('#cq').value.toLowerCase();
    const list = q ? rows.filter((c) => (c.name + c.phone + c.email).toLowerCase().includes(q)) : rows;
    $('#cbody').innerHTML =
      list.length === 0
        ? '<tr><td colspan="6" class="empty"><span class="big">👥</span>No customers yet.</td></tr>'
        : list
            .map((c) => `<tr>
              <td><strong>${esc(c.name)}</strong>${c.notes ? `<br><span class="small muted">${esc(c.notes)}</span>` : ''}</td>
              <td class="muted">${esc(c.phone || '—')}</td>
              <td class="muted">${esc(c.email || '—')}</td>
              <td class="num">${c.orderCount}</td>
              <td class="num"><strong>${money(c.totalSpentCents)}</strong></td>
              <td><div class="actions">
                <button class="btn xs" data-edit="${c.id}">Edit</button>
                <button class="btn xs danger" data-del="${c.id}">Delete</button>
              </div></td></tr>`)
            .join('');
    $$('#cbody [data-edit]').forEach((b) => (b.onclick = () => custForm(rows.find((r) => r.id === Number(b.dataset.edit)))));
    $$('#cbody [data-del]').forEach((b) =>
      (b.onclick = async () => {
        const c = rows.find((r) => r.id === Number(b.dataset.del));
        if (!confirm(`Delete customer "${c.name}"?`)) return;
        try {
          await api('/customers/' + c.id, { method: 'DELETE' });
          toast('Customer deleted');
          loadRows();
        } catch (e) {
          toast(e.message, true);
        }
      })
    );
  }

  function custForm(existing) {
    const isEdit = !!existing;
    openModal(
      modalShell(
        isEdit ? `Edit · ${esc(existing.name)}` : 'Add Customer',
        `<form id="custf">
          <div class="form-row"><label>Name *</label><input name="name" class="field" required value="${esc(existing?.name || '')}" autofocus></div>
          <div class="form-cols">
            <div class="form-row"><label>Phone</label><input name="phone" class="field" value="${esc(existing?.phone || '')}"></div>
            <div class="form-row"><label>Email</label><input name="email" class="field" type="email" value="${esc(existing?.email || '')}"></div>
          </div>
          <div class="form-row"><label>Notes</label><textarea name="notes" class="field" rows="2">${esc(existing?.notes || '')}</textarea></div>
        </form>`,
        `<button class="btn" data-close>Cancel</button><button class="btn primary" id="custf-save">${isEdit ? 'Save' : 'Add'}</button>`
      )
    );
    bindModalClose($('#modal-content'));
    $('#custf-save').onclick = async () => {
      const f = new FormData($('#custf'));
      const payload = Object.fromEntries(f.entries());
      if (!payload.name.trim()) return toast('Name is required', true);
      try {
        if (isEdit) await api('/customers/' + existing.id, { method: 'PUT', body: JSON.stringify(payload) });
        else await api('/customers', { method: 'POST', body: JSON.stringify(payload) });
        closeModal();
        toast(isEdit ? 'Customer updated' : 'Customer added');
        loadRows();
      } catch (e) {
        toast(e.message, true);
      }
    };
  }

  $('#cq').addEventListener('input', debounce(loadRows, 200));
  $('#add-cust').onclick = () => custForm(null);
  await loadRows();
}];

ROUTES.suppliers = ['Suppliers', async (el) => {
  el.innerHTML = `
    <div class="toolbar"><div class="spacer"></div><button class="btn primary" id="add-sup">＋ Add Supplier</button></div>
    <div class="supplier-grid" id="sup-grid"><div class="empty">Loading…</div></div>`;

  let rows = [];
  async function loadRows() {
    rows = await api('/suppliers');
    $('#sup-grid').innerHTML =
      rows.length === 0
        ? '<div class="empty"><span class="big">🚚</span>No suppliers yet.</div>'
        : rows
            .map((s) => `<div class="card supplier-card">
              <div class="flex"><h2 style="margin:0" class="grow">${esc(s.name)}</h2><span class="badge blue">${s.productCount} products</span></div>
              ${s.contactName ? `<div class="sc-row">👤 ${esc(s.contactName)}</div>` : ''}
              ${s.phone ? `<div class="sc-row">📞 ${esc(s.phone)}</div>` : ''}
              ${s.email ? `<div class="sc-row">✉️ ${esc(s.email)}</div>` : ''}
              <div class="flex mt">
                <button class="btn sm grow" data-edit="${s.id}">Edit</button>
                <button class="btn sm danger" data-del="${s.id}">Delete</button>
              </div>
            </div>`)
            .join('');
    $$('#sup-grid [data-edit]').forEach((b) => (b.onclick = () => supForm(rows.find((r) => r.id === Number(b.dataset.edit)))));
    $$('#sup-grid [data-del]').forEach((b) =>
      (b.onclick = async () => {
        const s = rows.find((r) => r.id === Number(b.dataset.del));
        if (!confirm(`Delete supplier "${s.name}"?`)) return;
        try {
          await api('/suppliers/' + s.id, { method: 'DELETE' });
          toast('Supplier deleted');
          loadRows();
        } catch (e) {
          toast(e.message, true);
        }
      })
    );
  }

  function supForm(existing) {
    const isEdit = !!existing;
    openModal(
      modalShell(
        isEdit ? `Edit · ${esc(existing.name)}` : 'Add Supplier',
        `<form id="supf">
          <div class="form-row"><label>Company name *</label><input name="name" class="field" required value="${esc(existing?.name || '')}" autofocus></div>
          <div class="form-row"><label>Contact person</label><input name="contactName" class="field" value="${esc(existing?.contactName || '')}"></div>
          <div class="form-cols">
            <div class="form-row"><label>Phone</label><input name="phone" class="field" value="${esc(existing?.phone || '')}"></div>
            <div class="form-row"><label>Email</label><input name="email" class="field" type="email" value="${esc(existing?.email || '')}"></div>
          </div>
        </form>`,
        `<button class="btn" data-close>Cancel</button><button class="btn primary" id="supf-save">${isEdit ? 'Save' : 'Add'}</button>`
      )
    );
    bindModalClose($('#modal-content'));
    $('#supf-save').onclick = async () => {
      const f = new FormData($('#supf'));
      const payload = Object.fromEntries(f.entries());
      if (!payload.name.trim()) return toast('Name is required', true);
      try {
        if (isEdit) await api('/suppliers/' + existing.id, { method: 'PUT', body: JSON.stringify(payload) });
        else await api('/suppliers', { method: 'POST', body: JSON.stringify(payload) });
        closeModal();
        toast(isEdit ? 'Supplier updated' : 'Supplier added');
        loadRows();
      } catch (e) {
        toast(e.message, true);
      }
    };
  }

  $('#add-sup').onclick = () => supForm(null);
  await loadRows();
}];

ROUTES.reports = ['Reports', async (el) => {
  el.innerHTML = `
    <div class="toolbar chips" id="rep-chips">
      ${[7, 30, 90].map((d) => `<button class="chip ${reportDays === d ? 'active' : ''}" data-days="${d}">Last ${d} days</button>`).join('')}
      <div class="spacer"></div>
      <a class="btn" href="/api/export/orders.csv" download>⬇ Export orders CSV</a>
    </div>
    <div id="rep-body"><div class="empty">Loading…</div></div>`;

  async function load() {
    const [summary, tops, cats] = await Promise.all([
      api('/reports/summary?days=' + reportDays),
      api('/reports/top-products?days=' + reportDays),
      api('/reports/sales-by-category?days=' + reportDays),
    ]);
    const maxCat = Math.max(...cats.map((c) => c.revenueCents), 1);
    $('#rep-body').innerHTML = `
      <div class="grid-cards">
        <div class="card stat"><div class="stat-label">Revenue</div><div class="stat-value">${money(summary.revenueCents)}</div><div class="stat-sub">${summary.orders} orders</div></div>
        <div class="card stat"><div class="stat-label">Est. Gross Profit</div><div class="stat-value">${money(summary.profitCents)}</div><div class="stat-sub">${summary.revenueCents ? ((summary.profitCents / summary.revenueCents) * 100).toFixed(1) : 0}% margin</div></div>
        <div class="card stat"><div class="stat-label">Avg Order Value</div><div class="stat-value">${money(summary.avgOrderCents)}</div><div class="stat-sub">per completed order</div></div>
        <div class="card stat"><div class="stat-label">Refunds</div><div class="stat-value">${money(summary.refundAmountCents)}</div><div class="stat-sub">${summary.refunds} refunded order${summary.refunds === 1 ? '' : 's'}</div></div>
      </div>
      <div class="dash-grid mt">
        <div class="card"><h2>🏆 Top Products</h2>
          <table class="tbl"><thead><tr><th>#</th><th>Product</th><th class="num">Qty Sold</th><th class="num">Revenue</th><th class="num">Profit</th></tr></thead>
          <tbody>${tops.length === 0 ? '<tr><td colspan="5" class="muted">No sales in this period.</td></tr>' :
            tops.map((t, i) => `<tr>
              <td class="muted">${i + 1}</td>
              <td><strong>${esc(t.emoji) || '🛒'} ${esc(t.productName)}</strong></td>
              <td class="num">${fmtQty(t.qtySold)}</td>
              <td class="num"><strong>${money(t.revenueCents)}</strong></td>
              <td class="num" style="color:var(--green)">${money(t.profitCents)}</td></tr>`).join('')}
          </tbody></table>
        </div>
        <div class="card"><h2>🗂 Sales by Category</h2>
          ${cats.length === 0 ? '<p class="muted">No sales in this period.</p>' : cats.map((c) => `
            <div class="mb">
              <div class="flex small"><span>${esc(c.emoji)} <strong>${esc(c.category)}</strong></span><span class="grow"></span><strong>${money(c.revenueCents)}</strong></div>
              <div class="bar-cell mt" style="margin-top:6px"><div class="bar-track"><div class="bar-fill" style="width:${Math.max(2, (c.revenueCents / maxCat) * 100)}%"></div></div></div>
            </div>`).join('')}
        </div>
      </div>`;
  }

  $$('#rep-chips [data-days]').forEach((ch) =>
    (ch.onclick = () => {
      reportDays = Number(ch.dataset.days);
      $$('#rep-chips [data-days]').forEach((x) => x.classList.toggle('active', x === ch));
      load();
    })
  );
  await load();
}];

function settingsModal() {
  openModal(
    modalShell(
      '⚙️ Settings',
      `<form id="sf">
        <div class="form-row"><label>Store name</label><input name="storeName" class="field" value="${esc(settings.storeName)}"></div>
        <div class="form-row"><label>Tax rate (%)</label><input name="taxRate" class="field" type="number" step="0.1" min="0" max="50" value="${settings.taxRate}"></div>
      </form>`,
      `<button class="btn" data-close>Cancel</button><button class="btn primary" id="sf-save">Save</button>`
    )
  );
  bindModalClose($('#modal-content'));
  $('#sf-save').onclick = async () => {
    const f = new FormData($('#sf'));
    try {
      await api('/settings', {
        method: 'PUT',
        body: JSON.stringify({ storeName: f.get('storeName'), taxRate: Number(f.get('taxRate')) }),
      });
      settings.storeName = f.get('storeName');
      settings.taxRate = Number(f.get('taxRate'));
      closeModal();
      toast('Settings saved');
      route();
    } catch (e) {
      toast(e.message, true);
    }
  };
}

function route() {
  const name = location.hash.replace(/^#\/?/, '').split('?')[0] || 'dashboard';
  const def = ROUTES[name] || ROUTES.dashboard;
  $$('#nav a').forEach((a) => a.classList.toggle('active', a.dataset.route === (ROUTES[name] ? name : 'dashboard')));
  $('#view-title').textContent = def[0];
  const el = $('#view');
  el.innerHTML = '<div class="empty">Loading…</div>';
  Promise.resolve(def[1](el)).catch((e) => {
    console.error(e);
    el.innerHTML = `<div class="empty"><span class="big">😵</span>${esc(e.message)}</div>`;
  });
}

$('#modal').addEventListener('click', (e) => {
  if (e.target === $('#modal')) closeModal();
});

$('#hamburger').addEventListener('click', () => $('#sidebar').classList.toggle('open'));
document.addEventListener('click', (e) => {
  if (e.target.closest('#nav a') && window.innerWidth <= 900) $('#sidebar').classList.remove('open');
});
$('#settings-btn').addEventListener('click', settingsModal);

async function boot() {
  try {
    settings = { ...settings, ...(await api('/settings')) };
  } catch {}
  $('#topbar-date').textContent = new Date().toLocaleDateString(undefined, {
    weekday: 'long',
    year: 'numeric',
    month: 'long',
    day: 'numeric',
  });
  window.addEventListener('hashchange', route);
  route();
}

boot();
