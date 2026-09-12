// Does a kept detection actually come back on screen? Writes the metadata a
// prior detection would have left, then opens the Media tab and looks for the
// proposal rows. The restore half is what matters for "leave and come back",
// and the unit tests cannot see it.
//
// NOTE the method key is `builtin:silero`, the composite the service picker
// uses, not the bare model name. The app writes whatever it is and compares
// against the same value, so real use round-trips; a hand-written probe has to
// get it exactly right or the restore correctly refuses.
import { chromium } from '@playwright/test';
import { makeClient } from '../bugbash/harness.mjs';

const PROJECT = '01a043bf-fa13-7aa8-921c-13ff44e74415';
const DOC = '01a043bf-fcdd-7965-8843-b320a24c10db';

const client = makeClient();
const before = (await client.documents.get(DOC)).metadata || {};
const media = await fetch(`http://localhost:8085/api/v1/documents/${DOC}/media`, {
  headers: { Authorization: `Bearer ${client.token}` },
});
const bytes = Number(media.headers.get('content-length'));
console.log('media bytes:', bytes);

await client.documents.setMetadata(DOC, {
  ...before,
  speechDetection: {
    mediaBytes: bytes,
    method: 'builtin:silero',
    regions: [
      { timeBegin: 1.0, timeEnd: 2.5 },
      { timeBegin: 4.0, timeEnd: 6.25 },
      { timeBegin: 8.5, timeEnd: 11.0 },
    ],
    dismissed: [],
  },
});

const browser = await chromium.launch();
const page = await browser.newPage();
await page.goto('http://localhost:5174/#/login');
await page.fill('input[type="email"], input[name="username"], input[type="text"]', 'a@b.com');
await page.fill('input[type="password"]', 'password');
await page.click('button[type="submit"]');
await page.waitForTimeout(2000);
await page.goto(`http://localhost:5174/#/projects/${PROJECT}/documents/${DOC}?tab=media`);

let seen = null;
for (let i = 0; i < 20; i++) {
  seen = await page.evaluate(() => ({
    proposalRows: document.querySelectorAll('[data-vad-proposal-row]').length,
    segmentRows: document.querySelectorAll('[data-segment-id]').length,
    transcript: (document.body.innerText.match(/\d+ segments?/) || [])[0] ?? null,
  }));
  if (seen.proposalRows > 0) break;
  await page.waitForTimeout(1000);
}
console.log('on screen:', JSON.stringify(seen));
console.log(
  seen.proposalRows === 3
    ? 'OK  all three kept cuts came back as proposals'
    : 'FAIL restore did not surface the cuts',
);

await browser.close();
await client.documents.setMetadata(DOC, before);
console.log('document metadata restored');
