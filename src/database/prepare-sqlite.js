import 'dotenv/config';
import fs from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

// Prisma 5 can fail to migrate when the SQLite file does not exist yet.
// Append mode creates an empty file without truncating an existing database.
const url = process.env.DATABASE_URL;
if (!url?.startsWith('file:') || !url.slice(5).split('?')[0]) {
  throw new Error('SQLite üçün DATABASE_URL="file:./dev.db" formatından istifadə et.');
}
const root = fileURLToPath(new URL('../', import.meta.url));
const file = path.resolve(root, 'prisma', url.slice(5).split('?')[0]);
await fs.mkdir(path.dirname(file), { recursive: true });
const handle = await fs.open(file, 'a', 0o600);
await handle.close();
