// The grid's provenance marks read as plaid-ui's shared ones: the same
// pattern (italic, DASHED underline, since dotted means an opener in
// plaid-igt) and the same violet, never a hard-coded near-violet.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import { fileURLToPath } from 'node:url';
import { autoColor } from '../src/utils/udVocab.js';
import { CATEGORICAL, DYES } from '../../plaid-ui/src/domain/dyes.js';

const read = (rel) => readFile(fileURLToPath(new URL(rel, import.meta.url)), 'utf8');
const rowCss = await read('../src/components/editor/annotation/SentenceRow.css');
const uiCss = await read('../../plaid-ui/src/index.css');

// The declarations of the first rule whose selector list contains `selector`.
const rule = (css, selector) => {
  const re = /([^{}]+)\{([^}]*)\}/g;
  for (let m = re.exec(css); m; m = re.exec(css)) {
    const selectors = m[1]
      .replace(/\/\*[\s\S]*?\*\//g, '')
      .split(',')
      .map((s) => s.trim());
    if (selectors.includes(selector)) return m[2];
  }
  return null;
};

test('a machine or contributed cell is italic with a dashed underline, as plaid-ui marks one', () => {
  const cell = rule(rowCss, '.editable-field--machine');
  assert.ok(cell, 'the rule exists');
  assert.match(cell, /font-style:\s*italic/);
  assert.match(cell, /text-decoration-style:\s*dashed/);
  assert.doesNotMatch(cell, /dotted/);
  const shared = rule(uiCss, '.plaid-prov--machine');
  assert.match(shared, /text-decoration-style:\s*dashed/);
  assert.match(rule(uiCss, '.plaid-prov--contributed'), /text-decoration-style:\s*dashed/);
});

test('the grid names no violet of its own', () => {
  assert.doesNotMatch(rowCss, /#7c3aed|#6d28d9/i);
  assert.match(rule(rowCss, '.word-accept'), /background-color:\s*var\(--plaid-machine\)/);
});

test('Accept and Discard wear the shared review pair', () => {
  const accept = uiCss.match(/\.plaid-review\.plaid-review--accept \{([^}]*)\}/)[1];
  assert.match(accept, /color:\s*var\(--plaid-machine\)/);
  assert.doesNotMatch(rowCss, /accept-predictions-btn|discard-predictions-btn/);
});

// The legend's samples ARE the marks, so they take plaid-ui's classes rather
// than a hand-written look that drifts from the grid's.
test('the legend draws its samples with the shared mark classes', async () => {
  const legend = await read('../src/components/editor/annotation/EditorLegend.jsx');
  assert.match(legend, /className="plaid-prov--machine"/);
  assert.match(legend, /className="plaid-prov--contributed"/);
  assert.doesNotMatch(legend, /decoration-dotted/);
  assert.match(legend, /className="plaid-prov--machine plaid-prov--doubtful"/);
});

test('a doubtful machine value keeps the dash and draws it heavier, in the machine violet', () => {
  const cell = rule(rowCss, '.editable-field--machine.editable-field--doubtful');
  assert.match(cell, /text-decoration-thickness:\s*2px/);
  assert.match(cell, /text-decoration-color:\s*var\(--plaid-machine\)/);
  assert.match(rule(uiCss, '.plaid-prov--doubtful'), /text-decoration-thickness:\s*2px/);
});

// Violet and amber mean provenance on every annotation surface, so colours
// for kinds keep clear of both: violet and magenta from 250 to 330 degrees,
// and a saturated amber or orange from 20 to 50. The cloth's browns are dull
// beside the contributor's amber, so the amber test asks for saturation too.
const hue = (hex) => {
  const [r, g, b] = [1, 3, 5].map((i) => parseInt(hex.slice(i, i + 2), 16) / 255);
  const max = Math.max(r, g, b);
  const d = max - Math.min(r, g, b);
  if (d === 0) return null;
  const h = max === r ? ((g - b) / d) % 6 : max === g ? (b - r) / d + 2 : (r - g) / d + 4;
  return (h * 60 + 360) % 360;
};
const provenanceHue = (h) => h !== null && ((h >= 250 && h <= 330) || (h >= 5 && h <= 50));

const saturation = (hex) => {
  const [r, g, b] = [1, 3, 5].map((i) => parseInt(hex.slice(i, i + 2), 16) / 255);
  const max = Math.max(r, g, b);
  const min = Math.min(r, g, b);
  const l = (max + min) / 2;
  return max === min ? 0 : (max - min) / (1 - Math.abs(2 * l - 1));
};

// The Grew query box's syntax colours are the cloth's dyes, a hex value or a
// dye named through plaid-ui's `--plaid-dye-*`.
test('the Grew syntax colours are dyes, with no violet and no amber', async () => {
  const appCss = await read('../src/index.css');
  const colours = [
    ...appCss.matchAll(/--grew-([a-z]+):\s*(?:(#[0-9a-f]{6})|var\(--plaid-dye-([a-z]+)\))/gi),
  ].map(([, name, hex, dye]) => [name, hex ?? DYES[dye]]);
  assert.ok(colours.length >= 5, 'the Grew palette is found');
  for (const [name, hex] of colours) {
    const h = hue(hex);
    if (h === null) continue;
    assert.ok(
      !(h >= 250 && h <= 330),
      `--grew-${name} ${hex} (hue ${Math.round(h)}) is not violet`,
    );
    assert.ok(
      !(h >= 20 && h <= 50 && saturation(hex) > 0.6),
      `--grew-${name} ${hex} (hue ${Math.round(h)}) is not amber`,
    );
    assert.ok(CATEGORICAL.includes(hex.toLowerCase()), `--grew-${name} ${hex} is one of the dyes`);
  }
});

// A UPOS value or a DEPREL with no configured colour takes one of the cloth's
// dyes (plaid-ui's categorical palette). A settled value drawn in violet or
// amber reads as a machine's or a contributor's, and one in red as an error,
// so none of the three is among them. The teal is left out, since it is the
// primary that marks the arc being worked on.
test('the auto colours for labels are the shared dyes, with no violet, amber or red', () => {
  const seen = new Set();
  for (let i = 0; i < 2000; i++) seen.add(autoColor(`label-${i}`));
  assert.deepEqual(
    [...seen].sort(),
    CATEGORICAL.filter((c) => c !== '#2a5c57').sort(),
    'every dye but the teal is reached, and nothing else',
  );
  for (const c of seen) {
    const h = hue(c);
    const s = saturation(c);
    assert.ok(!(h >= 250 && h <= 330), `${c} (hue ${Math.round(h)}) is not violet`);
    assert.ok(!(h >= 20 && h <= 50 && s > 0.6), `${c} (hue ${Math.round(h)}) is not amber`);
    assert.ok(!((h < 15 || h > 345) && s > 0.4), `${c} (hue ${Math.round(h)}) is not red`);
  }
});

// The Accept and Discard pair is quiet by its outline, not by opacity: dimmed,
// the violet and the red fell below AA contrast on white.
test('the review pair is at full strength at rest', () => {
  const pair = rule(uiCss, '.plaid-review.plaid-review--accept');
  assert.ok(pair, 'the rule exists');
  assert.doesNotMatch(pair, /opacity/);
  assert.match(pair, /background-color:\s*transparent/);
  assert.doesNotMatch(uiCss.match(/\.plaid-review[^{]*\{[^}]*\}/g).join('\n'), /opacity/);
});

// The standing actions under a sentence (Edit metadata, Edit text, Ask,
// Comment) are quiet by weight and by having no outline, not by opacity:
// dimmed to 0.55, their gray measured 2.96:1 on white. They wear plaid-ui's
// SENTENCE_ACTION, as every app's sentence actions do.
test('the standing sentence actions are at full strength at rest', async () => {
  const shared = await read('../../plaid-ui/src/components/shared/sentenceActions.js');
  const action = shared.match(/SENTENCE_ACTION =\s*'([^']*)'/)?.[1];
  assert.ok(action, 'the shared treatment exists');
  assert.doesNotMatch(action, /opacity/);
  assert.match(action, /text-\[hsl\(var\(--foreground\)\/0\.85\)\]/);
  assert.doesNotMatch(rowCss, /\.sentence-action[^{]*\{[^}]*opacity/);
});

// A flash that lands on a sentence, and the multi-word token chip, are not
// provenance, so neither wears amber (or orange beside it) nor violet.
test('the hand-off flash and the multi-word token chip use no violet and no amber', async () => {
  const tv = await read('../src/components/editor/TokenVisualizer.module.css');
  const editor = await read('../src/components/editor/AnnotationEditor.jsx');
  const hexes = (text) => [...text.matchAll(/#[0-9a-f]{6}\b/gi)].map((m) => m[0]);
  const flash = rule(tv, ".sentence[data-flash='true']");
  const chip = rule(tv, ".badge[data-mwt='true']");
  const chipHover = rule(tv, ".badge[data-mwt='true']:hover");
  const ring = editor.match(/boxShadow: '([^']*)'/)[1];
  for (const c of hexes([flash, chip, chipHover, ring].join('\n'))) {
    assert.ok(!provenanceHue(hue(c)), `${c} (hue ${Math.round(hue(c))})`);
  }
});

// The relations that meet on one verb, and the modifiers that meet on one
// noun, are told apart by colour, and every common label is a dye that is not
// the teal.
test('the common relations on one head have different colours', () => {
  const distinct = (labels) =>
    assert.equal(new Set(labels.map(autoColor)).size, labels.length, labels.join(', '));
  distinct(['nsubj', 'obj', 'obl', 'advmod', 'root']);
  distinct(['det', 'amod', 'nmod']);
  distinct(['NOUN', 'VERB', 'ADJ', 'ADV', 'PRON']);
  for (const l of ['nsubj', 'obj', 'obl', 'det', 'case', 'NOUN', 'VERB']) {
    assert.ok(CATEGORICAL.includes(autoColor(l)) && autoColor(l) !== '#2a5c57', l);
  }
});
