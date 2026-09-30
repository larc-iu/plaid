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
// need equal token counts per line, so an empty cell becomes {} and a cell
// with a space in it is braced (texWord). They also set the gloss line's
// grammatical abbreviations in small caps (texGloss). Untokenized baseline
// text (punctuation) gets its own column with empty gloss cells.

import { canNameWord, joinMorphemes } from './affixMarkers.js';
import { boundByPieces, glossSmallCaps } from './tagsets.js';
import { isTexSpecial, texEscape, texLine } from './tex.js';

export const COPY_FORMATS = [
  { id: 'plain', label: 'Plain text (aligned)' },
  { id: 'tsv', label: 'Tab-separated (spreadsheet)' },
  { id: 'gb4e', label: 'LaTeX: gb4e' },
  { id: 'expex', label: 'LaTeX: ExPex' },
  { id: 'leipzig', label: 'HTML: leipzig.js' },
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
    ? joinMorphemes(
        texts.map((t, i) => ({
          text: t,
          morphType: morphemes[i]?.morphType ?? morphemes[i]?.metadata?.morphType,
        })),
      )
    : '';

// Per-word cells: segmented form + one joined-gloss string per morph field +
// one value per word field. morphPieces holds, per morph field, each
// morpheme's gloss and whether it can never name the word, which is how the
// LaTeX small caps read the joined gloss (texGloss).
export function wordCells(token, { morphFields, wordFields }) {
  const morphemes = token.morphemes || [];
  const bound = morphemes.map(
    (m) => !canNameWord(m.morphType ?? m.metadata?.morphType, morphFormOf(m)),
  );
  const segmented = morphemes.length
    ? joinMorphemeTexts(
        morphemes,
        morphemes.map((m) => morphFormOf(m)),
      )
    : (token.content ?? '');
  const morphLines = morphFields.map((f) =>
    morphemes.length
      ? joinMorphemeTexts(
          morphemes,
          morphemes.map((m) => m.annotations?.[f]?.value ?? ''),
        )
      : '',
  );
  const morphPieces = morphFields.map((f) =>
    morphemes.map((m, i) => ({ text: m.annotations?.[f]?.value ?? '', bound: bound[i] })),
  );
  const wordLines = wordFields.map((f) => token.annotations?.[f]?.value ?? '');
  return { segmented, morphLines, morphPieces, wordLines };
}

// One cell column per piece of the sentence in reading order: word tokens plus
// the baseline runs no token covers (punctuation, stray characters), which the
// Analyze grid shows as inert columns and which the built-in tokenizer leaves
// untokenized on purpose. A gap contributes its text to line 1 and nothing to
// the gloss/word tiers. Whitespace-only gaps (ordinary spacing) are dropped.
// Sentences without derived `pieces` (older callers, test fixtures) fall back
// to their token list.
function columnCells(sentence, fields) {
  const pieces = sentence.pieces || (sentence.tokens || []).map((t) => ({ type: 'token', ...t }));
  const cells = [];
  for (const piece of pieces) {
    if (piece.type === 'token') {
      cells.push(wordCells(piece, fields));
      continue;
    }
    const text = (piece.content ?? '').trim();
    if (text === '') continue;
    cells.push({
      segmented: text,
      morphLines: fields.morphFields.map(() => ''),
      morphPieces: fields.morphFields.map(() => null),
      wordLines: fields.wordFields.map(() => ''),
    });
  }
  return cells;
}

// A line break or tab inside a value would break every copy format's
// layout: the plain text's columns, a Leipzig word, a TSV row. Each becomes
// one space here, once for all of them.
const oneLine = (s) => String(s ?? '').replace(/[\t\n\v\f\r\u0085\u2028\u2029]+/g, ' ');

function tiers(sentence, fields) {
  const cells = columnCells(sentence, fields);
  const lines = [{ label: null, cells: cells.map((c) => oneLine(c.segmented)) }];
  fields.morphFields.forEach((f, i) => {
    lines.push({
      label: f,
      cells: cells.map((c) => oneLine(c.morphLines[i])),
      pieces: cells.map((c) => c.morphPieces[i]),
    });
  });
  fields.wordFields.forEach((f, i) => {
    lines.push({ label: f, cells: cells.map((c) => oneLine(c.wordLines[i])) });
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
    Math.max(...lines.map((l) => cpLen(l.cells[i]))),
  );
  const out = lines.map((l) =>
    l.cells
      .map((c, i) => c + ' '.repeat(widths[i] - cpLen(c)))
      .join('  ')
      .trimEnd(),
  );
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
// A gloss as a paper sets it: each grammatical abbreviation in small caps
// (glossSmallCaps, the tagsets' rule, which the Analyze tab also shows by),
// written in lowercase because \textsc only changes lowercase letters and
// \textsc{NOM} prints as full capitals. "1SG.NOM" gives \textsc{1sg}.\textsc{nom}.
// A word's joined morpheme gloss is read by its pieces: its stems' glosses as
// one unit with the fall-back, so pass.PST=and keeps pass, and an affix's or a
// clitic's with none, so the suffix of pass.PST-sbj:3.pfv is all tags. A part
// holds only letters, marks and digits, none of them a LaTeX special.
//
// Lowercase for \textsc. Turkish capital dotted I (U+0130) lowercases to i
// plus a combining dot above everywhere but a Turkish locale, and the dot
// would then print over a small-caps i. It is set as a plain i.
const smallCapsText = (part) => part.replace(/\u0130/g, 'i').toLowerCase();
export const texGloss = (s, pieces) =>
  glossSmallCaps(s, { bound: boundByPieces(pieces) })
    .map((p) => (p.smallCaps ? `\\textsc{${smallCapsText(p.text)}}` : texEscape(p.text)))
    .join('');

// gb4e and ExPex split each line into words at spaces, so a cell is always one
// word: a blank one is {} and one with a space inside ("look after") is braced.
// ExPex also ends a line at the first //, so a cell holding one (a URL, a
// gloss like PST//FUT) is braced too, where the delimiter cannot see it.
// A run of whitespace becomes one space, since a blank line inside \gll or
// \gla would end the paragraph.
//
// ExPex also stops ("Extra \else") or misaligns the line when a \gla word is
// one escaped special alone (\{, \_, \$, \textbackslash{}), braced or not, so
// a cell that opens with a special opens with an empty group, which it prints
// as nothing. A \gla word that is one of + @ [ ] alone is ExPex markup (a
// bracket, a skipped gloss), so such a cell opens with one too.
const EXPEX_MARKUP_WORD = /^[+@[\]]$/;
export const texWord = (render) => (s) => {
  const text = texLine(s);
  if (text === '') return '{}';
  const lead = isTexSpecial(text[0]) || EXPEX_MARKUP_WORD.test(text) ? '{}' : '';
  const body = lead + render(text);
  return text.includes(' ') || text.includes('//') ? `{${body}}` : body;
};
export const texCell = texWord(texEscape);
// A gloss line's cells, each read by its morpheme pieces when it has them
// (a word field's line has none, and each cell is one word's gloss).
const texGlossCells = (line, n) =>
  (line?.cells ?? Array.from({ length: n }, () => '')).map((c, i) =>
    texWord((t) => texGloss(t, line?.pieces?.[i]))(c),
  );

export function formatGb4e(sentence, fields) {
  const lines = tiers(sentence, fields);
  const forms = lines[0].cells.map(texCell).join(' ');
  // gb4e's \gll takes exactly two aligned lines: forms + the first gloss tier.
  const gloss = texGlossCells(lines[1], lines[0].cells.length).join(' ');
  const tr = translations(sentence, fields)[0]?.value ?? '';
  return [
    '\\begin{exe}',
    '\\ex',
    `\\gll ${forms}\\\\`,
    `     ${gloss}\\\\`,
    `\\glt \`${texEscape(texLine(tr))}'`,
    '\\end{exe}',
  ].join('\n');
}

export function formatExpex(sentence, fields) {
  const lines = tiers(sentence, fields);
  const forms = lines[0].cells.map(texCell).join(' ');
  const gloss = texGlossCells(lines[1], lines[0].cells.length).join(' ');
  const tr = translations(sentence, fields)[0]?.value ?? '';
  return [
    '\\ex',
    '\\begingl',
    `\\gla ${forms} //`,
    `\\glb ${gloss} //`,
    // Braced, so a // in the translation is not the end of the line.
    `\\glft {\`${texEscape(texLine(tr))}'} //`,
    '\\endgl',
    '\\xe',
  ].join('\n');
}

// ---- HTML (leipzig.js) ------------------------------------------------------
const htmlEscape = (s) =>
  String(s ?? '')
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;');

// leipzig.js: <div data-gloss> with one <p> per aligned line + a final <p>
// for the free translation. Words split on whitespace, so multiword cells
// are kept intact with non-breaking spaces.
export function formatLeipzig(sentence, fields) {
  const nbsp = (s) => htmlEscape(s === '' ? '\u00a0' : s).replace(/ /g, '\u00a0');
  const lines = tiers(sentence, fields).map((l) => `  <p>${l.cells.map(nbsp).join(' ')}</p>`);
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
