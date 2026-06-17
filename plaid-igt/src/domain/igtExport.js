// Render a derived sentence (IgtDocument doc.sentences[i] shape) as
// publication-ready interlinear text. Pure functions — unit-tested, no DOM.
//
// Formats:
//   plain   — column-aligned text (one line per tier + quoted free translation)
//   tsv     — one row per tier, tab-separated (pastes cleanly into spreadsheets)
//   gb4e    — LaTeX \begin{exe}\ex\gll … (two aligned lines + \glt)
//   expex   — LaTeX \ex\begingl \gla/\glb/\glft … (safe expex subset)
//   leipzig — HTML for leipzig.js (<div data-gloss> + one <p> per line)
//
// Line 1 is always the morpheme-segmented word forms ("tod-os"); the gloss
// line(s) join each word's morpheme values the same way. The joint between
// two morphemes is "=" when either is a clitic (metadata.morphType), else "-"
// — see domain/affixMarkers.js; markers are display-only, never stored.
// Words with no morphemes fall back to their surface form. LaTeX formats
// need equal token counts per line, so empty glosses become {}.

import { joinMorphemes } from './affixMarkers.js';

export const COPY_FORMATS = [
  { id: 'plain', label: 'Plain text (aligned)' },
  { id: 'tsv', label: 'Tab-separated (spreadsheet)' },
  { id: 'gb4e', label: 'LaTeX — gb4e' },
  { id: 'expex', label: 'LaTeX — ExPex' },
  { id: 'leipzig', label: 'HTML — leipzig.js' },
];

export const COPY_FORMAT_STORAGE_KEY = 'plaid_igt_copy_format';

const cpLen = (s) => [...(s ?? '')].length;

/** A morpheme's display form: the user-editable metadata.form when the key
 * exists (it may legitimately be ''), else the raw baseline content. Shared
 * with the document/flextext exporters in src/export/. */
export const morphFormOf = (m) => {
  const meta = m?.metadata;
  if (meta && Object.prototype.hasOwnProperty.call(meta, 'form')) return meta.form ?? '';
  return m?.content ?? '';
};

/** Join per-morpheme strings with -/= joints from the morphemes' morphTypes
 * (texts and morphemes are parallel arrays). Shared with src/export/.
 * When EVERY piece is blank (e.g. an unglossed multi-morpheme word) the result
 * is empty rather than a bare run of joints ("-"/"--"), which read as a stray
 * gloss in exports/copy. */
export const joinMorphemeTexts = (morphemes, texts) =>
  texts.some((t) => (t ?? '').trim() !== '')
    ? joinMorphemes(texts.map((t, i) => ({ text: t, morphType: morphemes[i]?.metadata?.morphType })))
    : '';

// Per-word cells: segmented form + one joined-gloss string per morph field +
// one value per word field.
function wordCells(token, { morphFields, wordFields }) {
  const morphemes = token.morphemes || [];
  const segmented = morphemes.length
    ? joinMorphemeTexts(morphemes, morphemes.map((m) => morphFormOf(m)))
    : (token.content ?? '');
  const morphLines = morphFields.map((f) =>
    morphemes.length
      ? joinMorphemeTexts(morphemes, morphemes.map((m) => m.annotations?.[f]?.value ?? ''))
      : '');
  const wordLines = wordFields.map((f) => token.annotations?.[f]?.value ?? '');
  return { segmented, morphLines, wordLines };
}

function tiers(sentence, fields) {
  const cells = (sentence.tokens || []).map((t) => wordCells(t, fields));
  const lines = [{ label: null, cells: cells.map((c) => c.segmented) }];
  fields.morphFields.forEach((f, i) => {
    lines.push({ label: f, cells: cells.map((c) => c.morphLines[i]) });
  });
  fields.wordFields.forEach((f, i) => {
    lines.push({ label: f, cells: cells.map((c) => c.wordLines[i]) });
  });
  return lines;
}

function translations(sentence, fields) {
  return fields.sentFields
    .map((f) => ({ label: f, value: sentence.annotations?.[f]?.value ?? '' }))
    .filter((t) => t.value !== '');
}

// ---- plain ----------------------------------------------------------------
export function formatPlain(sentence, fields) {
  const lines = tiers(sentence, fields);
  const n = lines[0].cells.length;
  const widths = Array.from({ length: n }, (_, i) =>
    Math.max(...lines.map((l) => cpLen(l.cells[i]))));
  const out = lines.map((l) =>
    l.cells.map((c, i) => c + ' '.repeat(widths[i] - cpLen(c))).join('  ').trimEnd());
  for (const t of translations(sentence, fields)) out.push(`‘${t.value}’`);
  return out.join('\n');
}

// ---- tsv ------------------------------------------------------------------
const tsvCell = (s) => String(s ?? '').replace(/[\t\r\n]+/g, ' ');

export function formatTsv(sentence, fields) {
  const out = tiers(sentence, fields).map((l) => l.cells.map(tsvCell).join('\t'));
  for (const t of translations(sentence, fields)) out.push(tsvCell(t.value));
  return out.join('\n');
}

// ---- LaTeX ----------------------------------------------------------------
const LATEX_SPECIALS = {
  '\\': '\\textbackslash{}', '&': '\\&', '%': '\\%', '$': '\\$', '#': '\\#',
  '_': '\\_', '{': '\\{', '}': '\\}', '~': '\\textasciitilde{}', '^': '\\textasciicircum{}',
};
const texEscape = (s) => [...(s ?? '')].map((ch) => LATEX_SPECIALS[ch] ?? ch).join('');
const texCell = (s) => (s === '' ? '{}' : texEscape(s));

export function formatGb4e(sentence, fields) {
  const lines = tiers(sentence, fields);
  const forms = lines[0].cells.map(texCell).join(' ');
  // gb4e's \gll takes exactly two aligned lines: forms + the first gloss tier.
  const gloss = (lines[1]?.cells ?? lines[0].cells.map(() => '')).map(texCell).join(' ');
  const tr = translations(sentence, fields)[0]?.value ?? '';
  return [
    '\\begin{exe}',
    '\\ex',
    `\\gll ${forms}\\\\`,
    `     ${gloss}\\\\`,
    `\\glt \`${texEscape(tr)}'`,
    '\\end{exe}',
  ].join('\n');
}

export function formatExpex(sentence, fields) {
  const lines = tiers(sentence, fields);
  const forms = lines[0].cells.map(texCell).join(' ');
  const gloss = (lines[1]?.cells ?? lines[0].cells.map(() => '')).map(texCell).join(' ');
  const tr = translations(sentence, fields)[0]?.value ?? '';
  return [
    '\\ex',
    '\\begingl',
    `\\gla ${forms} //`,
    `\\glb ${gloss} //`,
    `\\glft \`${texEscape(tr)}' //`,
    '\\endgl',
    '\\xe',
  ].join('\n');
}

// ---- HTML (leipzig.js) ------------------------------------------------------
const htmlEscape = (s) => String(s ?? '')
  .replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;');

// leipzig.js: <div data-gloss> with one <p> per aligned line + a final <p>
// for the free translation. Words split on whitespace, so multiword cells
// are kept intact with non-breaking spaces.
export function formatLeipzig(sentence, fields) {
  const nbsp = (s) => htmlEscape(s === '' ? '\u00a0' : s).replace(/ /g, '\u00a0');
  const lines = tiers(sentence, fields)
    .map((l) => `  <p>${l.cells.map(nbsp).join(' ')}</p>`);
  const tr = translations(sentence, fields)[0]?.value;
  if (tr) lines.push(`  <p>‘${htmlEscape(tr)}’</p>`);
  return ['<div data-gloss>', ...lines, '</div>'].join('\n');
}

export function formatSentence(sentence, fields, format) {
  if (format === 'tsv') return formatTsv(sentence, fields);
  if (format === 'gb4e') return formatGb4e(sentence, fields);
  if (format === 'expex') return formatExpex(sentence, fields);
  if (format === 'leipzig') return formatLeipzig(sentence, fields);
  return formatPlain(sentence, fields);
}
