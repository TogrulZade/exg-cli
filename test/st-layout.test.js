import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import path from 'node:path';
import os from 'node:os';
import { usesSt } from '../src/layout.js';
import { installQueue } from '../src/install-queue.js';
import { makeJob } from '../src/make-job.js';
import { makeRequest } from '../src/make-request.js';
import { installJwt } from '../src/install-jwt.js';

// A project made from the @st starter: framework code in src/@st, no src/config or src/middlewares.
const server = `import 'dotenv/config';
import { startServer } from '@st/core';
import { connectDB } from '@st/database';
import app from './app.js';

await startServer(app, { boot: [connectDB] });
`;
const database = `import { PrismaClient } from '@prisma/client';
import { onShutdown } from '@st/core';

const prisma = new PrismaClient();

export default prisma;
export const connectDB = () => prisma.$connect();
export const disconnectDB = () => prisma.$disconnect();

onShutdown(disconnectDB);
`;
const schema = `generator client {
  provider = "prisma-client-js"
}

model User {
  id        Int      @id @default(autoincrement())
  email     String   @unique
}
`;
const routes = `import { Router } from 'express';

const router = Router();

export default router;
`;
const pkg = {
  name: 'my-api', type: 'module', workspaces: ['src/@st/*'],
  dependencies: { express: '^5.3.0', '@prisma/client': '^5.19.0', zod: '^4.6.7' },
};

async function fixture(t, extra = {}) {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), 'st-layout-'));
  t.after(() => fs.rm(root, { recursive: true, force: true }));
  const files = {
    'package.json': JSON.stringify(pkg, null, 2) + '\n',
    'src/@st/core/index.js': 'export function onShutdown() {}\n',
    'src/@st/database/index.js': database,
    'src/@st/http/index.js': 'export const validate = () => {};\n',
    'src/server.js': server,
    'src/routes/index.js': routes,
    'src/controllers/UserController.js': '',
    'prisma/schema.prisma': schema,
    '.env': 'PORT=3000\n',
    ...extra,
  };
  for (const [relative, content] of Object.entries(files)) {
    await fs.mkdir(path.dirname(path.join(root, relative)), { recursive: true });
    await fs.writeFile(path.join(root, relative), content);
  }
  return root;
}

const read = (root, file) => fs.readFile(path.join(root, file), 'utf8');
const missing = (root, file) => assert.rejects(fs.lstat(path.join(root, file)), { code: 'ENOENT' });

test('usesSt detects the @st layout', async (t) => {
  const root = await fixture(t);
  assert.equal(await usesSt(root), true);
  await fs.rm(path.join(root, 'src/@st'), { recursive: true });
  assert.equal(await usesSt(root), false);
});

test('install:queue adds the @st/queue package and leaves server.js alone', async (t) => {
  const root = await fixture(t);
  const result = await installQueue({ cwd: root });
  assert.equal(result.st, true);
  assert.deepEqual(result.created, ['src/@st/queue/package.json', 'src/@st/queue/index.js', 'src/@st/queue/worker.js', 'src/jobs/index.js', 'src/worker.js']);
  assert.deepEqual(result.warnings, []);
  assert.equal(await read(root, 'src/server.js'), server);
  assert.equal(JSON.parse(await read(root, 'src/@st/queue/package.json')).name, '@st/queue');
  assert.match(await read(root, 'src/@st/queue/index.js'), /onShutdown\(closeQueue\)/);
  assert.match(await read(root, 'src/worker.js'), /import \{ startWorker \} from '@st\/queue';[\s\S]*startWorker\(jobs\);/);
  await missing(root, 'src/queues');
  const updated = JSON.parse(await read(root, 'package.json'));
  assert.ok(updated.dependencies.bullmq && updated.dependencies.ioredis);
  assert.equal(updated.scripts['queue:work'], 'node src/worker.js');

  const job = await makeJob({ name: 'SendPing', cwd: root });
  assert.equal(job.st, true);
  assert.match(await read(root, 'src/jobs/SendPing.js'), /import \{ dispatch \} from '@st\/queue';/);
});

test('make:request imports validate from @st/http and creates no validate middleware', async (t) => {
  const root = await fixture(t);
  const result = await makeRequest({ name: 'StoreProduct', cwd: root });
  assert.deepEqual(result.files, ['src/requests/StoreProductRequest.js']);
  assert.match(await read(root, 'src/requests/StoreProductRequest.js'), /import \{ validate \} from '@st\/http';/);
  await missing(root, 'src/middlewares');
});

test('install:jwt uses @st packages and creates missing app folders', async (t) => {
  const root = await fixture(t);
  const result = await installJwt({ cwd: root });
  assert.equal(result.st, true);
  assert.ok(result.updated.includes('src/@st/database/index.js'));
  assert.match(await read(root, 'src/@st/database/index.js'), /new PrismaClient\(\{ omit: \{ user: \{ password: true \} \} \}\)/);
  assert.match(await read(root, 'src/services/AuthService.js'), /import prisma from '@st\/database';/);
  assert.match(await read(root, 'src/services/AuthService.js'), /global `omit` in src\/@st\/database\/index\.js/);
  for (const file of ['src/requests/LoginRequest.js', 'src/requests/RegisterRequest.js']) {
    assert.match(await read(root, file), /import \{ validate \} from '@st\/http';/);
  }
  assert.match(await read(root, 'prisma/schema.prisma'), /Hidden from queries by the global omit in src\/@st\/database\/index\.js/);
  await missing(root, 'src/middlewares/validate.js');
  await read(root, 'src/config/auth.js');
  await read(root, 'src/middlewares/auth.js');
});

test('install:jwt removes the folders it created when it fails', async (t) => {
  const root = await fixture(t, { 'src/@st/database/index.js': 'export default {};\n' });
  await assert.rejects(installJwt({ cwd: root }), /new PrismaClient\(\)/);
  for (const dir of ['src/config', 'src/middlewares', 'src/services', 'src/requests']) await missing(root, dir);
});
