// The LaTeX book: a project, or the documents chosen, as LaTeX source a person
// adds front matter to and compiles with LuaLaTeX into a book of
// interlinear texts. One chapter per document, one numbered example per
// sentence, and the example's lines in the order the Analyze tab shows them:
// the words, each orthography, each word field, the morphemes, each morpheme
// field, then the sentence fields under the grid.
//
// The bundle (buildLatexBook):
//   main.tex           preamble, title, table of contents, one \include per text
//   abbreviations.tex  every gloss abbreviation the texts use
//   texts/NNN-name.tex one chapter per document, in the order of the export
//   vocabulary.tex     the entries the texts use, when the preset asks for it
//   latexmkrc          makes latexmk (and so Overleaf) run LuaLaTeX
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

import { morphFormOf, texCell, texGloss, texWord, wordCells } from '../domain/igtExport.js';
import { joinerBetween } from '../domain/affixMarkers.js';
import { texEscape, texLine } from '../domain/tex.js';
import { readTagsets } from '../domain/tagsets.js';
import { readVocabFields } from '../domain/igtConfig.js';
import { FIELD_TYPES, exportedVocabFields, fieldLabel } from '../domain/vocabFields.js';
import {
  buildItemNumbers,
  buildSenseTree,
  descendantsOf,
  exampleKey,
  exampleRefs,
  fieldsForItem,
  refIds,
} from '../domain/vocabDictionary.js';
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

// An entry's dotted number (buildItemNumbers) as a subscript after its form,
// kai₁, in the texts and in the vocabulary alike. Digits and dots only.
const homonym = (number) => (number ? `\\PlaidHomonym{${number}}` : '');

// A word cell with its entry's number after it.
const numberedWordCell = (macro, docDir) => (text, number) =>
  number
    ? inScript(
        texWord((t) => `${texEscape(t)}${homonym(number)}`)(text),
        texLine(text),
        docDir,
        macro,
      )
    : plainCell(macro, docDir)(text);

// A segmented word with each morpheme's entry number after that morpheme,
// joined as the plain line joins them (joinerBetween on the bare forms).
const numberedMorphemes = (morphemes, numbers) => {
  const forms = morphemes.map((m) => morphFormOf(m));
  const piece = (i) => ({
    text: forms[i],
    morphType: morphemes[i].morphType ?? morphemes[i].metadata?.morphType,
  });
  return forms
    .map(
      (form, i) =>
        `${i === 0 ? '' : joinerBetween(piece(i - 1), piece(i))}${texEscape(texLine(form))}${homonym(numbers[i])}`,
    )
    .join('');
};

// ---- one sentence ---------------------------------------------------------

/**
 * The columns of one sentence, in reading order: one per word token, and one
 * per whitespace-separated run of the text no token covers (punctuation left
 * untokenized, or a sentence nobody has tokenized at all). The Analyze tab
 * shows an uncovered stretch as one inert column. Here each run is its own,
 * so a long untokenized stretch can break across lines like any other.
 */
const namesOf = (rows, kind) => rows.filter((r) => r.kind === kind).map((r) => r.name);

function sentenceColumns(sentence, selection, numbers = null) {
  const fields = {
    morphFields: namesOf(selection.rows, ROW_KINDS.MORPHEME_FIELD),
    wordFields: namesOf(selection.rows, ROW_KINDS.WORD_FIELD),
  };
  const orthographies = namesOf(selection.rows, ROW_KINDS.ORTHOGRAPHY);
  const pieces = sentence.pieces || (sentence.tokens || []).map((t) => ({ type: 'token', ...t }));
  // The number of the entry a word or morpheme is linked to, when it has one.
  const numberOf = (linked) => (numbers && linked?.id ? (numbers.get(linked.id) ?? '') : '');
  const columns = [];
  for (const piece of pieces) {
    if (piece.type === 'token') {
      const cells = wordCells(piece, fields);
      const morphemes = piece.morphemes || [];
      const word = piece.content ?? '';
      // A word with no morphemes (punctuation the project skips) has none to show.
      const segmented = morphemes.length ? cells.segmented : '';
      const morphNumbers = morphemes.map((m) => numberOf(m.vocabItem));
      columns.push({
        word,
        orthographies: orthographies.map((o) => piece.orthographies?.[o] ?? ''),
        wordLines: cells.wordLines,
        segmented,
        morphLines: cells.morphLines,
        morphPieces: cells.morphPieces,
        morphemes,
        morphNumbers,
        wordNumber: numberOf(piece.vocabItem),
        // A word that is its one morpheme shows that morpheme's number when
        // the morpheme line is not printed.
        soleNumber: morphemes.length === 1 && segmented === word ? morphNumbers[0] : '',
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
        morphemes: [],
        morphNumbers: [],
        wordNumber: '',
        soleNumber: '',
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
  const morphemeLine =
    selection.rows.some((r) => r.kind === ROW_KINDS.MORPHEMES) &&
    columns.some((c) => c.segmented !== '' && c.segmented !== c.word);
  const index = { orthography: 0, wordField: 0, morphemeField: 0 };
  for (const row of selection.rows) {
    if (row.kind === ROW_KINDS.WORDS) {
      add(
        columns.map((c) => c.word),
        numberedWordCell('PlaidWord', docDir),
        columns.map((c) => c.wordNumber || (morphemeLine ? '' : c.soleNumber)),
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
      if (morphemeLine) {
        const plain = plainCell('PlaidMorphemes', docDir);
        add(
          columns.map((c) => c.segmented),
          (text, c) =>
            c.morphNumbers.some(Boolean)
              ? inScript(
                  texWord(() => numberedMorphemes(c.morphemes, c.morphNumbers))(text),
                  texLine(text),
                  docDir,
                  'PlaidMorphemes',
                )
              : plain(text),
          columns,
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
export function formatExample(
  sentence,
  selection,
  { docDir = 'ltr', speaker = null, numbers = null } = {},
) {
  const columns = sentenceColumns(sentence, selection, numbers);
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
 * from 1. `numbers` (entry id -> its number) writes each linked word's or
 * morpheme's entry number after it. Returns the file's text.
 */
export function formatChapter(igtDoc, selection, { numbers = null } = {}) {
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
    out.push(formatExample(sentence, selection, { docDir, speaker, numbers }), '');
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

// ---- the vocabulary -------------------------------------------------------

// Which entries a vocabulary chapter lists: those the texts in the book link
// to (a headword with every sense, when any of them is linked), or all.
export const VOCAB_SCOPES = Object.freeze({ USED: 'used', ALL: 'all' });

/**
 * The preset's vocabulary choices as the project has them now. `vocabs` is
 * the project's list of vocabularies as a project read gives it ({ id, name,
 * config }). The chapter is on by default when there is a vocabulary, every
 * vocabulary and every field it exports is on unless the preset switched it
 * off, the chapter lists the entries the texts use, and the texts show no
 * entry numbers.
 */
export function latexVocabulary(options, vocabs) {
  const saved =
    options?.vocabulary && typeof options.vocabulary === 'object' ? options.vocabulary : {};
  const savedVocabs = Array.isArray(saved.vocabularies) ? saved.vocabularies : [];
  const list = (vocabs || []).filter((v) => v && v.id);
  return {
    include: typeof saved.include === 'boolean' ? saved.include : list.length > 0,
    scope: saved.scope === VOCAB_SCOPES.ALL ? VOCAB_SCOPES.ALL : VOCAB_SCOPES.USED,
    numbersInTexts: saved.numbersInTexts === true,
    vocabularies: list.map((v) => {
      const s = savedVocabs.find((x) => x?.id === v.id);
      const savedFields = Array.isArray(s?.fields) ? s.fields : [];
      return {
        id: v.id,
        name: v.name ?? '',
        on: s?.on !== false,
        fields: exportedVocabFields(readVocabFields(v.config)).map((f) => ({
          name: f.name,
          on: savedFields.find((x) => x?.name === f.name)?.on !== false,
        })),
      };
    }),
  };
}

/** latexVocabulary's result as a preset stores it: ids and names, no labels. */
export const storedLatexVocabulary = (choice) => ({
  include: choice.include,
  scope: choice.scope,
  numbersInTexts: choice.numbersInTexts,
  vocabularies: choice.vocabularies.map((v) => ({
    id: v.id,
    on: v.on,
    fields: v.fields.map((f) => ({ name: f.name, on: f.on })),
  })),
});

/** Every entry's number across `vocabularies`, by entry id (buildItemNumbers). */
export const entryNumbers = (vocabularies) => {
  const out = new Map();
  for (const v of vocabularies || []) {
    for (const [id, n] of buildItemNumbers(v.items || [])) out.set(id, n);
  }
  return out;
};

/** The ids of the entries a document's words and morphemes are linked to. */
export const linkedEntryIds = (igtDoc, out = new Set()) => {
  for (const vocab of Object.values(igtDoc?.vocabularies || {})) {
    for (const link of vocab?.vocabLinks || []) {
      const id = link?.vocabItem?.id ?? link?.vocabItem;
      if (typeof id === 'string') out.add(id);
    }
  }
  return out;
};

/**
 * The book's example number of each sentence, word and morpheme of `igtDoc`
 * that is in `wanted` (exampleKey strings), as [chapter, example]: the
 * chapter is the document's place in the book, the example its sentence's,
 * both from 1.
 */
export const exampleNumbersOf = (igtDoc, docId, chapter, wanted, out = new Map()) => {
  (igtDoc?.sortedSentences || []).forEach((sentence, i) => {
    const ids = [sentence.id];
    for (const token of sentence.tokens || []) {
      ids.push(token.id, ...(token.morphemes || []).map((m) => m.id));
    }
    for (const id of ids) {
      const key = exampleKey(docId, id);
      if (wanted.has(key) && !out.has(key)) out.set(key, [chapter, i + 1]);
    }
  });
  return out;
};

// A form with its entry number, set in its script. The number goes inside
// the form's direction, after it in reading order.
const entryName = (form, number, macro = null) => {
  const text = texLine(form);
  const body = macro ? `\\${macro}{${texEscape(text)}}` : texEscape(text);
  return inScript(`${body}${homonym(number)}`, text, 'ltr');
};

const fieldText = (value) =>
  Array.isArray(value)
    ? value.filter((v) => v != null && typeof v !== 'object').join('; ')
    : value != null && typeof value !== 'object'
      ? String(value)
      : '';

const collatorFor = (lang) => {
  try {
    return new Intl.Collator(lang || 'und');
  } catch {
    return new Intl.Collator('und');
  }
};

/**
 * One vocabulary's entries: each headword in the collation of `lang`, with
 * its number, its gloss and fields, the examples of the book that show it,
 * and then each of its senses by its number. Returns null when
 * no entry is listed.
 */
function vocabularyEntries({ vocab, choice, scope, used, exampleNumbers, collator }) {
  const items = vocab.items || [];
  const tree = buildSenseTree(items);
  const numbers = buildItemNumbers(items, tree);
  const on = new Set(choice.fields.filter((f) => f.on).map((f) => f.name));
  // The gloss comes first, after the form, and the other fields in the
  // vocabulary's order.
  const fields = exportedVocabFields(readVocabFields(vocab.config))
    .filter((f) => on.has(f.name))
    .sort((a, b) => (b.name === 'gloss') - (a.name === 'gloss'));
  const nameOf = (id) => {
    const target = tree.byId.get(id);
    return target ? entryName(target.form ?? '', numbers.get(id)) : '';
  };
  const parts = (item) => {
    const out = [];
    for (const f of fieldsForItem(fields, item)) {
      if (f.type === FIELD_TYPES.ITEM) {
        const names = refIds(item, f).map(nameOf).filter(Boolean);
        if (names.length) {
          out.push(`\\PlaidEntryField{${runText(fieldLabel(f), 'ltr')}}{${names.join(', ')}}`);
        }
        continue;
      }
      const value = texLine(fieldText(item.metadata?.[f.name]));
      if (value === '') continue;
      out.push(
        f.name === 'gloss'
          ? `\\PlaidEntryGloss{${runText(value, 'ltr')}}`
          : `\\PlaidEntryField{${runText(fieldLabel(f), 'ltr')}}{${runText(value, 'ltr')}}`,
      );
    }
    const refs = [];
    const seen = new Set();
    for (const ref of exampleRefs(item)) {
      const at = exampleNumbers.get(exampleKey(ref.document, ref.token));
      if (!at || seen.has(at.join('.'))) continue;
      seen.add(at.join('.'));
      refs.push(at);
    }
    refs.sort((a, b) => a[0] - b[0] || a[1] - b[1]);
    if (refs.length) {
      out.push(
        `\\PlaidEntryExamples{${refs.map(([c, n]) => `\\PlaidExampleRef{${c}}{${n}}`).join(', ')}}`,
      );
    }
    return out;
  };
  const listed = tree.roots.filter(
    (root) =>
      scope === VOCAB_SCOPES.ALL ||
      used.has(root.id) ||
      descendantsOf(tree, root.id).some((s) => used.has(s.id)),
  );
  if (!listed.length) return null;
  const position = new Map(items.map((it, i) => [it.id, i]));
  const homographNo = (it) => Number.parseInt(numbers.get(it.id) || '0', 10);
  // An affix files under its letters: -s with s, not before a.
  const sortKey = (it) => texLine(it.form ?? '').replace(/^[-=]+|[-=]+$/g, '');
  listed.sort(
    (a, b) =>
      collator.compare(sortKey(a), sortKey(b)) ||
      homographNo(a) - homographNo(b) ||
      position.get(a.id) - position.get(b.id),
  );
  return listed.map((root) => {
    const body = parts(root);
    for (const sense of descendantsOf(tree, root.id)) {
      // A sense goes by its whole number, as the texts write it (kai 2.1).
      // One spelled like its headword shows no form of its own.
      const form =
        texLine(sense.form ?? '') !== texLine(root.form ?? '')
          ? `${entryName(sense.form ?? '', '', 'PlaidEntryForm')} `
          : '';
      body.push(`\\PlaidSense{${numbers.get(sense.id)}}{${form}${parts(sense).join(' ')}}`);
    }
    return `\\PlaidEntry{${entryName(root.form ?? '', numbers.get(root.id), 'PlaidEntryForm')}}{${body.join(' ')}}`;
  });
}

/**
 * The vocabulary at the end of the book: one chapter per vocabulary chosen,
 * headed "Vocabulary" when there is one and by each vocabulary's name when
 * there are several. A vocabulary with no entry to list is left out, and
 * with none left this returns null.
 *
 * vocabularies: the loaded vocabularies ({ id, name, config, items }).
 * choice: latexVocabulary's result. used: the ids of the entries the texts
 * link to. exampleNumbers: exampleKey -> [chapter, example] (exampleNumbersOf).
 * lang: the language the entries are written in (a BCP 47 tag), for their
 * order, else the root collation.
 */
export function formatVocabulary({
  vocabularies,
  choice,
  used = new Set(),
  exampleNumbers = new Map(),
  lang = null,
}) {
  const collator = collatorFor(lang);
  const byId = new Map((vocabularies || []).map((v) => [v.id, v]));
  const chapters = [];
  for (const c of choice.vocabularies) {
    const vocab = byId.get(c.id);
    if (!c.on || !vocab) continue;
    const entries = vocabularyEntries({
      vocab,
      choice: c,
      scope: choice.scope,
      used,
      exampleNumbers,
      collator,
    });
    if (entries) chapters.push({ name: vocab.name ?? c.name ?? '', entries });
  }
  if (!chapters.length) return null;
  const out = [];
  for (const { name, entries } of chapters) {
    const title = chapters.length === 1 ? 'Vocabulary' : heading(texLine(name)) || 'Vocabulary';
    out.push(
      `\\chapter*{${title}}`,
      `\\addcontentsline{toc}{chapter}{${title}}`,
      `\\markboth{${title}}{${title}}`,
      '',
      '\\begin{PlaidEntryList}',
      ...entries,
      '\\end{PlaidEntryList}',
      '',
    );
  }
  return out.join('\n');
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
function formatMain({ title, chapters, scripts, abbreviations = true, vocabulary = false }) {
  const includes = chapters.map((c) => `\\include{texts/${c}}`).join('\n');
  return `% ${texLine(title)}
% Compile with LuaLaTeX, twice, or with latexmk, which runs it as often as
% the table of contents needs: latexmk -lualatex main.tex

\\ifdefined\\directlua\\else
  \\errmessage{Compile this book with LuaLaTeX}
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
% An example's number reads left to right in a text written right to left too,
% and the vocabulary links to it.
\\newcommand{\\PlaidExampleNumber}[1]{\\hypertarget{plaidex.\\thechapter.#1}{(#1)}}
\\lingset{exnoformat=\\begingroup\\textdir TLT\\PlaidExampleNumber X\\endgroup}

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

% The vocabulary, and an entry's number after a form in the texts.
\\newcommand{\\PlaidHomonym}[1]{\\textsubscript{\\normalfont #1}} % an entry's number: kai₁
\\newcommand{\\PlaidEntry}[2]{\\par\\hangindent=1em\\hangafter=1\\noindent #1 #2\\par} % an entry
\\newcommand{\\PlaidEntryForm}[1]{\\textbf{#1}}     % an entry's form
\\newcommand{\\PlaidEntryGloss}[1]{‘#1’}            % its gloss
\\newcommand{\\PlaidEntryField}[2]{\\textit{#1:} #2.} % each other field
\\newcommand{\\PlaidEntryExamples}[1]{(#1)}         % the examples that show it
\\newcommand{\\PlaidExampleRef}[2]{\\hyperlink{plaidex.#1.#2}{#1.#2}} % chapter and example
\\newcommand{\\PlaidSense}[2]{\\textbf{#1.}~#2}     % a sense, by its number
\\newenvironment{PlaidEntryList}{\\begin{multicols}{2}\\raggedright\\small}{\\end{multicols}}

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

% The table of contents is read from the previous run, so the first run
% leaves it empty, and says so on the page and in the log. latexmk runs
% LuaLaTeX again by itself.
\\newcommand{\\PlaidContentsNote}{}
\\IfFileExists{\\jobname.toc}{}{\\renewcommand{\\PlaidContentsNote}{%
  \\emph{The table of contents is filled in when the book is compiled again.}%
  \\GenericWarning{}{LaTeX Warning: The table of contents is empty. Rerun to get cross-references right.}}}

\\begin{document}

% ---- Front matter -----------------------------------------------------------
% Add a title page, a preface, acknowledgments and the like here.
\\frontmatter
\\title{${heading(title)}}
\\author{}
\\date{}
\\maketitle
\\tableofcontents
\\PlaidContentsNote
${abbreviations ? '\\include{abbreviations}\n' : ''}% ---- End of front matter ----------------------------------------------------

\\mainmatter
% One chapter per text. To compile only some of them while you work, list
% them here, for example \\includeonly{texts/001-name}.
${includes}

\\backmatter
${vocabulary ? '\\include{vocabulary}\n' : ''}\\end{document}
`;
}

const LATEXMKRC = `# latexmk: compile main.tex with LuaLaTeX.
$pdf_mode = 4;
$pdflatex = 'lualatex %O %S';
$lualatex = 'lualatex %O %S';
`;

/** README.txt: how to compile, in the fewest words. */
const formatReadme = ({ title, chapterCount, vocabulary = false }) =>
  [
    `${texLine(title)}: LaTeX source for a book of interlinear texts, exported from Plaid.`,
    '',
    'Contents:',
    '  main.tex           the book: preamble, front matter, table of contents',
    '  abbreviations.tex  the gloss abbreviations the texts use',
    `  texts/             one chapter per text (${chapterCount})`,
    ...(vocabulary ? ['  vocabulary.tex     the vocabulary the texts use'] : []),
    '  latexmkrc          makes latexmk use LuaLaTeX',
    '',
    'To compile, with TeX Live 2023 or later:',
    '  latexmk -lualatex main.tex',
    '',
    'latexmk runs LuaLaTeX as many times as the book needs. Run by hand,',
    'LuaLaTeX has to run twice: the first run leaves the table of contents',
    'empty, and the second fills it in.',
    '  lualatex main.tex',
    '  lualatex main.tex',
    '',
    'An online editor that compiles with latexmk works too: upload the .zip',
    'and set its compiler to LuaLaTeX.',
    '',
    'Front matter (title page, preface, acknowledgments) goes between the',
    '"Front matter" markers in main.tex. The look of each interlinear line is',
    'set by the \\Plaid... commands in the preamble.',
    '',
    'Fonts: Charis SIL, with Noto fonts for other scripts. A character no',
    'installed font has is left out, and the log says so. main.tex names',
    'the Noto fonts it looks for.',
    '',
  ].join('\n');

/**
 * The whole bundle from each text's chapter source.
 *
 * texts: [{ name, tex }] in book order. vocabulary: the vocabulary
 * chapters' source (formatVocabulary), or null. Returns [{ path, data }] for
 * assembleZip.
 */
export function buildLatexBook({ title, texts, projectConfig, vocabulary = null }) {
  const chapters = texts.map((t, i) => chapterFileName(i, texts.length, t.name));
  const scripts = scriptCollector();
  const tags = [];
  for (const t of texts) {
    scripts.add(t.tex);
    tags.push(...smallCapsIn(t.tex));
  }
  scripts.add(title);
  if (vocabulary) scripts.add(vocabulary);
  return [
    {
      path: 'main.tex',
      data: formatMain({ title, chapters, scripts: scripts.scripts(), vocabulary: !!vocabulary }),
    },
    { path: 'abbreviations.tex', data: formatAbbreviations(tags, projectConfig) },
    ...texts.map((t, i) => ({ path: `texts/${chapters[i]}.tex`, data: t.tex })),
    { path: 'latexmkrc', data: LATEXMKRC },
    ...(vocabulary ? [{ path: 'vocabulary.tex', data: vocabulary }] : []),
    {
      path: 'README.txt',
      data: formatReadme({ title, chapterCount: texts.length, vocabulary: !!vocabulary }),
    },
  ];
}
