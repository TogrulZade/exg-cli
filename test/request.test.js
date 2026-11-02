import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import path from 'node:path';
import os from 'node:os';
import { pathToFileURL } from 'node:url';
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { makeRequest, parseRequestArgs, requestNames } from '../src/make-request.js';

const run = promisify(execFile);
const entry = path.resolve('index.js');
const zodDir = path.resolve('node_modules/zod');

async function fixture(t, { deps = { express: '^4', zod: '^4' }, validate = true } = {}) {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), 'exg-request-'));
  t.after(() => fs.rm(root, { recursive: true, force: true }));
  await fs.mkdir(path.join(root, 'src/middlewares'), { recursive: true });
  await fs.writeFile(path.join(root, 'package.json'), JSON.stringify({ type: 'module', dependencies: deps }));
  if (validate) await fs.writeFile(path.join(root, 'src/middlewares/validate.js'), '// existing\nexport const validate = () => {};\n');
  return root;
}

test('request names accept an optional suffix', () => {
  assert.deepEqual(requestNames('storeProduct'), requestNames('StoreProductRequest'));
  assert.deepEqual(requestNames('StoreProduct'), { request: 'StoreProductRequest', schema: 'StoreProductSchema', file: 'src/requests/StoreProductRequest.js' });
  for (const name of [undefined, '', 'Request', '../Store', 'Store.js', 'Store-Product', '1Store', 'A'.repeat(101)]) {
    assert.throws(() => requestNames(name));
  }
  assert.deepEqual(parseRequestArgs(['StoreProduct', '--project', './api']), { name: 'StoreProduct', project: './api' });
  for (const args of [[], ['A', 'B'], ['A', '--force'], ['A', '--project']]) assert.throws(() => parseRequestArgs(args));
});

test('creates a request whose default export validates the body like a FormRequest', async (t) => {
  const root = await fixture(t, { validate: false });
  const result = await makeRequest({ name: 'StoreProduct', cwd: root });
  assert.deepEqual(result.files, ['src/requests/StoreProductRequest.js', 'src/middlewares/validate.js']);

  // Fill in a rule the way a user would, then run the middleware.
  const file = path.join(root, result.file);
  const source = await fs.readFile(file, 'utf8');
  await fs.writeFile(file, source.replace("  // price: z.coerce.number().positive(),", "  price: z.coerce.number().positive(),"));
  // The generated file imports zod; link this repo's copy into the temp project.
  await fs.mkdir(path.join(root, 'node_modules'));
  await fs.symlink(zodDir, path.join(root, 'node_modules/zod'), 'dir');
  const { default: middleware, StoreProductSchema } = await import(pathToFileURL(file));
  assert.ok(StoreProductSchema);

  const call = (body) => {
    const req = { body };
    let response;
    let passed = false;
    const res = { status(code) { response = { code }; return this; }, json(value) { response.body = value; } };
    middleware(req, res, () => { passed = true; });
    return { req, response, passed };
  };
  const ok = call({ price: '9.5', extra: 'dropped' });
  assert.equal(ok.passed, true);
  assert.deepEqual(ok.req.body, { price: 9.5 });
  const bad = call({ price: -1 });
  assert.equal(bad.passed, false);
  assert.equal(bad.response.code, 422);
});

test('existing requests and validate.js are never overwritten', async (t) => {
  const root = await fixture(t);
  await makeRequest({ name: 'Login', cwd: root });
  assert.equal(await fs.readFile(path.join(root, 'src/middlewares/validate.js'), 'utf8'), '// existing\nexport const validate = () => {};\n');
  await fs.writeFile(path.join(root, 'src/requests/LoginRequest.js'), '// user work');
  await assert.rejects(makeRequest({ name: 'login', cwd: root }), /artıq mövcuddur/);
  assert.equal(await fs.readFile(path.join(root, 'src/requests/LoginRequest.js'), 'utf8'), '// user work');
});

test('projects without zod are refused before anything is created', async (t) => {
  const root = await fixture(t, { deps: { express: '^4' } });
  await assert.rejects(makeRequest({ name: 'Login', cwd: root }), /zod/);
  await assert.rejects(fs.stat(path.join(root, 'src/requests')), { code: 'ENOENT' });
});

test('the CLI creates a request with --project and reports duplicates', async (t) => {
  const root = await fixture(t);
  assert.match((await run(process.execPath, [entry, 'make:request', '--help'])).stdout, /--project/);
  const result = await run(process.execPath, [entry, 'make:request', 'StoreProductRequest', '--project', root]);
  assert.match(result.stdout, /router.post\('\/', StoreProductRequest, Controller.store\)/);
  await assert.rejects(run(process.execPath, [entry, 'make:request', 'StoreProduct', '--project', root]), (error) => error.code === 1 && /artıq/.test(error.stdout + error.stderr));
});
