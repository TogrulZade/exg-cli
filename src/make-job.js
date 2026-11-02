import fs from 'node:fs/promises';
import path from 'node:path';
import { parse } from 'acorn';
import { directory, projectRoot } from './make-controller.js';
import { replaceFile } from './install-jwt.js';
import { jobTemplate } from './templates/queue.js';
import { usesSt } from './layout.js';

export function parseJobArgs(args) {
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
    } else if (arg.startsWith('-')) {
      throw new Error(`Naməlum seçim: ${arg}`);
    } else if (options.name) {
      throw new Error('Yalnız bir job adı ver.');
    } else options.name = arg;
  }
  if (!options.help) jobName(options.name);
  return options;
}

// Job names are kept as written (SendWelcomeEmail), like Laravel job classes.
export function jobName(name) {
  if (typeof name !== 'string' || name.length > 100 || !/^[A-Za-z][A-Za-z0-9]*$/.test(name)) {
    throw new Error('Job adı hərflə başlamalı, yalnız latın hərfləri və rəqəmlərdən ibarət olmalıdır. Məsələn: SendWelcomeEmail.');
  }
  const job = name[0].toUpperCase() + name.slice(1);
  return { job, file: `src/jobs/${job}.js` };
}

// Adds `import Job from './Job.js'` and a `Job,` entry to `export const jobs = { ... }`.
export function registerJob(source, job) {
  const tokens = [];
  const ast = parse(source, { ecmaVersion: 'latest', sourceType: 'module', onToken: tokens });
  if (tokens.some((token) => token.type.label === 'name' && token.value === job)) {
    throw new Error(`${job} artıq src/jobs/index.js daxilində mövcuddur.`);
  }
  const exported = ast.body.find((node) => node.type === 'ExportNamedDeclaration' &&
    node.declaration?.type === 'VariableDeclaration' &&
    node.declaration.declarations.some((item) => item.id.name === 'jobs' && item.init?.type === 'ObjectExpression'));
  if (!exported) {
    throw new Error('src/jobs/index.js daxilində export const jobs = { ... } gözlənilir. Fayl dəyişdirilmədi.');
  }
  const list = exported.declaration.declarations.find((item) => item.id.name === 'jobs').init;
  const imports = ast.body.filter((node) => node.type === 'ImportDeclaration');
  const newline = source.includes('\r\n') ? '\r\n' : '\n';
  const quote = imports.length ? source.slice(imports.at(-1).source.start, imports.at(-1).source.start + 1) : "'";

  // Insert from the end of the file backwards so earlier offsets stay valid.
  let result = source;
  const last = list.properties.at(-1);
  if (last) {
    let next = last.end;
    while (/\s/.test(result[next])) next++;
    result = result[next] === ','
      ? result.slice(0, next + 1) + `${newline}  ${job},` + result.slice(next + 1)
      : result.slice(0, last.end) + `,${newline}  ${job},` + result.slice(last.end);
  } else {
    const close = list.end - 1;
    const lead = result.slice(list.start + 1, close).includes('\n') ? '' : newline;
    result = result.slice(0, close) + `${lead}  ${job},${newline}` + result.slice(close);
  }
  const statement = `import ${job} from ${quote}./${job}.js${quote};`;
  result = imports.length
    ? result.slice(0, imports.at(-1).end) + newline + statement + result.slice(imports.at(-1).end)
    : result.slice(0, exported.start) + statement + newline + newline + result.slice(exported.start);
  parse(result, { ecmaVersion: 'latest', sourceType: 'module' });
  return result;
}

export async function makeJob({ name, cwd = process.cwd(), project }) {
  const names = jobName(name);
  const root = await projectRoot(cwd, project);
  const dir = path.join(root, 'src/jobs');
  const indexPath = path.join(dir, 'index.js');
  try {
    await directory(dir);
    const stat = await fs.lstat(indexPath);
    if (!stat.isFile() || stat.isSymbolicLink()) throw new Error('src/jobs/index.js adi fayl olmalıdır.');
  } catch (error) {
    if (error.code === 'ENOENT') throw new Error('src/jobs/index.js tapılmadı. Əvvəlcə: st install:queue');
    throw error;
  }
  const entries = await fs.readdir(dir);
  if (entries.some((entry) => entry.toLowerCase() === `${names.job}.js`.toLowerCase())) {
    throw new Error(`${names.file} artıq mövcuddur; üzərinə yazılmadı.`);
  }

  const original = await fs.readFile(indexPath, 'utf8');
  const updated = registerJob(original, names.job);
  const file = path.join(root, names.file);
  const st = await usesSt(root);
  const content = jobTemplate(names.job, { st });
  const handle = await fs.open(file, 'wx');
  try { await handle.writeFile(content); } finally { await handle.close(); }
  try {
    if (await fs.readFile(indexPath, 'utf8') !== original) throw new Error('src/jobs/index.js əməliyyat zamanı dəyişib. Yenidən cəhd et.');
    await replaceFile(indexPath, updated);
  } catch (error) {
    if (await fs.readFile(file, 'utf8').catch(() => null) === content) await fs.unlink(file);
    throw error;
  }
  return { root, ...names, st, files: [names.file, 'src/jobs/index.js'] };
}
