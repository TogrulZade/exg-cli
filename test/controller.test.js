import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import path from 'node:path';
import os from 'node:os';
import { pathToFileURL } from 'node:url';
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { makeController, controllerNames, parseControllerArgs } from '../src/make-controller.js';

const run = promisify(execFile);
const entry = path.resolve('index.js');
const source = `import { Router } from "express";
import userRoutes from "./userRoutes.js";

const router = Router();

// Existing routes must be kept.
router.get("/health", (req, res) => res.json({ status: "ok" }));
router.use("/users", userRoutes);

export default router;
`;

async function fixture(t, index = source) {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), 'exg-controller-'));
  t.after(() => fs.rm(root, { recursive: true, force: true }));
  await fs.mkdir(path.join(root, 'src/controllers'), { recursive: true });
  await fs.mkdir(path.join(root, 'src/routes'), { recursive: true });
  await fs.writeFile(path.join(root, 'package.json'), JSON.stringify({ type: 'module', dependencies: { express: '^4.21.0' } }));
  await fs.writeFile(path.join(root, 'src/routes/index.js'), index);
  return root;
}

test('controller names support optional suffix and predictable multi-word routes', () => {
  assert.deepEqual(controllerNames('Home'), controllerNames('HomeController'));
  assert.equal(controllerNames('UserProfileController').mount, '/user-profile');
  assert.equal(controllerNames('HTTPStatusController').routeFile, 'httpStatusRoutes.js');
  for (const name of [undefined, '', 'Controller', '../Home', 'Home.js', '/Home', 'Home-Page', '1Home', 'Home;evil', 'A'.repeat(101)]) {
    assert.throws(() => controllerNames(name));
  }
  assert.deepEqual(parseControllerArgs(['Home', '--project', './my-api']), { name: 'Home', project: './my-api' });
  assert.deepEqual(parseControllerArgs(['--help']), { help: true });
  for (const args of [[], ['Home', 'Other'], ['Home', '--force'], ['Home', '--project'], ['Home', '--project', 'a', '--project', 'b']]) {
    assert.throws(() => parseControllerArgs(args));
  }
});

test('creates a usable index stub, router and registration without disturbing existing routes', async (t) => {
  const root = await fixture(t);
  const result = await makeController({ name: 'HomeController', cwd: root });
  const index = await fs.readFile(path.join(root, 'src/routes/index.js'), 'utf8');
  assert.equal(result.mount, '/home');
  assert.match(index, /import homeRoutes from "\.\/homeRoutes.js";/);
  assert.match(index, /router.use\("\/home", homeRoutes\);/);
  assert.equal(index.replace('\nimport homeRoutes from "./homeRoutes.js";', '').replace('router.use("/home", homeRoutes);\n\n', ''), source);
  const route = await fs.readFile(path.join(root, 'src/routes/homeRoutes.js'), 'utf8');
  assert.match(route, /router.get\('\/', HomeController.index\)/);
  const { HomeController } = await import(pathToFileURL(path.join(root, 'src/controllers/HomeController.js')));
  let status;
  let body;
  await HomeController.index({}, { status(code) { status = code; return this; }, json(value) { body = value; } }, () => assert.fail('Must send a response'));
  assert.equal(status, 501);
  assert.deepEqual(body, { success: false, message: 'Not implemented' });
  await assert.rejects(fs.stat(path.join(root, '.exg-controller.lock')), { code: 'ENOENT' });
});

test('duplicate invocation and existing router files leave all contents untouched', async (t) => {
  const root = await fixture(t);
  await fs.writeFile(path.join(root, 'src/routes/homeRoutes.js'), '// user work');
  await assert.rejects(makeController({ name: 'Home', cwd: root }), /artıq mövcuddur/);
  assert.equal(await fs.readFile(path.join(root, 'src/routes/homeRoutes.js'), 'utf8'), '// user work');
  await assert.rejects(fs.stat(path.join(root, 'src/controllers/HomeController.js')), { code: 'ENOENT' });
  assert.equal(await fs.readFile(path.join(root, 'src/routes/index.js'), 'utf8'), source);
});

test('existing controller files are protected even when their case differs', async (t) => {
  const root = await fixture(t);
  await fs.writeFile(path.join(root, 'src/controllers/homecontroller.js'), '// do not overwrite');
  await assert.rejects(makeController({ name: 'Home', cwd: root }), /artıq mövcuddur/);
  assert.equal(await fs.readFile(path.join(root, 'src/controllers/homecontroller.js'), 'utf8'), '// do not overwrite');
  await assert.rejects(fs.stat(path.join(root, 'src/routes/homeRoutes.js')), { code: 'ENOENT' });
});

test('route and import conflicts are rejected before creating files', async (t) => {
  for (const conflict of [
    'router.use("/HOME/", userRoutes);',
    'router.get(["/other", "/home"], () => {});',
    'const homeRoutes = userRoutes;',
  ]) {
    const index = source.replace('export default router;', `${conflict}\nexport default router;`);
    const root = await fixture(t, index);
    await assert.rejects(makeController({ name: 'Home', cwd: root }), /artıq/);
    assert.deepEqual(await fs.readdir(path.join(root, 'src/controllers')), []);
    assert.equal(await fs.readFile(path.join(root, 'src/routes/index.js'), 'utf8'), index);
  }
});

test('unsupported router structure and invalid JS leave the project unchanged', async (t) => {
  for (const index of ['export default {};\n', 'const invalid = ;\n']) {
    const root = await fixture(t, index);
    await assert.rejects(makeController({ name: 'Home', cwd: root }));
    assert.deepEqual(await fs.readdir(path.join(root, 'src/controllers')), []);
    assert.equal(await fs.readFile(path.join(root, 'src/routes/index.js'), 'utf8'), index);
    await assert.rejects(fs.stat(path.join(root, '.exg-controller.lock')), { code: 'ENOENT' });
  }
});

test('preserves CRLF and uses the exported router variable and aliased factory', async (t) => {
  const index = source.replace('import { Router }', 'import { Router as createRouter }')
    .replace('Router()', 'createRouter()').replace(/\brouter\b/g, 'api').replaceAll('\n', '\r\n');
  const root = await fixture(t, index);
  await makeController({ name: 'Home', cwd: root });
  const updated = await fs.readFile(path.join(root, 'src/routes/index.js'), 'utf8');
  assert.match(updated, /api.use\("\/home", homeRoutes\);\r\n/);
  assert.equal(updated.replaceAll('\r\n', '').includes('\n'), false);
});

test('project detection supports child folders and rejects wrong project types', async (t) => {
  const root = await fixture(t);
  await makeController({ name: 'Home', cwd: path.join(root, 'src/controllers') });
  await fs.writeFile(path.join(root, 'package.json'), JSON.stringify({ type: 'commonjs' }));
  await assert.rejects(makeController({ name: 'Other', cwd: root }), /type: module/);
  await assert.rejects(makeController({ name: 'Other', cwd: root, project: 'missing' }), /tapılmadı/);
});

test('symlinked destinations are rejected without changing their targets', async (t) => {
  const root = await fixture(t);
  const outside = path.join(root, 'keep.txt');
  await fs.writeFile(outside, 'keep');
  await fs.symlink(outside, path.join(root, 'src/controllers/HomeController.js'));
  await assert.rejects(makeController({ name: 'Home', cwd: root }), /artıq mövcuddur/);
  assert.equal(await fs.readFile(outside, 'utf8'), 'keep');
  await fs.unlink(path.join(root, 'src/routes/index.js'));
  await fs.symlink(outside, path.join(root, 'src/routes/index.js'));
  await assert.rejects(makeController({ name: 'Other', cwd: root }), /adi fayl/);
  assert.equal(await fs.readFile(outside, 'utf8'), 'keep');
});

test('the CLI creates files noninteractively with --project and reports duplicate errors', async (t) => {
  const root = await fixture(t);
  const help = await run(process.execPath, [entry, 'make:controller', '--help']);
  assert.match(help.stdout, /--project/);
  const result = await run(process.execPath, [entry, 'make:controller', 'HomeController', '--project', root]);
  assert.match(result.stdout, /GET \/api\/home/);
  await assert.rejects(run(process.execPath, [entry, 'make:controller', 'HomeController', '--project', root]), (error) => error.code === 1 && /artıq/.test(error.stdout + error.stderr));
});
