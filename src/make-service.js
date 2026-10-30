import fs from 'node:fs/promises';
import path from 'node:path';
import { directory, projectRoot } from './make-controller.js';

export function parseServiceArgs(args) {
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
      throw new Error('Yalnız bir service adı ver.');
    } else options.name = arg;
  }
  if (!options.help) serviceNames(options.name);
  return options;
}

export function serviceNames(name) {
  if (typeof name !== 'string' || name.length > 100 || !/^[A-Za-z][A-Za-z0-9]*$/.test(name)) {
    throw new Error('Service adı hərflə başlamalı, yalnız latın hərfləri və rəqəmlərdən ibarət olmalıdır. Məsələn: UserService.');
  }
  const base = name.endsWith('Service') ? name.slice(0, -7) : name;
  if (!base) throw new Error('Service-dən əvvəl ad yaz: UserService.');
  const service = `${base[0].toUpperCase()}${base.slice(1)}Service`;
  return { service, file: `src/services/${service}.js` };
}

export function serviceTemplate(service) {
  return `// Biznes məntiqi burada olur; controller yalnız req/res ilə işləyir və bu metodları çağırır.
export class ${service} {
  static async all() {
    // TODO: Bu metodun məntiqini yaz.
    return [];
  }
}
`;
}

export async function makeService({ name, cwd = process.cwd(), project }) {
  const names = serviceNames(name);
  const root = await projectRoot(cwd, project);
  await directory(path.join(root, 'src'));
  const dir = path.join(root, 'src/services');
  await fs.mkdir(dir).catch((error) => { if (error.code !== 'EEXIST') throw error; });
  await directory(dir);

  const entries = await fs.readdir(dir);
  if (entries.some((entry) => entry.toLowerCase() === `${names.service}.js`.toLowerCase())) {
    throw new Error(`${names.file} artıq mövcuddur; üzərinə yazılmadı.`);
  }
  // 'wx' fails if the file appeared in the meantime, so existing work is never overwritten.
  const handle = await fs.open(path.join(root, names.file), 'wx');
  try {
    await handle.writeFile(serviceTemplate(names.service));
  } finally {
    await handle.close();
  }
  return { root, ...names };
}
