import fs from 'node:fs/promises';
import path from 'node:path';
import { parse } from 'acorn';
import { directory, projectRoot } from './make-controller.js';
import { exists, readFileIfExists, replaceFile } from './install-jwt.js';
import * as templates from './templates/queue.js';
import { usesSt } from './layout.js';

const VERSIONS = { bullmq: '^6.5.3', ioredis: '^6.0.0' };
const SCRIPTS = { 'queue:work': 'node src/worker.js', 'queue:dev': 'node --watch src/worker.js' };

export function parseQueueArgs(args) {
  const options = {};
  for (let index = 0; index < args.length; index++) {
    const arg = args[index];
    if (arg === '--help' || arg === '-h') options.help = true;
    else if (arg === '--project') {
      const value = args[++index];
      if (!value || value.startsWith('-') || options.project) {
        throw new Error('--project üçün bir layihə qovluğu göstər.');
      }
      options.project = value;
    } else throw new Error(`Naməlum seçim və ya arqument: ${arg}`);
  }
  return options;
}

export function addRedisEnv(source) {
  if (/^REDIS_URL=/m.test(source)) return source;
  const newline = source.includes('\r\n') ? '\r\n' : '\n';
  const lead = source === '' || source.endsWith(newline) ? '' : newline;
  return `${source}${lead}${newline}# Queue (BullMQ) and cache use this Redis server.${newline}REDIS_URL="redis://127.0.0.1:6379"${newline}`;
}

// Adds closeQueue() to the shutdown in src/server.js. Returns null when the file has another shape.
export function addCloseQueue(source) {
  if (source.includes('closeQueue')) return source;
  const marker = 'Promise.allSettled([';
  if (source.split(marker).length !== 2) return null;
  const ast = parse(source, { ecmaVersion: 'latest', sourceType: 'module' });
  const imports = ast.body.filter((node) => node.type === 'ImportDeclaration');
  if (!imports.length) return null;
  const last = imports.at(-1);
  const quote = source.slice(last.source.start, last.source.start + 1);
  const newline = source.includes('\r\n') ? '\r\n' : '\n';
  let result = source.replace(marker, `${marker}closeQueue(), `);
  result = result.slice(0, last.end) + `${newline}import { closeQueue } from ${quote}./queues/index.js${quote};` + result.slice(last.end);
  parse(result, { ecmaVersion: 'latest', sourceType: 'module' });
  return result;
}

export async function installQueue({ cwd = process.cwd(), project } = {}) {
  const root = await projectRoot(cwd, project);
  await directory(path.join(root, 'src'));
  const pkgPath = path.join(root, 'package.json');
  const pkgSource = await fs.readFile(pkgPath, 'utf8');
  const pkg = JSON.parse(pkgSource);

  // @st projects: the queue becomes the @st/queue framework package. It closes itself on
  // shutdown (@st/core), so src/server.js needs no change.
  const st = await usesSt(root);
  const creates = st ? [
    ['src/@st/queue/package.json', templates.stQueuePackage],
    ['src/@st/queue/index.js', templates.stQueueIndex],
    ['src/@st/queue/worker.js', templates.stQueueWorker],
    ['src/jobs/index.js', templates.jobsIndex],
    ['src/worker.js', templates.stWorker],
  ] : [
    ['src/queues/index.js', templates.queueIndex],
    ['src/jobs/index.js', templates.jobsIndex],
    ['src/worker.js', templates.worker],
  ];
  const newDirs = [];
  for (const dir of st ? ['src/@st/queue', 'src/jobs'] : ['src/queues', 'src/jobs']) {
    const full = path.join(root, dir);
    if (await exists(full)) await directory(full);
    else newDirs.push(full);
  }
  for (const [relative] of creates) {
    const file = path.join(root, relative);
    if (!await exists(path.dirname(file))) continue;
    const entries = await fs.readdir(path.dirname(file));
    if (entries.some((entry) => entry.toLowerCase() === path.basename(file).toLowerCase())) {
      throw new Error(`${relative} artıq mövcuddur; queue artıq quraşdırılıb ola bilər. Heç nə dəyişdirilmədi.`);
    }
  }

  // Plan every change before writing anything.
  const updates = [];
  const warnings = [];
  const update = async (relative, change) => {
    const file = path.join(root, relative);
    const original = await readFileIfExists(file);
    if (original === null) return false;
    const content = change(original);
    if (content === null) return null;
    if (content !== original) updates.push({ relative, file, original, content });
    return true;
  };

  const server = st || await update('src/server.js', addCloseQueue);
  if (server !== true) {
    warnings.push("src/server.js-də shutdown tapılmadı: server bağlananda closeQueue() çağır (import { closeQueue } from './queues/index.js').");
  }
  const envFiles = [];
  if (await update('.env', addRedisEnv)) envFiles.push('.env');
  if (await update('.env.example', addRedisEnv)) envFiles.push('.env.example');

  const added = [];
  const dependencies = { ...pkg.dependencies };
  for (const [name, version] of Object.entries(VERSIONS)) {
    if (!dependencies[name]) { dependencies[name] = version; added.push(name); }
  }
  const scripts = { ...pkg.scripts };
  for (const [name, command] of Object.entries(SCRIPTS)) scripts[name] ??= command;
  const nextPkg = {
    ...pkg,
    scripts,
    dependencies: Object.fromEntries(Object.entries(dependencies).sort(([a], [b]) => a.localeCompare(b))),
  };
  if (JSON.stringify(nextPkg) !== JSON.stringify(pkg)) {
    const indent = pkgSource.match(/^[ \t]+(?=")/m)?.[0] ?? '  ';
    const newline = pkgSource.includes('\r\n') ? '\r\n' : '\n';
    updates.push({
      relative: 'package.json', file: pkgPath, original: pkgSource,
      content: JSON.stringify(nextPkg, null, indent).replaceAll('\n', newline) + newline,
    });
  }

  const created = [];
  const replaced = [];
  const madeDirs = [];
  try {
    for (const dir of newDirs) { await fs.mkdir(dir); madeDirs.push(dir); }
    for (const [relative, content] of creates) {
      const file = path.join(root, relative);
      const handle = await fs.open(file, 'wx');
      created.push({ file, content });
      try { await handle.writeFile(content); } finally { await handle.close(); }
    }
    for (const item of updates) {
      if (await fs.readFile(item.file, 'utf8') !== item.original) throw new Error(`${item.relative} əməliyyat zamanı dəyişib. Yenidən cəhd et.`);
      await replaceFile(item.file, item.content);
      replaced.push(item);
    }
  } catch (error) {
    // Undo only what this run wrote and nobody has touched since.
    for (const item of replaced.reverse()) {
      if (await fs.readFile(item.file, 'utf8').catch(() => null) === item.content) await replaceFile(item.file, item.original);
    }
    for (const item of created.reverse()) {
      if (await fs.readFile(item.file, 'utf8').catch(() => null) === item.content) await fs.unlink(item.file);
    }
    for (const dir of madeDirs.reverse()) await fs.rmdir(dir).catch(() => {});
    throw error;
  }

  return {
    root,
    created: creates.map(([relative]) => relative),
    updated: updates.map((item) => item.relative),
    envFiles,
    added,
    warnings,
    st,
  };
}
