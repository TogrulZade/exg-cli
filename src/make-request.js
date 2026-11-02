import fs from 'node:fs/promises';
import path from 'node:path';
import { directory, projectRoot } from './make-controller.js';
import { validateMiddleware } from './templates/jwt.js';

export function parseRequestArgs(args) {
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
      throw new Error('Yalnız bir request adı ver.');
    } else options.name = arg;
  }
  if (!options.help) requestNames(options.name);
  return options;
}

export function requestNames(name) {
  if (typeof name !== 'string' || name.length > 100 || !/^[A-Za-z][A-Za-z0-9]*$/.test(name)) {
    throw new Error('Request adı hərflə başlamalı, yalnız latın hərfləri və rəqəmlərdən ibarət olmalıdır. Məsələn: StoreProductRequest.');
  }
  const base = name.endsWith('Request') ? name.slice(0, -7) : name;
  if (!base) throw new Error('Request-dən əvvəl ad yaz: StoreProductRequest.');
  const request = `${base[0].toUpperCase()}${base.slice(1)}Request`;
  return { request, schema: `${request.slice(0, -7)}Schema`, file: `src/requests/${request}.js` };
}

export function requestTemplate({ request, schema }) {
  return `import { z } from 'zod';
import { validate } from '../middlewares/validate.js';

// Laravel-dəki FormRequest kimi: bu sorğunun body qaydaları (rules) buradadır.
// Router-də: router.post('/', ${request}, Controller.store);
// Uğursuz olsa 422 qaytarılır; uğurlu olsa controller-də req.body yalnız təmizlənmiş sahələri saxlayır.
// Diqqət: burada yazılmayan sahələr req.body-dən silinir. Qaydaları yazmadan istifadə etsən body boş gələr.
export const ${schema} = z.object({
  // name: z.string().trim().min(2, 'Name must be at least 2 characters').max(100),
  // email: z.string().trim().toLowerCase().email('Invalid email address'),
  // price: z.coerce.number().positive(),
  // categoryIds: z.array(z.coerce.number().int().positive()).default([]),
});

export default validate(${schema});
`;
}

async function exists(file) {
  return fs.lstat(file).then(() => true, (error) => {
    if (error.code === 'ENOENT') return false;
    throw error;
  });
}

export async function makeRequest({ name, cwd = process.cwd(), project }) {
  const names = requestNames(name);
  const root = await projectRoot(cwd, project);
  const pkg = JSON.parse(await fs.readFile(path.join(root, 'package.json'), 'utf8'));
  if (!pkg.dependencies?.zod) {
    throw new Error('Bu əmr zod istifadə edir, amma package.json-da yoxdur. Əvvəlcə: npm install zod');
  }
  await directory(path.join(root, 'src'));
  for (const relative of ['src/requests', 'src/middlewares']) {
    await fs.mkdir(path.join(root, relative)).catch((error) => { if (error.code !== 'EEXIST') throw error; });
    await directory(path.join(root, relative));
  }

  const entries = await fs.readdir(path.join(root, 'src/requests'));
  if (entries.some((entry) => entry.toLowerCase() === `${names.request}.js`.toLowerCase())) {
    throw new Error(`${names.file} artıq mövcuddur; üzərinə yazılmadı.`);
  }

  const outputs = [{ relative: names.file, content: requestTemplate(names) }];
  if (!await exists(path.join(root, 'src/middlewares/validate.js'))) {
    outputs.push({ relative: 'src/middlewares/validate.js', content: validateMiddleware });
  }
  const created = [];
  try {
    for (const output of outputs) {
      // 'wx' never overwrites a file that appeared in the meantime.
      const handle = await fs.open(path.join(root, output.relative), 'wx');
      created.push(output);
      try { await handle.writeFile(output.content); } finally { await handle.close(); }
    }
  } catch (error) {
    for (const output of created.reverse()) {
      const file = path.join(root, output.relative);
      if (await fs.readFile(file, 'utf8').catch(() => null) === output.content) await fs.unlink(file);
    }
    throw error;
  }
  return { root, ...names, files: outputs.map((output) => output.relative) };
}
