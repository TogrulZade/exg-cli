import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { parse as parseEnv } from 'dotenv';
import { databaseChoices, databaseConfig, connectionUrl, promptDatabase, configureNewDatabase } from '../src/database.js';
import { createProject, parseArgs } from '../index.js';

// node:sqlite is available from Node 22.5; the CLI itself also supports earlier 22.x.
const sqlite = await import('node:sqlite').catch(() => null);
const run = promisify(execFile);

async function workspace(t) {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), 'exg-database-test-'));
  t.after(() => fs.rm(root, { recursive: true, force: true }));
  return root;
}

const schema = `generator client {
  provider = "prisma-client-js"
}
datasource db {
  provider = "postgresql"
  url = env("DATABASE_URL")
}
model User {
  id Int @id @default(autoincrement())
  name String
  email String @unique
  createdAt DateTime @default(now())
  updatedAt DateTime @updatedAt
}
`;

async function template(root, orm) {
  await fs.mkdir(root, { recursive: true });
  await fs.writeFile(path.join(root, 'package.json'), JSON.stringify({ name: 'template', type: 'module', dependencies: { express: '^4.19.2', ...(orm === 'sequelize' ? { sequelize: '^6.37.3', pg: '^8.12.0' } : {}) } }));
  await fs.writeFile(path.join(root, '.gitignore'), '.env\n');
  const key = orm === 'prisma' ? 'DATABASE_URL' : orm === 'mongoose' ? 'MONGO_URI' : 'DB_URI';
  await fs.writeFile(path.join(root, '.env.example'), `PORT=3000\nCORS_ORIGIN=\n${key}="old-url"\n`);
  await fs.writeFile(path.join(root, 'README.md'), '# Starter\n\n## Başlamaq\n\ncp .env.example .env\n\n## API\n\nGET /api/users\n');
  if (orm === 'prisma') {
    await fs.mkdir(path.join(root, 'prisma/migrations/20261028000000_create_users'), { recursive: true });
    await fs.writeFile(path.join(root, 'prisma/schema.prisma'), schema);
    await fs.writeFile(path.join(root, 'prisma/migrations/migration_lock.toml'), 'provider = "postgresql"\n');
    await fs.copyFile(new URL('../src/database/postgresql.sql', import.meta.url), path.join(root, 'prisma/migrations/20261028000000_create_users/migration.sql'));
  } else if (orm === 'sequelize') {
    await fs.mkdir(path.join(root, 'database'), { recursive: true });
    await fs.mkdir(path.join(root, 'src/config'), { recursive: true });
    await fs.writeFile(path.join(root, 'src/config/db.js'), '// original URI configuration');
  }
}

test('defaults are per database, editable, and constrained to compatible ORMs', () => {
  for (const orm of ['prisma', 'sequelize']) {
    assert.deepEqual(databaseChoices(orm), ['postgresql', 'mysql', 'mariadb', 'sqlite']);
    for (const [database, port, user] of [['postgresql', '5432', 'postgres'], ['mysql', '3306', 'root'], ['mariadb', '3306', 'root']]) {
      const config = databaseConfig(orm, 'shop-api', { database });
      assert.equal(config.port, port);
      assert.equal(config.user, user);
      assert.equal(config.password, '');
      assert.equal(config.host, 'localhost');
      assert.equal(config.name, 'shop_api');
      const custom = databaseConfig(orm, 'shop-api', { database, port: '3307', user: 'app', password: 'secret', host: 'db.internal', name: 'custom' });
      assert.equal(custom.port, '3307');
      assert.equal(custom.user, 'app');
      assert.equal(custom.name, 'custom');
    }
  }
  assert.equal(connectionUrl('mongoose', databaseConfig('mongoose', 'my-api')), 'mongodb://localhost:27017/my_api');
  assert.deepEqual(databaseConfig('prisma', 'my-api', { database: 'sqlite' }), { database: 'sqlite', file: './my_api.db' });
  assert.throws(() => databaseConfig('prisma', 'app', { database: 'mongodb' }));
  assert.throws(() => databaseConfig('mongoose', 'app', { database: 'mysql' }));
});

test('invalid ports, connection fragments, credentials and SQLite paths are rejected', () => {
  for (const port of ['0', '65536', '1.5', 'NaN', '5432/path', '-1', '']) assert.throws(() => databaseConfig('prisma', 'app', { port }));
  for (const host of ['host:5432', 'https://host', 'host@other', 'host?query', 'a\nb', '']) assert.throws(() => databaseConfig('prisma', 'app', { host }));
  for (const file of ['../outside.db', '/tmp/file.db', 'file.db#x', './db/../outside.db', 'file.sqlite', 'a\nb.db']) assert.throws(() => databaseConfig('prisma', 'app', { database: 'sqlite', file }));
  for (const input of [{ user: '' }, { password: 'a\nb' }, { name: 'db?ssl=false' }, { authSource: 'admin' }, { file: './a.db' }]) assert.throws(() => databaseConfig('prisma', 'app', input));
  assert.throws(() => databaseConfig('mongoose', 'app', { password: 'without-user' }));
  assert.throws(() => databaseConfig('prisma', 'app', { database: 'sqlite', port: '5432' }));
});

test('URL serialization preserves special characters, IPv6, and MongoDB authSource', () => {
  const password = 'p@ss:#?/\\"\' %$&()!';
  for (const [orm, database, protocol] of [['prisma', 'mariadb', 'mysql:'], ['sequelize', 'mariadb', 'mariadb:'], ['sequelize', 'postgresql', 'postgres:'], ['mongoose', 'mongodb', 'mongodb:']]) {
    const config = databaseConfig(orm, 'app', { database, host: '::1', user: 'user@domain', password });
    const url = connectionUrl(orm, config);
    const parsed = new URL(url);
    assert.equal(parsed.protocol, protocol);
    assert.equal(parsed.hostname, '[::1]');
    assert.equal(decodeURIComponent(parsed.username), 'user@domain');
    assert.equal(decodeURIComponent(parsed.password), password);
    assert.equal(parsed.hash, '');
    assert.ok(!url.includes('"'));
    if (orm === 'mongoose') assert.equal(parsed.searchParams.get('authSource'), 'admin');
  }
  assert.match(connectionUrl('prisma', databaseConfig('prisma', 'app')), /\?schema=public$/);
});

test('CLI parses DB flags and rejects unknown/incompatible options without exposing passwords', () => {
  const options = parseArgs(['shop', '--orm', 'prisma', '--database', 'mysql', '--db-port', '3307', '--db-user', 'app', '--db-name', 'shop_db', '--yes']);
  assert.deepEqual(options.database, { database: 'mysql', port: '3307', user: 'app', name: 'shop_db' });
  assert.equal(options.yes, true);
  assert.equal(parseArgs(['shop', '--database', 'sqlite', '-y']).orm, 'prisma');
  assert.throws(() => parseArgs(['app', '--database', 'mysql', '--database', 'sqlite']));
  assert.throws(() => parseArgs(['app', '--orm', 'mongoose', '--database', 'mysql']));
  assert.throws(() => parseArgs(['app', '--db-password=TOP_SECRET']), (error) => /EXG_DB_PASSWORD/.test(error.message) && !error.message.includes('TOP_SECRET'));
});

function mockPrompts(answers = []) {
  const calls = [];
  const ask = (kind) => async (options) => {
    calls.push({ kind, ...options });
    assert.ok(answers.length, `Unexpected ${kind} prompt`);
    return answers.shift();
  };
  return { calls, select: ask('select'), text: ask('text'), password: ask('password'), isCancel: (value) => typeof value === 'symbol' };
}

test('interactive prompts accept defaults, custom values, hidden passwords and cancellation', async () => {
  const ui = mockPrompts(['mysql', '', '3307', 'shop', 'app', 'secret']);
  const result = await promptDatabase({ orm: 'prisma', name: 'my-api' }, ui);
  assert.equal(result.host, 'localhost');
  assert.equal(result.port, '3307');
  assert.equal(result.user, 'app');
  assert.equal(result.password, 'secret');
  assert.equal(ui.calls.at(-1).kind, 'password');
  assert.equal(ui.calls.find((call) => call.message.startsWith('Database port')).defaultValue, '3306');
  const cancel = Symbol('cancel');
  for (const answers of [[cancel], ['mysql', cancel], ['mysql', '', '', '', '', cancel]]) {
    assert.equal(await promptDatabase({ orm: 'prisma', name: 'app' }, mockPrompts(answers)), cancel);
  }
  const sqliteUi = mockPrompts(['sqlite', '']);
  assert.equal((await promptDatabase({ orm: 'prisma', name: 'app' }, sqliteUi)).file, './app.db');
  assert.deepEqual(sqliteUi.calls.map((call) => call.kind), ['select', 'text']);
  const noAuth = mockPrompts(['', '', '', '']);
  assert.equal((await promptDatabase({ orm: 'mongoose', name: 'app' }, noAuth)).user, '');
  assert.ok(noAuth.calls.every((call) => call.kind !== 'password'));
  const auth = mockPrompts(['', '', '', 'admin-user', 'secret', 'accounts']);
  assert.equal((await promptDatabase({ orm: 'mongoose', name: 'app' }, auth)).authSource, 'accounts');
  assert.equal((await promptDatabase({ orm: 'prisma', name: 'app', input: { database: 'mysql' }, interactive: false }, mockPrompts())).port, '3306');
});

test('Prisma generation writes provider-specific migrations and keeps secrets out of distributable files', async (t) => {
  const cwd = await workspace(t);
  for (const database of databaseChoices('prisma')) {
    const config = database === 'sqlite' ? { database, file: './data/shop.db' } : { database, user: 'custom-user', password: 'TopSecret@#"$pass', host: 'private-host', port: '4321' };
    const target = await createProject({ name: `api-${database}`, orm: 'prisma', cwd, database: config }, async (_, { dir }) => template(dir, 'prisma'));
    const provider = database === 'mariadb' ? 'mysql' : database;
    assert.match(await fs.readFile(path.join(target, 'prisma/schema.prisma'), 'utf8'), new RegExp(`provider = "${provider}"`));
    assert.equal(await fs.readFile(path.join(target, 'prisma/migrations/migration_lock.toml'), 'utf8'), `provider = "${provider}"\n`);
    const sql = await fs.readFile(path.join(target, 'prisma/migrations/20261028000000_create_users/migration.sql'), 'utf8');
    if (provider === 'mysql') assert.match(sql, /AUTO_INCREMENT/);
    if (provider === 'sqlite') {
      assert.ok((await fs.stat(path.join(target, 'prisma/data'))).isDirectory());
      assert.match(await fs.readFile(path.join(target, '.gitignore'), 'utf8'), /\*\.db-wal/);
    }
    const env = await fs.readFile(path.join(target, '.env'), 'utf8');
    assert.match(env, /PORT=3000\nCORS_ORIGIN=/);
    if (database !== 'sqlite') assert.match(env, /custom-user:TopSecret%40%23%22%24pass@private-host:4321/);
    if (database !== 'sqlite') assert.equal(decodeURIComponent(new URL(parseEnv(env).DATABASE_URL).password), config.password);
    if (process.platform !== 'win32') assert.equal((await fs.stat(path.join(target, '.env'))).mode & 0o777, 0o600);
    for (const file of ['.env.example', 'README.md', 'DATABASE.md', 'package.json']) {
      assert.doesNotMatch(await fs.readFile(path.join(target, file), 'utf8'), /TopSecret|private-host|custom-user/);
    }
    const readme = await fs.readFile(path.join(target, 'README.md'), 'utf8');
    assert.doesNotMatch(readme, /cp .env.example .env/);
    assert.match(readme, /GET \/api\/users/);
  }
});

test('SQLite migration creates a usable table and enforces unique emails', { skip: !sqlite }, async () => {
  const db = new sqlite.DatabaseSync(':memory:');
  try {
    db.exec(await fs.readFile(new URL('../src/database/sqlite.sql', import.meta.url), 'utf8'));
    db.prepare('INSERT INTO "User" (name, email, updatedAt) VALUES (?, ?, ?)').run('Ali', 'ali@example.com', new Date().toISOString());
    assert.equal(db.prepare('SELECT COUNT(*) AS count FROM "User"').get().count, 1);
    assert.throws(() => db.prepare('INSERT INTO "User" (name, email, updatedAt) VALUES (?, ?, ?)').run('Ali', 'ali@example.com', new Date().toISOString()), /UNIQUE/);
  } finally { db.close(); }
});

test('Prisma SQLite npm hooks create missing nested files and preserve existing database bytes', async (t) => {
  const root = await workspace(t);
  await template(root, 'prisma');
  await configureNewDatabase(root, 'prisma', 'app', { database: 'sqlite' });
  await fs.symlink(path.resolve('node_modules'), path.join(root, 'node_modules'), 'dir');
  const pkg = JSON.parse(await fs.readFile(path.join(root, 'package.json'), 'utf8'));
  assert.equal(pkg.scripts['predb:deploy'], 'node scripts/prepare-sqlite.js');
  assert.equal(pkg.scripts['predb:migrate'], 'node scripts/prepare-sqlite.js');
  const env = { ...process.env, DATABASE_URL: 'file:./nested/test.db' };
  const file = path.join(root, 'prisma/nested/test.db');
  await run(process.execPath, ['scripts/prepare-sqlite.js'], { cwd: root, env });
  assert.equal((await fs.stat(file)).size, 0);
  const bytes = Buffer.from('existing database bytes');
  await fs.writeFile(file, bytes);
  await run(process.execPath, ['scripts/prepare-sqlite.js'], { cwd: root, env });
  assert.deepEqual(await fs.readFile(file), bytes);
  await assert.rejects(run(process.execPath, ['scripts/prepare-sqlite.js'], { cwd: root, env: { ...env, DATABASE_URL: 'postgres://localhost/app' } }));
});

test('Sequelize selects the driver, refreshes the lock and configures both runtime and migrations', async (t) => {
  const root = await workspace(t);
  for (const [database, driver, dialect] of [['postgresql', 'pg', 'postgres'], ['mysql', 'mysql2', 'mysql'], ['mariadb', 'mariadb', 'mariadb'], ['sqlite', 'sqlite3', 'sqlite']]) {
    const dir = path.join(root, database);
    await template(dir, 'sequelize');
    let refreshes = 0;
    await configureNewDatabase(dir, 'sequelize', 'shop-api', { database }, async (stage) => {
      assert.equal(stage, dir);
      await assert.rejects(fs.stat(path.join(stage, '.env')), { code: 'ENOENT' });
      refreshes++;
    });
    assert.equal(refreshes, database === 'postgresql' ? 0 : 1);
    const pkg = JSON.parse(await fs.readFile(path.join(dir, 'package.json'), 'utf8'));
    assert.ok(pkg.dependencies[driver]);
    assert.equal(Object.keys(pkg.dependencies).filter((key) => ['pg', 'mysql2', 'mariadb', 'sqlite3'].includes(key)).length, 1);
    const cliConfig = await fs.readFile(path.join(dir, 'database/config.cjs'), 'utf8');
    assert.match(cliConfig, new RegExp(`dialect: '${dialect}'`));
    if (database === 'sqlite') {
      assert.match(cliConfig, /process.env.DB_STORAGE/);
      assert.match(await fs.readFile(path.join(dir, 'src/config/db.js'), 'utf8'), /process.env.DB_STORAGE/);
      assert.doesNotMatch(await fs.readFile(path.join(dir, '.env'), 'utf8'), /DB_URI=/);
    } else assert.match(await fs.readFile(path.join(dir, '.env'), 'utf8'), new RegExp(`${dialect}:\\/\\/`));
  }
});

test('MongoDB URI supports optional credentials and non-default ports without leaking into the example', async (t) => {
  const root = await workspace(t);
  await template(root, 'mongoose');
  await configureNewDatabase(root, 'mongoose', 'app', { user: 'alice', password: 'SECRET@#', port: '27018', authSource: 'accounts' });
  assert.match(await fs.readFile(path.join(root, '.env'), 'utf8'), /mongodb:\/\/alice:SECRET%40%23@localhost:27018\/app\?authSource=accounts/);
  assert.match(await fs.readFile(path.join(root, '.env.example'), 'utf8'), /mongodb:\/\/localhost:27017\/app/);
});

test('custom Prisma history and linked output files fail before exposing a project or modifying linked targets', async (t) => {
  const cwd = await workspace(t);
  await assert.rejects(createProject({ name: 'custom', orm: 'prisma', cwd, database: { database: 'mysql' } }, async (_, { dir }) => {
    await template(dir, 'prisma');
    await fs.appendFile(path.join(dir, 'prisma/schema.prisma'), '\nmodel Extra { id Int @id }\n');
  }), /Xüsusi Prisma/);
  await assert.rejects(fs.stat(path.join(cwd, 'custom')), { code: 'ENOENT' });
  const secret = path.join(cwd, 'keep');
  await fs.writeFile(secret, 'keep');
  await assert.rejects(createProject({ name: 'linked', orm: 'prisma', cwd, database: { database: 'sqlite' } }, async (_, { dir }) => {
    await template(dir, 'prisma');
    await fs.unlink(path.join(dir, '.gitignore'));
    await fs.symlink(secret, path.join(dir, '.gitignore'));
  }), /simvolik link/);
  assert.equal(await fs.readFile(secret, 'utf8'), 'keep');
  await assert.rejects(fs.stat(path.join(cwd, 'linked')), { code: 'ENOENT' });
});

test('failed dependency resolution never writes a credential file', async (t) => {
  const root = await workspace(t);
  await template(root, 'sequelize');
  await assert.rejects(configureNewDatabase(root, 'sequelize', 'app', { database: 'mysql', password: 'SECRET' }, async () => { throw new Error('Offline'); }), /Offline/);
  await assert.rejects(fs.stat(path.join(root, '.env')), { code: 'ENOENT' });
});
