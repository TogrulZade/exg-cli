import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import path from 'node:path';
import os from 'node:os';
import { pathToFileURL } from 'node:url';
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { makeSeeder, parseSeederArgs, registerSeeder, seederNames, seedIndexTemplate } from '../src/make-seeder.js';

const run = promisify(execFile);
const entry = path.resolve('index.js');
const pkg = { type: 'module', scripts: { dev: 'node src/server.js' }, dependencies: { express: '^4.21.0', '@prisma/client': '^5.22.0' } };

async function fixture(t, { seed, packageJson = pkg } = {}) {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), 'exg-seeder-'));
  t.after(() => fs.rm(root, { recursive: true, force: true }));
  await fs.mkdir(path.join(root, 'prisma'), { recursive: true });
  await fs.writeFile(path.join(root, 'package.json'), JSON.stringify(packageJson, null, 2) + '\n');
  if (seed !== undefined) await fs.writeFile(path.join(root, 'prisma/seed.js'), seed);
  return root;
}

const read = (root, file) => fs.readFile(path.join(root, file), 'utf8');

test('seeder names accept an optional suffix and map to the Prisma delegate', () => {
  assert.deepEqual(seederNames('brand'), seederNames('BrandSeeder'));
  assert.equal(seederNames('ProductCategory').delegate, 'productCategory');
  assert.equal(seederNames('ProductCategorySeeder').file, 'prisma/seeders/ProductCategorySeeder.js');
  for (const name of [undefined, '', 'Seeder', '../Brand', 'Brand.js', 'Brand-Item', '1Brand', 'A'.repeat(101)]) {
    assert.throws(() => seederNames(name));
  }
  assert.deepEqual(parseSeederArgs(['Brand', '--project', './my-api']), { name: 'Brand', project: './my-api' });
  for (const args of [[], ['Brand', 'Other'], ['Brand', '--force'], ['Brand', '--project']]) {
    assert.throws(() => parseSeederArgs(args));
  }
});

test('first seeder creates seed.js and package.json settings', async (t) => {
  const root = await fixture(t);
  const result = await makeSeeder({ name: 'Brand', cwd: root });
  assert.deepEqual(result.files, ['prisma/seeders/BrandSeeder.js', 'prisma/seed.js', 'package.json']);
  assert.match(await read(root, 'prisma/seed.js'), /const seeders = \[BrandSeeder\];/);
  const updated = JSON.parse(await read(root, 'package.json'));
  assert.equal(updated.scripts['db:seed'], 'prisma db seed');
  assert.equal(updated.scripts.dev, 'node src/server.js');
  assert.equal(updated.prisma.seed, 'node prisma/seed.js');

  // The generated seeder runs against a fake client and upserts by the unique field.
  const file = path.join(root, 'prisma/seeders/BrandSeeder.js');
  await fs.writeFile(file, (await fs.readFile(file, 'utf8')).replace("// { name: 'Nümunə' },", "{ name: 'Apple', image: null },"));
  const calls = [];
  const { default: BrandSeeder } = await import(pathToFileURL(file));
  await BrandSeeder({ brand: { upsert: async (args) => calls.push(args) } });
  assert.deepEqual(calls, [{ where: { name: 'Apple' }, update: {}, create: { name: 'Apple', image: null } }]);
});

test('next seeders are appended to an existing seed.js without touching the rest', async (t) => {
  const root = await fixture(t);
  await makeSeeder({ name: 'User', cwd: root });
  const before = await read(root, 'prisma/seed.js');
  const result = await makeSeeder({ name: 'Brand', cwd: path.join(root, 'prisma') });
  assert.deepEqual(result.files, ['prisma/seeders/BrandSeeder.js', 'prisma/seed.js']);
  const after = await read(root, 'prisma/seed.js');
  assert.match(after, /const seeders = \[UserSeeder, BrandSeeder\];/);
  assert.equal(after.replace("\nimport BrandSeeder from './seeders/BrandSeeder.js';", '').replace(', BrandSeeder]', ']'), before);
});

test('registerSeeder handles empty and multi-line lists, quotes and CRLF', () => {
  const empty = seedIndexTemplate('UserSeeder').replace('[UserSeeder]', '[]').replace(/import UserSeeder.*\n/, '');
  assert.match(registerSeeder(empty, 'BrandSeeder'), /const seeders = \[BrandSeeder\];/);
  const multi = 'import a from "./a.js";\r\nconst seeders = [\r\n  A,\r\n];\r\n';
  const result = registerSeeder(multi, 'BrandSeeder');
  assert.match(result, /import BrandSeeder from "\.\/seeders\/BrandSeeder.js";\r\n/);
  assert.match(result, /A, BrandSeeder,\r\n\]/);
});

test('existing seeder files and registrations are never overwritten', async (t) => {
  const root = await fixture(t);
  await fs.mkdir(path.join(root, 'prisma/seeders'));
  await fs.writeFile(path.join(root, 'prisma/seeders/brandseeder.js'), '// user work');
  await assert.rejects(makeSeeder({ name: 'Brand', cwd: root }), /artıq mövcuddur/);
  assert.equal(await read(root, 'prisma/seeders/brandseeder.js'), '// user work');
  await assert.rejects(fs.stat(path.join(root, 'prisma/seed.js')), { code: 'ENOENT' });

  const seed = seedIndexTemplate('UserSeeder');
  const other = await fixture(t, { seed });
  await assert.rejects(makeSeeder({ name: 'User', cwd: other }), /artıq/);
  assert.equal(await read(other, 'prisma/seed.js'), seed);
});

test('an unrecognised seed.js or a non-Prisma project leaves everything untouched', async (t) => {
  for (const seed of ['export default {};\n', 'const broken = ;\n']) {
    const root = await fixture(t, { seed });
    await assert.rejects(makeSeeder({ name: 'Brand', cwd: root }));
    assert.equal(await read(root, 'prisma/seed.js'), seed);
    await assert.rejects(fs.stat(path.join(root, 'prisma/seeders/BrandSeeder.js')), { code: 'ENOENT' });
  }
  const mongoose = await fixture(t, { packageJson: { type: 'module', dependencies: { express: '^4', mongoose: '^8' } } });
  await assert.rejects(makeSeeder({ name: 'Brand', cwd: mongoose }), /yalnız Prisma/);
  await assert.rejects(fs.stat(path.join(mongoose, 'prisma/seeders')), { code: 'ENOENT' });
});

test('existing package.json settings are kept as they are', async (t) => {
  const custom = { ...pkg, scripts: { 'db:seed': 'custom seed' }, prisma: { schema: 'prisma/schema', seed: 'node other.js' } };
  const root = await fixture(t, { packageJson: custom });
  const before = await read(root, 'package.json');
  const result = await makeSeeder({ name: 'Brand', cwd: root });
  assert.deepEqual(result.pkgChanges, []);
  assert.equal(await read(root, 'package.json'), before);
});

test('the CLI creates a seeder with --project and reports duplicates', async (t) => {
  const root = await fixture(t);
  const help = await run(process.execPath, [entry, 'make:seeder', '--help']);
  assert.match(help.stdout, /--project/);
  const result = await run(process.execPath, [entry, 'make:seeder', 'BrandSeeder', '--project', root]);
  assert.match(result.stdout, /Brand modelində @unique/);
  await assert.rejects(run(process.execPath, [entry, 'make:seeder', 'Brand', '--project', root]), (error) => error.code === 1 && /artıq/.test(error.stdout + error.stderr));
});
