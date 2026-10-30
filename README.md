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

GitHub-da `togrulzade/express-mvc-starter` repozitoriyası və onun üç branch-i yayımlandıqdan sonra:

```bash
exg
exg my-api
exg my-api --orm prisma
exg another-api --orm sequelize
exg mongo-api --orm mongoose
```

Ad kiçik latın hərfi və ya rəqəmlə başlamalıdır. Yalnız `a-z`, `0-9`, `-` istifadə et. Mövcud qovluq, fayl və ya simvolik link üzərinə yazılmır.

GitHub-a göndərmədən lokal şablonla işləmək üçün iki repozitoriyanın olduğu ana qovluqda:

```bash
exg my-api --orm prisma --template ./express-mvc-starter
exg sql-api --orm sequelize --template ./express-mvc-starter
exg mongo-api --orm mongoose --template ./express-mvc-starter
```

Lokal seçim seçilmiş branch-in son commit-ini götürür. Şablondakı commit olunmamış dəyişikliklər, `.env`, `node_modules` və Git tarixçəsi yeni layihəyə köçürülmür. Şablonun hazırda açıq branch-i dəyişmir. Şablonda gizli faylları heç vaxt commit etmə.

Generator `package.json` və mövcuddursa `package-lock.json` içində ad və versiyanı dəyişir. Versiya `0.1.0`, layihə isə `private: true` olur. `.env.example` faylı `.env` olaraq kopyalanır. Paketlər avtomatik quraşdırılmır, database yaradılmır və server başlamır.

Layihə yaranandan sonra:

```bash
cd my-api
npm install
# .env içində database bağlantısını dəyiş
# PostgreSQL bazasını yarat və serverinin işlədiyini yoxla
npm run db:generate
npm run db:deploy
npm run dev
```

Bu əmrlər Prisma üçündür. Sequelize üçün `npm run db:migrate`, Mongoose üçün isə işləyən MongoDB serveri lazımdır. Hər şablonun README faylında uyğun addımlar var.

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

## GitHub və npm-dən quraşdırma

Bunlar repozitoriya və paket yayımlandıqdan sonra işləyəcək:

```bash
npm i -g github:togrulzade/exg-cli
# npm-ə dərc edilibsə:
npm i -g @togrulzade/exg
```

`togrulzade` bu kompüterdəki Git adından çıxarılıb; GitHub və npm hesablarına sahiblik yoxlanmayıb. Yayımlamadan əvvəl lazım olsa `package.json` içində scope-u, `index.js` içində `GITHUB_REPO` dəyərini və README ünvanlarını öz hesabına uyğunlaşdır.

## Yoxlama

```bash
npm test
npm audit
npm pack --dry-run
```

Testlər GitHub-a çıxmadan branch seçimini, yaradılan faylları, lokal Git şablonunu, yanlış adları, mövcud qovluğun qorunmasını və xəta hallarını yoxlayır. `giget` GitHub yükləməsi üçün istifadə olunur. Köhnə 1.x versiyasındakı `tar` asılılığının məlum boşluqlarına görə 3.x seçilib.

API mənbəyi: [giget rəsmi repozitoriyası](https://github.com/unjs/giget).
