import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import path from 'node:path';
import os from 'node:os';
import { pathToFileURL } from 'node:url';
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { parse } from 'acorn';
import { addCloseQueue, addRedisEnv, installQueue, parseQueueArgs } from '../src/install-queue.js';
import { jobName, makeJob, parseJobArgs, registerJob } from '../src/make-job.js';
import { jobsIndex } from '../src/templates/queue.js';

const run = promisify(execFile);
const entry = path.resolve('index.js');

const server = `import 'dotenv/config';
import app from './app.js';
import { connectDB, disconnectDB } from './config/db.js';
import cache from './services/cache.js';

async function shutdown() {
  const results = await Promise.allSettled([disconnectDB(), cache.close()]);
}
`;
const pkg = { name: 'my-api', type: 'module', scripts: { dev: 'node --watch src/server.js' }, dependencies: { express: '^4.19.2' } };

async function fixture(t, { files = {}, packageJson = pkg } = {}) {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), 'exg-queue-'));
  t.after(() => fs.rm(root, { recursive: true, force: true }));
  await fs.mkdir(path.join(root, 'src'), { recursive: true });
  const all = { 'package.json': JSON.stringify(packageJson, null, 2) + '\n', 'src/server.js': server, '.env': 'PORT=3000\n', ...files };
  for (const [relative, content] of Object.entries(all)) {
    if (content === null) continue;
    await fs.mkdir(path.dirname(path.join(root, relative)), { recursive: true });
    await fs.writeFile(path.join(root, relative), content);
  }
  return root;
}

const read = (root, file) => fs.readFile(path.join(root, file), 'utf8');

async function snapshot(root) {
  const result = {};
  async function walk(dir) {
    for (const entry of await fs.readdir(path.join(root, dir), { withFileTypes: true })) {
      const relative = path.join(dir, entry.name);
      if (entry.isDirectory()) { result[`${relative}/`] = true; await walk(relative); } else result[relative] = await read(root, relative);
    }
  }
  await walk('.');
  return result;
}

test('argument parsing and job names', () => {
  assert.deepEqual(parseQueueArgs(['--project', './api']), { project: './api' });
  assert.throws(() => parseQueueArgs(['extra']));
  assert.deepEqual(jobName('sendWelcomeEmail'), { job: 'SendWelcomeEmail', file: 'src/jobs/SendWelcomeEmail.js' });
  for (const name of [undefined, '', '../Job', 'Job.js', 'Send-Email', '1Job', 'A'.repeat(101)]) assert.throws(() => jobName(name));
  assert.deepEqual(parseJobArgs(['SendInvoice', '--project', './api']), { name: 'SendInvoice', project: './api' });
  for (const args of [[], ['A', 'B'], ['A', '--force']]) assert.throws(() => parseJobArgs(args));
});

test('source edits: closeQueue in shutdown, REDIS_URL, job registration', () => {
  const updated = addCloseQueue(server);
  assert.match(updated, /import cache from '\.\/services\/cache.js';\nimport \{ closeQueue \} from '\.\/queues\/index.js';/);
  assert.match(updated, /Promise\.allSettled\(\[closeQueue\(\), disconnectDB\(\)/);
  assert.equal(addCloseQueue(updated), updated);
  assert.equal(addCloseQueue('export default 1;\n'), null);
  assert.match(addRedisEnv('PORT=1'), /^PORT=1\n\n# Queue.*\nREDIS_URL="redis:\/\/127\.0\.0\.1:6379"\n$/);
  assert.equal(addRedisEnv('REDIS_URL="x"\n'), 'REDIS_URL="x"\n');

  const one = registerJob(jobsIndex, 'SendWelcomeEmail');
  const two = registerJob(one, 'SendInvoice');
  assert.match(two, /import SendWelcomeEmail from '\.\/SendWelcomeEmail.js';\nimport SendInvoice from '\.\/SendInvoice.js';/);
  assert.match(two, /export const jobs = \{\n  SendWelcomeEmail,\n  SendInvoice,\n\};/);
  assert.match(registerJob('import A from "./A.js";\r\nexport const jobs = { A };\r\n', 'B'), /import B from "\.\/B.js";\r\n[\s\S]*A,\r\n  B,/);
  assert.throws(() => registerJob(one, 'SendWelcomeEmail'), /artıq/);
  assert.throws(() => registerJob('export default {};\n', 'A'), /export const jobs/);
});

test('install:queue creates the queue, registry, worker and wires shutdown, env and package.json', async (t) => {
  const root = await fixture(t);
  const result = await installQueue({ cwd: path.join(root, 'src') });
  assert.deepEqual(result.created, ['src/queues/index.js', 'src/jobs/index.js', 'src/worker.js']);
  assert.deepEqual(result.added, ['bullmq', 'ioredis']);
  assert.deepEqual(result.warnings, []);
  for (const file of result.created) parse(await read(root, file), { ecmaVersion: 'latest', sourceType: 'module' });
  assert.match(await read(root, 'src/server.js'), /closeQueue\(\)/);
  assert.match(await read(root, '.env'), /^REDIS_URL=/m);
  const updated = JSON.parse(await read(root, 'package.json'));
  assert.equal(updated.scripts['queue:work'], 'node src/worker.js');
  assert.equal(updated.scripts.dev, 'node --watch src/server.js');
  assert.equal(updated.dependencies.bullmq, '^6.5.3');
});

test('an unknown server.js shape is a warning, not a failure', async (t) => {
  const root = await fixture(t, { files: { 'src/server.js': 'console.log(1);\n' } });
  const result = await installQueue({ cwd: root });
  assert.equal(result.warnings.length, 1);
  assert.equal(await read(root, 'src/server.js'), 'console.log(1);\n');
});

test('a second install:queue leaves every file unchanged', async (t) => {
  const root = await fixture(t);
  await installQueue({ cwd: root });
  const before = await snapshot(root);
  await assert.rejects(installQueue({ cwd: root }), /artıq mövcuddur/);
  assert.deepEqual(await snapshot(root), before);
});

test('make:job creates an importable job and registers it; duplicates and missing setup are refused', async (t) => {
  const missing = await fixture(t);
  await assert.rejects(makeJob({ name: 'SendInvoice', cwd: missing }), /install:queue/);

  const root = await fixture(t);
  await installQueue({ cwd: root });
  const result = await makeJob({ name: 'sendInvoice', cwd: root });
  assert.deepEqual(result.files, ['src/jobs/SendInvoice.js', 'src/jobs/index.js']);
  const { default: SendInvoice } = await import(pathToFileURL(path.join(root, 'src/jobs/SendInvoice.js')));
  assert.equal(SendInvoice.name, 'SendInvoice', 'dispatch() relies on the function name');
  assert.match(await read(root, 'src/jobs/index.js'), /SendInvoice,/);

  const before = await snapshot(root);
  await assert.rejects(makeJob({ name: 'SendInvoice', cwd: root }), /artıq mövcuddur/);
  assert.deepEqual(await snapshot(root), before);
});

test('the CLI runs install:queue and make:job with --project', async (t) => {
  const root = await fixture(t);
  assert.match((await run(process.execPath, [entry, 'install:queue', '--help'])).stdout, /queue:work/);
  assert.match((await run(process.execPath, [entry, 'install:queue', '--project', root])).stdout, /queue:dev/);
  assert.match((await run(process.execPath, [entry, 'make:job', 'SendWelcomeEmail', '--project', root])).stdout, /dispatch\(SendWelcomeEmail/);
  await assert.rejects(run(process.execPath, [entry, 'make:job', 'SendWelcomeEmail', '--project', root]), (error) => error.code === 1);
});
