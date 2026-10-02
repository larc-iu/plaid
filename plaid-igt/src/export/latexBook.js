// The LaTeX book: a project, or the documents chosen, as LaTeX source a person
// uploads to Overleaf, adds front matter to, and compiles into a book of
// interlinear texts. One chapter per document, one numbered example per
// sentence, and the example's lines in the order the Analyze tab shows them:
// the words, each orthography, each word field, the morphemes, each morpheme
// field, then the sentence fields under the grid.
//
// The bundle (buildLatexBook):
//   main.tex           preamble, title, table of contents, one \include per text
//   abbreviations.tex  every gloss abbreviation the texts use
//   texts/NNN-name.tex one chapter per document, in the order of the export
//   latexmkrc          makes Overleaf run LuaLaTeX
//   README.txt         how to compile it
//
// Glossing is ExPex (\begingl ... \endgl). It takes any number of gloss lines
// (\gla, then one \glb per line), and it breaks a sentence too long for the
// page into as many aligned blocks as it needs, which a book of real texts
// needs on nearly every page. gb4e's \glll stops at three lines and langsci's
// at four. The engine is LuaLaTeX, for two things only it gives: luaotfload's
// font fallback, so a character the main font lacks comes from the Noto font
// for its script without anyone choosing fonts, and \textdir, which lays out
// a right-to-left document's examples right to left.
//
// Every data string goes through the one TeX escaper (domain/tex.js), and the
// gloss cells through the copy formats' own ExPex cell rules (texWord,
// texGloss in domain/igtExport.js), small caps included.
//
// Pure functions: no DOM, no client.

import { texCell, texGloss, texWord, wordCells } from '../domain/igtExport.js';
import { texEscape, texLine } from '../domain/tex.js';
import { readTagsets } from '../domain/tagsets.js';
import { detectDirection, userMetadata, RTL } from '@ui/domain/textDirection.js';
import { phraseSpeakerFor } from './flextext.js';

// ---- the preset: which lines, in which order ------------------------------

// The lines an example can have, as the preset stores them: { kind, name? }.
// `name` is the field's or orthography's name, and absent for the two lines
// every project has.
export const ROW_KINDS = Object.freeze({
  WORDS: 'words',
  ORTHOGRAPHY: 'orthography',
  WORD_FIELD: 'wordField',
  MORPHEMES: 'morphemes',
  MORPHEME_FIELD: 'morphemeField',
});

/** Every line the project can show, in the Analyze tab's order. */
const defaultRows = (layers) => [
  { kind: ROW_KINDS.WORDS },
  ...layers.orthographies.map((name) => ({ kind: ROW_KINDS.ORTHOGRAPHY, name })),
  ...layers.wordFields.map((name) => ({ kind: ROW_KINDS.WORD_FIELD, name })),
  ...(layers.hasMorphemes ? [{ kind: ROW_KINDS.MORPHEMES }] : []),
  ...layers.morphFields.map((name) => ({ kind: ROW_KINDS.MORPHEME_FIELD, name })),
];

const sameRow = (a, b) => a.kind === b.kind && (a.name ?? null) === (b.name ?? null);
const sameField = (a, b) => a.name === b.name;

/**
 * `saved` (the preset's own list, in its order) with each entry of
 * `defaults` it lacks put back where the default order has it: right after
 * the nearest line before it that is there. Entries the project no longer
 * has are dropped, and so is a second copy of one.
 */
function mergeInDefaultOrder(saved, defaults, same) {
  const out = [];
  for (const r of saved) {
    if (defaults.some((d) => same(d, r)) && !out.some((o) => same(o, r))) out.push(r);
  }
  let after = -1;
  for (const d of defaults) {
    const at = out.findIndex((o) => same(o, d));
    if (at !== -1) {
      after = at;
      continue;
    }
    out.splice(after + 1, 0, d);
    after += 1;
  }
  return out;
}

/**
 * The preset's lines as the project has them now: every example line and
 * every sentence field, each `on` or not, in the preset's order. A line the
 * preset does not name (one added to the project since) is on, and goes right
 * after the line the Analyze tab's order puts before it (mergeInDefaultOrder).
 */
export function latexLayout(options, layers) {
  const savedRows = (Array.isArray(options?.rows) ? options.rows : [])
    .filter((r) => r && typeof r.kind === 'string')
    .map((r) => ({
      kind: r.kind,
      ...(r.name != null ? { name: r.name } : {}),
      on: r.on !== false,
    }));
  const rows = mergeInDefaultOrder(
    savedRows,
    defaultRows(layers).map((r) => ({ ...r, on: true })),
    sameRow,
  );
  const savedFields = (Array.isArray(options?.sentenceFields) ? options.sentenceFields : [])
    .filter((f) => f && typeof f.name === 'string')
    .map((f) => ({ name: f.name, on: f.on !== false }));
  const sentenceFields = mergeInDefaultOrder(
    savedFields,
    layers.sentFields.map((name) => ({ name, on: true })),
    sameField,
  );
  return { rows, sentenceFields };
}

/**
 * What an export prints: the lines that are on, in order, the sentence
 * fields that are on, in order, and whether each chapter lists its metadata.
 */
export function latexSelection(options, layers) {
  const { rows, sentenceFields } = latexLayout(options, layers);
  return {
    rows: rows
      .filter((r) => r.on)
      .map(({ kind, name }) => (name == null ? { kind } : { kind, name })),
    sentFields: sentenceFields.filter((f) => f.on).map((f) => f.name),
    includeHeader: options?.includeHeader !== false,
  };
}

/** The preset options a new LaTeX preset starts with: every line, in the Analyze tab's order. */
export const defaultLatexOptions = (layers) => {
  const { rows, sentenceFields } = latexLayout({}, layers);
  return { rows, sentenceFields, includeHeader: true };
};

// ---- one cell -------------------------------------------------------------

// Scripts written right to left. A value in one is set in that script's own
// font, named in the preamble (\\PlaidScriptFont), not left to the fallback
// list: LuaTeX shapes a fallback font's right-to-left run backwards more often
// than not, and an explicit font it shapes correctly.
const RTL_SCRIPTS = [
  'Arabic',
  'Hebrew',
  'Syriac',
  'Thaana',
  'Nko',
  'Adlam',
  'Samaritan',
  'Mandaic',
  'Hanifi_Rohingya',
  'Mende_Kikakui',
  'Yezidi',
  'Old_Hungarian',
  'Phoenician',
  'Imperial_Aramaic',
  'Kharoshthi',
  'Avestan',
  'Old_Turkic',
];
// A character of one of those scripts, or one the scripts share that no
// script of the main font uses: the Arabic comma, question mark, semicolon and
// tatweel belong to the Common script and the Arabic vowel marks and hamza to
// the Inherited one, and Charis SIL has no glyph for them.
const RTL_SCRIPT_CLASS = RTL_SCRIPTS.map((name) => `\\p{Script=${name}}`).join('');
const RTL_SHARED_CLASS = `[${RTL_SCRIPTS.map((name) => `\\p{Script_Extensions=${name}}`).join('')}]--[${RTL_SCRIPT_CLASS}\\p{Script_Extensions=Latin}\\p{Script_Extensions=Greek}\\p{Script_Extensions=Cyrillic}]`;
const RTL_CLASS = `${RTL_SCRIPT_CLASS}[${RTL_SHARED_CLASS}]`;
const RTL_SHARED_RE = new RegExp(`[${RTL_SHARED_CLASS}]`, 'gv');
const rtlScriptRes = (property) =>
  RTL_SCRIPTS.map((name) => [name, new RegExp(`\\p{${property}=${name}}`, 'u')]);
const RTL_SCRIPT_RES = rtlScriptRes('Script');
const RTL_EXTENSION_RES = rtlScriptRes('Script_Extensions');
// A run's script is the one its letters are in, else the first that uses its
// punctuation.
const rtlScriptOf = (text) =>
  (RTL_SCRIPT_RES.find(([, re]) => re.test(text)) ??
    RTL_EXTENSION_RES.find(([, re]) => re.test(text)))?.[0] ?? null;
// A run of right-to-left letters with the marks and joiners that go with
// them, spaces between words included.
const RTL_RUN_RE = new RegExp(
  `[${RTL_CLASS}][${RTL_CLASS}\\p{M}\\u200c\\u200d]*(?:\\s+[${RTL_CLASS}][${RTL_CLASS}\\p{M}\\u200c\\u200d]*)*`,
  'gv',
);
// A script's name as the letters of a TeX control sequence.
const scriptCs = (script) => script.replace(/_/g, '');

// A value whose own letters read the other way from the document's is set in
// its own direction, so an English gloss under an Arabic word reads left to
// right and an Arabic gloss in an English text right to left. A value with no
// letters (a number, a punctuation mark, a tatweel alone) goes with the
// document.
const valueDir = (text, docDir) =>
  /\p{L}/u.test(text.replace(RTL_SHARED_RE, '')) ? detectDirection(text) : docDir;

// A number, digits with the separators between them, a range of two (a hyphen
// or an en dash between digits) and a percent or per mille sign after it.
// Digits read left to right in every script, and LuaTeX lays a right-to-left
// run out as it comes, so in one a number is boxed left to right or 1584
// prints as 4851 and 1990-2000 as 2000-1990. The percent sign is escaped by now.
const NUMBER_RE = /\p{Nd}+(?:[.,:/\u066b\u066c\-\u2013]\p{Nd}+)*(?:\\%|[\u066a\u2030])?/gu;
const ltrNumbers = (rendered) => rendered.replace(NUMBER_RE, (n) => `\\PlaidLTR{${n}}`);

// Each right-to-left run of `rendered` in its script's font. Inside text read
// left to right the run is also boxed right to left (\\PlaidRTL), since LuaTeX
// shapes a right-to-left run backwards in a left-to-right line. The rendered
// LaTeX is safe to scan: every macro in it is written in ASCII.
const rtlRuns = (rendered, boxed) =>
  rendered.replace(RTL_RUN_RE, (run) => {
    const inFont = `\\PlaidScript{${scriptCs(rtlScriptOf(run))}}{${run}}`;
    return boxed ? `\\PlaidRTL{${inFont}}` : inFont;
  });

// Wrapped in one of the preamble's style macros (\\PlaidWord and the rest),
// so a whole line's look is changed in one place.
const styled = (macro, rendered) => (macro ? `\\${macro}{${rendered}}` : rendered);

/**
 * `rendered` (the LaTeX for `text`) in `macro`'s style, in its own direction
 * where that is not the document's, with its right-to-left runs in their
 * script's font. The direction goes outside the style, so a translation's
 * quotation marks read with it. An empty cell stays a bare {}, which ExPex
 * needs to keep the columns aligned.
 */
const inScript = (rendered, text, docDir, macro = null) => {
  if (rendered === '{}') return rendered;
  if (valueDir(text, docDir) === RTL) {
    const body = styled(macro, ltrNumbers(rtlRuns(rendered, false)));
    return docDir === RTL ? body : `\\PlaidRTL{${body}}`;
  }
  const body = styled(macro, rtlRuns(rendered, true));
  return docDir === RTL ? `\\PlaidLTR{${body}}` : body;
};

/**
 * A heading (a chapter, the title): set in its script like any value, and
 * plain for the PDF's bookmarks, which cannot hold a font or a direction.
 */
const heading = (value) => {
  const set = runText(value, 'ltr');
  const plain = texEscape(texLine(value));
  return set === plain ? plain : `\\texorpdfstring{${set}}{${plain}}`;
};

/** A value that is not a cell (a translation, a name, a heading), escaped and set in its script. */
const runText = (value, docDir, macro = null) => {
  const text = texLine(value);
  return text === '' ? '' : inScript(texEscape(text), text, docDir, macro);
};

const plainCell = (macro, docDir) => (text) =>
  inScript(texCell(text), texLine(text), docDir, macro);

const glossCell = (macro, docDir) => (text, pieces) =>
  inScript(texWord((t) => texGloss(t, pieces))(text), texLine(text), docDir, macro);

// ---- one sentence ---------------------------------------------------------

/**
 * The columns of one sentence, in reading order: one per word token, and one
 * per whitespace-separated run of the text no token covers (punctuation left
 * untokenized, or a sentence nobody has tokenized at all). The Analyze tab
 * shows an uncovered stretch as one inert column. Here each run is its own,
 * so a long untokenized stretch can break across lines like any other.
 */
const namesOf = (rows, kind) => rows.filter((r) => r.kind === kind).map((r) => r.name);

function sentenceColumns(sentence, selection) {
  const fields = {
    morphFields: namesOf(selection.rows, ROW_KINDS.MORPHEME_FIELD),
    wordFields: namesOf(selection.rows, ROW_KINDS.WORD_FIELD),
  };
  const orthographies = namesOf(selection.rows, ROW_KINDS.ORTHOGRAPHY);
  const pieces = sentence.pieces || (sentence.tokens || []).map((t) => ({ type: 'token', ...t }));
  const columns = [];
  for (const piece of pieces) {
    if (piece.type === 'token') {
      const cells = wordCells(piece, fields);
      columns.push({
        word: piece.content ?? '',
        orthographies: orthographies.map((o) => piece.orthographies?.[o] ?? ''),
        wordLines: cells.wordLines,
        // A word with no morphemes (punctuation the project skips) has none to show.
        segmented: (piece.morphemes || []).length ? cells.segmented : '',
        morphLines: cells.morphLines,
        morphPieces: cells.morphPieces,
      });
      continue;
    }
    for (const run of texLine(piece.content).split(' ')) {
      if (run === '') continue;
      columns.push({
        word: run,
        orthographies: orthographies.map(() => ''),
        wordLines: fields.wordFields.map(() => ''),
        segmented: '',
        morphLines: fields.morphFields.map(() => ''),
        morphPieces: fields.morphFields.map(() => null),
      });
    }
  }
  return columns;
}

const hasValue = (cells) => cells.some((c) => texLine(c) !== '');

/**
 * The gloss lines of one sentence in the preset's order, each an array of
 * rendered cells. ExPex aligns every line to the first one alike, so any line
 * can come first and a field's line can sit anywhere. A line with nothing in
 * it in this sentence is left out, and so is the morpheme line when every
 * word in the sentence is its own single morpheme, which would only print the
 * words a second time.
 */
function glossLines(columns, selection, docDir) {
  const lines = [];
  const add = (texts, render, pieces = null) => {
    if (!hasValue(texts)) return;
    lines.push(texts.map((t, i) => render(t, pieces?.[i])));
  };
  const index = { orthography: 0, wordField: 0, morphemeField: 0 };
  for (const row of selection.rows) {
    if (row.kind === ROW_KINDS.WORDS) {
      add(
        columns.map((c) => c.word),
        plainCell('PlaidWord', docDir),
      );
    } else if (row.kind === ROW_KINDS.ORTHOGRAPHY) {
      const i = index.orthography++;
      add(
        columns.map((c) => c.orthographies[i]),
        plainCell('PlaidOrthography', docDir),
      );
    } else if (row.kind === ROW_KINDS.WORD_FIELD) {
      const i = index.wordField++;
      add(
        columns.map((c) => c.wordLines[i]),
        glossCell('PlaidWordField', docDir),
      );
    } else if (row.kind === ROW_KINDS.MORPHEMES) {
      if (columns.some((c) => c.segmented !== '' && c.segmented !== c.word)) {
        add(
          columns.map((c) => c.segmented),
          plainCell('PlaidMorphemes', docDir),
        );
      }
    } else if (row.kind === ROW_KINDS.MORPHEME_FIELD) {
      const i = index.morphemeField++;
      add(
        columns.map((c) => c.morphLines[i]),
        glossCell('PlaidMorphemeField', docDir),
        columns.map((c) => c.morphPieces[i]),
      );
    }
  }
  return lines;
}

/**
 * One sentence as an ExPex example. The first sentence field with a value is
 * the free translation, in quotes. Every other one follows on its own line
 * under its field name.
 */
export function formatExample(sentence, selection, { docDir = 'ltr', speaker = null } = {}) {
  const columns = sentenceColumns(sentence, selection);
  const lines = glossLines(columns, selection, docDir);
  const free = selection.sentFields
    .map((name) => ({ name, value: texLine(sentence.annotations?.[name]?.value ?? '') }))
    .filter((f) => f.value !== '');
  const out = ['\\ex', '\\begingl'];
  if (speaker) out.push(`\\glpreamble \\PlaidSpeaker{${runText(speaker, docDir)}} //`);
  // An empty sentence still takes its number, so the examples keep the
  // numbering the Analyze tab gives the sentences.
  const [first = ['{}'], ...rest] = lines;
  out.push(`\\gla ${first.join(' ')} //`);
  for (const line of rest) out.push(`\\glb ${line.join(' ')} //`);
  if (free.length) {
    const [translation, ...others] = free;
    const parts = [runText(translation.value, docDir, 'PlaidTranslation')];
    for (const f of others) {
      parts.push(`\\PlaidSentenceField{${runText(f.name, docDir)}}{${runText(f.value, docDir)}}`);
    }
    // Braced, so a // in the text is not the end of the line.
    out.push(`\\glft {${parts.join(' ')}} //`);
  }
  out.push('\\endgl', '\\xe');
  return out.join('\n');
}

// ---- one document ---------------------------------------------------------

const RUNNING_HEAD_CHARS = 45;

/**
 * One document as a chapter: its name, the metadata fields that have a value
 * (when the preset includes them), and its sentences as examples numbered
 * from 1. Returns the file's text.
 */
export function formatChapter(igtDoc, selection) {
  const docData = igtDoc.document || {};
  const docDir = igtDoc.textDirection === RTL ? RTL : 'ltr';
  const name = texLine(docData.name ?? '');
  const out = [`\\chapter{${heading(name)}}`];
  // The running head has one line. A long name is cut short there, and only
  // there.
  const chars = [...name];
  if (chars.length > RUNNING_HEAD_CHARS) {
    out.push(
      `\\chaptermark{${heading(
        `${chars
          .slice(0, RUNNING_HEAD_CHARS - 1)
          .join('')
          .trimEnd()}…`,
      )}}`,
    );
  }
  out.push('\\excnt=1', '');
  if (selection.includeHeader !== false) {
    const rows = Object.entries(userMetadata(docData.metadata))
      .filter(([, v]) => v != null && typeof v !== 'object' && texLine(String(v)) !== '')
      .map(([k, v]) => `\\PlaidMetadata{${runText(k, 'ltr')}}{${runText(String(v), 'ltr')}}`);
    if (rows.length)
      out.push('\\begin{PlaidMetadataList}', ...rows, '\\end{PlaidMetadataList}', '');
  }
  if (docDir === RTL) out.push('\\begin{PlaidRightToLeft}', '');
  const alignment = igtDoc.alignmentTokens || [];
  for (const sentence of igtDoc.sortedSentences || []) {
    const speaker = phraseSpeakerFor(sentence, alignment);
    out.push(formatExample(sentence, selection, { docDir, speaker }), '');
  }
  if (docDir === RTL) out.push('\\end{PlaidRightToLeft}', '');
  return `${out.join('\n')}\n`;
}

// ---- fonts ----------------------------------------------------------------

// The scripts Charis SIL, the main font, sets itself.
const MAIN_FONT_SCRIPTS = new Set(['Latin', 'Greek', 'Cyrillic', 'Common', 'Inherited']);

// The Noto family for a script where it is not "Noto Serif <Script>" or
// "Noto Sans <Script>" by the script's name. Overleaf has the Noto fonts
// Ubuntu ships.
const NOTO_FAMILY = {
  Arabic: 'Noto Naskh Arabic',
  Han: 'Noto Serif CJK SC',
  Hiragana: 'Noto Serif CJK JP',
  Katakana: 'Noto Serif CJK JP',
  Hangul: 'Noto Serif CJK KR',
  Bopomofo: 'Noto Serif CJK TC',
  Nko: 'Noto Sans NKo',
  Canadian_Aboriginal: 'Noto Sans Canadian Aboriginal',
  Syriac: 'Noto Sans Syriac',
  Thaana: 'Noto Sans Thaana',
};
// Scripts with a Noto Serif face. The rest have Noto Sans only.
const NOTO_SERIF = new Set([
  'Armenian',
  'Bengali',
  'Devanagari',
  'Ethiopic',
  'Georgian',
  'Gujarati',
  'Gurmukhi',
  'Hebrew',
  'Kannada',
  'Khmer',
  'Lao',
  'Malayalam',
  'Myanmar',
  'Oriya',
  'Sinhala',
  'Tamil',
  'Telugu',
  'Thai',
  'Tibetan',
]);

// Every script a Unicode character can belong to that a text is likely to be
// written in. A script missing here costs its characters their fallback font,
// nothing else.
const SCRIPTS = [
  'Adlam',
  'Ahom',
  'Arabic',
  'Armenian',
  'Avestan',
  'Balinese',
  'Bamum',
  'Bassa_Vah',
  'Batak',
  'Bengali',
  'Bopomofo',
  'Brahmi',
  'Buginese',
  'Buhid',
  'Canadian_Aboriginal',
  'Carian',
  'Chakma',
  'Cham',
  'Cherokee',
  'Coptic',
  'Cuneiform',
  'Deseret',
  'Devanagari',
  'Egyptian_Hieroglyphs',
  'Ethiopic',
  'Georgian',
  'Glagolitic',
  'Gothic',
  'Gujarati',
  'Gunjala_Gondi',
  'Gurmukhi',
  'Han',
  'Hangul',
  'Hanifi_Rohingya',
  'Hanunoo',
  'Hebrew',
  'Hiragana',
  'Imperial_Aramaic',
  'Javanese',
  'Kannada',
  'Kayah_Li',
  'Katakana',
  'Kharoshthi',
  'Khmer',
  'Lao',
  'Lepcha',
  'Limbu',
  'Linear_B',
  'Lisu',
  'Lycian',
  'Lydian',
  'Malayalam',
  'Mandaic',
  'Masaram_Gondi',
  'Medefaidrin',
  'Meetei_Mayek',
  'Mende_Kikakui',
  'Miao',
  'Mongolian',
  'Mro',
  'Myanmar',
  'New_Tai_Lue',
  'Newa',
  'Nko',
  'Nyiakeng_Puachue_Hmong',
  'Ogham',
  'Ol_Chiki',
  'Old_Hungarian',
  'Old_Italic',
  'Old_Persian',
  'Old_Turkic',
  'Oriya',
  'Osage',
  'Pahawh_Hmong',
  'Phoenician',
  'Runic',
  'Samaritan',
  'Saurashtra',
  'Shavian',
  'Sinhala',
  'Sora_Sompeng',
  'Sundanese',
  'Syloti_Nagri',
  'Syriac',
  'Tagalog',
  'Tagbanwa',
  'Tai_Le',
  'Tai_Tham',
  'Tai_Viet',
  'Tamil',
  'Telugu',
  'Thaana',
  'Thai',
  'Tibetan',
  'Tifinagh',
  'Tirhuta',
  'Ugaritic',
  'Vai',
  'Wancho',
  'Warang_Citi',
  'Yezidi',
  'Yi',
];
const SCRIPT_RES = SCRIPTS.map((name) => [name, new RegExp(`\\p{Script=${name}}`, 'u')]);
const OUTSIDE_MAIN =
  /[^\p{Script=Latin}\p{Script=Greek}\p{Script=Cyrillic}\p{Script=Common}\p{Script=Inherited}]/gu;

export const notoFamilyFor = (script) =>
  NOTO_FAMILY[script] ??
  `Noto ${NOTO_SERIF.has(script) ? 'Serif' : 'Sans'} ${script.replace(/_/g, ' ')}`;

/**
 * A running record of the scripts a text uses beyond the main font's.
 * `add(text)` reads a string, `scripts()` lists what it found in order of
 * first appearance. Each character outside the main font's scripts is looked
 * up once.
 */
export function scriptCollector() {
  const seen = new Map();
  const found = new Set();
  return {
    add(text) {
      for (const [ch] of String(text ?? '').matchAll(OUTSIDE_MAIN)) {
        if (seen.has(ch)) continue;
        const hit = SCRIPT_RES.find(([, re]) => re.test(ch))?.[0] ?? null;
        seen.set(ch, hit);
        if (hit && !MAIN_FONT_SCRIPTS.has(hit)) found.add(hit);
      }
      // Punctuation of a right-to-left script is set in that script's font.
      for (const [ch] of String(text ?? '').matchAll(RTL_SHARED_RE)) {
        if (seen.has(ch)) continue;
        const hit = rtlScriptOf(ch);
        seen.set(ch, hit);
        if (hit) found.add(hit);
      }
    },
    scripts: () => [...found],
  };
}

// ---- abbreviations --------------------------------------------------------

// The Leipzig Glossing Rules' own list, for an abbreviation no tagset
// describes.
const LEIPZIG = {
  1: 'first person',
  2: 'second person',
  3: 'third person',
  A: 'agent-like argument of canonical transitive verb',
  ABL: 'ablative',
  ABS: 'absolutive',
  ACC: 'accusative',
  ADJ: 'adjective',
  ADV: 'adverb(ial)',
  AGR: 'agreement',
  ALL: 'allative',
  ANTIP: 'antipassive',
  APPL: 'applicative',
  ART: 'article',
  AUX: 'auxiliary',
  BEN: 'benefactive',
  CAUS: 'causative',
  CLF: 'classifier',
  COM: 'comitative',
  COMP: 'complementizer',
  COMPL: 'completive',
  COND: 'conditional',
  COP: 'copula',
  CVB: 'converb',
  DAT: 'dative',
  DECL: 'declarative',
  DEF: 'definite',
  DEM: 'demonstrative',
  DET: 'determiner',
  DIST: 'distal',
  DISTR: 'distributive',
  DU: 'dual',
  DUR: 'durative',
  ERG: 'ergative',
  EXCL: 'exclusive',
  F: 'feminine',
  FOC: 'focus',
  FUT: 'future',
  GEN: 'genitive',
  IMP: 'imperative',
  INCL: 'inclusive',
  IND: 'indicative',
  INDF: 'indefinite',
  INF: 'infinitive',
  INS: 'instrumental',
  INTR: 'intransitive',
  IPFV: 'imperfective',
  IRR: 'irrealis',
  LOC: 'locative',
  M: 'masculine',
  N: 'neuter',
  NEG: 'negation, negative',
  NMLZ: 'nominalizer/nominalization',
  NOM: 'nominative',
  NSG: 'nonsingular',
  NPST: 'nonpast',
  OBJ: 'object',
  OBL: 'oblique',
  P: 'patient-like argument of canonical transitive verb',
  PASS: 'passive',
  PFV: 'perfective',
  PL: 'plural',
  POSS: 'possessive',
  PRED: 'predicative',
  PRF: 'perfect',
  PRS: 'present',
  PROG: 'progressive',
  PROH: 'prohibitive',
  PROX: 'proximal/proximate',
  PST: 'past',
  PTCP: 'participle',
  PURP: 'purposive',
  Q: 'question particle/marker',
  QUOT: 'quotative',
  RECP: 'reciprocal',
  REFL: 'reflexive',
  REL: 'relative',
  RES: 'resultative',
  S: 'single argument of canonical intransitive verb',
  SBJ: 'subject',
  SBJV: 'subjunctive',
  SG: 'singular',
  TOP: 'topic',
  TR: 'transitive',
  VOC: 'vocative',
};

const SMALL_CAPS_RE = /\\textsc\{([^{}]*)\}/g;

/** Every small-caps abbreviation in some LaTeX source, as texGloss wrote it (lower case). */
export const smallCapsIn = (tex) => [...String(tex).matchAll(SMALL_CAPS_RE)].map((m) => m[1]);

// A tagset value is written as the gloss has it ("1SG"), and \textsc takes
// it in lower case, so the two meet in lower case.
const tagsetDescriptions = (projectConfig) => {
  const out = new Map();
  for (const tagset of Object.values(readTagsets(projectConfig))) {
    for (const v of tagset.values) {
      const d = typeof v.description === 'string' ? v.description.trim() : '';
      const key = v.value.replace(/\u0130/g, 'i').toLowerCase();
      if (d && !out.has(key)) out.set(key, d);
    }
  }
  return out;
};

const collator = new Intl.Collator('en', { numeric: true, sensitivity: 'base' });

/**
 * The abbreviations chapter: each small-caps abbreviation the texts use, with
 * what the project's tagsets say it means, else what the Leipzig Glossing
 * Rules say, else nothing for the author to fill in.
 */
export function formatAbbreviations(tags, projectConfig) {
  const described = tagsetDescriptions(projectConfig);
  const rows = [...new Set(tags)].sort(collator.compare).map((tag) => {
    const meaning = described.get(tag) ?? LEIPZIG[tag.toUpperCase()] ?? '';
    return `\\PlaidAbbreviation{\\textsc{${tag}}}{${texEscape(texLine(meaning))}}`;
  });
  return [
    '\\chapter*{Abbreviations}',
    '\\addcontentsline{toc}{chapter}{Abbreviations}',
    '',
    ...(rows.length
      ? ['\\begin{PlaidAbbreviationList}', ...rows, '\\end{PlaidAbbreviationList}']
      : []),
    '',
  ].join('\n');
}

// ---- the bundle -----------------------------------------------------------

/**
 * A text's file name: its place in the book, then its name in plain ASCII
 * letters, since \include cannot take a space and some TeX installations
 * cannot take anything outside ASCII in a file name.
 */
export const chapterFileName = (index, count, name) => {
  const number = String(index + 1).padStart(Math.max(3, String(count).length), '0');
  const slug = String(name ?? '')
    .normalize('NFKD')
    .replace(/\p{M}/gu, '')
    .replace(/[^A-Za-z0-9]+/g, '-')
    .replace(/^-+|-+$/g, '')
    .slice(0, 40)
    .replace(/-+$/, '')
    .toLowerCase();
  return slug ? `${number}-${slug}` : number;
};

const scriptFonts = (scripts) =>
  scripts
    .filter((s) => RTL_SCRIPTS.includes(s))
    .map((s) => `\\PlaidScriptFont{${scriptCs(s)}}{${notoFamilyFor(s)}}\n`)
    .join('');

const fallbackFonts = (scripts) =>
  [
    ...scripts.filter((s) => !RTL_SCRIPTS.includes(s)).map(notoFamilyFor),
    'Noto Serif',
    'Noto Sans',
    'Noto Sans Math',
    'Noto Sans Symbols',
    'Noto Sans Symbols2',
  ]
    .map((family) => `\\PlaidFallbackFont{${family}}`)
    .join('\n');

/** main.tex: the preamble, a place for front matter, and one \include per text. */
function formatMain({ title, chapters, scripts, abbreviations = true }) {
  const includes = chapters.map((c) => `\\include{texts/${c}}`).join('\n');
  return `% ${texLine(title)}
% Compile with LuaLaTeX. On Overleaf: Menu > Compiler > LuaLaTeX
% (the latexmkrc file beside this one also asks for it).

\\ifdefined\\directlua\\else
  \\errmessage{Compile this book with LuaLaTeX. On Overleaf: Menu, Compiler, LuaLaTeX}
  \\csname @@end\\endcsname
\\fi

\\documentclass[11pt,openany]{book}
\\raggedbottom

\\usepackage[a4paper,margin=2.5cm]{geometry}
% Room for four-digit page numbers in the table of contents, and a little
% give for a line holding a long unbreakable word such as a web address.
\\makeatletter\\renewcommand{\\@pnumwidth}{2.5em}\\makeatother
\\setlength{\\emergencystretch}{2em}
\\usepackage{fontspec}
\\usepackage{multicol}

% ---- Fonts ----------------------------------------------------------------
% Charis SIL sets Latin (IPA included), Greek and Cyrillic. A character it
% lacks is taken from the first installed font in this list that has it.
\\def\\PlaidFallbacks{}
\\newcommand{\\PlaidFallbackFont}[1]{%
  \\IfFontExistsTF{#1}{\\edef\\PlaidFallbacks{\\PlaidFallbacks "#1:mode=harf;",}}{}}
${fallbackFonts(scripts)}
\\directlua{luaotfload.add_fallback("plaidfallback", {\\PlaidFallbacks})}
% The main font is the first of these that is installed.
\\newcommand{\\PlaidMainFont}{Latin Modern Roman}
\\IfFontExistsTF{Noto Serif}{\\renewcommand{\\PlaidMainFont}{Noto Serif}}{}
\\IfFontExistsTF{Charis}{\\renewcommand{\\PlaidMainFont}{Charis}}{}
\\IfFontExistsTF{Charis SIL}{\\renewcommand{\\PlaidMainFont}{Charis SIL}}{}
\\setmainfont{\\PlaidMainFont}[Renderer=HarfBuzz,RawFeature={fallback=plaidfallback}]
% A script written right to left has a font of its own.
\\newcommand{\\PlaidScriptFont}[2]{%
  \\IfFontExistsTF{#2}%
    {\\expandafter\\newfontfamily\\csname PlaidFont#1\\endcsname{#2}[Renderer=HarfBuzz]}%
    {\\expandafter\\let\\csname PlaidFont#1\\endcsname\\relax}}
\\DeclareRobustCommand{\\PlaidScript}[2]{{\\csname PlaidFont#1\\endcsname #2}}
\\ifdefined\\AddToNoCaseChangeList\\AddToNoCaseChangeList{\\PlaidScript}\\fi
${scriptFonts(scripts)}
% ---- Interlinear examples ---------------------------------------------------
\\usepackage{expex}
% A sentence too long for the line breaks into blocks, set ragged right, and
% an example too long for the page continues on the next.
\\lingset{glbreaking,glrightskip=0pt plus .5\\hsize,aboveglftskip=.3ex}
% An example's number reads left to right in a text written right to left too.
\\lingset{exnoformat=\\begingroup\\textdir TLT(X)\\endgroup}

% How each line looks. Change one here to change it throughout the book.
\\newcommand{\\PlaidWord}[1]{\\textit{#1}}           % the words
\\newcommand{\\PlaidOrthography}[1]{#1}             % each orthography
\\newcommand{\\PlaidWordField}[1]{#1}               % each word field
\\newcommand{\\PlaidMorphemes}[1]{\\textit{#1}}      % the morphemes
\\newcommand{\\PlaidMorphemeField}[1]{#1}           % each morpheme field
\\newcommand{\\PlaidTranslation}[1]{‘#1’}           % the free translation
\\newcommand{\\PlaidSentenceField}[2]{\\newline\\textit{#1:} #2} % every other sentence field
\\newcommand{\\PlaidSpeaker}[1]{\\textsc{#1}:}      % the speaker
\\newcommand{\\PlaidMetadata}[2]{\\item[#1] #2}     % a document's metadata
\\newenvironment{PlaidMetadataList}{\\begin{description}\\small}{\\end{description}}
\\newcommand{\\PlaidAbbreviation}[2]{\\item[#1] #2}
\\newenvironment{PlaidAbbreviationList}{%
  \\begin{multicols}{2}\\raggedright
  \\begin{list}{}{\\setlength{\\labelwidth}{4.5em}\\setlength{\\leftmargin}{5em}%
    \\setlength{\\itemsep}{0pt}\\setlength{\\parsep}{0pt}\\renewcommand{\\makelabel}[1]{##1\\hfil}}}%
  {\\end{list}\\end{multicols}}

% Text that reads the other way from the text around it. A right-to-left run
% inside left-to-right text is boxed, since LuaTeX shapes it backwards
% otherwise.
\\DeclareRobustCommand{\\PlaidRTL}[1]{\\leavevmode\\hbox{\\textdir TRT #1}}
\\DeclareRobustCommand{\\PlaidLTR}[1]{{\\textdir TLT #1}}
% A text written right to left: its examples run right to left.
\\newenvironment{PlaidRightToLeft}{\\par\\pardir TRT\\textdir TRT}{\\par}

% The running head: the chapter's number and name, as written.
\\renewcommand{\\chaptermark}[1]{\\markboth{\\thechapter\\quad #1}{\\thechapter\\quad #1}}

\\usepackage[hidelinks]{hyperref}

\\begin{document}

% ---- Front matter -----------------------------------------------------------
% Add a title page, a preface, acknowledgments and the like here.
\\frontmatter
\\title{${heading(title)}}
\\author{}
\\date{}
\\maketitle
\\tableofcontents
${abbreviations ? '\\include{abbreviations}\n' : ''}% ---- End of front matter ----------------------------------------------------

\\mainmatter
% One chapter per text. To compile only some of them while you work, list
% them here, for example \\includeonly{texts/001-name}.
${includes}

\\backmatter
\\end{document}
`;
}

const LATEXMKRC = `# Overleaf and latexmk: compile main.tex with LuaLaTeX.
$pdf_mode = 4;
$pdflatex = 'lualatex %O %S';
$lualatex = 'lualatex %O %S';
`;

/** README.txt: how to compile, in the fewest words. */
const formatReadme = ({ title, chapterCount }) =>
  [
    `${texLine(title)}: LaTeX source for a book of interlinear texts, exported from Plaid.`,
    '',
    'Contents:',
    '  main.tex           the book: preamble, front matter, table of contents',
    '  abbreviations.tex  the gloss abbreviations the texts use',
    `  texts/             one chapter per text (${chapterCount})`,
    '  latexmkrc          compiler setting for Overleaf',
    '',
    'On Overleaf:',
    '  1. New Project > Upload Project, and choose this .zip.',
    '  2. Menu > Compiler: LuaLaTeX. (latexmkrc also selects it.)',
    '  3. Recompile.',
    '',
    'Elsewhere, with TeX Live 2023 or later:',
    '  latexmk -lualatex main.tex',
    '',
    'Front matter (title page, preface, acknowledgments) goes between the',
    '"Front matter" markers in main.tex. The look of each interlinear line is',
    'set by the \\Plaid... commands in the preamble.',
    '',
    'Fonts: Charis SIL, with Noto fonts for other scripts. Both come with',
    'Overleaf. Elsewhere, a character no installed font has is left out, and',
    'the log says so. main.tex names the Noto fonts it looks for.',
    '',
  ].join('\n');

/**
 * The whole bundle from each text's chapter source.
 *
 * texts: [{ name, tex }] in book order. Returns [{ path, data }] for
 * assembleZip.
 */
export function buildLatexBook({ title, texts, projectConfig }) {
  const chapters = texts.map((t, i) => chapterFileName(i, texts.length, t.name));
  const scripts = scriptCollector();
  const tags = [];
  for (const t of texts) {
    scripts.add(t.tex);
    tags.push(...smallCapsIn(t.tex));
  }
  scripts.add(title);
  return [
    { path: 'main.tex', data: formatMain({ title, chapters, scripts: scripts.scripts() }) },
    { path: 'abbreviations.tex', data: formatAbbreviations(tags, projectConfig) },
    ...texts.map((t, i) => ({ path: `texts/${chapters[i]}.tex`, data: t.tex })),
    { path: 'latexmkrc', data: LATEXMKRC },
    { path: 'README.txt', data: formatReadme({ title, chapterCount: texts.length }) },
  ];
}
