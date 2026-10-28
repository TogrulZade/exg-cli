import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import path from 'node:path';
import os from 'node:os';
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { createProject, parseArgs, validateName, GITHUB_REPO } from '../index.js';

const run = promisify(execFile);

async function workspace(t) {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), 'exg-test-'));
  t.after(() => fs.rm(root, { recursive: true, force: true }));
  return root;
}

async function template(dir, { env = true } = {}) {
  await fs.mkdir(dir, { recursive: true });
  await fs.writeFile(path.join(dir, 'package.json'), JSON.stringify({ name: 'template', version: '1.0.0', scripts: { start: 'node app.js' } }));
  await fs.writeFile(path.join(dir, 'package-lock.json'), JSON.stringify({ name: 'template', version: '1.0.0', lockfileVersion: 3, packages: { '': { name: 'template', version: '1.0.0' } } }));
  if (env) await fs.writeFile(path.join(dir, '.env.example'), 'PORT=3000\n');
}

test('project names reject paths, shell syntax, and unsafe package names', () => {
  for (const name of ['', '..', '../outside', '/tmp/app', 'My App', '@scope/app', '$(touch file)', 'CON', 'nul', 'a'.repeat(101)]) {
    assert.equal(typeof validateName(name), 'string', name);
  }
  assert.equal(validateName('my-api-2'), undefined);
  assert.throws(() => parseArgs(['../outside', '--orm', 'prisma']));
  assert.throws(() => parseArgs(['valid', '--orm', 'unknown']));
  assert.throws(() => parseArgs(['valid', '--template']));
  assert.throws(() => parseArgs(['valid', '--force']));
});

test('each ORM selects its GitHub branch and adjusts package, lock, and env', async (t) => {
  const cwd = await workspace(t);
  for (const [orm, branch] of [['prisma', 'main'], ['sequelize', 'sequelize'], ['mongoose', 'mongoose']]) {
    const target = await createProject({ name: `api-${orm}`, orm, cwd }, async (source, options) => {
      assert.equal(source, `github:${GITHUB_REPO}#${branch}`);
      assert.equal(options.force, false);
      await template(options.dir);
    });
    const pkg = JSON.parse(await fs.readFile(path.join(target, 'package.json'), 'utf8'));
    const lock = JSON.parse(await fs.readFile(path.join(target, 'package-lock.json'), 'utf8'));
    assert.equal(pkg.name, `api-${orm}`);
    assert.equal(pkg.version, '0.1.0');
    assert.equal(pkg.private, true);
    assert.equal(pkg.scripts.start, 'node app.js');
    assert.equal(lock.name, pkg.name);
    assert.equal(lock.packages[''].name, pkg.name);
    assert.equal(lock.packages[''].version, pkg.version);
    assert.equal(await fs.readFile(path.join(target, '.env'), 'utf8'), 'PORT=3000\n');
  }
});

test('existing targets, even empty directories or symlinks, are untouched', async (t) => {
  const cwd = await workspace(t);
  await fs.mkdir(path.join(cwd, 'empty'));
  await fs.writeFile(path.join(cwd, 'file'), 'keep');
  await fs.symlink(path.join(cwd, 'file'), path.join(cwd, 'link'));
  for (const name of ['empty', 'file', 'link']) {
    await assert.rejects(createProject({ name, orm: 'prisma', cwd }, () => assert.fail('No download should happen')), /artıq mövcuddur/);
  }
  assert.equal(await fs.readFile(path.join(cwd, 'file'), 'utf8'), 'keep');
});

test('download or missing env errors leave no project directory', async (t) => {
  const cwd = await workspace(t);
  await assert.rejects(createProject({ name: 'broken', orm: 'prisma', cwd }, async () => { throw new Error('Network failed'); }), /Network failed/);
  await assert.rejects(createProject({ name: 'no-env', orm: 'prisma', cwd }, async (_, options) => template(options.dir, { env: false })), /\.env.example/);
  assert.deepEqual(await fs.readdir(cwd), []);
});

test('a directory created during download is never overwritten', async (t) => {
  const cwd = await workspace(t);
  await assert.rejects(createProject({ name: 'race', orm: 'prisma', cwd }, async (_, options) => {
    await template(options.dir);
    await fs.mkdir(path.join(cwd, 'race'));
    await fs.writeFile(path.join(cwd, 'race', 'keep'), 'keep');
  }), { code: 'EEXIST' });
  assert.deepEqual(await fs.readdir(path.join(cwd, 'race')), ['keep']);
});

test('local generation reads the requested committed branch and omits git history', async (t) => {
  const cwd = await workspace(t);
  const source = path.join(cwd, 'source');
  await template(source);
  const git = (...args) => run('git', ['-C', source, ...args]);
  await git('init', '-b', 'main');
  await git('add', '.');
  await git('-c', 'user.name=EXG Test', '-c', 'user.email=exg@example.invalid', 'commit', '-m', 'Fixture');
  await git('checkout', '-b', 'mongoose');
  await fs.writeFile(path.join(source, 'branch.txt'), 'mongoose');
  await git('add', '.');
  await git('-c', 'user.name=EXG Test', '-c', 'user.email=exg@example.invalid', 'commit', '-m', 'MongoDB');
  await git('checkout', 'main');
  await fs.writeFile(path.join(source, 'untracked-secret'), 'not copied');
  const target = await createProject({ name: 'local-api', orm: 'mongoose', cwd, templateDirectory: source });
  assert.equal(await fs.readFile(path.join(target, 'branch.txt'), 'utf8'), 'mongoose');
  await assert.rejects(fs.lstat(path.join(target, '.git')), { code: 'ENOENT' });
  await assert.rejects(fs.lstat(path.join(target, 'untracked-secret')), { code: 'ENOENT' });
  assert.equal((await git('branch', '--show-current')).stdout.trim(), 'main');
});

test('command supports help and reports errors without hanging on noninteractive stdin', async () => {
  const entry = path.resolve('index.js');
  const help = await run(process.execPath, [entry, '--help']);
  assert.match(help.stdout, /--orm prisma/);
  await assert.rejects(run(process.execPath, [entry]), (error) => error.code === 1 && /İnteraktiv terminal yoxdur/.test(error.stdout + error.stderr));
  await assert.rejects(run(process.execPath, [entry, '../escape', '--orm', 'prisma']), (error) => error.code === 1);
});
