import { chromium } from 'playwright';
import { mkdirSync, writeFileSync } from 'fs';
import { dirname, join } from 'path';
import { fileURLToPath } from 'url';

const __dirname = dirname(fileURLToPath(import.meta.url));
const root = join(__dirname, '..');
const outDir = join(root, 'docs', 'phase3-fix-screenshots');
const port = process.argv[2] || '3456';
const url = `http://127.0.0.1:${port}/gooner-portal`;

mkdirSync(outDir, { recursive: true });

const browser = await chromium.launch();
const page = await browser.newPage({ viewport: { width: 1440, height: 900 } });
await page.goto(url, { waitUntil: 'networkidle' });
await page.waitForTimeout(1500);

const cards = page.locator('.dc-cards');
await cards.screenshot({ path: join(outDir, 'pc-normal-cards.png') });

const financeCard = page.locator('.dc-card[data-dept="finance"]');
await financeCard.hover();
await page.waitForTimeout(400);
await cards.screenshot({ path: join(outDir, 'pc-hover-cards.png') });

const mobile = await browser.newPage({ viewport: { width: 844, height: 390 } });
await mobile.goto(url, { waitUntil: 'networkidle' });
await mobile.waitForTimeout(1500);
await mobile.locator('.dc-cards').screenshot({ path: join(outDir, 'mobile-landscape-cards.png') });

const animPage = await browser.newPage({ viewport: { width: 1440, height: 900 } });
await animPage.goto(url, { waitUntil: 'networkidle' });
await animPage.waitForTimeout(800);
const t0 = await animPage.evaluate(() => {
  const img = document.querySelector('.dc-card[data-dept="finance"] .dc-card__image');
  if (!img) return null;
  const s = getComputedStyle(img);
  return { transform: s.transform, animationName: s.animationName };
});
await animPage.waitForTimeout(3200);
const t3 = await animPage.evaluate(() => {
  const img = document.querySelector('.dc-card[data-dept="finance"] .dc-card__image');
  if (!img) return null;
  const s = getComputedStyle(img);
  return { transform: s.transform, animationName: s.animationName };
});

const report = {
  url,
  reducedMotion: await page.evaluate(() => window.matchMedia('(prefers-reduced-motion: reduce)').matches),
  animation: { t0ms: t0, t3200ms: t3, idleDetected: t0?.animationName === 'dcCharacterIdle', transformChanged: t0?.transform !== t3?.transform },
  imageStyles: await page.evaluate(() => {
    const img = document.querySelector('.dc-card__image');
    if (!img) return null;
    const s = getComputedStyle(img);
    return { objectFit: s.objectFit, objectPosition: s.objectPosition, transform: s.transform };
  }),
};
writeFileSync(join(outDir, 'verification.json'), JSON.stringify(report, null, 2));

await browser.close();
console.log('saved to', outDir);
console.log(JSON.stringify(report, null, 2));
