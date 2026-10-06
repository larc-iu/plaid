// Makes the PDFs the PDF-reading tests run on, with Chromium's print to PDF.
// Run from plaid-igt (whose node_modules has Playwright), then add_outline.py
// gives sample.pdf its bookmarks and page labels:
//
//   cd plaid-igt && node ../plaid-agent/tests/pdf/make_fixtures.mjs [name.pdf ...]
//
// Names limit the run to those fixtures (sample.pdf is written as
// sample-raw.pdf), so adding one leaves the others' bytes alone.
//   python ../plaid-agent/tests/pdf/add_outline.py   (needs pypdf)
//
// The fixtures are committed, so neither step runs in a test. They are small
// on purpose: Chromium embeds subsets of the fonts it used.
import { createRequire } from 'node:module';
import { fileURLToPath } from 'node:url';
import path from 'node:path';

// Playwright from the package the script is run in, not from beside the script.
const { chromium } = createRequire(path.join(process.cwd(), 'noop.js'))('playwright');

const here = path.dirname(fileURLToPath(import.meta.url));

const style = `
  @page { size: A5; margin: 18mm; }
  body { font-family: 'DejaVu Serif'; font-size: 10pt; }
  h1, h2 { font-size: 12pt; }
  .page { break-after: page; }
  table.igt td { padding-right: 1.2em; vertical-align: top; }
  .sc { font-variant: small-caps; }
  .ar { font-family: 'DejaVu Sans'; direction: rtl; text-align: right; }
  .page { position: relative; }
  .slant { display: inline-block; transform: skewX(-14deg); }
  .turned { position: absolute; left: 60mm; top: 120mm; transform: rotate(-90deg); font-size: 8pt; }
`;

// Four pages: front matter, a chapter with a subsection, and a chapter with an
// interlinear example, IPA, tone marks, ligatures, small caps, Arabic, a
// slanted word (an oblique made by skewing, as a word processor does) and a
// word turned up the margin.
const sample = `<!doctype html><html><head><meta charset="utf-8"><style>${style}</style></head><body>
<div class="page"><h1>A grammar sample</h1><p>Contents and front matter.</p></div>
<div class="page"><h1>1 Introduction</h1>
<p>The first official filing describes a baffling efflorescence of forms.</p>
<h2>1.1 Sources</h2><p>Recordings were made in 2024.</p></div>
<div class="page"><h1>2 Phonology</h1>
<p>The consonants are /p t k ʔ ŋ ɲ ɾ ʃ/ and the vowels /i ɨ u ɛ ɔ a/.</p>
<p>Tone is marked: á, à, ǎ, and a vowel with two marks, ɛ́̃.</p></div>
<div class="page"><h1>3 Complex predicates</h1>
<p>A serial verb construction is given in (1).</p>
<table class="igt"><tr><td>(1)</td><td>ŋa-mriri</td><td>n-amat</td><td>ini</td><td>pingan</td></tr>
<tr><td></td><td><span class="sc">3sg</span>-stand</td><td>3-carry</td><td><span class="sc">3sg.poss</span></td><td>plate</td></tr>
<tr><td></td><td colspan="4">‘He stands holding his plate.’</td></tr></table>
<p class="ar">اللغة العربية لغة سامية</p>
<p>A slanted form: <span class="slant">pang∼pangga</span>.</p>
<div class="turned">DRAFT</div></div>
</body></html>`;

// Small capitals alone in their column, as a gloss line of tags (NEG, PFV, Q)
// often has them: neither side has a full-size run touching "neg", and both
// must read it in capitals.
const smallcaps = `<!doctype html><html><head><meta charset="utf-8"><style>${style}</style></head><body>
<p>A negated clause is given in (2).</p>
<table class="igt"><tr><td>(2)</td><td>ia</td><td>tak</td><td>mena-tak</td></tr>
<tr><td></td><td><span class="sc">3sg</span></td><td><span class="sc">neg</span></td><td>sleep-<span class="sc">neg</span></td></tr>
<tr><td></td><td colspan="3">‘She does not sleep.’</td></tr></table>
<p>A question takes <span class="sc">q</span> at the end.</p>
</body></html>`;

// Lower-case words that are merely smaller: a word in a sentence, a link, a
// margin note beside the text on the same baselines, and a footnote. None of
// them is small capitals, and neither reader may write them in capitals.
const smaller = `<!doctype html><html><head><meta charset="utf-8"><style>${style}
  .small { font-size: 8pt; } .row { display: flex; align-items: baseline; gap: 2em; } .row > div { flex: 1; }
</style></head><body>
<p>This sentence has a <span class="small">smaller</span> word in it.</p>
<p>Online at <span class="small">example.org</span> today.</p>
<div class="row"><div>Main column text runs here and here and here.</div><div class="small">margin note words in it</div></div>
<div class="row"><div>Main text.</div><div class="small">note</div></div>
<p class="small">see also the notes below here</p>
</body></html>`;

// No text layer at all: what a scanned grammar is.
const scan = `<!doctype html><html><head><meta charset="utf-8"><style>@page { size: A5; margin: 18mm; }</style></head><body>
<svg width="300" height="200"><rect x="10" y="10" width="280" height="40" fill="#999"/><rect x="10" y="70" width="200" height="40" fill="#999"/></svg>
<div style="break-after: page"></div>
<svg width="300" height="200"><rect x="10" y="10" width="250" height="40" fill="#999"/></svg>
</body></html>`;

const browser = await chromium.launch();
try {
  const page = await browser.newPage();
  const only = process.argv.slice(2);
  for (const [name, html] of [
    ['sample-raw.pdf', sample],
    ['scan.pdf', scan],
    ['smallcaps.pdf', smallcaps],
    ['smaller.pdf', smaller],
  ]) {
    if (only.length && !only.includes(name.replace('-raw', ''))) continue;
    await page.setContent(html);
    await page.pdf({ path: path.join(here, name), preferCSSPageSize: true });
  }
} finally {
  await browser.close();
}
