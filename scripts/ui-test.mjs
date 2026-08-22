import { JSDOM } from 'jsdom';
import { readFileSync } from 'node:fs';

const html = readFileSync('public/index.html', 'utf8');
const appJs = readFileSync('public/js/app.js', 'utf8');

const dom = new JSDOM(html, {
  url: 'http://localhost:3000/',
  runScripts: 'outside-only',
  pretendToBeVisual: true,
});
const { window } = dom;

const errors = [];
window.addEventListener('error', (e) => errors.push('window.onerror: ' + e.message));

window.fetch = async (url, opts = {}) => {
  const res = await fetch(new URL(url, 'http://localhost:3000'), opts);
  return {
    ok: res.ok,
    status: res.status,
    statusText: res.statusText,
    json: async () => res.json(),
  };
};
window.HTMLDialogElement.prototype.showModal = function () { this.setAttribute('open', ''); };
window.HTMLDialogElement.prototype.close = function () { this.removeAttribute('open'); };
window.scrollTo = () => {};

try {
  window.eval(appJs);
} catch (e) {
  console.log('EVAL ERROR:', e.message);
  process.exit(1);
}

await new Promise((r) => setTimeout(r, 1500));
const doc = window.document;
console.log('hash:', doc.defaultView.location.hash);
console.log('errors so far:', errors.length ? errors : 'none');

function fire(el, type) {
  el.dispatchEvent(new window.Event(type, { bubbles: true }));
}

console.log('\n--- POS TEST ---');
doc.querySelector('a[href="#/pos"]')?.click();
await new Promise((r) => setTimeout(r, 1200));
console.log('after nav, tiles bound?', doc.querySelectorAll('#pos-tiles [data-add]').length);

const add = (id) => {
  const t = doc.querySelector(`#pos-tiles [data-add="${id}"]`);
  if (!t) return console.log(`tile ${id}: NOT FOUND`);
  t.click();
};

add(24);
add(25);
add(26);
await new Promise((r) => setTimeout(r, 200));
const lines = [...doc.querySelectorAll('.cart-line .cl-name')].map((e) => e.textContent.trim());
console.log('cart lines after 3 clicks:', JSON.stringify(lines));
console.log('dead-tile toast shown?', [...doc.querySelectorAll('.toast')].some((t) => t.textContent.includes('out of stock')));

const qtyInput = doc.querySelector('[data-qty]');
if (qtyInput) {
  qtyInput.value = '4';
  qtyInput.dispatchEvent(new window.Event('change', { bubbles: true }));
  await new Promise((r) => setTimeout(r, 100));
  const v = doc.querySelector('[data-qty]')?.value;
  console.log('qty input after set to 4 ->', v);
  const inc = doc.querySelector('[data-inc]');
  inc?.click();
  await new Promise((r) => setTimeout(r, 100));
  console.log('qty after + click ->', doc.querySelector('[data-qty]')?.value);
}

const paySel = doc.querySelector('#cart-pay');
paySel.value = 'card';
paySel.dispatchEvent(new window.Event('change', { bubbles: true }));
add(1);
await new Promise((r) => setTimeout(r, 150));
console.log('payment preserved after re-render?', doc.querySelector('#cart-pay').value);

const disc = doc.querySelector('#cart-discount');
disc.focus();
const beforeHtml = doc.querySelector('#cart-panel').innerHTML.length;
disc.value = '10';
disc.dispatchEvent(new window.Event('input', { bubbles: true }));
await new Promise((r) => setTimeout(r, 100));
console.log('focus kept while editing discount?', doc.activeElement === disc);
console.log('discount value still "10"?', doc.querySelector('#cart-discount').value === '10');
console.log('total updated to discount?', doc.querySelector('#sum-total').textContent);

const q2 = doc.querySelector('[data-qty]');
q2.focus();
q2.value = '2';
q2.dispatchEvent(new window.Event('input', { bubbles: true }));
await new Promise((r) => setTimeout(r, 100));
console.log('focus kept while typing qty?', doc.activeElement === q2);
console.log('line total updated live?', doc.querySelector('[data-lt]')?.textContent);
console.log('checkout label synced?', doc.querySelector('#checkout').textContent.trim());

const checkout = doc.querySelector('#checkout');
console.log('checkout enabled?', checkout && !checkout.disabled, '| label:', checkout?.textContent.trim());
console.log('final errors:', errors.length ? errors : 'none');
