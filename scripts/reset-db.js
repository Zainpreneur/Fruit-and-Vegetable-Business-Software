import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const dbPath = path.join(__dirname, '..', 'data', 'store.db');
if (fs.existsSync(dbPath)) {
  fs.rmSync(dbPath);
  console.log('Database removed. It will be re-seeded on next start.');
} else {
  console.log('No database file found.');
}
