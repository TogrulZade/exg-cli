import fs from 'node:fs/promises';
import path from 'node:path';
import { parse } from 'acorn';

export function parseControllerArgs(args) {
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
      throw new Error('Yalnız bir controller adı ver.');
    } else options.name = arg;
  }
  if (!options.help) controllerNames(options.name);
  return options;
}

export function controllerNames(name) {
  if (typeof name !== 'string' || name.length > 100 || !/^[A-Za-z][A-Za-z0-9]*$/.test(name)) {
    throw new Error('Controller adı hərflə başlamalı, yalnız latın hərfləri və rəqəmlərdən ibarət olmalıdır. Məsələn: HomeController.');
  }
  const base = name.endsWith('Controller') ? name.slice(0, -10) : name;
  if (!base) throw new Error('Controller-dən əvvəl ad yaz: HomeController.');
  const stem = base[0].toUpperCase() + base.slice(1);
  const words = stem.replace(/([A-Z]+)([A-Z][a-z])/g, '$1-$2').replace(/([a-z0-9])([A-Z])/g, '$1-$2').toLowerCase();
  const variable = words.replace(/-([a-z0-9])/g, (_, letter) => letter.toUpperCase()) + 'Routes';
  return { controller: `${stem}Controller`, variable, routeFile: `${variable}.js`, mount: `/${words}` };
}

export async function projectRoot(cwd, project) {
  let current = path.resolve(cwd, project || '.');
  while (true) {
    let pkg;
    try {
      pkg = JSON.parse(await fs.readFile(path.join(current, 'package.json'), 'utf8'));
    } catch (error) {
      if (error.code !== 'ENOENT') throw error;
    }
    if (pkg) {
      if (pkg.type !== 'module' || !pkg.dependencies?.express) {
        throw new Error('Bu əmr type: module və express dependency-si olan EXG layihəsi üçündür. --project ./my-api istifadə edə bilərsən.');
      }
      return current;
    }
    const parent = path.dirname(current);
    if (project || parent === current) {
      throw new Error('Express layihəsi tapılmadı. Layihənin içində işlə və ya --project ./my-api göstər.');
    }
    current = parent;
  }
}

export async function directory(dir) {
  const stat = await fs.lstat(dir);
  if (!stat.isDirectory() || stat.isSymbolicLink()) {
    throw new Error(`Adi layihə qovluğu olmalıdır: ${dir}`);
  }
}

export function routeIndex(source, names) {
  const tokens = [];
  const ast = parse(source, { ecmaVersion: 'latest', sourceType: 'module', onToken: tokens });
  const exported = ast.body.find((node) => node.type === 'ExportDefaultDeclaration');
  const routerName = exported?.declaration.type === 'Identifier' ? exported.declaration.name : null;
  if (!routerName || ast.body.at(-1) !== exported) {
    throw new Error('src/routes/index.js sonunda export default router tipli export gözlənilir. Fayl dəyişdirilmədi.');
  }
  const imports = ast.body.filter((node) => node.type === 'ImportDeclaration');
  const factoryNames = imports.filter((node) => node.source.value === 'express')
    .flatMap((node) => node.specifiers.filter((item) => item.type === 'ImportSpecifier' && item.imported.name === 'Router').map((item) => item.local.name));
  const declarations = ast.body.filter((node) => node.type === 'VariableDeclaration').flatMap((node) => node.declarations);
  const declaration = declarations.find((node) => node.id.name === routerName);
  if (declaration?.init?.type !== 'CallExpression' || !factoryNames.includes(declaration.init.callee.name)) {
    throw new Error('src/routes/index.js daxilində Express Router() yaradılması tapılmadı. Fayl dəyişdirilmədi.');
  }
  if (tokens.some((token) => token.type.label === 'name' && token.value === names.variable) ||
      imports.some((node) => node.source.value === `./${names.routeFile}`)) {
    throw new Error(`${names.variable} artıq routes/index.js daxilində mövcuddur.`);
  }
  for (const node of ast.body) {
    const call = node.type === 'ExpressionStatement' ? node.expression : null;
    if (call?.type !== 'CallExpression' || call.callee.type !== 'MemberExpression' || call.callee.object.name !== routerName) continue;
    const first = call.arguments[0];
    const paths = first?.type === 'ArrayExpression' ? first.elements : [first];
    if (paths.some((value) => value?.type === 'Literal' && typeof value.value === 'string' &&
      value.value.replace(/\/+$/, '').toLowerCase() === names.mount.toLowerCase())) {
      throw new Error(`${names.mount} yolu artıq routes/index.js daxilində istifadə olunur.`);
    }
  }
  const newline = source.includes('\r\n') ? '\r\n' : '\n';
  const lastImport = imports.at(-1);
  const quote = source.slice(lastImport.source.start, lastImport.source.start + 1);
  const mount = `${routerName}.use(${quote}${names.mount}${quote}, ${names.variable});${newline}${newline}`;
  const imported = `${newline}import ${names.variable} from ${quote}./${names.routeFile}${quote};`;
  // Insert from the end so original offsets, comments and formatting remain intact.
  let result = source.slice(0, exported.start) + mount + source.slice(exported.start);
  result = result.slice(0, lastImport.end) + imported + result.slice(lastImport.end);
  parse(result, { ecmaVersion: 'latest', sourceType: 'module' });
  return result;
}

export async function makeController({ name, cwd = process.cwd(), project }) {
  const names = controllerNames(name);
  const root = await projectRoot(cwd, project);
  for (const relative of ['src', 'src/controllers', 'src/routes']) await directory(path.join(root, relative));
  const indexPath = path.join(root, 'src/routes/index.js');
  const stat = await fs.lstat(indexPath);
  if (!stat.isFile() || stat.isSymbolicLink()) throw new Error('routes/index.js adi fayl olmalıdır.');

  const lockPath = path.join(root, '.exg-controller.lock');
  let lock;
  try {
    lock = await fs.open(lockPath, 'wx');
  } catch (error) {
    if (error.code === 'EEXIST') throw new Error('Başqa controller yaratma əməliyyatı işləyir. Əgər əvvəlki əməliyyat yarıda dayanıbsa, .exg-controller.lock faylını yoxla.');
    throw error;
  }
  const created = [];
  let stagedIndex;
  try {
    const original = await fs.readFile(indexPath, 'utf8');
    const updated = routeIndex(original, names);
    const outputs = [
      {
        relative: `src/controllers/${names.controller}.js`,
        content: `export class ${names.controller} {\n  static async index(req, res, next) {\n    // TODO: Bu metodun məntiqini yaz.\n    return res.status(501).json({\n      success: false,\n      message: 'Not implemented',\n    });\n  }\n}\n`,
      },
      {
        relative: `src/routes/${names.routeFile}`,
        content: `import { Router } from 'express';\nimport { ${names.controller} } from '../controllers/${names.controller}.js';\n\nconst router = Router();\n\nrouter.get('/', ${names.controller}.index);\n\nexport default router;\n`,
      },
    ];
    for (const output of outputs) {
      output.file = path.join(root, output.relative);
      const entries = await fs.readdir(path.dirname(output.file));
      if (entries.some((entry) => entry.toLowerCase() === path.basename(output.file).toLowerCase())) {
        throw new Error(`${output.relative} artıq mövcuddur; üzərinə yazılmadı.`);
      }
    }
    for (const output of outputs) {
      const handle = await fs.open(output.file, 'wx');
      created.push(output);
      try { await handle.writeFile(output.content); } finally { await handle.close(); }
    }
    if (await fs.readFile(indexPath, 'utf8') !== original) {
      throw new Error('routes/index.js əməliyyat zamanı dəyişib. Yenidən cəhd et.');
    }
    stagedIndex = await fs.mkdtemp(path.join(root, 'src/routes/.exg-'));
    const stagedFile = path.join(stagedIndex, 'index.js');
    await fs.writeFile(stagedFile, updated, { mode: stat.mode & 0o777 });
    await fs.rename(stagedFile, indexPath);
    return { root, ...names, files: [...outputs.map((output) => output.relative), 'src/routes/index.js'] };
  } catch (error) {
    for (const output of created.reverse()) {
      // Never remove a generated file if it was edited by another process.
      if (await fs.readFile(output.file, 'utf8').catch(() => null) === output.content) await fs.unlink(output.file);
    }
    throw error;
  } finally {
    if (stagedIndex) await fs.rm(stagedIndex, { recursive: true, force: true });
    await lock.close();
    await fs.unlink(lockPath);
  }
}
