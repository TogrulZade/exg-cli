import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import path from 'node:path';
import os from 'node:os';
import { pathToFileURL } from 'node:url';
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { makeService, parseServiceArgs, serviceNames } from '../src/make-service.js';

const run = promisify(execFile);
const entry = path.resolve('index.js');

async function fixture(t, { services = true } = {}) {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), 'exg-service-'));
  t.after(() => fs.rm(root, { recursive: true, force: true }));
  await fs.mkdir(path.join(root, services ? 'src/services' : 'src'), { recursive: true });
  await fs.writeFile(path.join(root, 'package.json'), JSON.stringify({ type: 'module', dependencies: { express: '^4.21.0' } }));
  return root;
}

test('service names accept an optional suffix and reject unsafe names', () => {
  assert.deepEqual(serviceNames('user'), serviceNames('UserService'));
  assert.equal(serviceNames('orderItem').file, 'src/services/OrderItemService.js');
  for (const name of [undefined, '', 'Service', '../User', 'User.js', 'User-Item', '1User', 'A'.repeat(101)]) {
    assert.throws(() => serviceNames(name));
  }
  assert.deepEqual(parseServiceArgs(['User', '--project', './my-api']), { name: 'User', project: './my-api' });
  assert.deepEqual(parseServiceArgs(['-h']), { help: true });
  for (const args of [[], ['User', 'Other'], ['User', '--force'], ['User', '--project']]) {
    assert.throws(() => parseServiceArgs(args));
  }
});

test('creates an importable service class', async (t) => {
  const root = await fixture(t);
  const result = await makeService({ name: 'User', cwd: path.join(root, 'src') });
  assert.equal(result.file, 'src/services/UserService.js');
  const { UserService } = await import(pathToFileURL(path.join(root, result.file)));
  assert.deepEqual(await UserService.all(), []);
});

test('creates src/services when the project has none', async (t) => {
  const root = await fixture(t, { services: false });
  await makeService({ name: 'User', cwd: root });
  await fs.stat(path.join(root, 'src/services/UserService.js'));
});

test('existing files are never overwritten, whatever their case', async (t) => {
  const root = await fixture(t);
  const existing = path.join(root, 'src/services/userservice.js');
  await fs.writeFile(existing, '// user work');
  await assert.rejects(makeService({ name: 'UserService', cwd: root }), /artıq mövcuddur/);
  assert.equal(await fs.readFile(existing, 'utf8'), '// user work');
});

test('symlinked services folder is rejected', async (t) => {
  const root = await fixture(t, { services: false });
  const outside = await fs.mkdtemp(path.join(os.tmpdir(), 'exg-outside-'));
  t.after(() => fs.rm(outside, { recursive: true, force: true }));
  await fs.symlink(outside, path.join(root, 'src/services'));
  await assert.rejects(makeService({ name: 'User', cwd: root }), /Adi layihə qovluğu/);
  assert.deepEqual(await fs.readdir(outside), []);
});

test('the CLI creates a service with --project and reports duplicates', async (t) => {
  const root = await fixture(t);
  const help = await run(process.execPath, [entry, 'make:service', '--help']);
  assert.match(help.stdout, /--project/);
  const result = await run(process.execPath, [entry, 'make:service', 'UserService', '--project', root]);
  assert.match(result.stdout, /import \{ UserService \}/);
  await assert.rejects(run(process.execPath, [entry, 'make:service', 'User', '--project', root]), (error) => error.code === 1 && /artıq/.test(error.stdout + error.stderr));
});
