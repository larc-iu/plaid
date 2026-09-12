// Does the timeline waveform actually draw, and does it REDRAW at a new zoom?
// The unit tests cover the arithmetic; this covers the canvas and the
// positioning, which nothing else does.
import { chromium } from '@playwright/test';

const PROJECT = '01a043bf-fa13-7aa8-921c-13ff44e74415';
const DOC = '01a043bf-fcdd-7965-8843-b320a24c10db';
const browser = await chromium.launch();
const page = await browser.newPage();
page.on('console', (m) => {
  if (m.type() === 'error') console.log('  console error:', m.text());
});

await page.goto('http://localhost:5174/');
await page.evaluate(() => localStorage.clear());
await page.goto('http://localhost:5174/#/login');
await page.fill('input[type="email"], input[name="username"], input[type="text"]', 'a@b.com');
await page.fill('input[type="password"]', 'password');
await page.click('button[type="submit"]');
await page.waitForTimeout(2000);

await page.goto(`http://localhost:5174/#/projects/${PROJECT}/documents/${DOC}?tab=media`);
const read = async () =>
  page.evaluate(() => {
    const el = [...document.querySelectorAll('div')].find((d) =>
      (d.style.backgroundImage || '').startsWith('url('),
    );
    const media = document.querySelector('audio, video');
    return {
      duration: media?.duration ?? null,
      readyState: media?.readyState ?? null,
      box: el ? { left: el.style.left, width: el.style.width } : null,
      img: el ? el.style.backgroundImage.slice(0, 20) : null,
      zoom: document.body.innerText.match(/\d+px\/s/)?.[0] ?? null,
    };
  });

for (let i = 0; i < 20; i++) {
  const s = await read();
  if (s.box) {
    console.log('drawn at open :', JSON.stringify(s));
    break;
  }
  await page.waitForTimeout(1000);
  if (i === 19) console.log('never drawn   :', JSON.stringify(s));
}

// Zoom in and confirm the image is redrawn for the new width, not stretched.
const before = await read();
const zoomIn = page.locator('button:near(:text("px/s"))').last();
for (let i = 0; i < 4; i++) {
  await zoomIn.click().catch(() => {});
  await page.waitForTimeout(400);
}
await page.waitForTimeout(1500);
const after = await read();
console.log('after zooming :', JSON.stringify(after));
console.log(
  before.box && after.box && (before.img !== after.img || before.box.width !== after.box.width)
    ? 'OK  the waveform was redrawn for the new zoom'
    : 'CHECK it looks unchanged after zooming',
);
await browser.close();
