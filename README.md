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
npm run db:migrate -- --name init
npm run dev
```

Bu əmrlər Prisma üçündür. Sequelize üçün `npm run db:migrate`, Mongoose üçün isə işləyən MongoDB serveri lazımdır. Hər şablonun README faylında uyğun addımlar var.

Şəbəkə və ya şablon hazırlama xətası olduqda hədəf layihə qovluğu yaradılmır. Son fayl köçürülməsi zamanı disk xətası olarsa qismən qovluq qala bilər; CLI xəta verir və mövcud məlumatları avtomatik silmir.

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
