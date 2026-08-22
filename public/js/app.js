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
    <div class="grid-cards mt" style="grid-template-columns:repeat(auto-fit,minmax(160px,1fr))">
      <div class="card stat" style="padding:14px 16px"><div class="stat-label">Stock Value (at cost)</div><div class="stat-value" style="font-size:20px">${money(d.stockValueCents)}</div></div>
      <div class="card stat" style="padding:14px 16px"><div class="stat-label">Expiring ≤3 days</div><div class="stat-value" style="font-size:20px;color:${d.expiringSoonCount ? 'var(--amber)' : 'inherit'}">${money(d.expiringSoonValueCents)}</div><div class="stat-sub">${d.expiringSoonCount} batch(es)</div></div>
      <div class="card stat" style="padding:14px 16px"><div class="stat-label">Waste · last 7 days</div><div class="stat-value" style="font-size:20px">${money(d.waste7dValueCents)}</div></div>
      <div class="card stat" style="padding:14px 16px"><div class="stat-label">Cold Chain</div><div class="stat-value" style="font-size:20px;color:${d.coldChainBreaches ? 'var(--red)' : 'var(--green)'}">${d.coldChainBreaches ? d.coldChainBreaches + ' breach' + (d.coldChainBreaches === 1 ? '' : 'es') : 'OK'}</div></div>
      <div class="card stat" style="padding:14px 16px"><div class="stat-label">Open POs</div><div class="stat-value" style="font-size:20px">${d.openPOs}</div></div>
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
      if (!p) return;
      if (p.stockQty <= 0) return toast(`${p.name} is out of stock`, true);
      const cur = cart.get(p.id);
      const next = (cur?.qty || 0) + 1;
      if (next > p.stockQty + 1e-9) return toast(`Only ${fmtQty(p.stockQty)} ${p.unit} of ${p.name} left`, true);
      cart.set(p.id, { product: p, qty: next });
      renderCartPanel();
    })
  );
}

function cartMath() {
  const lines = [...cart.values()];
  const pct = Math.min(Math.max(Number($('#cart-discount')?.value) || 0, 0), 100);
  const subtotal = lines.reduce((a, l) => a + Math.round(l.qty * l.product.priceCents), 0);
  const disc = Math.round((subtotal * pct) / 100);
  const taxRate = Number(settings.taxRate) || 0;
  const tax = Math.round(((subtotal - disc) * taxRate) / 100);
  return { lines, pct, subtotal, disc, tax, total: subtotal - disc + tax };
}

function updateCartSums() {
  const { subtotal, disc, tax, total } = cartMath();
  const set = (id, v) => {
    const n = $('#cart-panel')?.querySelector('#' + id);
    if (n) n.textContent = money(v);
  };
  set('sum-sub', subtotal);
  set('sum-disc', disc);
  set('sum-tax', tax);
  set('sum-total', total);
  const btn = $('#checkout');
  if (btn) {
    btn.disabled = cart.size === 0;
    btn.textContent = `✓ Complete Sale · ${money(total)}`;
  }
}

function renderCartPanel() {
  const panel = $('#cart-panel');
  if (!panel) return;
  const lines = [...cart.values()];
  const { pct, subtotal, disc, tax, total } = cartMath();

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
        <div class="cl-total" data-lt="${p.id}">${money(Math.round(qty * p.priceCents))}</div>
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
    <div class="form-row"><label>Sale channel</label>
      <select id="cart-channel" class="field">
        <option value="retail" ${saleChannel === 'retail' ? 'selected' : ''}>🛒 Retail counter</option>
        <option value="b2b" ${saleChannel === 'b2b' ? 'selected' : ''}>🏢 Wholesale / B2B</option>
      </select></div>
    <div class="form-row"><label>Customer${saleChannel !== 'retail' ? ' *' : ''}</label>
      <select id="cart-customer" class="field"><option value="">Walk-in customer</option>${
        (posCustomers || []).map((c) => `<option value="${c.id}">${esc(c.name)}</option>`).join('')
      }</select></div>
    <div class="form-row"><label>Payment</label>
      <select id="cart-pay" class="field">
        <option value="cash" ${salePayMethod === 'cash' ? 'selected' : ''}>💵 Cash</option>
        <option value="card" ${salePayMethod === 'card' ? 'selected' : ''}>💳 Card</option>
        <option value="mobile" ${salePayMethod === 'mobile' ? 'selected' : ''}>📱 Mobile</option>
      </select></div>
    <div class="cart-sums">
      <div class="row"><span>Subtotal</span><span id="sum-sub">${money(subtotal)}</span></div>
      <div class="row"><span>Discount</span><span id="sum-disc">−${money(disc)}</span></div>
      <div class="row"><span>Tax (${settings.taxRate}%)</span><span id="sum-tax">${money(tax)}</span></div>
      <div class="row total"><span>Total</span><span id="sum-total">${money(total)}</span></div>
      <button class="btn primary block mt" id="checkout" ${lines.length ? '' : 'disabled'}>✓ Complete Sale · ${money(total)}</button>
    </div>`;

  panel.querySelector('#cart-clear')?.addEventListener('click', () => {
    cart.clear();
    renderCartPanel();
  });
  panel.querySelector('#cart-discount').addEventListener('input', () => updateCartSums());
  panel.querySelectorAll('[data-inc]').forEach((b) => (b.onclick = () => bumpQty(Number(b.dataset.inc), 0.5)));
  panel.querySelectorAll('[data-dec]').forEach((b) => (b.onclick = () => bumpQty(Number(b.dataset.dec), -0.5)));
  panel.querySelectorAll('[data-rm]').forEach((b) => (b.onclick = () => {
    cart.delete(Number(b.dataset.rm));
    renderCartPanel();
  }));
  panel.querySelectorAll('[data-qty]').forEach((inp) => {
    inp.addEventListener('input', () => {
      const item = cart.get(Number(inp.dataset.qty));
      if (!item) return;
      let v = Number(inp.value);
      if (!Number.isFinite(v) || v <= 0) return;
      if (v > item.product.stockQty + 1e-9) v = item.product.stockQty;
      item.qty = Math.round(v * 100) / 100;
      const lt = panel.querySelector(`[data-lt="${inp.dataset.qty}"]`);
      if (lt) lt.textContent = money(Math.round(item.qty * item.product.priceCents));
      updateCartSums();
    });
    inp.addEventListener('change', () => {
      const item = cart.get(Number(inp.dataset.qty));
      if (!item) return;
      let v = Number(inp.value);
      if (!Number.isFinite(v) || v <= 0) v = 1;
      if (v > item.product.stockQty + 1e-9) {
        v = item.product.stockQty;
        toast(`Stock limited to ${fmtQty(v)} ${item.product.unit}`, true);
      }
      item.qty = Math.round(v * 100) / 100;
      renderCartPanel();
    });
  });
  const custSel = panel.querySelector('#cart-customer');
  custSel.value = selectedCustomerId ?? '';
  custSel.onchange = () => (selectedCustomerId = custSel.value ? Number(custSel.value) : null);
  panel.querySelector('#cart-channel').onchange = (e) => {
    saleChannel = e.target.value;
    renderCartPanel();
  };
  panel.querySelector('#cart-pay').onchange = (e) => (salePayMethod = e.target.value);

  panel.querySelector('#checkout')?.addEventListener('click', async () => {
    const btn = $('#checkout');
    btn.disabled = true;
    btn.textContent = 'Processing…';
    try {
      const payload = {
        items: [...cart.values()].map(({ product, qty }) => ({ productId: product.id, qty })),
        customerId: selectedCustomerId || null,
        discountPct: Math.min(Math.max(Number($('#cart-discount').value) || 0, 0), 100),
        paymentMethod: salePayMethod,
        channel: saleChannel,
      };
      if (saleChannel !== 'retail' && !payload.customerId)
        return toast('Select a customer for B2B sales', true);
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
let saleChannel = 'retail';
let salePayMethod = 'cash';

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
      <div class="form-cols-3">
        <div class="form-row"><label>Wholesale price</label><input name="wholesale" class="field" type="number" step="0.01" min="0" value="${existing && existing.wholesalePriceCents ? (existing.wholesalePriceCents / 100).toFixed(2) : ''}" placeholder="auto 80%"></div>
        <div class="form-row"><label>Shelf life (days)</label><input name="shelfLife" class="field" type="number" min="1" max="365" value="${existing?.shelfLifeDays || 7}"></div>
        <div class="form-row"><label>Storage requirement</label><select name="storageReq" class="field">
          ${['ambient', 'chilled', 'cold', 'dry'].map((s) => `<option ${existing?.storageReq === s ? 'selected' : ''}>${s}</option>`).join('')}
        </select></div>
      </div>
      <div class="form-cols">
        <div class="form-row"><label>Variety</label><input name="variety" class="field" placeholder="e.g. Roma" value="${esc(existing?.variety || '')}"></div>
        <div class="form-row"><label>Origin</label><input name="origin" class="field" placeholder="e.g. Green Valley Farms" value="${esc(existing?.origin || '')}"></div>
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
      wholesalePriceCents: f.get('wholesale') ? Math.round(parseFloat(f.get('wholesale')) * 100) : 0,
      shelfLifeDays: parseInt(f.get('shelfLife'), 10) || 7,
      storageReq: f.get('storageReq'),
      variety: f.get('variety'),
      origin: f.get('origin'),
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

function traceabilityHTML(s) {
  if (!s.allocations || !s.allocations.length)
    return '<p class="muted small">No batch allocations recorded for this order.</p>';
  return `<table class="tbl"><thead><tr><th>Product</th><th>Batch</th><th>Grade</th><th class="num">Qty</th><th>Supplier / Origin</th></tr></thead>
    <tbody>${s.allocations.map((a) => `<tr>
      <td>${esc(a.productName)}</td>
      <td><span class="badge blue">${esc(a.batchCode)}</span></td>
      <td>${esc(a.grade)}</td>
      <td class="num">${fmtQty(a.qty)}</td>
      <td class="muted">${esc(a.supplierName || '—')}</td></tr>`).join('')}</tbody></table>`;
}

async function orderDetail(id) {
  const s = await api('/sales/' + id);
  const isInvoice = s.payment_method === 'invoice';
  openModal(
    modalShell(
      `Order #${s.id} · ${new Date(s.created_at).toLocaleString()}`,
      `
      <div class="flex mb" style="gap:8px">
        ${statusBadge(s.status)}
        <span class="badge ${s.channel === 'retail' ? 'green' : s.channel === 'b2b' ? 'blue' : 'amber'}">${esc(s.channel)}</span>
        ${payBadge(s.payment_method)}
        ${s.due_date ? `<span class="muted small">due ${esc(s.due_date.slice(0, 10))}</span>` : ''}
        ${isInvoice ? `<span class="grow"></span><strong>Paid ${money(s.paidCents)} · Balance <span style="color:${s.balanceCents > 0 ? 'var(--red)' : 'var(--green)'}">${money(s.balanceCents)}</span></strong>` : ''}
      </div>
      ${receiptHTML({ ...s, createdAt: s.created_at })}
      <h2 style="font-size:15px;margin:18px 0 8px">🔗 Batch Traceability (FEFO)</h2>
      ${traceabilityHTML(s)}
      `,
      `${isInvoice && s.balanceCents > 0 && s.status === 'completed' ? '<button class="btn" id="pay-btn">💵 Record Payment</button>' : ''}
       ${s.status === 'completed' ? '<button class="btn danger" id="refund-btn">↩ Refund Order</button>' : ''}
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
  $('#pay-btn')?.addEventListener('click', () => paymentForm(s));
}

function paymentForm(sale) {
  openModal(
    modalShell(
      `Record Payment · Order #${sale.id}`,
      `<form id="pf2">
        <p class="muted small" style="margin-top:0">Balance due: <strong>${money(sale.balanceCents)}</strong> · Customer: ${esc(sale.customerName || '')}</p>
        <div class="form-cols">
          <div class="form-row"><label>Amount *</label><input name="amount" class="field" type="number" step="0.01" min="0.01" max="${(sale.balanceCents / 100).toFixed(2)}" value="${(sale.balanceCents / 100).toFixed(2)}" required></div>
          <div class="form-row"><label>Method</label><select name="method" class="field">
            <option value="cash">Cash</option><option value="card">Card</option><option value="mobile">Mobile</option><option value="transfer">Bank transfer</option>
          </select></div>
        </div>
      </form>`,
      `<button class="btn" data-close>Cancel</button><button class="btn primary" id="pf2-save">Save Payment</button>`
    )
  );
  bindModalClose($('#modal-content'));
  $('#pf2-save').onclick = async () => {
    const f = new FormData($('#pf2'));
    try {
      await api('/payments', {
        method: 'POST',
        body: JSON.stringify({
          saleId: sale.id,
          amountCents: Math.round(parseFloat(f.get('amount')) * 100),
          method: f.get('method'),
        }),
      });
      closeModal();
      toast('Payment recorded');
      route();
    } catch (e) {
      toast(e.message, true);
    }
  };
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
          <div class="form-cols">
            <div class="form-row"><label>Segment</label><select name="segment" class="field">
              ${['retail', 'restaurant', 'hotel', 'cafe', 'caterer', 'reseller', 'corporate', 'wholesale'].map((sg) => `<option ${(existing?.segment || 'retail') === sg ? 'selected' : ''}>${sg}</option>`).join('')}
            </select></div>
            <div class="form-row"><label>Payment terms</label><input name="payment_terms" class="field" placeholder='e.g. "net14"' value="${esc(existing?.paymentTerms || '')}"></div>
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
                <button class="btn sm grow" data-perf="${s.id}">📊 Performance</button>
                <button class="btn sm" data-edit="${s.id}">Edit</button>
                <button class="btn sm danger" data-del="${s.id}">Delete</button>
              </div>
            </div>`)
            .join('');
    $$('#sup-grid [data-perf]').forEach((b) => (b.onclick = () => supPerformance(Number(b.dataset.perf))));
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

  async function supPerformance(id) {
    const s = rows.find((r) => r.id === id);
    const p = await api(`/suppliers/${id}/performance`);
    openModal(
      modalShell(`📊 Performance · ${esc(s.name)}`,
        `<div class="grid-cards">
          <div class="stat"><div class="stat-label">Purchase orders</div><div class="stat-value" style="font-size:20px">${p.totalPOs}</div><div class="stat-sub">${p.completedPOs} completed</div></div>
          <div class="stat"><div class="stat-label">Acceptance rate</div><div class="stat-value" style="font-size:20px;color:${p.acceptanceRatePct >= 90 ? 'var(--green)' : p.acceptanceRatePct >= 75 ? 'var(--amber)' : 'var(--red)'}">${p.acceptanceRatePct}%</div><div class="stat-sub">of received qty</div></div>
          <div class="stat"><div class="stat-label">Total purchased</div><div class="stat-value" style="font-size:20px">${money(p.totalValueCents)}</div></div>
        </div>
        <h2 style="font-size:15px;margin:16px 0 8px">Waste traceable to this supplier (30d)</h2>
        <p style="margin:0 0 12px"><strong style="color:${p.wasteValueCents30d ? 'var(--red)' : 'var(--green)'}">${money(p.wasteValueCents30d)}</strong> <span class="muted small">across ${p.wasteEvents30d} disposal event(s)</span></p>
        <table class="tbl"><thead><tr><th>PO</th><th>Status</th><th class="num">Ordered</th><th class="num">Accepted</th><th class="num">Rejected</th><th class="num">Value</th></tr></thead>
        <tbody>${p.recentPOs.length === 0 ? '<tr><td colspan="6" class="muted">No purchase orders yet.</td></tr>' : p.recentPOs.map((po) => `<tr>
          <td><strong>#${po.code}</strong></td>
          <td><span class="badge gray">${po.status}</span></td>
          <td class="num">${fmtQty(po.orderedQty)}</td>
          <td class="num" style="color:var(--green)">${fmtQty(po.acceptedQty)}</td>
          <td class="num" style="color:${po.rejectedQty ? 'var(--red)' : 'inherit'}">${fmtQty(po.rejectedQty)}</td>
          <td class="num">${money(po.valueCents)}</td></tr>`).join('')}</tbody></table>
        ${p.worstProducts.length ? `<h2 style="font-size:15px;margin:16px 0 8px">Most wasted items from this supplier</h2>
        ${p.worstProducts.map((w) => `<div class="flex small mb"><span>${esc(w.productName)}</span><span class="grow"></span><strong style="color:var(--red)">${money(w.valueCents)}</strong></div>`).join('')}` : ''}`,
        `<button class="btn primary" data-close>Close</button>`),
      true);
    bindModalClose($('#modal-content'));
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

const STATE_META = {
  fresh: ['🟢 Fresh', 'fresh'],
  aging: ['🔵 Aging', 'aging'],
  urgent: ['🟠 Urgent', 'urgent'],
  expired: ['🔴 Expired', 'expired'],
};

function batchCard(b) {
  const col = STATE_META[b.state] ? b.state : 'expired';
  return `<div class="batch-card ${col}" data-id="${b.id}">
    <div class="bc-top">${esc(b.emoji) || '📦'} <span class="grow">${esc(b.productName)}</span>
      <span class="badge ${b.grade === 'A' ? 'green' : b.grade === 'B' ? 'blue' : 'gray'}">${esc(b.grade)}</span></div>
    <div class="bc-meta">
      ${esc(b.code)} · <strong>${fmtQty(b.qty_remaining)} ${esc(b.unit)}</strong> · ${money(b.valueCents)}
      <br>${b.daysLeft >= 0 ? `⏳ ${b.daysLeft}d left` : `⚠️ ${-b.daysLeft}d overdue`}
      ${b.discount_pct ? ` · <strong style="color:var(--amber)">-${b.discount_pct}%</strong>` : ''}
      ${b.state === 'quarantined' ? ' · 🚫 Quarantined' : ''}
    </div>
  </div>`;
}

ROUTES.batches = ['Batches & Lots', async (el) => {
  el.innerHTML = `
    <div class="toolbar">
      <input type="search" id="bq" placeholder="🔍 Search product, code or origin…">
      <div class="spacer"></div>
      <button class="btn" id="log-temp">🌡️ Log Temperature</button>
    </div>
    <div class="kanban" id="kanban"></div>
    <h2 style="font-size:16px;margin:20px 0 12px">❄️ Storage Zones / Cold Chain</h2>
    <div class="supplier-grid" id="zones"><div class="empty">Loading…</div></div>`;

  async function load() {
    const q = $('#bq').value.trim();
    const [list, zones] = await Promise.all([
      api('/batches' + (q ? '?q=' + encodeURIComponent(q) + '&open=1' : '')),
      api('/zones'),
    ]);
    const cols = { fresh: [], aging: [], urgent: [], expired: [] };
    for (const b of list) cols[STATE_META[b.state] ? b.state : 'expired'].push(b);
    $('#kanban').innerHTML = Object.entries(STATE_META).map(([state, [label]]) => `
      <div class="kanban-col ${state}">
        <h3>${label}<span>${cols[state].length}</span></h3>
        ${cols[state].map(batchCard).join('') || '<div class="muted small" style="padding:6px 2px">—</div>'}
      </div>`).join('');
    $$('#kanban .batch-card').forEach((c) => (c.onclick = () => batchModal(Number(c.dataset.id), load)));
    $('#zones').innerHTML = zones.map((z) => `
      <div class="card zone-card ${z.breach ? 'breach' : ''}">
        <div class="flex"><strong class="grow">${esc(z.name)}</strong>
          ${z.breach ? '<span class="badge red">BREACH</span>' : z.lastTemp != null ? '<span class="badge green">OK</span>' : ''}</div>
        <div class="sc-row">🌡️ Last: <strong>${z.lastTemp != null ? z.lastTemp + ' °C' : 'no readings'}</strong> · limits ${z.min_temp ?? '–'}…${z.max_temp ?? '–'} °C</div>
        <div class="sc-row">📦 ${z.batchCount} batch(es) stored</div>
        <button class="btn sm mt" data-zone="${z.id}">＋ Log reading</button>
      </div>`).join('');
    $$('#zones [data-zone]').forEach((btn) =>
      (btn.onclick = async () => {
        const v = prompt('Temperature °C for this zone:');
        if (v == null || v === '') return;
        try {
          const r = await api(`/zones/${btn.dataset.zone}/readings`, { method: 'POST', body: JSON.stringify({ tempC: parseFloat(v) }) });
          toast(r.breach ? '⚠️ Reading recorded — BREACH detected!' : 'Reading recorded');
          load();
        } catch (e) {
          toast(e.message, true);
        }
      })
    );
  }

  $('#log-temp').onclick = () => $('#zones').scrollIntoView({ behavior: 'smooth' });
  $('#bq').addEventListener('input', debounce(load));
  await load();
}];

async function batchModal(id, onDone) {
  const b = await api('/batches/' + id);
  openModal(
    modalShell(
      `${esc(b.emoji)} ${esc(b.productName)} · ${esc(b.code)}`,
      `
      <table class="tbl"><tbody>
        <tr><td>Grade</td><td><strong>${esc(b.grade)}</strong> ${b.discount_pct ? `<span class="badge amber">-${b.discount_pct}% markdown</span>` : ''}</td>
            <td>Status</td><td>${b.status === 'available' ? '<span class="badge green">Available</span>' : `<span class="badge gray">${esc(b.status)}</span>`}</td></tr>
        <tr><td>Remaining</td><td><strong>${fmtQty(b.qty_remaining)} / ${fmtQty(b.qty_initial)} ${esc(b.unit)}</strong></td>
            <td>Value at cost</td><td><strong>${money(Math.round(b.qty_remaining * b.unit_cost_cents))}</strong></td></tr>
        <tr><td>Supplier</td><td colspan="3">${esc(b.supplierName || '—')} · Origin: ${esc(b.origin || '—')}</td></tr>
        <tr><td>Received</td><td>${esc((b.received_at || '').slice(0, 10))}</td>
            <td>Expires</td><td><strong>${esc((b.expiry_date || '').slice(0, 10))}</strong> (${b.expiry_date <= new Date().toISOString().slice(0, 19).replace('T', ' ').slice(0, 10) ? 'expired' : Math.ceil((new Date(b.expiry_date) - Date.now()) / 86400000) + 'd'})</td></tr>
        <tr><td>Zone</td><td colspan="3">${esc(b.zoneName || 'Unassigned')}</td></tr>
      </tbody></table>
      ${b.inspections.length ? `<h2 style="font-size:15px;margin:16px 0 8px">🔍 Inspections (${b.inspections.length})</h2>
        <table class="tbl"><thead><tr><th>Date</th><th>Result</th><th>Scores A/F/R/D</th><th>Acc/Rej</th></tr></thead>
        <tbody>${b.inspections.slice(0, 5).map((i) => `<tr>
          <td class="muted small">${esc((i.created_at || '').slice(0, 10))}</td>
          <td><span class="badge ${i.result === 'pass' ? 'green' : i.result === 'partial' ? 'amber' : 'red'}">${esc(i.result)}</span></td>
          <td class="muted small">${i.appearance}/${i.firmness}/${i.ripeness}/${i.damage}${i.temp_c != null ? ' · ' + i.temp_c + '°C' : ''}</td>
          <td class="num small">${fmtQty(i.accepted_qty)}/${fmtQty(i.rejected_qty)}</td></tr>`).join('')}</tbody></table>` : ''}
      `,
      `<button class="btn" id="bm-inspect">🔍 Inspect</button>
       <button class="btn" id="bm-discount">% Markdown</button>
       <button class="btn danger" id="bm-dispose">🗑️ Dispose</button>
       <button class="btn primary" data-close>Close</button>`
    ),
    true
  );
  bindModalClose($('#modal-content'));
  $('#bm-discount').onclick = () => markdownForm(b, onDone);
  $('#bm-dispose').onclick = () => disposeForm(b, onDone);
  $('#bm-inspect').onclick = () => inspectForm(b, onDone);
}

async function markdownForm(b, onDone) {
  openModal(
    modalShell(`Markdown · ${esc(b.code)}`,
      `<form id="mkf">
        <p class="muted small" style="margin-top:0">Current markdown: <strong>${b.discount_pct}%</strong>. POS prices from this batch drop accordingly (grade multiplier still applies).</p>
        <div class="form-row"><label>Discount %</label><input name="pct" type="number" min="0" max="100" value="${Math.max(b.discount_pct, 25)}" class="field"></div>
      </form>`,
      `<button class="btn" data-close>Cancel</button><button class="btn primary" id="mkf-go">Apply</button>`));
  bindModalClose($('#modal-content'));
  $('#mkf-go').onclick = async () => {
    const pct = parseInt(new FormData($('#mkf')).get('pct'), 10) || 0;
    await api(`/batches/${b.id}/discount`, { method: 'POST', body: JSON.stringify({ discountPct: pct }) });
    closeModal();
    toast(`${b.code} marked down ${pct}%`);
    onDone?.();
  };
}

async function disposeForm(b, onDone) {
  const reasons = await api('/meta/waste-reasons');
  openModal(
    modalShell(`Dispose stock · ${esc(b.code)}`,
      `<form id="dpf">
        <p class="muted small" style="margin-top:0">Remaining in batch: <strong>${fmtQty(b.qty_remaining)} ${esc(b.unit)}</strong>. Disposal is recorded as waste at cost value.</p>
        <div class="form-cols">
          <div class="form-row"><label>Quantity *</label><input name="qty" type="number" step="any" min="0.01" max="${b.qty_remaining}" value="${b.qty_remaining}" class="field" required></div>
          <div class="form-row"><label>Reason</label><select name="reason" class="field">
            ${reasons.map((r) => `<option value="${r}">${r.replace(/_/g, ' ')}</option>`).join('')}
          </select></div>
        </div>
        <div class="form-row"><label>Note</label><input name="note" class="field" placeholder="Optional details"></div>
      </form>`,
      `<button class="btn" data-close>Cancel</button><button class="btn danger" id="dpf-go">Record Waste</button>`));
  bindModalClose($('#modal-content'));
  $('#dpf-go').onclick = async () => {
    const f = new FormData($('#dpf'));
    try {
      await api(`/batches/${b.id}/dispose`, {
        method: 'POST',
        body: JSON.stringify({ qty: parseFloat(f.get('qty')), reason: f.get('reason'), note: f.get('note') }),
      });
      closeModal();
      toast('Disposal recorded');
      onDone?.();
    } catch (e) {
      toast(e.message, true);
    }
  };
}

async function inspectForm(b, onDone) {
  openModal(
    modalShell(`Quality inspection · ${esc(b.code)}`,
      `<form id="iqf">
        <div class="form-cols-3">
          ${[['appearance', 'Appearance'], ['firmness', 'Firmness'], ['ripeness', 'Ripeness']].map(([n, l]) => `
            <div class="form-row"><label>${l} (1-5)</label><input name="${n}" type="number" min="1" max="5" value="4" class="field"></div>`).join('')}
        </div>
        <div class="form-cols-3">
          <div class="form-row"><label>Damage level (1=min)</label><input name="damage" type="number" min="1" max="5" value="2" class="field"></div>
          <div class="form-row"><label>Pulp temp °C</label><input name="tempC" type="number" step="0.1" class="field" placeholder="e.g. 5.5"></div>
          <div class="form-row"><label>Rejected qty</label><input name="rejectedQty" type="number" step="any" min="0" max="${b.qty_remaining}" value="0" class="field"></div>
        </div>
        <div class="form-cols">
          <div class="form-row"><label>Outcome</label><select name="result" class="field">
            <option value="pass">Pass — accept into stock</option>
            <option value="partial">Partial — reject some qty</option>
            <option value="quarantine">Quarantine pending review</option>
            <option value="reject">Reject whole batch</option>
          </select></div>
          <div class="form-row"><label>Inspector</label><input name="inspector" class="field" placeholder="Name / desk"></div>
        </div>
        <div class="form-row"><label>Notes</label><input name="notes" class="field" placeholder="Defects observed…"></div>
      </form>`,
      `<button class="btn" data-close>Cancel</button><button class="btn primary" id="iqf-go">Save Inspection</button>`),
    true);
  bindModalClose($('#modal-content'));
  $('#iqf-go').onclick = async () => {
    const f = new FormData($('#iqf'));
    try {
      await api(`/batches/${b.id}/inspect`, {
        method: 'POST',
        body: JSON.stringify({
          appearance: +f.get('appearance'), firmness: +f.get('firmness'),
          ripeness: +f.get('ripeness'), damage: +f.get('damage'),
          tempC: f.get('tempC') ? parseFloat(f.get('tempC')) : null,
          rejectedQty: parseFloat(f.get('rejectedQty')) || 0,
          result: f.get('result'), inspector: f.get('inspector'), notes: f.get('notes'),
        }),
      });
      closeModal();
      toast('Inspection saved');
      onDone?.();
    } catch (e) {
      toast(e.message, true);
    }
  };
}

ROUTES.purchasing = ['Purchasing', async (el) => {
  el.innerHTML = `
    <div class="toolbar">
      <input type="search" id="poq" placeholder="🔍 Filter supplier or code…" hidden>
      <div class="spacer"></div>
      <button class="btn primary" id="new-po">＋ New Purchase Order</button>
    </div>
    <div class="tbl-wrap"><table class="tbl">
      <thead><tr><th>PO</th><th>Supplier</th><th>Status</th><th>Expected</th><th class="num">Est. Value</th><th>Progress</th><th class="right">Actions</th></tr></thead>
      <tbody id="pobody"><tr><td colspan="7" class="muted">Loading…</td></tr></tbody>
    </table></div>`;

  async function load() {
    const rows = await api('/purchase-orders');
    const stBadge = (st) => ({ draft: 'gray', ordered: 'blue', receiving: 'amber', completed: 'green', cancelled: 'red' }[st] || 'gray');
    $('#pobody').innerHTML =
      rows.length === 0
        ? '<tr><td colspan="7" class="empty"><span class="big">📋</span>No purchase orders yet.</td></tr>'
        : rows
            .map((po) => `<tr data-id="${po.id}" style="cursor:pointer">
              <td><strong>#${po.code}</strong></td>
              <td>${esc(po.supplierName)}</td>
              <td><span class="badge ${stBadge(po.status)}">${po.status}</span></td>
              <td class="muted">${po.expected_date ? esc(po.expected_date.slice(0, 10)) : '—'}</td>
              <td class="num">${money(po.status === 'completed' ? po.acceptedValueCents : po.est_total_cents)}</td>
              <td><div class="bar-cell"><div class="bar-track"><div class="bar-fill" style="width:${po.totalQty ? Math.min(100, (po.receivedQty / po.totalQty) * 100) : 0}%"></div></div><span class="small muted">${fmtQty(po.receivedQty)}/${fmtQty(po.totalQty)}</span></div></td>
              <td><div class="actions">${['draft', 'ordered'].includes(po.status) ? '<span class="badge blue">open</span>' : ''}</div></td>
            </tr>`)
            .join('');
    $$('#pobody tr[data-id]').forEach((tr) => (tr.onclick = () => poDetail(Number(tr.dataset.id))));
  }

  async function poDetail(id) {
    const po = await api('/purchase-orders/' + id);
    openModal(
      modalShell(`Purchase Order #${po.code}`,
        `<p class="muted small" style="margin-top:0">Supplier: <strong>${esc(po.supplierName)}</strong> · Status: <strong>${po.status}</strong> · Expected: ${po.expected_date ? esc(po.expected_date.slice(0, 10)) : '—'}</p>
         <table class="tbl"><thead><tr><th>Product</th><th class="num">Ordered</th><th class="num">Received</th><th class="num">Accepted</th><th class="num">Rejected</th><th class="num">Unit Cost</th></tr></thead>
         <tbody>${po.items.map((i) => `<tr>
           <td>${esc(i.emoji)} ${esc(i.productName)}</td>
           <td class="num">${fmtQty(i.qty)}</td>
           <td class="num">${fmtQty(i.qty_received)}</td>
           <td class="num" style="color:var(--green)">${fmtQty(i.qty_accepted)}</td>
           <td class="num" style="color:${i.qty_rejected ? 'var(--red)' : 'inherit'}">${fmtQty(i.qty_rejected)}</td>
           <td class="num">${money(i.unit_cost_cents)}</td></tr>`).join('')}</tbody></table>`,
        `${po.status === 'draft' ? '<button class="btn primary" id="po-order">📤 Submit to Supplier</button>' : ''}
         ${['ordered', 'receiving'].includes(po.status) ? '<button class="btn primary" id="po-receive">📥 Receive Goods</button>' : ''}
         ${['draft', 'ordered'].includes(po.status) ? '<button class="btn danger" id="po-cancel">✕ Cancel PO</button>' : ''}
         <button class="btn" data-close>Close</button>`),
      true);
    bindModalClose($('#modal-content'));
    $('#po-order').onclick = async () => {
      await api(`/purchase-orders/${id}/order`, { method: 'POST' });
      toast('PO submitted to supplier');
      closeModal();
      load();
    };
    $('#po-cancel').onclick = async () => {
      if (!confirm('Cancel this purchase order?')) return;
      await api(`/purchase-orders/${id}/cancel`, { method: 'POST' });
      toast('PO cancelled');
      closeModal();
      load();
    };
    $('#po-receive')?.addEventListener('click', () => receiveForm(po));
  }

  async function receiveForm(po) {
    openModal(
      modalShell(`Receive Goods · #${po.code}`,
        `<form id="rcv">
          <p class="muted small" style="margin-top:0">Enter what actually arrived. Quality scores drive the batch grade automatically (A ≥ 84%, B ≥ 60%).</p>
          ${po.items.map((i) => `
            <div class="card mb" style="padding:12px">
              <strong>${esc(i.emoji)} ${esc(i.productName)}</strong> <span class="muted small">ordered ${fmtQty(i.qty)} ${esc(i.unit)}</span>
              <div class="form-cols-3 mt" style="margin-top:8px">
                <div class="form-row"><label>Accepted qty</label><input name="acc-${i.id}" type="number" step="any" min="0" value="${Math.max(i.qty - i.qty_received, 0)}" class="field"></div>
                <div class="form-row"><label>Rejected qty</label><input name="rej-${i.id}" type="number" step="any" min="0" value="0" class="field"></div>
                <div class="form-row"><label>Pulp temp °C</label><input name="temp-${i.id}" type="number" step="0.1" class="field" placeholder="optional"></div>
              </div>
              <div class="form-cols-4" style="display:grid;grid-template-columns:repeat(4,1fr);gap:8px">
                ${[['appearance', 'Appear'], ['firmness', 'Firm'], ['ripeness', 'Ripe'], ['damage', 'Damage']].map(([n, l]) => `
                  <div class="form-row"><label>${l} (1-5)</label><input name="${n}-${i.id}" type="number" min="1" max="5" value="${n === 'damage' ? 2 : 4}" class="field"></div>`).join('')}
              </div>
              <div class="form-row"><label>Line notes</label><input name="note-${i.id}" class="field" placeholder="Condition remarks"></div>
            </div>`).join('')}
          <div class="form-row"><label>Inspector</label><input name="inspector" class="field" value="Receiving Bay 1"></div>
        </form>`,
        `<button class="btn" data-close>Cancel</button><button class="btn primary" id="rcv-go">📥 Create Batches</button>`),
      true);
    bindModalClose($('#modal-content'));
    $('#rcv-go').onclick = async () => {
      const f = new FormData($('#rcv'));
      const lines = po.items.map((i) => ({
        itemId: i.id,
        acceptedQty: parseFloat(f.get(`acc-${i.id}`)) || 0,
        rejectedQty: parseFloat(f.get(`rej-${i.id}`)) || 0,
        tempC: f.get(`temp-${i.id}`) ? parseFloat(f.get(`temp-${i.id}`)) : null,
        appearance: +f.get(`appearance-${i.id}`),
        firmness: +f.get(`firmness-${i.id}`),
        ripeness: +f.get(`ripeness-${i.id}`),
        damage: +f.get(`damage-${i.id}`),
        notes: f.get(`note-${i.id}`) || '',
      })).filter((l) => l.acceptedQty + l.rejectedQty > 0);
      if (!lines.length) return toast('Nothing to receive', true);
      try {
        const r = await api(`/purchase-orders/${po.id}/receive`, {
          method: 'POST',
          body: JSON.stringify({ lines, inspector: f.get('inspector') }),
        });
        closeModal();
        toast(r.completed ? `Received ✓ batches created: ${r.batchesCreated.join(', ')}` : 'Partially received');
        route();
      } catch (e) {
        toast(e.message, true);
      }
    };
  }

  async function newPOForm() {
    const [sups, prods] = await Promise.all([api('/suppliers'), api('/products?active=all')]);
    let lineNo = 0;
    const renderLines = () => {
      $('#po-lines').innerHTML = poLines
        .map(
          (l, idx) => `<div class="flex mb" data-ln="${idx}">
            <select class="field grow" data-f="productId">
              <option value="">Select produce…</option>
              ${prods.map((p) => `<option value="${p.id}" ${l.productId === p.id ? 'selected' : ''}>${esc(p.emoji)} ${esc(p.name)} (${esc(p.unit)})</option>`).join('')}
            </select>
            <input class="field" style="width:110px" type="number" step="any" min="0" placeholder="Qty" data-f="qty" value="${l.qty ?? ''}">
            <input class="field" style="width:130px" type="number" step="0.01" min="0" placeholder="Unit cost $" data-f="cost" value="${l.cost ?? ''}">
            <button type="button" class="btn sm danger" data-rm="${idx}">✕</button>
          </div>`
        )
        .join('');
      $$('#po-lines select,#po-lines input').forEach((inp) =>
        (inp.onchange = () => {
          const idx = Number(inp.closest('[data-ln]').dataset.ln);
          poLines[idx][inp.dataset.f] = inp.value;
          if (inp.dataset.f === 'productId' && !poLines[idx].cost) {
            const p = prods.find((x) => x.id === Number(inp.value));
            if (p) {
              poLines[idx].cost = (p.costCents / 100).toFixed(2);
              renderLines();
            }
          }
        })
      );
      $$('#po-lines [data-rm]').forEach((b) => (b.onclick = () => {
        poLines.splice(Number(b.dataset.rm), 1);
        renderLines();
      }));
    };
    openModal(
      modalShell('New Purchase Order',
        `<form id="npof">
          <div class="form-cols">
            <div class="form-row"><label>Supplier *</label><select name="supplierId" class="field">
              ${sups.map((s) => `<option value="${s.id}">${esc(s.name)}</option>`).join('')}
            </select></div>
            <div class="form-row"><label>Expected delivery</label><input name="expectedDate" type="date" class="field" value="${new Date(Date.now() + 2 * 86400000).toISOString().slice(0, 10)}"></div>
          </div>
          <label style="font-size:13px;font-weight:600;color:var(--muted)">Items</label>
          <div id="po-lines"></div>
          <button type="button" class="btn sm" id="add-line">＋ Add item</button>
          <div class="form-row mt"><label>Notes</label><input name="notes" class="field"></div>
        </form>`,
        `<button class="btn" data-close>Cancel</button><button class="btn primary" id="npof-save">Create Draft PO</button>`),
      true);
    const poLines = [{ productId: '', qty: '', cost: '' }];
    bindModalClose($('#modal-content'));
    renderLines();
    $('#add-line').onclick = () => {
      poLines.push({ productId: '', qty: '', cost: '' });
      renderLines();
    };
    $('#npof-save').onclick = async () => {
      const f = new FormData($('#npof'));
      try {
        await api('/purchase-orders', {
          method: 'POST',
          body: JSON.stringify({
            supplierId: Number(f.get('supplierId')),
            expectedDate: f.get('expectedDate') || null,
            notes: f.get('notes'),
            items: poLines.filter((l) => l.productId && l.qty > 0).map((l) => ({
              productId: Number(l.productId),
              qty: parseFloat(l.qty),
              unitCostCents: Math.round(parseFloat(l.cost || 0) * 100),
            })),
          }),
        });
        closeModal();
        toast('Draft purchase order created');
        load();
      } catch (e) {
        toast(e.message, true);
      }
    };
  }

  $('#new-po').onclick = () => newPOForm();
  await load();
}];

ROUTES.waste = ['Waste & Spoilage', async (el) => {
  el.innerHTML = `
    <div class="toolbar">
      <div class="chips" id="w-range">
        <button class="chip active" data-days="7">7 days</button>
        <button class="chip" data-days="30">30 days</button>
        <button class="chip" data-days="90">90 days</button>
      </div>
      <div class="spacer"></div>
      <button class="btn primary" id="rec-waste">＋ Record Waste / Spoilage</button>
    </div>
    <div id="w-body"></div>`;

  let days = 7;
  async function load() {
    const [a, list] = await Promise.all([
      api('/waste/analytics?days=' + days),
      api('/waste?days=' + days),
    ]);
    const topReason = a.byReason[0]?.reason?.replace(/_/g, ' ');
    $('#w-body').innerHTML = `
      <div class="grid-cards">
        <div class="card stat"><div class="stat-label">Waste Value (${days}d)</div><div class="stat-value" style="color:var(--red)">${money(a.wasteValueCents)}</div><div class="stat-sub">${a.events} events · ${fmtQty(a.totalQty)} units</div></div>
        <div class="card stat"><div class="stat-label">% of Purchases</div><div class="stat-value">${a.wastePctOfPurchases != null ? a.wastePctOfPurchases + '%' : '—'}</div><div class="stat-sub">purchases ${money(a.purchaseValueCents)}</div></div>
        <div class="card stat"><div class="stat-label">Top Cause</div><div class="stat-value" style="font-size:20px;text-transform:capitalize">${topReason || '—'}</div><div class="stat-sub">${a.byReason[0] ? money(a.byReason[0].valueCents) : ''}</div></div>
        <div class="card stat"><div class="stat-label">Top Product</div><div class="stat-value" style="font-size:20px">${a.byProduct[0] ? esc(a.byProduct[0].emoji) + ' ' + esc(a.byProduct[0].productName) : '—'}</div><div class="stat-sub">${a.byProduct[0] ? money(a.byProduct[0].valueCents) : ''}</div></div>
      </div>
      <div class="dash-grid mt">
        <div class="card"><h2>Waste by Cause</h2>
          ${a.byReason.length === 0 ? '<p class="muted">No waste recorded 🎉</p>' : a.byReason.map((r) => `
            <div class="mb"><div class="flex small"><span style="text-transform:capitalize">${r.reason.replace(/_/g, ' ')}</span><span class="grow"></span><strong>${money(r.valueCents)}</strong></div>
            <div class="bar-cell" style="margin-top:6px"><div class="bar-track"><div class="bar-fill" style="background:var(--red);width:${Math.max(2, (r.valueCents / a.wasteValueCents) * 100)}%"></div></div></div></div>`).join('')}
        </div>
        <div class="card"><h2>Worst Products & Suppliers</h2>
          ${a.byProduct.slice(0, 5).map((p) => `<div class="alert-list" style="border:none"><li><span>${esc(p.emoji)}</span><div class="al-name">${esc(p.productName)}<div class="al-sub">${fmtQty(p.qty)} ${esc(p.unit)} lost</div></div><strong>${money(p.valueCents)}</strong></li></div>`).join('') || ''}
          <hr style="border:none;border-top:1px dashed var(--line);margin:10px 0">
          ${(a.bySupplier || []).slice(0, 4).map((s) => `<div class="flex small mb"><span>🚚 ${esc(s.supplierName)}</span><span class="grow"></span><strong style="color:var(--red)">${money(s.valueCents)}</strong></div>`).join('')}
        </div>
      </div>
      <div class="mt"><table class="tbl"><thead><tr><th>When</th><th>Product</th><th>Batch</th><th class="num">Qty</th><th class="num">Value</th><th>Cause</th><th>Note</th></tr></thead>
        <tbody>${list.length === 0 ? '<tr><td colspan="7" class="muted">Nothing wasted in this period.</td></tr>' : list.map((w) => `<tr>
          <td class="muted small">${fmtDate(w.created_at)}</td>
          <td><strong>${esc(w.emoji)} ${esc(w.productName)}</strong></td>
          <td>${w.batch_id ? '#' + w.batch_id : '—'}</td>
          <td class="num">${fmtQty(w.qty)} ${esc(w.unit)}</td>
          <td class="num" style="color:var(--red)">${money(w.value_cents)}</td>
          <td><span class="badge red">${esc(w.reason.replace(/_/g, ' '))}</span></td>
          <td class="muted small">${esc(w.note || '')}</td></tr>`).join('')}</tbody></table></div>`;
  }

  $('#w-range').addEventListener('click', (e) => {
    const ch = e.target.closest('[data-days]');
    if (!ch) return;
    days = Number(ch.dataset.days);
    $$('#w-range .chip').forEach((c) => c.classList.toggle('active', c === ch));
    load();
  });

  $('#rec-waste').onclick = async () => {
    const batches = await api('/batches');
    if (!batches.length) return toast('No open batches to dispose from', true);
    openModal(
      modalShell('Record Waste / Spoilage',
        `<form id="wf">
          <div class="form-row"><label>Batch *</label><select name="batchId" class="field" required>
            ${batches.map((b) => `<option value="${b.id}">${esc(b.emoji)} ${esc(b.productName)} · ${esc(b.code)} (${fmtQty(b.qty_remaining)} ${esc(b.unit)}, exp ${esc(b.expiry_date.slice(0, 10))})</option>`).join('')}
          </select></div>
          <div class="form-cols">
            <div class="form-row"><label>Quantity *</label><input name="qty" type="number" step="any" min="0.01" class="field" required></div>
            <div class="form-row"><label>Cause</label><select name="reason" class="field">
              ${(await api('/meta/waste-reasons')).map((r) => `<option value="${r}">${r.replace(/_/g, ' ')}</option>`).join('')}
            </select></div>
          </div>
          <div class="form-row"><label>Note</label><input name="note" class="field"></div>
        </form>`,
        `<button class="btn" data-close>Cancel</button><button class="btn danger" id="wf-go">Record Waste</button>`));
    bindModalClose($('#modal-content'));
    $('#wf-go').onclick = async () => {
      const f = new FormData($('#wf'));
      try {
        await api(`/batches/${f.get('batchId')}/dispose`, {
          method: 'POST',
          body: JSON.stringify({ qty: parseFloat(f.get('qty')), reason: f.get('reason'), note: f.get('note') }),
        });
        closeModal();
        toast('Waste recorded');
        load();
      } catch (e) {
        toast(e.message, true);
      }
    };
  };

  await load();
}];

ROUTES.subscriptions = ['Subscriptions', async (el) => {
  el.innerHTML = `
    <div class="toolbar">
      <button class="btn" id="run-due">▶ Run Due Orders</button>
      <div class="spacer"></div>
      <button class="btn primary" id="new-sub">＋ New Subscription</button>
    </div>
    <div class="tbl-wrap"><table class="tbl">
      <thead><tr><th>Title</th><th>Customer</th><th>Box contents</th><th>Every</th><th>Next run</th><th class="num">Est. Price</th><th>Status</th><th class="right">Actions</th></tr></thead>
      <tbody id="subbody"><tr><td colspan="8" class="muted">Loading…</td></tr></tbody>
    </table></div>`;

  async function load() {
    const rows = await api('/subscriptions');
    $('#subbody').innerHTML =
      rows.length === 0
        ? '<tr><td colspan="8" class="empty"><span class="big">🔁</span>No subscriptions yet.</td></tr>'
        : rows
            .map((s) => `<tr>
              <td><strong>${esc(s.title)}</strong></td>
              <td>${esc(s.customerName)}</td>
              <td class="small muted">${s.items.map((i) => `${esc(i.emoji)}${fmtQty(i.qty)}${esc(i.unit)}`).join(' · ')}</td>
              <td>${s.freq_days}d</td>
              <td>${esc(s.next_run)}</td>
              <td class="num">${money(s.estPriceCents)}</td>
              <td>${s.active ? '<span class="badge green">Active</span>' : '<span class="badge gray">Paused</span>'}</td>
              <td><div class="actions"><button class="btn xs" data-tgl="${s.id}">${s.active ? 'Pause' : 'Resume'}</button></div></td>
            </tr>`)
            .join('');
    $$('#subbody [data-tgl]').forEach((b) =>
      (b.onclick = async () => {
        await api(`/subscriptions/${b.dataset.tgl}/toggle`, { method: 'POST' });
        load();
      })
    );
  }

  $('#run-due').onclick = async () => {
    const r = await api('/subscriptions/run-due', { method: 'POST' });
    if (r.generated.length)
      toast(`Generated ${r.generated.length} order(s): ${r.generated.map((g) => '#' + g.orderId).join(', ')}`);
    else toast('Nothing due today');
    r.errors.forEach((e) => toast(`Sub #${e.subscriptionId}: ${e.error}`, true));
    load();
  };

  $('#new-sub').onclick = async () => {
    const [custs, prods] = await Promise.all([api('/customers'), api('/products')]);
    const lines = [{ productId: prods[0]?.id || '', qty: 1 }];
    const renderLines = () => {
      $('#sub-lines').innerHTML = lines
        .map(
          (l, idx) => `<div class="flex mb" data-ln="${idx}">
            <select class="field grow" data-f="productId">
              ${prods.map((p) => `<option value="${p.id}" ${Number(l.productId) === p.id ? 'selected' : ''}>${esc(p.emoji)} ${esc(p.name)} (${esc(p.unit)})</option>`).join('')}
            </select>
            <input class="field" style="width:100px" type="number" step="any" min="0.01" data-f="qty" value="${l.qty}">
            <button type="button" class="btn sm danger" data-rm="${idx}">✕</button>
          </div>`
        )
        .join('');
      $$('#sub-lines select, #sub-lines input').forEach((inp) =>
        (inp.onchange = () => (lines[Number(inp.closest('[data-ln]').dataset.ln)][inp.dataset.f] = inp.value))
      );
      $$('#sub-lines [data-rm]').forEach((b) => (b.onclick = () => {
        lines.splice(Number(b.dataset.rm), 1);
        renderLines();
      }));
    };
    openModal(
      modalShell('New Subscription Box',
        `<form id="nsf">
          <div class="form-cols">
            <div class="form-row"><label>Customer *</label><select name="customerId" class="field">
              ${custs.map((c) => `<option value="${c.id}">${esc(c.name)} (${esc(c.segment)})</option>`).join('')}
            </select></div>
            <div class="form-row"><label>Title *</label><input name="title" class="field" required placeholder="Weekly Veggie Box"></div>
          </div>
          <div class="form-cols">
            <div class="form-row"><label>Every (days)</label><input name="freqDays" type="number" min="1" max="90" value="7" class="field"></div>
            <div class="form-row"><label>First delivery</label><input name="nextRun" type="date" class="field" value="${new Date(Date.now() + 86400000).toISOString().slice(0, 10)}"></div>
          </div>
          <label style="font-size:13px;font-weight:600;color:var(--muted)">Box contents</label>
          <div id="sub-lines"></div>
          <button type="button" class="btn sm" id="add-line">＋ Add produce</button>
        </form>`,
        `<button class="btn" data-close>Cancel</button><button class="btn primary" id="nsf-save">Create</button>`));
    bindModalClose($('#modal-content'));
    renderLines();
    $('#add-line').onclick = () => {
      lines.push({ productId: prods[0]?.id, qty: 1 });
      renderLines();
    };
    $('#nsf-save').onclick = async () => {
      const f = new FormData($('#nsf'));
      try {
        await api('/subscriptions', {
          method: 'POST',
          body: JSON.stringify({
            customerId: Number(f.get('customerId')),
            title: f.get('title'),
            freqDays: parseInt(f.get('freqDays'), 10),
            nextRun: f.get('nextRun'),
            items: lines.map((l) => ({ productId: Number(l.productId), qty: parseFloat(l.qty) })).filter((l) => l.productId && l.qty > 0),
          }),
        });
        closeModal();
        toast('Subscription created');
        load();
      } catch (e) {
        toast(e.message, true);
      }
    };
  };

  await load();
}];

ROUTES.finance = ['Receivables', async (el) => {
  el.innerHTML = '<div class="empty">Loading…</div>';
  const r = await api('/finance/receivables');
  el.innerHTML = `
    <div class="grid-cards">
      <div class="card stat"><div class="stat-label">Total Receivable</div><div class="stat-value">${money(r.totalReceivableCents)}</div><div class="stat-sub">${r.invoices.length} open invoice(s)</div></div>
      <div class="card stat"><div class="stat-label">Overdue</div><div class="stat-value" style="color:${r.overdueCents ? 'var(--red)' : 'var(--green)'}">${money(r.overdueCents)}</div><div class="stat-sub">past due date</div></div>
    </div>
    <div class="tbl-wrap mt"><table class="tbl">
      <thead><tr><th>Order</th><th>Date</th><th>Customer</th><th>Due</th><th class="num">Total</th><th class="num">Paid</th><th class="num">Balance</th><th class="right">Action</th></tr></thead>
      <tbody>${r.invoices.length === 0 ? '<tr><td colspan="8" class="empty"><span class="big">💰</span>All invoices settled.</td></tr>'
        : r.invoices.map((i) => `<tr>
            <td><a href="#/orders" onclick="location.hash='/orders'" style="text-decoration:none;color:var(--ink)">#${i.id}</a></td>
            <td class="muted">${esc(i.createdAt.slice(0, 10))}</td>
            <td><strong>${esc(i.customerName)}</strong></td>
            <td class="muted">${esc((i.dueDate || '').slice(0, 10))} ${i.overdue ? '<span class="badge red">overdue</span>' : ''}</td>
            <td class="num">${money(i.totalCents)}</td>
            <td class="num" style="color:var(--green)">${money(i.paidCents)}</td>
            <td class="num"><strong>${money(i.balanceCents)}</strong></td>
            <td><div class="actions"><button class="btn xs" data-pay="${i.id}" data-bal="${i.balanceCents}">💵 Payment</button></div></td></tr>`).join('')}</tbody>
    </table></div>`;
  $$('#view [data-pay]').forEach((b) =>
    (b.onclick = async () => {
      const sale = await api('/sales/' + b.dataset.pay);
      paymentForm(sale);
    })
  );
}];

ROUTES.insights = ['AI Insights', async (el) => {
  el.innerHTML = '<div class="empty"><span class="big">🤖</span>Analyzing your business…</div>';
  const [brief, perish, procure] = await Promise.all([
    api('/agents/executive-brief'),
    api('/agents/perishability'),
    api('/agents/procurement'),
  ]);

  const actionBadge = (a) => ({ dispose: 'red', discount: 'amber', bundle: 'blue', monitor: 'gray' }[a] || 'gray');

  el.innerHTML = `
    <div class="card mb"><div class="card-head"><h2>🎯 Executive Brief</h2><span class="muted small">${new Date(brief.generatedAt).toLocaleTimeString()}</span></div>
      <div class="grid-cards">
        <div class="stat"><div class="stat-label">Today vs 7d avg</div><div class="stat-value" style="font-size:20px">${money(brief.todayRevenueCents)}</div><div class="stat-sub">avg day ${money(brief.weekAvgDailyCents)}</div></div>
        <div class="stat"><div class="stat-label">Receivables outstanding</div><div class="stat-value" style="font-size:20px">${money(brief.receivableCents)}</div></div>
        <div class="stat"><div class="stat-label">Urgent batches</div><div class="stat-value" style="font-size:20px;color:${brief.urgentBatches.length ? 'var(--amber)' : 'var(--green)'}">${brief.urgentBatches.length}</div></div>
        <div class="stat"><div class="stat-label">Low stock items</div><div class="stat-value" style="font-size:20px">${brief.lowStock.length}</div></div>
      </div>
      <ul class="alert-list mt">
        ${brief.recommendedActions.map((a) => `<li><span>💡</span><div class="al-name" style="font-weight:500">${esc(a)}</div></li>`).join('') || '<li><span>✅</span><div class="al-name">All clear — no pressing issues detected.</div></li>'}
      </ul>
      ${brief.coldChainBreaches.map((z) => `<div class="card mt" style="border-left:4px solid var(--red);padding:10px 14px">❄️ <strong>${esc(z.name)}</strong>: ${z.lastTemp}°C (limits ${z.min_temp}…${z.max_temp}°C) — inspect and correct immediately.</div>`).join('')}
    </div>

    <div class="card mb"><div class="card-head"><h2>⏳ Perishability Agent</h2><span class="muted small">${perish.recommendations.length} batch(es) need attention</span></div>
      ${perish.recommendations.length === 0 ? '<p class="muted">No batches approaching expiry. Great freshness control!</p>' : `
      <table class="tbl"><thead><tr><th>Batch</th><th>Product</th><th class="num">Remaining</th><th>Expiry</th><th>Recommended Action</th><th class="right">Apply</th></tr></thead>
      <tbody>${perish.recommendations.map((r) => `<tr>
        <td><span class="badge blue">${esc(r.code)}</span></td>
        <td>${esc(r.emoji)} <strong>${esc(r.productName)}</strong></td>
        <td class="num">${fmtQty(r.qtyRemaining)} ${esc(r.unit)}</td>
        <td class="muted">${esc(r.expiryDate.slice(0, 10))} (${r.daysLeft < 0 ? -r.daysLeft + 'd over' : r.daysLeft + 'd'})</td>
        <td><span class="badge ${actionBadge(r.action)}" style="text-transform:capitalize">${esc(r.action)}</span>
            <span class="small muted"> ${esc(r.rationale)}</span></td>
        <td><div class="actions">
          ${r.action === 'discount' ? `<button class="btn xs" data-disc="${r.batchId}" data-pct="${r.suggestedDiscountPct}">-${r.suggestedDiscountPct}%</button>` : ''}
          ${r.action === 'dispose' ? `<button class="btn xs danger" data-disp="${r.batchId}" data-code="${esc(r.code)}" data-qty="${r.qtyRemaining}">Dispose</button>` : ''}
          ${r.action === 'bundle' ? `<span class="muted small">suggest promo</span>` : ''}
        </div></td></tr>`).join('')}</tbody></table>`}
    </div>

    <div class="card"><div class="card-head"><h2>📋 Procurement Agent</h2><span class="muted small">${procure.suggestions.length} suggestion(s)</span></div>
      ${procure.suggestions.length === 0 ? '<p class="muted">Stock levels are healthy across the catalog.</p>' : `
      <table class="tbl"><thead><tr><th>Product</th><th class="num">Stock</th><th class="num">Reorder at</th><th class="num">Suggested Qty</th><th>Driver</th><th class="right">Action</th></tr></thead>
      <tbody>${procure.suggestions.map((s) => `<tr>
        <td>${esc(s.emoji)} <strong>${esc(s.productName)}</strong></td>
        <td class="num">${fmtQty(s.stockQty)}</td>
        <td class="num muted">${fmtQty(s.reorderLevel)}</td>
        <td class="num"><strong>+${fmtQty(s.suggestQty)} ${esc(s.unit)}</strong></td>
        <td class="small muted">${esc(s.reason)}</td>
        <td><div class="actions"><button class="btn xs primary" data-po='${esc(JSON.stringify(s))}'>Draft PO</button></div></td></tr>`).join('')}</tbody></table>`}
    </div>`;

  $$('#view [data-disc]').forEach((b) =>
    (b.onclick = async () => {
      await api(`/batches/${b.dataset.disc}/discount`, { method: 'POST', body: JSON.stringify({ discountPct: Number(b.dataset.pct) }) });
      toast(`Markdown applied (-${b.dataset.pct}%)`);
      route();
    })
  );
  $$('#view [data-disp]').forEach((b) =>
    (b.onclick = async () => {
      if (!confirm(`Dispose all of batch ${b.dataset.code}?`)) return;
      try {
        await api(`/batches/${b.dataset.disp}/dispose`, { method: 'POST', body: JSON.stringify({ qty: parseFloat(b.dataset.qty), reason: 'expired', note: 'AI recommendation' }) });
        toast('Disposed & recorded as waste');
        route();
      } catch (e) {
        toast(e.message, true);
      }
    })
  );
  $$('#view [data-po]').forEach((b) =>
    (b.onclick = async () => {
      const s = JSON.parse(b.dataset.po);
      if (!s.supplierId) return toast('No supplier linked to this product — set one first', true);
      try {
        await api('/purchase-orders', {
          method: 'POST',
          body: JSON.stringify({
            supplierId: s.supplierId,
            expectedDate: new Date(Date.now() + 2 * 86400000).toISOString().slice(0, 10),
            notes: 'Auto-drafted by Procurement Agent',
            items: [{ productId: s.productId, qty: s.suggestQty, unitCostCents: s.unitCostCents }],
          }),
        });
        toast(`Draft PO created for ${s.productName}`);
      } catch (e) {
        toast(e.message, true);
      }
    })
  );
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
