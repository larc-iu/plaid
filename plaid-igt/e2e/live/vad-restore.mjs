// Does a kept detection actually come back on screen? Writes the metadata a
// prior detection would have left, then opens the Media tab and looks for the
// proposal rows. The restore half is what matters for "leave and come back",
// and the unit tests cannot see it.
//
// NOTE the method key is `builtin:silero`, the composite the service picker
// uses, not the bare model name. The app writes whatever it is and compares
// against the same value, so real use round-trips; a hand-written probe has to
// get it exactly right or the restore correctly refuses. The same goes for the
// recording's print (`media`, mediaFingerprint.js), read here from the bytes
// the Media tab will play, and for the regions, a flat list of begin and end
// in turn.
//
//   PLAID_CORE_URL=http://127.0.0.1:PORT node --import ./e2e/live/aliases.mjs \
//     e2e/live/vad-restore.mjs PROJECT_ID [DOCUMENT_ID]
//
// The document is the given one, else the project's first with a recording.
// PLAID_APP_URL is where the igt app runs against that core (default http://localhost:5174).
import { chromium } from '@playwright/test';
import { makeClient } from '../bugbash/harness.mjs';
import { mediaFingerprint } from '../../src/domain/media/mediaFingerprint.js';

const CORE = process.env.PLAID_CORE_URL || 'http://localhost:8085';
const APP = process.env.PLAID_APP_URL || 'http://localhost:5174';
const [PROJECT, given] = process.argv.slice(2);
if (!PROJECT) {
  console.error('usage: node e2e/live/vad-restore.mjs PROJECT_ID [DOCUMENT_ID]');
  process.exit(2);
}

const client = makeClient();
const mediaOf = (id) =>
  fetch(`${CORE}/api/v1/documents/${id}/media`, {
    headers: { Authorization: `Bearer ${client.token}` },
  });
let DOC = given;
let media = DOC ? await mediaOf(DOC) : null;
if (!DOC) {
  for (const d of (await client.projects.get(PROJECT)).documents || []) {
    const r = await mediaOf(d.id);
    if (r.ok) {
      DOC = d.id;
      media = r;
      break;
    }
  }
}
if (!DOC || !media?.ok) {
  console.error(`FAIL no document with a recording in project ${PROJECT}`);
  process.exit(1);
}
const before = (await client.documents.get(DOC)).metadata || {};
const print = await mediaFingerprint(await media.blob());
console.log('media print:', print);

await client.documents.setMetadata(DOC, {
  ...before,
  speechDetection: {
    media: print,
    method: 'builtin:silero',
    regions: [1.0, 2.5, 4.0, 6.25, 8.5, 11.0],
    dismissed: [],
  },
});

const browser = await chromium.launch();
const page = await browser.newPage();
await page.goto(`${APP}/#/login`);
await page.fill('input[type="email"], input[name="username"], input[type="text"]', 'a@b.com');
await page.fill('input[type="password"]', 'password');
await page.click('button[type="submit"]');
await page.waitForTimeout(2000);
await page.goto(`${APP}/#/projects/${PROJECT}/documents/${DOC}?tab=media`);

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
