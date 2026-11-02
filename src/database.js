import fs from 'node:fs/promises';
import path from 'node:path';
import { usesSt } from './layout.js';
import { isIP } from 'node:net';
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import * as prompts from '@clack/prompts';

const run = promisify(execFile);

export const DATABASES = {
  postgresql: { label: 'PostgreSQL', port: 5432, user: 'postgres', provider: 'postgresql', dialect: 'postgres', driver: { pg: '^8.12.0' } },
  mysql: { label: 'MySQL', port: 3306, user: 'root', provider: 'mysql', dialect: 'mysql', driver: { mysql2: '^3.24.6' } },
  mariadb: { label: 'MariaDB', port: 3306, user: 'root', provider: 'mysql', dialect: 'mariadb', driver: { mariadb: '^3.5.4' } },
  sqlite: { label: 'SQLite (fayl bazası)', provider: 'sqlite', dialect: 'sqlite', driver: { sqlite3: '^6.0.1' } },
  mongodb: { label: 'MongoDB', port: 27017, user: '' },
};

export function databaseChoices(orm) {
  if (orm === 'mongoose') return ['mongodb'];
  if (orm === 'prisma' || orm === 'sequelize') return ['postgresql', 'mysql', 'mariadb', 'sqlite'];
  throw new Error('Düzgün ORM seç: prisma, sequelize, mongoose.');
}

function fieldError(field, value) {
  if (typeof value !== 'string') return 'Mətn daxil et.';
  if (field === 'host') {
    const bare = value.replace(/^\[([^\]]+)\]$/, '$1');
    if (!isIP(bare) && !/^[a-zA-Z0-9](?:[a-zA-Z0-9._-]*[a-zA-Z0-9])?$/.test(value)) {
      return 'Host üçün domen və ya IP yaz; protokol və port əlavə etmə.';
    }
  } else if (field === 'port') {
    if (!/^\d+$/.test(value) || Number(value) < 1 || Number(value) > 65535) return 'Port 1–65535 arasında tam ədəd olmalıdır.';
  } else if (field === 'name' || field === 'authSource') {
    if (!/^[a-zA-Z0-9_][a-zA-Z0-9_-]{0,62}$/.test(value)) return '1–63 simvol: latın hərfi, rəqəm, _ və - istifadə et.';
  } else if (field === 'file') {
    if (!/^(?:\.\/)?[a-zA-Z0-9_-][a-zA-Z0-9_./-]*\.db$/.test(value) || value.split('/').includes('..')) {
      return 'Layihə daxilində nisbi .db yolu yaz. Məsələn: ./dev.db';
    }
  } else if (/[\u0000-\u001f\u007f]/.test(value)) return 'İdarəetmə simvolları istifadə edilə bilməz.';
}

export function databaseConfig(orm, projectName, input = {}) {
  const choices = databaseChoices(orm);
  const database = input.database === 'postgres' ? 'postgresql' : (input.database ?? choices[0]);
  if (!choices.includes(database)) throw new Error(`${orm} üçün baza seçimi: ${choices.join(', ')}.`);
  const spec = DATABASES[database];
  const name = (projectName || 'mydb').replaceAll('-', '_').slice(0, 63);
  if (database === 'sqlite') {
    if (['host', 'port', 'user', 'password', 'name', 'authSource'].some((key) => input[key] !== undefined && input[key] !== '')) {
      throw new Error('SQLite üçün host, port, istifadəçi və şifrə lazım deyil; --db-file istifadə et.');
    }
    const file = input.file ?? `./${name}.db`;
    const error = fieldError('file', file);
    if (error) throw new Error(error);
    return { database, file };
  }
  if (input.file !== undefined) throw new Error('--db-file yalnız SQLite üçündür.');
  if (database !== 'mongodb' && input.authSource !== undefined) throw new Error('--db-auth-source yalnız MongoDB üçündür.');
  const config = {
    database, host: input.host ?? 'localhost', port: String(input.port ?? spec.port),
    user: input.user ?? spec.user, password: input.password ?? '', name: input.name ?? name,
    ...(database === 'mongodb' ? { authSource: input.authSource ?? 'admin' } : {}),
  };
  for (const [key, value] of Object.entries(config)) {
    if (key === 'database') continue;
    const error = fieldError(key, value);
    if (error) throw new Error(`${key}: ${error}`);
  }
  if (database !== 'mongodb' && !config.user.trim()) throw new Error('SQL bazası üçün istifadəçi adı boş ola bilməz.');
  if (database === 'mongodb' && !config.user && config.password) throw new Error('MongoDB şifrəsi üçün istifadəçi adı da lazımdır.');
  return config;
}

// Encode credentials before writing a dotenv value, including quotes and #.
const encode = (value) => encodeURIComponent(value).replace(/[!'()*]/g, (char) => `%${char.charCodeAt(0).toString(16).toUpperCase()}`);

export function connectionUrl(orm, config) {
  const spec = DATABASES[config.database];
  if (config.database === 'sqlite') return `file:${config.file}`;
  const bareHost = config.host.replace(/^\[([^\]]+)\]$/, '$1');
  const host = isIP(bareHost) === 6 ? `[${bareHost}]` : bareHost;
  const protocol = orm === 'prisma' ? spec.provider : (spec.dialect ?? 'mongodb');
  const credentials = config.user ? `${encode(config.user)}:${encode(config.password)}@` : '';
  const query = orm === 'prisma' && config.database === 'postgresql' ? '?schema=public'
    : config.database === 'mongodb' && config.user ? `?authSource=${encode(config.authSource)}` : '';
  return `${protocol}://${credentials}${host}:${config.port}/${encode(config.name)}${query}`;
}

export async function promptDatabase({ orm, name, input = {}, interactive = true }, ui = prompts) {
  const choices = databaseChoices(orm);
  const database = input.database ?? (interactive && choices.length > 1 ? await ui.select({
    message: 'Hansı database istifadə olunsun?',
    options: choices.map((value) => ({ value, label: DATABASES[value].label })),
  }) : choices[0]);
  if (ui.isCancel(database)) return database;
  // Validate supplied flags before any further questions.
  const defaults = databaseConfig(orm, name, { ...input, database });
  if (!interactive) return defaults;
  const result = { ...defaults };
  const fields = defaults.database === 'sqlite' ? [['file', `SQLite faylı (${orm === 'prisma' ? 'prisma/ qovluğuna' : 'layihənin kökünə'} nəzərən)`]]
    : [['host', 'Database host'], ['port', 'Database port'], ['name', 'Database adı'], ['user', 'Database istifadəçisi (MongoDB üçün boş qala bilər)']];
  for (const [field, label] of fields) {
    if (input[field] !== undefined) continue;
    const value = await ui.text({
      message: `${label} [${defaults[field] || 'boş'}]`,
      placeholder: defaults[field], defaultValue: defaults[field],
      validate: (value) => {
        const resolved = value || defaults[field];
        if (field === 'user' && defaults.database !== 'mongodb' && !resolved.trim()) return 'İstifadəçi adı boş ola bilməz.';
        return fieldError(field, resolved);
      },
    });
    if (ui.isCancel(value)) return value;
    result[field] = value || defaults[field];
  }
  if (defaults.database !== 'sqlite' && result.user && input.password === undefined) {
    const password = await ui.password({ message: 'Database şifrəsi (Enter = boş)', validate: (value) => fieldError('password', value) });
    if (ui.isCancel(password)) return password;
    result.password = password;
  }
  if (defaults.database === 'mongodb' && result.user && input.authSource === undefined) {
    const authSource = await ui.text({
      message: 'MongoDB istifadəçisi hansı bazada yaradılıb? [admin]', placeholder: 'admin', defaultValue: 'admin',
      validate: (value) => fieldError('authSource', value || 'admin'),
    });
    if (ui.isCancel(authSource)) return authSource;
    result.authSource = authSource || 'admin';
  }
  return databaseConfig(orm, name, result);
}

function setEnv(source, key, value) {
  const line = `${key}="${value}"`;
  const pattern = new RegExp(`^(?:export\\s+)?${key}=.*$`, 'gm');
  // Template values are single-line URLs; reject ambiguous duplicate keys.
  if ([...source.matchAll(pattern)].length > 1) throw new Error(`.env.example daxilində ${key} təkrarlanır.`);
  return pattern.test(source) ? source.replace(pattern, () => line) : `${source.trimEnd()}\n${line}\n`;
}

async function refreshLock(directory) {
  const env = { ...process.env };
  delete env.EXG_DB_PASSWORD;
  try {
    await run('npm', ['install', '--package-lock-only', '--ignore-scripts', '--no-audit', '--no-fund'], {
      cwd: directory, env, timeout: 120_000, maxBuffer: 1024 * 1024,
    });
  } catch {
    throw new Error('Database driver-i üçün package-lock.json hazırlana bilmədi. npm/şəbəkə bağlantısını yoxlayıb yenidən çalışdır.');
  }
}

async function configurePrisma(directory, database) {
  const file = path.join(directory, 'prisma/schema.prisma');
  const schema = await fs.readFile(file, 'utf8');
  const datasource = /datasource\s+\w+\s*\{[^}]*\}/g;
  const blocks = [...schema.matchAll(datasource)];
  if (blocks.length !== 1 || !/url\s*=\s*env\("DATABASE_URL"\)/.test(blocks[0][0])) throw new Error('Şablonda standart Prisma datasource tapılmadı.');
  const provider = DATABASES[database].provider;
  const current = blocks[0][0].match(/provider\s*=\s*"([^"]+)"/)?.[1];
  if (current === provider) return;

  // Convert only the stock starter migration. Never silently lose custom models/history.
  const model = `model User { id Int @id @default(autoincrement()) name String email String @unique createdAt DateTime @default(now()) updatedAt DateTime @updatedAt }`;
  const models = schema.match(/(?:model|enum|type)\s+\w+\s*\{[^}]*\}/g) ?? [];
  const migrations = path.join(directory, 'prisma/migrations');
  const entries = (await fs.readdir(migrations)).sort();
  const stock = '20261028000000_create_users';
  const originalSql = await fs.readFile(path.join(migrations, stock, 'migration.sql'), 'utf8');
  const expectedSql = await fs.readFile(new URL('./database/postgresql.sql', import.meta.url), 'utf8');
  const normalize = (value) => value.replace(/--[^\n]*/g, '').replace(/\s+/g, ' ').trim();
  if (current !== 'postgresql' || models.length !== 1 || normalize(models[0]) !== model ||
      entries.join(',') !== `${stock},migration_lock.toml` || normalize(originalSql) !== normalize(expectedSql)) {
    throw new Error('Xüsusi Prisma schema/migration-ları avtomatik başqa bazaya çevirmək olmur. Standart EXG şablonu istifadə et.');
  }
  const sql = await fs.readFile(new URL(`./database/${provider}.sql`, import.meta.url), 'utf8');
  await fs.writeFile(file, schema.replace(datasource, (block) => block.replace(/provider\s*=\s*"[^"]+"/, `provider = "${provider}"`)));
  await fs.writeFile(path.join(migrations, stock, 'migration.sql'), sql);
  await fs.writeFile(path.join(migrations, 'migration_lock.toml'), `provider = "${provider}"\n`);
}

async function preparePrismaSqlite(directory) {
  await fs.mkdir(path.join(directory, 'scripts'), { recursive: true });
  await fs.copyFile(new URL('./database/prepare-sqlite.js', import.meta.url), path.join(directory, 'scripts/prepare-sqlite.js'), fs.constants.COPYFILE_EXCL);
  const pkgFile = path.join(directory, 'package.json');
  const pkg = JSON.parse(await fs.readFile(pkgFile, 'utf8'));
  pkg.scripts ??= {};
  for (const hook of ['predb:deploy', 'predb:migrate']) {
    if (pkg.scripts[hook]) throw new Error(`Şablonda ${hook} artıq var; SQLite hazırlığını əl ilə uyğunlaşdır.`);
    pkg.scripts[hook] = 'node scripts/prepare-sqlite.js';
  }
  await fs.writeFile(pkgFile, `${JSON.stringify(pkg, null, 2)}\n`);
}

async function configureSequelize(directory, config, updateLock) {
  const spec = DATABASES[config.database];
  const pkgFile = path.join(directory, 'package.json');
  const pkg = JSON.parse(await fs.readFile(pkgFile, 'utf8'));
  const before = JSON.stringify(pkg.dependencies);
  for (const driver of ['pg', 'pg-hstore', 'mysql2', 'mariadb', 'sqlite3']) delete pkg.dependencies[driver];
  Object.assign(pkg.dependencies, spec.driver);
  const shared = config.database === 'sqlite'
    ? `const path = require('node:path');\nconst config = { dialect: 'sqlite', storage: path.resolve(__dirname, '..', process.env.DB_STORAGE || './dev.db'), logging: false };`
    : `const config = { use_env_variable: 'DB_URI', dialect: '${spec.dialect}', logging: false };`;
  await fs.writeFile(path.join(directory, 'database/config.cjs'), `require('dotenv/config');\n${shared}\nmodule.exports = { development: config, test: config, production: config };\n`);
  if (config.database === 'sqlite') {
    // @st starter: the connection lives in the @st/database package and closes itself on shutdown.
    const st = await usesSt(directory);
    await fs.writeFile(path.join(directory, st ? 'src/@st/database/index.js' : 'src/config/db.js'), `import { Sequelize } from 'sequelize';
import { fileURLToPath } from 'node:url';
import path from 'node:path';
${st ? "import { onShutdown } from '@st/core';\n" : ''}
const root = fileURLToPath(new URL('${st ? '../../../' : '../../'}', import.meta.url));
const sequelize = new Sequelize({ dialect: 'sqlite', storage: path.resolve(root, process.env.DB_STORAGE || './dev.db'), logging: false });

export default sequelize;
export const connectDB = () => sequelize.authenticate();
export const disconnectDB = () => sequelize.close();
${st ? '\nonShutdown(disconnectDB);\n' : ''}`);
  }
  if (before !== JSON.stringify(pkg.dependencies)) {
    await fs.writeFile(pkgFile, `${JSON.stringify(pkg, null, 2)}\n`);
    await updateLock(directory);
  }
}

async function checkTemplatePaths(directory, config, orm) {
  const paths = ['.env.example', '.env', 'package.json', 'package-lock.json', '.gitignore', 'README.md', 'DATABASE.md'];
  if (orm === 'prisma') paths.push('prisma/schema.prisma', 'prisma/migrations/migration_lock.toml', 'prisma/migrations/20261028000000_create_users/migration.sql');
  if (orm === 'prisma' && config.database === 'sqlite') paths.push('scripts/prepare-sqlite.js');
  if (orm === 'sequelize') paths.push('database/config.cjs', await usesSt(directory) ? 'src/@st/database/index.js' : 'src/config/db.js');
  if (config.database === 'sqlite') paths.push(path.join(orm === 'prisma' ? 'prisma' : '', config.file));
  for (const relative of paths) {
    let current = directory;
    for (const part of relative.split(path.sep)) {
      current = path.join(current, part);
      try {
        if ((await fs.lstat(current)).isSymbolicLink()) throw new Error('Database konfiqurasiyası simvolik link üzərinə yazıla bilməz.');
      } catch (error) {
        if (error.code === 'ENOENT') break;
        throw error;
      }
    }
  }
}

export function databaseSteps(orm) {
  return orm === 'prisma' ? 'npm run db:generate\nnpm run db:deploy'
    : orm === 'sequelize' ? 'npm run db:migrate' : '# MongoDB serverinin işlədiyini yoxla';
}

// This function is used only on the temporary, freshly downloaded template.
export async function configureNewDatabase(directory, orm, projectName, input, updateLock = refreshLock) {
  const config = databaseConfig(orm, projectName, input);
  await checkTemplatePaths(directory, config, orm);
  if (orm === 'prisma') await configurePrisma(directory, config.database);
  if (orm === 'prisma' && config.database === 'sqlite') await preparePrismaSqlite(directory);
  if (orm === 'sequelize') await configureSequelize(directory, config, updateLock);
  const exampleFile = path.join(directory, '.env.example');
  let example = await fs.readFile(exampleFile, 'utf8');
  const sqliteSequelize = orm === 'sequelize' && config.database === 'sqlite';
  if (sqliteSequelize) example = example.replace(/^(?:export\s+)?DB_URI=.*\r?\n?/gm, '');
  const key = orm === 'prisma' ? 'DATABASE_URL' : orm === 'mongoose' ? 'MONGO_URI' : sqliteSequelize ? 'DB_STORAGE' : 'DB_URI';
  const defaults = databaseConfig(orm, projectName, { database: config.database });
  const exampleValue = sqliteSequelize ? defaults.file : connectionUrl(orm, defaults);
  const value = sqliteSequelize ? config.file : connectionUrl(orm, config);
  // The example contains local defaults, never the user's credentials/host.
  await fs.writeFile(exampleFile, setEnv(example, key, exampleValue));
  await fs.writeFile(path.join(directory, '.env'), setEnv(example, key, value), { flag: 'wx', mode: 0o600 });
  if (config.database === 'sqlite') {
    await fs.appendFile(path.join(directory, '.gitignore'), '\n# Local SQLite databases\n*.db\n*.db-journal\n*.db-wal\n*.db-shm\n');
    const base = path.join(directory, orm === 'prisma' ? 'prisma' : '');
    await fs.mkdir(path.dirname(path.join(base, config.file)), { recursive: true });
  }
  const guide = `# Database quraşdırılması

Bu layihə **${DATABASES[config.database].label}** və **${orm}** ilə hazırlanıb.
Bağlantı məlumatları layihənin kökündəki \`.env\` faylındadır: \`${key}\`.
Şifrəni və digər məlumatları sonradan həmin faylda dəyişə bilərsən. Şifrə URL daxilindədirsə, xüsusi simvolları URL-encode et.
\`.env.example\` şəxsi məlumatlarını saxlamır; yalnız lokal başlanğıc nümunəsidir.

${config.database === 'sqlite'
    ? `SQLite ayrıca server, istifadəçi və şifrə istəmir. Fayl yolu ${orm === 'prisma' ? '\`prisma/\` qovluğuna' : 'layihənin kökünə'} nəzərən hesablanır. Migration əmri faylı yaradacaq.${orm === 'prisma' ? ' npm migration əmrlərindən əvvəl scripts/prepare-sqlite.js işləyir: çatışmayan qovluq və boş faylı yaradır, mövcud məlumatları silmir. Buna görə aşağıdakı npm əmrlərini istifadə et.' : ''}`
    : config.database === 'mongodb' ? 'Əvvəl MongoDB serverini işə sal. İstifadəçi/şifrə seçmisənsə, həmin hesab serverdə mövcud olmalıdır. MongoDB baza/kolleksiyanı ilk yazıda yarada bilər.'
      : 'Əvvəl database serverini işə sal, .env-dəki adla bazanı yarat və istifadəçiyə giriş icazəsi ver. EXG server quraşdırmır, database və istifadəçi yaratmır.'}

\`root\` (MySQL/MariaDB), \`postgres\` (PostgreSQL) və boş şifrə yalnız CLI-nin təklif etdiyi dəyərlərdir. Bunlar sənin serverindəki hesabı və şifrəni dəyişmir; öz serverində təyin etdiyin şifrəni yaz.

## Başlat

\`\`\`bash
npm install
${databaseSteps(orm)}
npm run dev
\`\`\`

${orm === 'prisma' ? 'Hazır User migration-ı seçilmiş baza üçün hazırlanıb. Yeni model əlavə etdikdə: `npm run db:migrate -- --name add_products`, sonra `npm run db:generate`. Baza növünü sonradan dəyişmək schema və migration planı tələb edir; təkcə URL-i dəyişmək kifayət deyil.' : orm === 'sequelize' ? 'Database driver-i package.json və package-lock.json-a əlavə edilib. Runtime və migration konfiqurasiyası eyni bazanı istifadə edir. Yeni migration-ları database/migrations/ qovluğunda saxla.' : 'Mongoose üçün SQL migration əmri yoxdur. Modellər src/models/ qovluğundadır.'}
`;
  await fs.writeFile(path.join(directory, 'DATABASE.md'), guide);
  const readmePath = path.join(directory, 'README.md');
  const readme = await fs.readFile(readmePath, 'utf8').catch((error) => { if (error.code === 'ENOENT') return ''; throw error; });
  const start = `## Başlamaq\n\nBağlantı artıq .env-də hazırlanıb. Baza, migration və şifrə izahı üçün [DATABASE.md](./DATABASE.md) faylını oxu.\n\n\`\`\`bash\nnpm install\n${databaseSteps(orm)}\nnpm run dev\n\`\`\`\n\n`;
  await fs.writeFile(readmePath, `> Seçilmiş baza: **${DATABASES[config.database].label}**. Quraşdırma: [DATABASE.md](./DATABASE.md).\n\n${readme.replace(/## Başlamaq\n[\s\S]*?(?=\n## |$)/, start)}`);
  return config;
}
