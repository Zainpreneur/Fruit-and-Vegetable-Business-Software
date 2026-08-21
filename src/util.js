export function sendJSON(res, status, data) {
  const body = JSON.stringify(data);
  res.writeHead(status, { 'Content-Type': 'application/json; charset=utf-8' });
  res.end(body);
}

export function bad(res, message, status = 400) {
  sendJSON(res, status, { error: message });
}

export function readJSON(req) {
  return new Promise((resolve, reject) => {
    let size = 0;
    const chunks = [];
    req.on('data', (c) => {
      size += c.length;
      if (size > 2_000_000) {
        reject(new Error('Payload too large'));
        req.destroy();
        return;
      }
      chunks.push(c);
    });
    req.on('end', () => {
      if (!chunks.length) return resolve({});
      try {
        resolve(JSON.parse(Buffer.concat(chunks).toString('utf8')));
      } catch {
        reject(new Error('Invalid JSON body'));
      }
    });
    req.on('error', reject);
  });
}

export const UNITS = ['kg', 'pcs', 'bunch', 'pack', 'dozen'];
export const PAYMENT_METHODS = ['cash', 'card', 'mobile'];

export function num(v) {
  const n = Number(v);
  return Number.isFinite(n) ? n : NaN;
}

export function intCents(v) {
  const n = Math.round(Number(v));
  return Number.isFinite(n) && n >= 0 ? n : NaN;
}

export function csvEscape(v) {
  const s = String(v ?? '');
  return /[",\n]/.test(s) ? `"${s.replace(/"/g, '""')}"` : s;
}
