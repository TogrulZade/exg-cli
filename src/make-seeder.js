import fs from 'node:fs/promises';
import path from 'node:path';
import { parse } from 'acorn';
import { directory, projectRoot } from './make-controller.js';

export function parseSeederArgs(args) {
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
      throw new Error('Yalnız bir seeder adı ver.');
    } else options.name = arg;
  }
  if (!options.help) seederNames(options.name);
  return options;
}

export function seederNames(name) {
  if (typeof name !== 'string' || name.length > 100 || !/^[A-Za-z][A-Za-z0-9]*$/.test(name)) {
    throw new Error('Seeder adı hərflə başlamalı, yalnız latın hərfləri və rəqəmlərdən ibarət olmalıdır. Məsələn: BrandSeeder.');
  }
  const base = name.endsWith('Seeder') ? name.slice(0, -6) : name;
  if (!base) throw new Error('Seeder-dən əvvəl model adını yaz: BrandSeeder.');
  const model = base[0].toUpperCase() + base.slice(1);
  return {
    seeder: `${model}Seeder`,
    model,
    // Prisma Client names model delegates in camelCase: ProductCategory -> prisma.productCategory.
    delegate: model[0].toLowerCase() + model.slice(1),
    file: `prisma/seeders/${model}Seeder.js`,
  };
}

export function seederTemplate({ seeder, model, delegate }) {
  return `// ${model} cədvəlinə başlanğıc data yazır. prisma/seed.js bu funksiyanı çağırır.

// Yazı bu sahəyə görə axtarılır: yoxdursa yaradılır, varsa toxunulmur.
// Ona görə seeder-i neçə dəfə işlətsən də dublikat yaranmır.
// Bu sahə schema-da @unique olmalıdır (məsələn: name String @unique).
const uniqueBy = 'name';

const records = [
  // { name: 'Nümunə' },
];

export default async function ${seeder}(prisma) {
  for (const data of records) {
    await prisma.${delegate}.upsert({
      where: { [uniqueBy]: data[uniqueBy] },
      update: {},
      create: data,
    });
  }
  console.log(\`${seeder}: \${records.length} yazı\`);
}
`;
}

export function seedIndexTemplate(seeder) {
  return `// Laravel-dəki DatabaseSeeder kimi: bütün seeder-ləri ardıcıllıqla çağırır.
// İşlətmək: npm run db:seed (npx prisma migrate reset də sonda bunu avtomatik işlədir).
import 'dotenv/config';
import { PrismaClient } from '@prisma/client';
import ${seeder} from './seeders/${seeder}.js';

// Sıra vacibdir: əlaqəli data (məsələn Product -> Brand) asılı olduğu modeldən sonra gəlməlidir.
const seeders = [${seeder}];

const prisma = new PrismaClient();

try {
  for (const seeder of seeders) await seeder(prisma);
} catch (error) {
  console.error('Seed failed:', error);
  process.exitCode = 1;
} finally {
  await prisma.$disconnect();
}
`;
}

// Adds the import and appends the seeder to the `seeders` array, keeping the rest of the file as written.
export function registerSeeder(source, seeder) {
  const tokens = [];
  const ast = parse(source, { ecmaVersion: 'latest', sourceType: 'module', onToken: tokens });
  const imports = ast.body.filter((node) => node.type === 'ImportDeclaration');
  if (tokens.some((token) => token.type.label === 'name' && token.value === seeder) ||
      imports.some((node) => node.source.value === `./seeders/${seeder}.js`)) {
    throw new Error(`${seeder} artıq prisma/seed.js daxilində mövcuddur.`);
  }
  const list = ast.body.filter((node) => node.type === 'VariableDeclaration').flatMap((node) => node.declarations)
    .find((node) => node.id.type === 'Identifier' && node.id.name === 'seeders')?.init;
  if (list?.type !== 'ArrayExpression' || !imports.length) {
    throw new Error('prisma/seed.js daxilində import-lar və const seeders = [...] siyahısı gözlənilir. Fayl dəyişdirilmədi.');
  }
  const lastImport = imports.at(-1);
  const quote = source.slice(lastImport.source.start, lastImport.source.start + 1);
  const newline = source.includes('\r\n') ? '\r\n' : '\n';
  const last = list.elements.at(-1);
  // Insert from the end so earlier offsets stay valid.
  let result = last
    ? source.slice(0, last.end) + `, ${seeder}` + source.slice(last.end)
    : source.slice(0, list.end - 1) + seeder + source.slice(list.end - 1);
  result = result.slice(0, lastImport.end) +
    `${newline}import ${seeder} from ${quote}./seeders/${seeder}.js${quote};` + result.slice(lastImport.end);
  parse(result, { ecmaVersion: 'latest', sourceType: 'module' });
  return result;
}

async function readIfExists(file) {
  try {
    const stat = await fs.lstat(file);
    if (!stat.isFile() || stat.isSymbolicLink()) throw new Error(`Adi fayl olmalıdır: ${file}`);
    return await fs.readFile(file, 'utf8');
  } catch (error) {
    if (error.code === 'ENOENT') return null;
    throw error;
  }
}

async function replaceFile(file, content, root) {
  // Write to a temp file first, then rename, so a crash never leaves a half-written file.
  const temp = path.join(path.dirname(file), `.exg-${process.pid}-${Date.now()}-${path.basename(file)}`);
  const mode = await fs.stat(file).then((stat) => stat.mode & 0o777, () => 0o644);
  await fs.writeFile(temp, content, { mode, flag: 'wx' });
  try {
    await fs.rename(temp, file);
  } catch (error) {
    await fs.rm(temp, { force: true });
    throw error;
  }
  return path.relative(root, file);
}

export async function makeSeeder({ name, cwd = process.cwd(), project }) {
  const names = seederNames(name);
  const root = await projectRoot(cwd, project);
  const pkgPath = path.join(root, 'package.json');
  const pkgSource = await fs.readFile(pkgPath, 'utf8');
  const pkg = JSON.parse(pkgSource);
  if (!pkg.dependencies?.['@prisma/client'] && !pkg.devDependencies?.prisma) {
    throw new Error('make:seeder hazırda yalnız Prisma layihələri üçündür (@prisma/client tapılmadı).');
  }

  const prismaDir = path.join(root, 'prisma');
  await directory(prismaDir);
  const seedersDir = path.join(prismaDir, 'seeders');
  await fs.mkdir(seedersDir).catch((error) => { if (error.code !== 'EEXIST') throw error; });
  await directory(seedersDir);
  const entries = await fs.readdir(seedersDir);
  if (entries.some((entry) => entry.toLowerCase() === `${names.seeder}.js`.toLowerCase())) {
    throw new Error(`${names.file} artıq mövcuddur; üzərinə yazılmadı.`);
  }

  const seedPath = path.join(prismaDir, 'seed.js');
  const seedSource = await readIfExists(seedPath);
  // Validate seed.js before creating anything, so a bad file leaves the project untouched.
  const seedContent = seedSource === null ? seedIndexTemplate(names.seeder) : registerSeeder(seedSource, names.seeder);

  pkg.scripts ??= {};
  const pkgChanges = [];
  if (!pkg.scripts['db:seed']) { pkg.scripts['db:seed'] = 'prisma db seed'; pkgChanges.push('scripts.db:seed'); }
  if (typeof pkg.prisma !== 'object' || pkg.prisma === null) pkg.prisma = {};
  if (!pkg.prisma.seed) { pkg.prisma.seed = 'node prisma/seed.js'; pkgChanges.push('prisma.seed'); }
  const indent = pkgSource.match(/^[ \t]+(?=")/m)?.[0] ?? '  ';

  const seederFile = path.join(root, names.file);
  const seederContent = seederTemplate(names);
  const handle = await fs.open(seederFile, 'wx');
  try { await handle.writeFile(seederContent); } finally { await handle.close(); }

  const files = [names.file];
  try {
    if (seedSource === null) {
      const created = await fs.open(seedPath, 'wx');
      try { await created.writeFile(seedContent); } finally { await created.close(); }
      files.push('prisma/seed.js');
    } else {
      if (await fs.readFile(seedPath, 'utf8') !== seedSource) throw new Error('prisma/seed.js əməliyyat zamanı dəyişib. Yenidən cəhd et.');
      files.push(await replaceFile(seedPath, seedContent, root));
    }
    if (pkgChanges.length) {
      if (await fs.readFile(pkgPath, 'utf8') !== pkgSource) throw new Error('package.json əməliyyat zamanı dəyişib. Yenidən cəhd et.');
      const newline = pkgSource.includes('\r\n') ? '\r\n' : '\n';
      files.push(await replaceFile(pkgPath, JSON.stringify(pkg, null, indent).replaceAll('\n', newline) + newline, root));
    }
  } catch (error) {
    // Never remove a generated file if someone already edited it.
    if (await fs.readFile(seederFile, 'utf8').catch(() => null) === seederContent) await fs.unlink(seederFile);
    if (await fs.readFile(seedPath, 'utf8').catch(() => null) === seedContent) {
      if (seedSource === null) await fs.unlink(seedPath);
      else await replaceFile(seedPath, seedSource, root);
    }
    throw error;
  }
  return { root, ...names, files, pkgChanges };
}
