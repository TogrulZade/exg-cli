import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import path from 'node:path';
import os from 'node:os';
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { parse } from 'acorn';
import { addEnv, addOmitPreview, addPasswordField, installJwt, needsOmitPreview, parseInstallArgs } from '../src/install-jwt.js';

const run = promisify(execFile);
const entry = path.resolve('index.js');

const schema = `generator client {
  provider = "prisma-client-js"
}

datasource db {
  provider = "mysql"
  url      = env("DATABASE_URL")
}

model User {
  id        Int      @id @default(autoincrement())
  name      String
  email     String   @unique
  createdAt DateTime @default(now())
  updatedAt DateTime @updatedAt
}
`;
const db = `import { PrismaClient } from '@prisma/client';

const prisma = new PrismaClient();

export default prisma;
`;
const routes = `import { Router } from 'express';
import userRoutes from './userRoutes.js';

const router = Router();

router.use('/users', userRoutes);

export default router;
`;
const pkg = { type: 'module', dependencies: { express: '^4.19.2', '@prisma/client': '^5.19.0', zod: '^4.6.7' }, devDependencies: { prisma: '^5.19.0' } };

async function fixture(t, overrides = {}) {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), 'exg-jwt-'));
  t.after(() => fs.rm(root, { recursive: true, force: true }));
  const files = {
    'package.json': JSON.stringify(overrides.pkg ?? pkg, null, 2) + '\n',
    'prisma/schema.prisma': schema,
    'src/config/db.js': db,
    'src/routes/index.js': routes,
    'src/middlewares/validate.js': '// existing validate\n',
    '.env': 'PORT=3000\n',
    '.env.example': 'PORT=3000',
    ...overrides.files,
  };
  for (const dir of ['src/config', 'src/controllers', 'src/middlewares', 'src/routes', 'src/services', 'test', 'prisma']) {
    await fs.mkdir(path.join(root, dir), { recursive: true });
  }
  for (const [relative, content] of Object.entries(files)) {
    if (content !== null) await fs.writeFile(path.join(root, relative), content);
  }
  return root;
}

const read = (root, file) => fs.readFile(path.join(root, file), 'utf8');

async function snapshot(root) {
  const result = {};
  async function walk(dir) {
    for (const entry of await fs.readdir(path.join(root, dir), { withFileTypes: true })) {
      const relative = path.join(dir, entry.name);
      if (entry.isDirectory()) await walk(relative);
      else result[relative] = await read(root, relative);
    }
  }
  await walk('.');
  return result;
}

test('arguments and Prisma version detection', () => {
  assert.deepEqual(parseInstallArgs(['--project', './api']), { project: './api' });
  assert.deepEqual(parseInstallArgs(['-h']), { help: true });
  for (const args of [['extra'], ['--force'], ['--project']]) assert.throws(() => parseInstallArgs(args));
  assert.equal(needsOmitPreview('^5.19.0'), true);
  assert.equal(needsOmitPreview('~6.1.0'), true);
  assert.equal(needsOmitPreview('^6.2.0'), false);
  assert.equal(needsOmitPreview('7.0.0'), false);
});

test('schema edits add an aligned password field and merge the omitApi flag', () => {
  const updated = addOmitPreview(addPasswordField(schema));
  assert.match(updated, /\n  email     String   @unique\n  \/\/ scrypt hash.*\n  password  String\?\n  createdAt/);
  assert.match(updated, /provider = "prisma-client-js"\n  previewFeatures = \["omitApi"\]/);
  const withFlags = schema.replace('provider = "prisma-client-js"', 'provider = "prisma-client-js"\n  previewFeatures = ["prismaSchemaFolder"]');
  assert.match(addOmitPreview(withFlags), /previewFeatures = \["prismaSchemaFolder", "omitApi"\]/);
  assert.equal(addOmitPreview(addOmitPreview(withFlags)), addOmitPreview(withFlags));
  assert.equal(addPasswordField('model Post {\n  id Int @id\n}\n'), null);
  assert.throws(() => addPasswordField(addPasswordField(schema)), /artıq password/);
  assert.match(addEnv('A=1', 'abc'), /^A=1\n\n# JWT auth.*\nJWT_SECRET=abc\n/);
  assert.equal(addEnv('JWT_SECRET=keep\n', 'new'), 'JWT_SECRET=keep\n');
});

test('installs auth files, routes, global omit, env and dependency', async (t) => {
  const root = await fixture(t);
  const result = await installJwt({ cwd: path.join(root, 'src') });
  assert.deepEqual(result.created, ['src/config/auth.js', 'src/services/AuthService.js', 'src/middlewares/auth.js', 'src/controllers/AuthController.js', 'src/routes/authRoutes.js', 'src/requests/RegisterRequest.js', 'src/requests/LoginRequest.js', 'test/auth.test.js']);
  assert.match(await read(root, 'src/routes/authRoutes.js'), /router.post\('\/register', RegisterRequest, AuthController.register\)/);
  assert.deepEqual(result.added, ['jsonwebtoken']);
  for (const file of result.created) parse(await read(root, file), { ecmaVersion: 'latest', sourceType: 'module' });

  assert.equal(await read(root, 'src/middlewares/validate.js'), '// existing validate\n');
  assert.match(await read(root, 'src/routes/index.js'), /import authRoutes from '\.\/authRoutes.js';[\s\S]*router.use\('\/auth', authRoutes\);/);
  assert.match(await read(root, 'src/config/db.js'), /new PrismaClient\(\{ omit: \{ user: \{ password: true \} \} \}\)/);
  assert.match(await read(root, 'prisma/schema.prisma'), /password  String\?/);
  assert.match(await read(root, '.env'), /^JWT_SECRET=[0-9a-f]{64}$/m);
  assert.match(await read(root, '.env.example'), /^PORT=3000\n\n# JWT auth[\s\S]*^JWT_SECRET=$/m);
  const updated = JSON.parse(await read(root, 'package.json'));
  assert.equal(updated.dependencies.jsonwebtoken, '^9.0.3');
  assert.deepEqual(Object.keys(updated.dependencies), [...Object.keys(updated.dependencies)].sort());
  assert.match(await read(root, 'src/services/AuthService.js'), /omit: \{ password: false \}/);
});

test('works with a Prisma schema folder and creates validate.js when missing', async (t) => {
  const root = await fixture(t, {
    pkg: { ...pkg, prisma: { schema: 'prisma/schema' } },
    files: { 'prisma/schema.prisma': null, 'src/middlewares/validate.js': null },
  });
  await fs.mkdir(path.join(root, 'prisma/schema'));
  const [generator, rest] = schema.split('\nmodel User');
  await fs.writeFile(path.join(root, 'prisma/schema/main.prisma'), generator.replace('"prisma-client-js"', '"prisma-client-js"\n  previewFeatures = ["prismaSchemaFolder"]'));
  await fs.writeFile(path.join(root, 'prisma/schema/user.prisma'), `model User${rest}`);
  const result = await installJwt({ cwd: root });
  assert.ok(result.created.includes('src/middlewares/validate.js'));
  assert.match(await read(root, 'prisma/schema/main.prisma'), /\["prismaSchemaFolder", "omitApi"\]/);
  assert.match(await read(root, 'prisma/schema/user.prisma'), /password  String\?/);
});

test('a second run or an unexpected project leaves every file unchanged', async (t) => {
  const installed = await fixture(t);
  await installJwt({ cwd: installed });
  const before = await snapshot(installed);
  await assert.rejects(installJwt({ cwd: installed }), /artıq mövcuddur/);
  assert.deepEqual(await snapshot(installed), before);

  for (const [files, message] of [
    [{ 'src/config/db.js': 'export default {};\n' }, /new PrismaClient\(\)/],
    [{ 'prisma/schema.prisma': schema.replace('model User', 'model Account') }, /model User/],
    [{ 'prisma/schema.prisma': schema.replace('  email ', '  password String?\n  email ') }, /artıq password/],
    [{ 'src/routes/index.js': 'export default {};\n' }, /routes\/index.js/],
  ]) {
    const root = await fixture(t, { files });
    const original = await snapshot(root);
    await assert.rejects(installJwt({ cwd: root }), message);
    assert.deepEqual(await snapshot(root), original);
  }

  const mongoose = await fixture(t, { pkg: { type: 'module', dependencies: { express: '^4', mongoose: '^8' } } });
  const original = await snapshot(mongoose);
  await assert.rejects(installJwt({ cwd: mongoose }), /yalnız Prisma/);
  assert.deepEqual(await snapshot(mongoose), original);
});

test('Prisma 6.2+ projects get the global omit without the preview flag', async (t) => {
  const root = await fixture(t, { pkg: { ...pkg, dependencies: { ...pkg.dependencies, '@prisma/client': '^6.19.0' } } });
  await installJwt({ cwd: root });
  assert.doesNotMatch(await read(root, 'prisma/schema.prisma'), /previewFeatures/);
  assert.match(await read(root, 'src/config/db.js'), /omit:/);
});

test('the CLI installs with --project and reports a second run as an error', async (t) => {
  const root = await fixture(t);
  const help = await run(process.execPath, [entry, 'install:jwt', '--help']);
  assert.match(help.stdout, /--project/);
  const result = await run(process.execPath, [entry, 'install:jwt', '--project', root]);
  assert.match(result.stdout, /add_user_password/);
  await assert.rejects(run(process.execPath, [entry, 'install:jwt', '--project', root]), (error) => error.code === 1 && /artıq/.test(error.stdout + error.stderr));
});
