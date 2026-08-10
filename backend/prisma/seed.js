/* eslint-disable no-console */
const { PrismaClient } = require('@prisma/client');
const bcrypt = require('bcryptjs');

const prisma = new PrismaClient();

const ROLES = [
  { key: 'CUSTOMER', name: 'مشتری' },
  { key: 'SELLER', name: 'فروشنده' },
  { key: 'ADMIN', name: 'ادمین' },
  { key: 'SUPER_ADMIN', name: 'مدیر اصلی سایت' },
];

async function main() {
  console.log('Seeding roles...');
  for (const r of ROLES) {
    await prisma.role.upsert({
      where: { key: r.key }, update: {}, create: r,
    });
  }

  console.log('Seeding super admin...');
  const superAdminRole = await prisma.role.findUnique({ where: { key: 'SUPER_ADMIN' } });
  const passwordHash = await bcrypt.hash(process.env.SEED_SUPERADMIN_PASSWORD || 'ChangeMe@1404', 12);
  // Mobile MUST match the `^09\d{9}$` format enforced by auth.validation.js's loginSchema —
  // a non-conforming value (e.g. the literal string "superadmin") would pass the DB write
  // here but then be rejected by request validation on every future /auth/login attempt,
  // permanently locking the seeded account out.
  const superAdminMobile = process.env.SEED_SUPERADMIN_MOBILE || '09999999999';
  const superAdmin = await prisma.user.upsert({
    where: { mobile: superAdminMobile },
    update: {},
    create: {
      name: 'مدیر اصلی سایت',
      mobile: superAdminMobile,
      passwordHash,
      roleId: superAdminRole.id,
      status: 'ACTIVE',
    },
  });

  console.log('Seeding base categories...');
  const categories = [
    { name: 'پوشاک', slug: 'clothing', icon: 'i-shirt' },
    { name: 'مواد غذایی', slug: 'food', icon: 'i-food' },
    { name: 'اسباب‌بازی', slug: 'toys', icon: 'i-toy' },
    { name: 'لوازم خانه', slug: 'home', icon: 'i-home' },
    { name: 'زیبایی و آرایشی', slug: 'beauty', icon: 'i-beauty' },
    { name: 'کیف و کفش', slug: 'shoes', icon: 'i-shoe' },
  ];
  for (const c of categories) {
    await prisma.category.upsert({ where: { slug: c.slug }, update: {}, create: c });
  }

  console.log('Seeding hero slides...');
  const heroSlides = [
    {
      title: 'خرید بهترین کالاهای خارجی در ایران',
      subtitle: 'منطقه آزاد ارس — جلفا',
      description: 'مستقیم از فروشگاه‌های معتبر بازار جلفا؛ مقایسه قیمت، خرید آنلاین، تحویل به سراسر کشور.',
      desktopImageUrl: 'https://placehold.co/1600x700/1e1b4b/ffffff?text=Slide+1',
      primaryButtonText: 'مشاهده فروشگاه‌ها',
      primaryButtonLink: '/shops',
      secondaryButtonText: 'محصولات پرطرفدار',
      secondaryButtonLink: '/products',
      displayOrder: 0,
    },
    {
      title: 'قیمت عمده برای فروشندگان و مغازه‌داران',
      subtitle: 'خرید عمده',
      description: 'تخفیف‌های ویژه‌ی پلکانی برای خریدهای حجمی، مستقیم از تأمین‌کنندگان بازار جلفا.',
      desktopImageUrl: 'https://placehold.co/1600x700/312e81/ffffff?text=Slide+2',
      primaryButtonText: 'ورود به خرید عمده',
      primaryButtonLink: '/wholesale',
      secondaryButtonText: 'درباره ما',
      secondaryButtonLink: '/about',
      displayOrder: 1,
    },
  ];
  for (const s of heroSlides) {
    const existing = await prisma.heroSlide.findFirst({ where: { title: s.title } });
    if (!existing) await prisma.heroSlide.create({ data: s });
  }

  console.log('Seeding default GLOBAL commission rule...');
  // CommissionRule has no unique constraint we can upsert against for this
  // (scope alone isn't unique — multiple GLOBAL rows are allowed, e.g. an
  // inactive historical one). Guard idempotency manually instead: only
  // create the default when no active GLOBAL rule exists yet. This never
  // fights assertNotRemovingLastActiveGlobal() — that guard blocks removing
  // the *last* active GLOBAL rule, it never prevents adding one.
  const existingActiveGlobal = await prisma.commissionRule.findFirst({
    where: { scope: 'GLOBAL', isActive: true },
  });
  if (!existingActiveGlobal) {
    // 10% matches the GLOBAL commission rate used consistently as the
    // project's convention across the test suite (order-settlement.test.js,
    // order-refund.test.js, settlement-reporting.test.js, payout-liabilities.test.js).
    await prisma.commissionRule.create({
      data: {
        scope: 'GLOBAL',
        rate: 10,
        isActive: true,
        createdById: superAdmin.id,
      },
    });
  }

  console.log('Seed complete.');
}

main()
  .catch((e) => { console.error(e); process.exit(1); })
  .finally(async () => prisma.$disconnect());
