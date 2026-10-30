#!/usr/bin/env node

import * as p from '@clack/prompts';
import { downloadTemplate } from 'giget';
import pc from 'picocolors';
import fs from 'node:fs/promises';
import path from 'node:path';
import os from 'node:os';
import { fileURLToPath } from 'node:url';
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { makeController, parseControllerArgs } from './src/make-controller.js';
import { databaseConfig, promptDatabase, configureNewDatabase, databaseSteps } from './src/database.js';

const execFileAsync = promisify(execFile);
export const GITHUB_REPO = 'togrulzade/express-mvc-starter';
export const BRANCHES = { prisma: 'main', sequelize: 'sequelize', mongoose: 'mongoose' };

export function validateName(value) {
  if (!value) return 'Layihə adı boş ola bilməz.';
  if (value.length > 100 || !/^[a-z0-9][a-z0-9-]*$/.test(value)) {
    return 'Ad kiçik latın hərfi və ya rəqəmlə başlamalıdır; yalnız a-z, 0-9 və - istifadə et (ən çox 100 simvol).';
  }
  if (/^(node_modules|favicon\.ico|con|prn|aux|nul|com[1-9]|lpt[1-9])$/i.test(value)) {
    return 'Bu ad sistem tərəfindən istifadə olunur. Başqa ad seç.';
  }
}

export function parseArgs(args) {
  const options = {};
  const dbFlags = { '--database': 'database', '--db-host': 'host', '--db-port': 'port', '--db-user': 'user', '--db-name': 'name', '--db-file': 'file', '--db-auth-source': 'authSource' };
  for (let i = 0; i < args.length; i++) {
    const arg = args[i];
    if (arg === '--help' || arg === '-h') options.help = true;
    else if (arg === '--yes' || arg === '-y') options.yes = true;
    else if (arg.startsWith('--db-password')) throw new Error('Şifrəni interaktiv daxil et və ya EXG_DB_PASSWORD mühit dəyişənini istifadə et.');
    else if (Object.hasOwn(dbFlags, arg)) {
      const value = args[++i];
      if (value === undefined || value.startsWith('--')) throw new Error(`${arg} üçün dəyər lazımdır.`);
      options.database ??= {};
      const key = dbFlags[arg];
      if (Object.hasOwn(options.database, key)) throw new Error(`${arg} yalnız bir dəfə istifadə oluna bilər.`);
      options.database[key] = value;
    }
    else if (arg === '--orm' || arg === '--template') {
      const value = args[++i];
      if (!value || value.startsWith('--')) throw new Error(`${arg} üçün dəyər lazımdır.`);
      const key = arg === '--orm' ? 'orm' : 'templateDirectory';
      if (options[key]) throw new Error(`${arg} yalnız bir dəfə istifadə oluna bilər.`);
      options[key] = value;
    } else if (arg.startsWith('-')) throw new Error(`Naməlum seçim: ${arg}`);
    else if (options.name) throw new Error('Yalnız bir layihə adı ver.');
    else options.name = arg;
  }
  if (options.name && validateName(options.name)) throw new Error(validateName(options.name));
  if (options.orm && !Object.hasOwn(BRANCHES, options.orm)) {
    throw new Error('--orm prisma, sequelize və ya mongoose olmalıdır.');
  }
  if (options.yes && !options.orm) options.orm = 'prisma';
  if (options.orm && options.database) databaseConfig(options.orm, options.name, options.database);
  return options;
}

async function ensureAbsent(target) {
  try {
    await fs.lstat(target);
  } catch (error) {
    if (error.code === 'ENOENT') return;
    throw error;
  }
  throw new Error(`Bu ünvan artıq mövcuddur: ${target}. Yeni layihə adı seç.`);
}

async function requireFile(file) {
  let stat;
  try {
    stat = await fs.lstat(file);
  } catch (error) {
    if (error.code === 'ENOENT') throw new Error(`Şablonda tələb olunan fayl yoxdur: ${path.basename(file)}`);
    throw error;
  }
  if (!stat.isFile()) throw new Error(`Şablonda adi fayl olmalıdır: ${path.basename(file)}`);
}

export async function createProject({ name, orm, cwd = process.cwd(), templateDirectory, database }, downloader = downloadTemplate) {
  const nameError = validateName(name);
  if (nameError) throw new Error(nameError);
  if (!Object.hasOwn(BRANCHES, orm)) throw new Error('Düzgün ORM seç: prisma, sequelize, mongoose.');
  if (database) database = databaseConfig(orm, name, database);
  const targetDir = path.resolve(cwd, name);
  await ensureAbsent(targetDir);
  const tempDir = await fs.mkdtemp(path.join(os.tmpdir(), 'exg-'));
  const stage = path.join(tempDir, 'template');

  try {
    if (templateDirectory) {
      // Only committed files from the selected branch; no source checkout changes.
      await execFileAsync('git', ['clone', '--local', '--no-hardlinks', '--single-branch', '--branch', BRANCHES[orm], '--', path.resolve(cwd, templateDirectory), stage]);
      await fs.rm(path.join(stage, '.git'), { recursive: true, force: true });
    } else {
      await downloader(`github:${GITHUB_REPO}#${BRANCHES[orm]}`, { dir: stage, force: false });
    }

    const pkgPath = path.join(stage, 'package.json');
    const envExample = path.join(stage, '.env.example');
    await requireFile(pkgPath);
    await requireFile(envExample);
    const pkg = JSON.parse(await fs.readFile(pkgPath, 'utf8'));
    pkg.name = name;
    pkg.version = '0.1.0';
    pkg.private = true;
    await fs.writeFile(pkgPath, `${JSON.stringify(pkg, null, 2)}\n`);

    const lockPath = path.join(stage, 'package-lock.json');
    try {
      await fs.lstat(lockPath);
      await requireFile(lockPath);
      const lock = JSON.parse(await fs.readFile(lockPath, 'utf8'));
      lock.name = name;
      lock.version = '0.1.0';
      if (lock.packages?.['']) {
        lock.packages[''].name = name;
        lock.packages[''].version = '0.1.0';
      }
      await fs.writeFile(lockPath, `${JSON.stringify(lock, null, 2)}\n`);
    } catch (error) {
      if (error.code !== 'ENOENT') throw error;
    }

    if (database) await configureNewDatabase(stage, orm, name, database);
    else await fs.copyFile(envExample, path.join(stage, '.env'), fs.constants.COPYFILE_EXCL);
    // Exclusive mkdir also guards against a target created during download.
    await fs.mkdir(targetDir);
    for (const entry of await fs.readdir(stage)) {
      await fs.cp(path.join(stage, entry), path.join(targetDir, entry), { recursive: true, force: false, errorOnExist: true });
    }
    return targetDir;
  } finally {
    await fs.rm(tempDir, { recursive: true, force: true });
  }
}

export async function main(args = process.argv.slice(2)) {
  if (args[0] === 'make:controller') {
    const options = parseControllerArgs(args.slice(1));
    if (options.help) {
      console.log(`İstifadə: exg make:controller HomeController [--project ./my-api]

Controller-də index metodu, uyğun router və əsas router-də qeydiyyat yaradır.
Home adı da HomeController kimi qəbul edilir. Mövcud faylların üzərinə yazılmır.`);
      return;
    }
    const result = await makeController(options);
    for (const file of result.files) p.log.success(file);
    p.log.info(`Router yolu: ${result.mount} (standart EXG tətbiqində GET /api${result.mount}).`);
    p.log.info('index metodu hazırda 501 qaytarır; TODO hissəsinə öz məntiqini əlavə et.');
    return;
  }
  const options = parseArgs(args);
  if (options.help) {
    console.log(`EXG — Express MVC Generator

İstifadə:
  exg                           İnteraktiv seçim
  exg my-api                    ORM və database-i interaktiv seç
  exg my-api --orm prisma        Database bağlantısını interaktiv qur
  exg my-api --orm prisma --database mysql
  exg local-api --database sqlite --yes
  exg my-api --orm mongoose --template ../express-mvc-starter
  exg make:controller HomeController
  exg make:controller HomeController --project ./my-api

Seçimlər:
  --orm prisma|sequelize|mongoose
  --database postgresql|mysql|mariadb|sqlite|mongodb
  --db-host HOST     Default: localhost
  --db-port PORT     Seçilmiş bazanın standart portu
  --db-user USER     MySQL/MariaDB: root; PostgreSQL: postgres
  --db-name NAME     Default: layihə adı (- əvəzinə _)
  --db-file PATH     SQLite üçün nisbi .db yolu
  --db-auth-source NAME  MongoDB istifadəçisinin bazası (default: admin)
  --yes, -y          Sualları keç, verilməyən dəyərləri default götür
  --template PATH    Lokal Git şablonundan seçilmiş branch-i götür
  --help, -h         Bu köməyi göstər

Şifrə gizli soruşulur; default boşdur. Avtomatlaşdırma: EXG_DB_PASSWORD.
TTY olmayan mühitdə ad və ORM verildikdə suallar default ilə keçilir.
GitHub şablonu: ${GITHUB_REPO}
Node.js 22+ tələb olunur; lokal şablon seçimi üçün Git də lazımdır.`);
    return;
  }
  const interactive = !options.yes && Boolean(process.stdin.isTTY && process.stdout.isTTY);
  if ((!options.name || !options.orm) && !interactive) {
    throw new Error('İnteraktiv terminal yoxdur. Məsələn: exg my-api --orm prisma');
  }

  p.intro(pc.bgCyan(pc.black(' EXG - Express MVC Generator ')));
  const name = options.name ?? await p.text({
    message: 'Layihənin qovluq adı nə olsun?',
    placeholder: 'my-api',
    validate: validateName,
  });
  if (p.isCancel(name)) return p.cancel('Əməliyyat ləğv edildi.');
  const orm = options.orm ?? await p.select({
    message: 'Hansı ORM / baza şablonunu yükləyək?',
    options: [
      { value: 'prisma', label: 'Prisma ORM (SQL)', hint: 'Tövsiyə edilir' },
      { value: 'sequelize', label: 'Sequelize (Active Record SQL)' },
      { value: 'mongoose', label: 'Mongoose (MongoDB)' },
    ],
  });
  if (p.isCancel(orm)) return p.cancel('Əməliyyat ləğv edildi.');
  const input = { ...options.database };
  if (process.env.EXG_DB_PASSWORD !== undefined) input.password = process.env.EXG_DB_PASSWORD;
  const database = await promptDatabase({ orm, name, input, interactive });
  if (p.isCancel(database)) return p.cancel('Əməliyyat ləğv edildi.');

  const spinner = p.spinner();
  spinner.start(`Şablon hazırlanır (${BRANCHES[orm]})...`);
  try {
    await createProject({ ...options, name, orm, database });
    spinner.stop(pc.green('Layihə uğurla yaradıldı!'));
    p.note(`cd ${name}\nnpm install\n# .env hazırdır. Server bazası seçmisənsə, onu əvvəl yarat.\n${databaseSteps(orm)}\nnpm run dev`, 'Başlamaq üçün');
    p.outro(pc.cyan('Database addımları: yaradılan layihənin DATABASE.md faylı.'));
  } catch (error) {
    spinner.stop(pc.red('Layihə yaradıla bilmədi.'));
    throw error;
  }
}

// npm link may invoke this file through a symlink.
if (process.argv[1] && await fs.realpath(process.argv[1]) === fileURLToPath(import.meta.url)) {
  main().catch((error) => {
    p.log.error(error.message);
    process.exitCode = 1;
  });
}
