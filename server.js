import http from 'node:http';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { createRouter } from './src/router.js';
import { sendJSON } from './src/util.js';
import { registerCatalogRoutes } from './src/routes/catalog.js';
import { registerPeopleRoutes } from './src/routes/people.js';
import { registerSalesRoutes } from './src/routes/sales.js';
import { registerInventoryRoutes } from './src/routes/inventory.js';
import { registerReportRoutes } from './src/routes/reports.js';
import { registerOperationsRoutes } from './src/routes/operations.js';
import { registerPurchasingRoutes } from './src/routes/purchasing.js';
import { registerBillingRoutes } from './src/routes/billing.js';
import { registerIntelligenceRoutes } from './src/routes/intelligence.js';
import './src/db.js';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const PUBLIC_DIR = path.join(__dirname, 'public');
const PORT = process.env.PORT || 3000;

const MIME = {
  '.html': 'text/html; charset=utf-8',
  '.css': 'text/css; charset=utf-8',
  '.js': 'text/javascript; charset=utf-8',
  '.json': 'application/json',
  '.svg': 'image/svg+xml',
  '.png': 'image/png',
  '.ico': 'image/x-icon',
  '.txt': 'text/plain; charset=utf-8',
};

function serveStatic(res, pathname) {
  let filePath = path.normalize(path.join(PUBLIC_DIR, pathname === '/' ? 'index.html' : pathname));
  if (!filePath.startsWith(PUBLIC_DIR)) {
    res.writeHead(403).end('Forbidden');
    return;
  }
  if (!fs.existsSync(filePath) || fs.statSync(filePath).isDirectory()) {
    filePath = path.join(PUBLIC_DIR, 'index.html');
  }
  const ext = path.extname(filePath).toLowerCase();
  res.writeHead(200, {
    'Content-Type': MIME[ext] || 'application/octet-stream',
    'Cache-Control': 'no-store',
  });
  fs.createReadStream(filePath).pipe(res);
}

const router = createRouter();
registerCatalogRoutes(router);
registerPeopleRoutes(router);
registerSalesRoutes(router);
registerInventoryRoutes(router);
registerReportRoutes(router);
registerOperationsRoutes(router);
registerPurchasingRoutes(router);
registerBillingRoutes(router);
registerIntelligenceRoutes(router);

const server = http.createServer(async (req, res) => {
  const url = new URL(req.url, `http://${req.headers.host || 'localhost'}`);
  try {
    if (url.pathname.startsWith('/api/')) {
      const handled = await router.handle(req, res, url);
      if (!handled) sendJSON(res, 404, { error: 'API endpoint not found' });
      return;
    }
    if (req.method !== 'GET') {
      res.writeHead(405).end();
      return;
    }
    serveStatic(res, url.pathname);
  } catch (e) {
    console.error('[server]', e);
    if (!res.headersSent) sendJSON(res, 500, { error: 'Internal server error: ' + e.message });
    else res.end();
  }
});

server.listen(PORT, () => {
  console.log(`\n  🥬 GreenBasket — Fruit & Vegetable Store Manager`);
  console.log(`  ➜ App + API running at http://localhost:${PORT}\n`);
});
