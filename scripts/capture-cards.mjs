import { chromium } from 'playwright';
import { mkdirSync } from 'fs';
import { dirname, join } from 'path';
import { fileURLToPath } from 'url';

const __dirname = dirname(fileURLToPath(import.meta.url));
const root = join(__dirname, '..');
const outDir = join(root, 'docs', 'phase3-screenshots');
const label = process.argv[2] || 'after';
const port = process.argv[3] || '3456';
const url = `http://127.0.0.1:${port}/gooner-portal`;

mkdirSync(outDir, { recursive: true });

const views = [
  { name: 'pc', width: 1440, height: 900 },
  { name: 'mobile-landscape', width: 844, height: 390 },
];

const browser = await chromium.launch();
for (const view of views) {
  const page = await browser.newPage({ viewport: { width: view.width, height: view.height } });
  await page.goto(url, { waitUntil: 'networkidle' });
  await page.waitForTimeout(1200);
  const cards = page.locator('.dc-cards');
  await cards.screenshot({ path: join(outDir, `${label}-${view.name}-cards.png`) });
  await page.screenshot({ path: join(outDir, `${label}-${view.name}-dashboard.png`), fullPage: false });
  await page.close();
}
await browser.close();
console.log('saved to', outDir, 'label=', label);
