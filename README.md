# EXG — Express MVC Generator

Laravel-ə bənzər qovluq quruluşu olan Express layihəsi yaradan CLI. Üç seçim var: Prisma (`main` branch), Sequelize (`sequelize`) və Mongoose (`mongoose`). İnteraktiv suallar Azərbaycan dilindədir.

## Lokal quraşdırma

Node.js 22+ istifadə et. Şablonun lokal nüsxəsi üçün Git də lazımdır.

```bash
cd exg-cli
npm ci
npm link
exg --help
```

`npm link` bu qovluğu kompüterində `exg` əmrinə bağlayır. Kod dəyişəndə əmr həmin yeni kodu işlədir.

## İstifadə

Yeni layihə yaratmaq üçün:

```bash
exg
exg my-api
exg my-api --orm prisma
exg another-api --orm sequelize
exg mongo-api --orm mongoose
```

Terminalda layihə adından və ORM seçimindən sonra database sualları gəlir. `--orm prisma` versən, yalnız ORM sualı keçilir; baza məlumatları yenə soruşulur.

Ad kiçik latın hərfi və ya rəqəmlə başlamalıdır. Yalnız `a-z`, `0-9`, `-` istifadə et. Mövcud qovluq, fayl və ya simvolik link üzərinə yazılmır.

GitHub-a göndərmədən lokal şablonla işləmək üçün iki repozitoriyanın olduğu ana qovluqda:

```bash
exg my-api --orm prisma --template ./express-mvc-starter
exg sql-api --orm sequelize --template ./express-mvc-starter
exg mongo-api --orm mongoose --template ./express-mvc-starter
```

Lokal seçim seçilmiş branch-in son commit-ini götürür. Şablondakı commit olunmamış dəyişikliklər, `.env`, `node_modules` və Git tarixçəsi yeni layihəyə köçürülmür. Şablonun hazırda açıq branch-i dəyişmir. Şablonda gizli faylları heç vaxt commit etmə.

Generator `package.json` və mövcuddursa `package-lock.json` içində ad və versiyanı dəyişir. Versiya `0.1.0`, layihə isə `private: true` olur. Seçdiyin bağlantı `.env`-ə yazılır. Sequelize driver-i dəyişəndə npm vasitəsilə lock faylı yenilənir; bunun üçün registry bağlantısı lazımdır. Paketlər hələ quraşdırılmır, database yaradılmır və server başlamır.

## Database seçimi və bağlantı

Məsələn, MySQL ilə Prisma layihəsi:

```bash
exg shop-api --orm prisma --database mysql
```

Suallarda Enter bassan bu dəyərlər götürülür. Host, port, istifadəçi, şifrə və baza adını özün dəyişə bilərsən.

| Database | Hansı ORM-də? | Host | Port | İstifadəçi | Şifrə |
| --- | --- | --- | --- | --- | --- |
| PostgreSQL | Prisma, Sequelize | localhost | 5432 | postgres | boş |
| MySQL | Prisma, Sequelize | localhost | 3306 | root | boş |
| MariaDB | Prisma, Sequelize | localhost | 3306 | root | boş |
| SQLite | Prisma, Sequelize | lazım deyil | lazım deyil | lazım deyil | lazım deyil |
| MongoDB | Mongoose | localhost | 27017 | boş | boş |

**Boş şifrə serverinin həqiqi şifrəsi demək deyil.** EXG serverində istifadəçi və şifrə yaratmır. MySQL-də `root` üçün hansı şifrəni qoymusansa, sualda onu yaz. PostgreSQL-də adətən istifadəçi `postgres` olur; bu dəyəri də dəyişmək olar.

Baza adı layihə adından götürülür: `shop-api` → `shop_api` (maksimum 63 simvol). SQLite üçün başlanğıc fayl `./shop_api.db` olur. Prisma-da bu yol `prisma/` qovluğuna, Sequelize-də layihənin kökünə nəzərəndir. Fayl adını və alt qovluğunu dəyişmək olar, məsələn `./data/dev.db`. SQLite üçün ayrıca server və şifrə soruşulmur.

Şifrə gizli daxil edilir. URL-də problem yaradan `@`, `#`, `:`, `$` kimi simvollar generator tərəfindən kodlaşdırılır. Şəxsi bağlantın yalnız `.env`-ə yazılır; `.env.example` lokal və şifrəsiz nümunə saxlayır. `.env` Git-ə daxil edilmir.

MongoDB-də istifadəçini boş saxlasan, şifrəsiz lokal bağlantı hazırlanır. İstifadəçi yazsan, şifrə və `authSource` da soruşulur. `authSource` istifadəçinin yaradıldığı bazadır, başlanğıc dəyəri `admin`-dir.

Parametrləri birbaşa da verə bilərsən:

```bash
# Portu və istifadəçini dəyiş; çatışmayan məlumatlar soruşulacaq
exg shop-api --orm prisma --database mysql --db-port 3307 --db-user app_user

# Bütün sualları keç; şifrə boş, qalan sahələr standart olsun
exg local-api --orm prisma --database sqlite --yes

# PostgreSQL bağlantısının parametrləri
exg report-api --orm sequelize --database postgresql \
  --db-host localhost --db-port 5433 --db-user postgres --db-name reports --yes
```

`--yes` (`-y`) verilsə, çatışmayan sahələr üçün başlanğıc dəyərlər istifadə olunur; ORM verilməyibsə Prisma seçilir. Layihə adı yenə lazımdır. İnteraktiv terminal olmayan mühitdə layihə adı və ORM verilməlidir; baza sahələri soruşulmadan başlanğıc dəyərlərini alır. Avtomatlaşdırmada şifrəni secret/env vasitəsilə `EXG_DB_PASSWORD` dəyişəninə ver. Şifrəni əmr tarixçəsinə salmamaq üçün `--db-password` parametri yoxdur.

Bu quraşdırma **yeni layihə yaradılarkən** edilir. Mövcud layihədə host, port, istifadəçi və şifrəni `.env`-də dəyiş. Baza növünü sonradan dəyişmək üçün ORM schema-sı, driver və migration-lar da uyğunlaşdırılmalıdır.

Prisma üçün həm `schema.prisma` provider-i, həm ilkin `User` migration-ı, həm də `migration_lock.toml` seçilmiş bazaya uyğun hazırlanır. MariaDB Prisma-nın `mysql` provider-indən istifadə edir. Hazır SQL faylları Prisma 5.22 `migrate diff` ilə yaradılıb. Xüsusi model və migration-ları olan lokal Prisma şablonunun başqa provider-ə çevrilməsi qəbul edilmir; generator məlumatı səssiz itirməmək üçün xəta verir.

Sequelize üçün runtime bağlantısı və `database/config.cjs` eyni dialekti istifadə edir. Müvafiq paket (`pg`, `mysql2`, `mariadb` və ya `sqlite3`) və lock faylı hazırlanır. SQLite faylları `.gitignore`-a əlavə olunur.

Prisma 5-də SQLite migration-ından əvvəl baza faylı mövcud olmalıdır. Generator `scripts/prepare-sqlite.js` və `predb:migrate` / `predb:deploy` npm hook-larını əlavə edir. Aşağıdakı npm əmrləri çatışmayan qovluğu və faylı hazırlayır; mövcud baza silinmir. Bu, layihəni sonradan Git-dən götürəndə də işləyir.

Layihə yaranandan sonra:

```bash
cd my-api
npm install
# .env hazırdır; server bazası seçmisənsə, əvvəl onu yarat və serverini başlat
npm run db:generate
npm run db:deploy
npm run dev
```

Bu əmrlər Prisma üçündür. Sequelize üçün `npm run db:migrate`, Mongoose üçün isə işləyən MongoDB serveri lazımdır. Hər yaradılan layihənin `DATABASE.md` faylında seçdiyin bazaya uyğun addımlar var.

Şəbəkə və ya şablon hazırlama xətası olduqda hədəf layihə qovluğu yaradılmır. Son fayl köçürülməsi zamanı disk xətası olarsa qismən qovluq qala bilər; CLI xəta verir və mövcud məlumatları avtomatik silmir.

## Controller və router yaratmaq

Yaratdığın Express layihəsinin içində:

```bash
cd my-api
exg make:controller HomeController
```

Ana qovluqdan da işlədə bilərsən:

```bash
exg make:controller HomeController --project ./my-api
```

Əmr bunları hazırlayır:

- `src/controllers/HomeController.js`: `static async index(req, res, next)` metodu.
- `src/routes/homeRoutes.js`: `GET /` route-u controller-in `index` metoduna bağlıdır.
- `src/routes/index.js`: router import edilir və `/home` yoluna qoşulur. Standart EXG tətbiqində ünvan `GET /api/home` olur.

`index` daxilində TODO var və başlanğıcda `501 Not implemented` JSON cavabı verir; metodu boş saxlayıb sorğunu cavabsız qoymur. Həmin hissəyə öz kodunu yaz.

`exg make:controller Home` də işləyir. `UserProfileController` üçün `userProfileRoutes.js` və `/user-profile` yaranır. Qovluqlu adlar (`Admin/HomeController`) dəstəklənmir.

Mövcud faylların üzərinə yazılmır; eyni route yolu və import adı təkrar yaradılmır. Əmr ESM Express layihəsi və standart `Router()` + `export default router` quruluşu gözləyir. Standart quruluş tapılmazsa dəyişiklik etmədən xəta verir. Mövcud middleware və route sırası saxlanılır; yeni route default export-dan əvvəl qoşulur. Əsas router-də əvvəlcədən bütün yolları tutan 404/catch-all route varsa onun sırasını ayrıca nəzərə al.

Yalnız fayl yaradırsan, database əməliyyatı və migration işləmir. Lokal `npm link` istifadə edirsənsə yeni əmr dərhal əlçatandır.

## Service yaratmaq

Biznes məntiqini (database sorğuları, hesablamalar, cache) controller-dən ayırmaq üçün:

```bash
exg make:service UserService
# və ya: exg make:service User --project ./my-api
```

`src/services/UserService.js` yaranır. `src/services` qovluğu yoxdursa yaradılır, mövcud faylın üzərinə yazılmır:

```js
export class UserService {
  static async all() {
    // TODO: Bu metodun məntiqini yaz.
    return [];
  }
}
```

Controller-də istifadəsi:

```js
import { UserService } from '../services/UserService.js';

export class UserController {
  static async index(req, res, next) {
    try {
      const users = await UserService.all();
      res.json({ success: true, data: users });
    } catch (error) {
      next(error);
    }
  }
}
```

Controller yalnız sorğunu oxuyur və cavab qaytarır; data ilə iş service-də olur. Belə olduqda eyni məntiqi başqa controller-dən, admin paneldən və ya testdən də çağırmaq olur.

## Request (validation) yaratmaq

Laravel-dəki `make:request` (FormRequest) kimi:

```bash
exg make:request StoreProductRequest
# və ya: exg make:request StoreProduct --project ./my-api
```

`src/requests/StoreProductRequest.js` yaranır. Qaydaları zod ilə yaz:

```js
export const StoreProductSchema = z.object({
  name: z.string().trim().min(2).max(100),
  price: z.coerce.number().positive(),
  categoryIds: z.array(z.coerce.number().int().positive()).default([]),
});

export default validate(StoreProductSchema);
```

Router-də middleware kimi istifadə et:

```js
import StoreProductRequest from '../requests/StoreProductRequest.js';

router.post('/', StoreProductRequest, ProductController.store);
```

Qaydalar ödənməsə controller-ə çatmadan `422` və sahə xətaları qaytarılır. Uğurlu olsa `req.body` təmizlənmiş datadır (`trim`, `coerce`, `default` tətbiq olunub). `z.object`-də yazılmayan sahələr `req.body`-dən silinir, ona görə qaydaları yazmadan istifadə etmə.

`src/middlewares/validate.js` yoxdursa yaradılır. Layihədə `zod` olmalıdır. Mövcud faylın üzərinə yazılmır. Validation yalnız `req.body` üçündür.

## Seeder yaratmaq (Prisma)

Laravel-dəki `make:seeder` kimi:

```bash
exg make:seeder BrandSeeder
# və ya: exg make:seeder Brand --project ./my-api
```

Əmr bunları edir:

- `prisma/seeders/BrandSeeder.js` yaradır. `records` siyahısına data yaz, seeder hər birini `prisma.brand.upsert()` ilə yazır: `uniqueBy` sahəsinə (default `name`) görə yoxdursa yaradır, varsa toxunmur. Bu sahə schema-da `@unique` olmalıdır.
- `prisma/seed.js` (Laravel-dəki `DatabaseSeeder`) faylında seeder-i import edir və `const seeders = [...]` siyahısının sonuna əlavə edir. Fayl yoxdursa yaradılır.
- `package.json`-da yoxdursa `db:seed` script-i və `prisma.seed` ayarı əlavə olunur. Mövcud dəyərlərə toxunulmur.

İşlətmək: `npm run db:seed`. `npx prisma migrate reset` (Laravel-dəki `migrate:fresh --seed`) də sonda seed işlədir, amma bazadakı bütün datanı silir.

Seeder-lər `seeders` siyahısındakı sırayla işləyir: əlaqəli modellər (məsələn `Product` → `Brand`) asılı olduqları modeldən sonra gəlməlidir. Seeder-i təkrar işlətmək təhlükəsizdir, dublikat yaranmır. Modelin unikal sahəsi `name` deyilsə (məsələn `email`, `slug`), `uniqueBy` dəyərini dəyiş.

Mövcud seeder faylının üzərinə yazılmır. `seed.js` gözlənilən quruluşda deyilsə heç bir fayl dəyişdirilmədən xəta verilir. Sequelize və Mongoose şablonları üçün hələ dəstəklənmir.

## JWT authentication quraşdırmaq (Prisma)

```bash
exg install:jwt
# və ya: exg install:jwt --project ./my-api
```

Sonra:

```bash
npm install
npm run db:migrate -- --name add_user_password
```

Hazır endpoint-lər:

| Endpoint | Nə edir |
|---|---|
| `POST /api/auth/register` | `{ name, email, password }` → istifadəçi yaradır, `{ user, token }` qaytarır |
| `POST /api/auth/login` | `{ email, password }` → `{ user, token }` |
| `GET /api/auth/me` | Token sahibini qaytarır |

Route qorumaq üçün `requireAuth` middleware-ini əlavə et; daxil olan istifadəçi `req.user`-dədir:

```js
import { requireAuth } from '../middlewares/auth.js';

router.post('/', requireAuth, ProductController.store);
```

Sorğularda token header kimi göndərilir: `Authorization: Bearer <token>`.

Əmr bunları edir:

- Yaradır: `src/config/auth.js`, `src/services/AuthService.js`, `src/middlewares/auth.js`, `src/controllers/AuthController.js`, `src/routes/authRoutes.js`, `src/requests/RegisterRequest.js`, `src/requests/LoginRequest.js`, `test/auth.test.js` (və yoxdursa `src/middlewares/validate.js`).
- `src/routes/index.js`-də `/auth` route-unu qoşur.
- `User` modelinə `password String?` əlavə edir. Şifrə Node-un `scrypt` funksiyası ilə hash olunur.
- `src/config/db.js`-də `new PrismaClient({ omit: { user: { password: true } } })` yazır: şifrə hash-i heç bir sorğuda (məsələn `findMany()`) qaytarılmır. Prisma 6.2-dən köhnə versiyalarda schema-ya `previewFeatures = ["omitApi"]` də əlavə olunur.
- `.env`-ə təsadüfi `JWT_SECRET` və `JWT_EXPIRES_IN=1d`, `.env.example`-a boş nümunə yazır.
- `package.json`-a `jsonwebtoken` əlavə edir.

Mövcud faylların üzərinə yazılmır. Layihə gözlənilən quruluşda deyilsə (məsələn `db.js`-də tək `new PrismaClient()` yoxdursa və ya `User` modelində artıq `password` varsa) heç bir fayl dəyişdirilmədən xəta verilir. Sequelize və Mongoose şablonları hələ dəstəklənmir.

Token 1 gün etibarlıdır və bu müddətdə ləğv edilmir (logout və refresh token yoxdur). Production-da login üçün rate limit (məsələn `express-rate-limit`) əlavə et.

## GitHub və npm-dən quraşdırma

GitHub-dan quraşdırmaq üçün:

```bash
npm i -g github:togrulzade/exg-cli
# npm-ə dərc edilibsə:
npm i -g @togrulzade/exg
```

GitHub repozitoriyası: [TogrulZade/exg-cli](https://github.com/TogrulZade/exg-cli). npm-dən quraşdırma yalnız paket npm-ə dərc edilibsə işləyir.

## Yoxlama

```bash
npm test
npm audit
npm pack --dry-run
```

Testlər GitHub-a çıxmadan branch seçimini, yaradılan faylları, lokal Git şablonunu, yanlış adları, mövcud qovluğun qorunmasını və xəta hallarını yoxlayır. `giget` GitHub yükləməsi üçün istifadə olunur. Köhnə 1.x versiyasındakı `tar` asılılığının məlum boşluqlarına görə 3.x seçilib.

API mənbələri: [giget](https://github.com/unjs/giget), [Prisma bağlantı URL-ləri](https://www.prisma.io/docs/orm/reference/connection-urls), [Sequelize driver-ləri](https://sequelize.org/docs/v6/getting-started/).
