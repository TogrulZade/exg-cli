import fs from 'node:fs/promises';
import path from 'node:path';
import { randomBytes } from 'node:crypto';
import { directory, projectRoot, routeIndex } from './make-controller.js';
import * as templates from './templates/jwt.js';

const JWT_VERSION = '^9.0.3';
const ZOD_VERSION = '^4.1.0';
const OMIT = '{ omit: { user: { password: true } } }';

export function parseInstallArgs(args) {
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

async function readFileIfExists(file) {
  try {
    const stat = await fs.lstat(file);
    if (!stat.isFile() || stat.isSymbolicLink()) throw new Error(`Adi fayl olmalıdır: ${file}`);
    return await fs.readFile(file, 'utf8');
  } catch (error) {
    if (error.code === 'ENOENT') return null;
    throw error;
  }
}

async function exists(file) {
  return fs.lstat(file).then(() => true, (error) => {
    if (error.code === 'ENOENT') return false;
    throw error;
  });
}

// Prisma <6.2 needs the "omitApi" preview flag for the global omit option.
export function needsOmitPreview(range) {
  const match = String(range ?? '').match(/(\d+)\.(\d+)/);
  if (!match) return true;
  const [major, minor] = [Number(match[1]), Number(match[2])];
  return major < 6 || (major === 6 && minor < 2);
}

// Returns every .prisma file of the project's schema (single file or schema folder).
async function schemaFiles(root, pkg) {
  const configured = pkg.prisma?.schema;
  const candidates = configured ? [configured] : ['prisma/schema.prisma', 'prisma/schema'];
  for (const relative of candidates) {
    const full = path.join(root, relative);
    let stat;
    try { stat = await fs.lstat(full); } catch (error) { if (error.code === 'ENOENT') continue; throw error; }
    if (stat.isSymbolicLink()) throw new Error(`Prisma schema simvolik link ola bilməz: ${relative}`);
    if (stat.isFile()) return [full];
    if (stat.isDirectory()) {
      const entries = (await fs.readdir(full)).filter((entry) => entry.endsWith('.prisma')).sort();
      return entries.map((entry) => path.join(full, entry));
    }
  }
  throw new Error('Prisma schema tapılmadı (prisma/schema.prisma və ya package.json-dakı prisma.schema).');
}

// Finds a `<keyword> <name> { ... }` block. Prisma block headers and closing braces start at column 0.
function findBlock(source, keyword, name) {
  const header = new RegExp(`^${keyword}\\s+${name}\\s*\\{[^\\S\\n]*$`, 'm').exec(source);
  if (!header) return null;
  const close = source.indexOf('\n}', header.index);
  if (close === -1) return null;
  return { start: header.index, bodyStart: header.index + header[0].length, end: close + 1 };
}

export function addPasswordField(source) {
  const block = findBlock(source, 'model', 'User');
  if (!block) return null;
  const body = source.slice(block.bodyStart, block.end);
  if (/^\s*password\s/m.test(body)) throw new Error('User modelində artıq password sahəsi var. Əmr dəyişiklik etmədi.');
  const newline = source.includes('\r\n') ? '\r\n' : '\n';
  const email = /^([ \t]+)email(\s+)\S.*$/m.exec(body);
  const comment = '// scrypt hash, never the plain password. Hidden from queries by the global omit in src/config/db.js.';
  if (email) {
    // Align with the email line: "  email     String ..." -> "  password  String?".
    const [line, indent, gap] = email;
    const pad = ' '.repeat(Math.max(1, 'email'.length + gap.length - 'password'.length));
    const at = block.bodyStart + email.index + line.length;
    return source.slice(0, at) + `${newline}${indent}${comment}${newline}${indent}password${pad}String?` + source.slice(at);
  }
  return source.slice(0, block.end - 1) + `  ${comment}${newline}  password String?${newline}` + source.slice(block.end - 1);
}

export function addOmitPreview(source) {
  const block = findBlock(source, 'generator', 'client');
  if (!block) return null;
  const body = source.slice(block.bodyStart, block.end);
  const preview = /^([ \t]*previewFeatures\s*=\s*\[)([^\]]*)\]/m.exec(body);
  if (preview) {
    if (/["']omitApi["']/.test(preview[2])) return source;
    const items = preview[2].trim();
    const at = block.bodyStart + preview.index;
    const replacement = `${preview[1]}${items ? `${items}, ` : ''}"omitApi"]`;
    return source.slice(0, at) + replacement + source.slice(at + preview[0].length);
  }
  const provider = /^([ \t]+)provider(\s*)=.*$/m.exec(body);
  if (!provider) throw new Error('generator client blokunda provider sətri tapılmadı. Əmr dəyişiklik etmədi.');
  const newline = source.includes('\r\n') ? '\r\n' : '\n';
  const at = block.bodyStart + provider.index + provider[0].length;
  return source.slice(0, at) + `${newline}${provider[1]}previewFeatures = ["omitApi"]` + source.slice(at);
}

export function addGlobalOmit(source) {
  if (/\bomit\s*:/.test(source)) throw new Error('src/config/db.js artıq omit ayarı istifadə edir. password-u əl ilə gizlət.');
  const calls = source.match(/new PrismaClient\(\s*\)/g) ?? [];
  if (calls.length !== 1) {
    throw new Error(`src/config/db.js daxilində tək "new PrismaClient()" gözlənilir. Əl ilə dəyiş: new PrismaClient(${OMIT})`);
  }
  return source.replace(/new PrismaClient\(\s*\)/, `new PrismaClient(${OMIT})`);
}

export function addEnv(source, secret) {
  if (/^JWT_SECRET=/m.test(source)) return source;
  const newline = source.includes('\r\n') ? '\r\n' : '\n';
  const lead = source === '' || source.endsWith(newline) ? '' : newline;
  return `${source}${lead}${newline}# JWT auth. At least 32 random characters, e.g. from: openssl rand -hex 32${newline}` +
    `JWT_SECRET=${secret}${newline}# How long a login token stays valid: 15m, 1h, 1d, 7d ...${newline}JWT_EXPIRES_IN=1d${newline}`;
}

async function replaceFile(file, content) {
  // Temp file + rename, so a crash never leaves a half-written file.
  const temp = path.join(path.dirname(file), `.exg-${process.pid}-${Date.now()}-${path.basename(file)}`);
  const mode = await fs.stat(file).then((stat) => stat.mode & 0o777, () => 0o644);
  await fs.writeFile(temp, content, { mode, flag: 'wx' });
  try {
    await fs.rename(temp, file);
  } catch (error) {
    await fs.rm(temp, { force: true });
    throw error;
  }
}

export async function installJwt({ cwd = process.cwd(), project } = {}) {
  const root = await projectRoot(cwd, project);
  for (const relative of ['src', 'src/config', 'src/controllers', 'src/middlewares', 'src/routes', 'src/services']) {
    await directory(path.join(root, relative));
  }
  const requestsDir = path.join(root, 'src/requests');
  const requestsDirExisted = await exists(requestsDir);
  if (requestsDirExisted) await directory(requestsDir);
  const pkgPath = path.join(root, 'package.json');
  const pkgSource = await fs.readFile(pkgPath, 'utf8');
  const pkg = JSON.parse(pkgSource);
  if (!pkg.dependencies?.['@prisma/client']) {
    throw new Error('install:jwt hazırda yalnız Prisma layihələri üçündür (@prisma/client tapılmadı).');
  }

  // Plan every change in memory first; nothing is written until all checks pass.
  const creates = [
    ['src/config/auth.js', templates.authConfig],
    ['src/services/AuthService.js', templates.authService],
    ['src/middlewares/auth.js', templates.authMiddleware],
    ['src/controllers/AuthController.js', templates.authController],
    ['src/routes/authRoutes.js', templates.authRoutes],
    ['src/requests/RegisterRequest.js', templates.registerRequest],
    ['src/requests/LoginRequest.js', templates.loginRequest],
  ];
  if (!await exists(path.join(root, 'src/middlewares/validate.js'))) creates.push(['src/middlewares/validate.js', templates.validateMiddleware]);
  if (await exists(path.join(root, 'test')) && !await exists(path.join(root, 'test/auth.test.js'))) creates.push(['test/auth.test.js', templates.authTest]);
  for (const [relative] of creates) {
    const file = path.join(root, relative);
    if (!await exists(path.dirname(file))) continue;
    const entries = await fs.readdir(path.dirname(file));
    if (entries.some((entry) => entry.toLowerCase() === path.basename(file).toLowerCase())) {
      throw new Error(`${relative} artıq mövcuddur; JWT artıq quraşdırılıb ola bilər. Heç nə dəyişdirilmədi.`);
    }
  }

  const updates = [];
  const update = async (relative, change) => {
    const file = path.join(root, relative);
    const original = await readFileIfExists(file);
    if (original === null) return false;
    const content = change(original);
    if (content !== null && content !== original) updates.push({ relative, file, original, content });
    return true;
  };

  if (!await update('src/routes/index.js', (source) => routeIndex(source, { variable: 'authRoutes', routeFile: 'authRoutes.js', mount: '/auth' }))) {
    throw new Error('src/routes/index.js tapılmadı.');
  }
  if (!await update('src/config/db.js', addGlobalOmit)) throw new Error('src/config/db.js tapılmadı.');

  const files = await schemaFiles(root, pkg);
  let userFound = false;
  let generatorFound = false;
  const preview = needsOmitPreview(pkg.dependencies['@prisma/client']);
  for (const file of files) {
    const relative = path.relative(root, file);
    await update(relative, (source) => {
      let result = source;
      const withPassword = addPasswordField(result);
      if (withPassword !== null) { userFound = true; result = withPassword; }
      if (preview) {
        const withPreview = addOmitPreview(result);
        if (withPreview !== null) { generatorFound = true; result = withPreview; }
      }
      return result;
    });
  }
  if (!userFound) throw new Error('Prisma schema-da "model User" tapılmadı. Əmr dəyişiklik etmədi.');
  if (preview && !generatorFound) throw new Error('Prisma schema-da "generator client" tapılmadı. Əmr dəyişiklik etmədi.');

  const secret = randomBytes(32).toString('hex');
  const envFiles = [];
  if (await update('.env', (source) => addEnv(source, secret))) envFiles.push('.env');
  if (await update('.env.example', (source) => addEnv(source, ''))) envFiles.push('.env.example');

  const dependencies = { ...pkg.dependencies };
  const added = [];
  if (!dependencies.jsonwebtoken) { dependencies.jsonwebtoken = JWT_VERSION; added.push('jsonwebtoken'); }
  if (!dependencies.zod) { dependencies.zod = ZOD_VERSION; added.push('zod'); }
  if (added.length) {
    const sorted = Object.fromEntries(Object.entries(dependencies).sort(([a], [b]) => a.localeCompare(b)));
    const indent = pkgSource.match(/^[ \t]+(?=")/m)?.[0] ?? '  ';
    const newline = pkgSource.includes('\r\n') ? '\r\n' : '\n';
    const content = JSON.stringify({ ...pkg, dependencies: sorted }, null, indent).replaceAll('\n', newline) + newline;
    updates.push({ relative: 'package.json', file: pkgPath, original: pkgSource, content });
  }

  const created = [];
  const replaced = [];
  try {
    // Laravel-style FormRequest files live in src/requests (exg make:request adds more).
    if (!requestsDirExisted) await fs.mkdir(requestsDir);
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
    if (!requestsDirExisted) await fs.rmdir(requestsDir).catch(() => {});
    throw error;
  }

  return {
    root,
    created: creates.map(([relative]) => relative),
    updated: updates.map((item) => item.relative),
    envFiles,
    added,
  };
}
