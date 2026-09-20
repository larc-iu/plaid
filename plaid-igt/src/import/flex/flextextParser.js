// FLEx interlinear XML (.flextext) → the FLEx IR that buildDocuments reads.
//
// A .flextext is what FieldWorks writes from its Interlinear view (File →
// Export Interlinear), and what ELAN, SayMore and Paratext write for FLEx to
// read. It holds texts and their analyses and no lexicon: a morph names its
// entry only by form (`cf`, `hn`), and nothing is built from that here. What
// the IR has a place for is read. Everything else is COUNTED in `unread`, so
// the review screen can say what stays behind instead of dropping it quietly.
//
// The running text is not in the file. FieldWorks writes a phrase's words and
// punctuation, not the string they came from, so the baseline is rebuilt from
// them by FieldWorks' own rule (see joinPhrase), which is the text FLEx itself
// makes when it imports the same file. A phrase that carries its text
// (`<item type="txt">` on the phrase) keeps it as written, as in FLEx.
//
// Every string is NFC, like the .fwdata parser's, and offsets are UTF-16 units
// into a paragraph, which buildDocuments turns into code points.
//
// Structure, per FieldWorks' FlexInterlinear.xsd and InterlinearExporter.cs:
//   document > interlinear-text[guid] > item[title|title-abbreviation|source|
//   comment|genre], paragraphs > paragraph > phrases > phrase > item[txt|gls|
//   lit|note|segnum], words > word > item[txt|punct|gls|pos], morphemes >
//   morph[type] > item[txt|cf|hn|gls|msa]; interlinear-text > languages >
//   language[lang, vernacular]. An <item> may hold <run> elements in place of
//   text, one per writing system or style.

import { SaxesParser } from 'saxes';
import { readAffixMarkers } from '../../domain/affixMarkers.js';

const nfc = (s) => String(s ?? '').normalize('NFC');

// --- tree ---------------------------------------------------------------------

function parseTree(xml) {
  const parser = new SaxesParser();
  const root = { tag: '#root', attrs: {}, children: [], text: '' };
  const stack = [root];
  parser.on('error', (e) => {
    throw new Error(`not readable XML (${e.message})`);
  });
  parser.on('opentag', (node) => {
    const n = { tag: node.name, attrs: node.attributes, children: [], text: '' };
    stack[stack.length - 1].children.push(n);
    stack.push(n);
  });
  const onText = (t) => {
    stack[stack.length - 1].text += t;
  };
  parser.on('text', onText);
  parser.on('cdata', onText);
  parser.on('closetag', () => {
    stack.pop();
  });
  parser.write(String(xml ?? '').replace(/^\uFEFF/, '')).close();
  return root;
}

const kids = (n, tag) => n?.children.filter((c) => c.tag === tag) ?? [];
const kid = (n, tag) => n?.children.find((c) => c.tag === tag) ?? null;

// An item's text: its runs joined when it has any, since the whitespace an
// indenting writer puts between them is not part of the value.
const valueOf = (item) => {
  const runs = kids(item, 'run');
  return nfc(runs.length ? runs.map((r) => r.text).join('') : item.text);
};

// --- rebuilding a phrase's text ----------------------------------------------

// Characters after which "other" punctuation takes a space.
const ENDING = [',', '.', ';', ':', '?', '!', '"'];

// One punctuation character's spacing, the way FieldWorks decides it
// (AdjustPunctStringForCharacter in LinguaLinksImport.cs): closing and final
// punctuation takes a space after, opening and initial punctuation a space
// before, and other punctuation a space after when the piece ends in one of
// ENDING (a lone '"' excepted, which takes a space BEFORE when it follows a
// word). An inverted '¡' or '¿' after a word takes a space in front of it.
function spacePunctChar(s, c, index, followsWord) {
  let before = false;
  let after = false;
  let here = false;
  if (/\p{Pe}|\p{Pf}/u.test(c)) after = true;
  else if (/\p{Ps}|\p{Pi}/u.test(c)) before = true;
  else if (/\p{Po}/u.test(c)) {
    if (ENDING.includes(s.at(-1))) after = c !== '"' || s.length > 1;
    if (c === '\u00A1' || c === '\u00BF') here = true;
    if (c === '"' && s.length === 1) before = followsWord;
  }
  let out = s;
  if (before) out = ` ${out}`;
  if (here && followsWord && !(index > 0 && [' ', '"'].includes(out[index - 1]))) {
    out = `${out.slice(0, index)} ${out.slice(index)}`;
  }
  if (after) out = `${out} `;
  return out;
}

// A punctuation piece is spaced by its first character and then its last.
const spacePunct = (s, followsWord) => {
  const chars = [...s];
  if (!chars.length) return s;
  let out = spacePunctChar(s, chars[0], 0, followsWord);
  if (chars.length > 1) {
    out = spacePunctChar(out, chars[chars.length - 1], s.length - 1, followsWord);
  }
  return out;
};

/**
 * A phrase's text from its pieces, [{kind: 'word'|'punct', text}], by
 * FieldWorks' rule (UpdatePhraseTextForWordItems in
 * BIRDInterlinearImporter.cs): two words are joined by a space, a punctuation
 * piece is spaced by spacePunct, and the first piece is written as it is.
 * Where the source had other spacing, this is FLEx's text rather than the
 * author's, and it is exactly what a FLEx import of the file would show.
 */
export function joinPhrase(pieces) {
  let text = null;
  let lastWasWord = false;
  for (const p of pieces) {
    const isWord = p.kind === 'word';
    if (text == null) text = p.text;
    else if (isWord) text += `${lastWasWord ? ' ' : ''}${p.text}`;
    else text += spacePunct(p.text, lastWasWord);
    lastWasWord = isWord;
  }
  return text ?? '';
}

// --- one file -----------------------------------------------------------------

// Text-level items FieldWorks writes for its own bookkeeping, which are not
// anything a person wrote about the text.
const SILENT_TEXT_ITEMS = new Set(['date-created', 'date-modified']);

/** A tally of what a file holds that this import does not bring in. */
function makeCensus() {
  const unread = new Map();
  const langs = {
    wordFirst: new Map(), // lang of the txt item a word's text comes from
    phraseText: new Map(), // lang of the txt item a phrase's own line comes from
    wordForms: new Map(),
    wordGloss: new Map(),
    morphGloss: new Map(),
    pos: new Map(),
    freeTranslation: new Map(),
    literalTranslation: new Map(),
    note: new Map(),
  };
  return {
    unread,
    langs,
    skip: (label, n = 1) => unread.set(label, (unread.get(label) ?? 0) + n),
    use: (kind, lang) => {
      if (lang) langs[kind].set(lang, (langs[kind].get(lang) ?? 0) + 1);
    },
  };
}

function readMorph(m, census) {
  let raw = null;
  let formLang = null;
  const gloss = {};
  let pos = null;
  let lexical = false;
  let guessed = null;
  for (const item of kids(m, 'item')) {
    const { type, lang } = item.attrs;
    const v = valueOf(item).trim();
    const status = item.attrs.analysisStatus;
    if (status && status !== 'humanApproved') guessed = status;
    if (type === 'txt') {
      if (raw == null && v) {
        raw = v;
        formLang = lang ?? null;
      }
    } else if (type === 'gls') {
      if (v) {
        gloss[lang] = v;
        census.use('morphGloss', lang);
      }
    } else if (type === 'msa') {
      if (v && pos == null) {
        pos = v;
        census.use('pos', lang);
      }
    } else if (type === 'cf' || type === 'hn') lexical = true;
    else if (type === 'variantTypes') census.skip('Variant Types');
    else census.skip(`“${type}” on morphemes`);
  }
  if (lexical) census.skip('Lex. Entries');
  const { form, morphType } = readAffixMarkers(m.attrs.type, raw);
  return {
    morph: {
      forms: form ? { [formLang ?? '']: form } : null,
      gloss: Object.keys(gloss).length ? gloss : null,
      pos,
      morphType,
      senseGuid: null,
      entryGuid: null,
    },
    guessed,
  };
}

/**
 * One <word> as a piece of text and an analysis, or null when it has neither
 * a word form nor punctuation. The text comes from its first txt or punct
 * item, which is the one FieldWorks builds the phrase from.
 */
function readWord(w, census) {
  let first = null;
  const forms = {};
  const gloss = {};
  let pos = null;
  const guesses = new Set();
  for (const item of kids(w, 'item')) {
    const { type, lang } = item.attrs;
    const v = valueOf(item).trim();
    const status = item.attrs.analysisStatus;
    if (status && status !== 'humanApproved' && (type === 'gls' || type === 'pos')) {
      guesses.add(status);
    }
    if (type === 'txt') {
      if (!v) continue;
      if (!first) {
        first = { kind: 'word', text: v };
        census.use('wordFirst', lang);
      }
      if (forms[lang] == null) {
        forms[lang] = v;
        census.use('wordForms', lang);
      }
    } else if (type === 'punct') {
      if (v && !first) first = { kind: 'punct', text: v };
    } else if (type === 'gls') {
      if (v) {
        gloss[lang] = v;
        census.use('wordGloss', lang);
      }
    } else if (type === 'pos') {
      if (v && pos == null) {
        pos = v;
        census.use('pos', lang);
      }
    } else census.skip(`“${type}” on words`);
  }
  if (!first) return null;
  if (first.kind === 'punct') {
    return { piece: first, analysis: { kind: 'punct', form: first.text } };
  }
  // A word that is nothing but punctuation is spaced as punctuation, which is
  // where this parts from FieldWorks: Plaid's own export writes a punctuation
  // token as a word, and FLEx's rule would put "Cuomo ( born" back together
  // with a space on every side. It still comes in as a word.
  const piece = /^\p{P}+$/u.test(first.text) ? { kind: 'punct', text: first.text } : first;

  const morphemesEl = kid(w, 'morphemes');
  const status = morphemesEl?.attrs.analysisStatus;
  if (status && status !== 'humanApproved') guesses.add(status);
  let morphemes = morphemesEl
    ? kids(morphemesEl, 'morph').map((m) => {
        const r = readMorph(m, census);
        if (r.guessed) guesses.add(r.guessed);
        return r.morph;
      })
    : null;
  // One morph that is only the word again, with no gloss, category or type,
  // is no segmentation: Plaid's own export writes one for every word nobody
  // segmented, and an unsegmented word has no morpheme of its own here
  // (domain/virtualMorpheme.js).
  const [only] = morphemes ?? [];
  if (
    morphemes?.length === 1 &&
    !only.gloss &&
    !only.pos &&
    !only.morphType &&
    Object.values(only.forms ?? {}).every((f) => f === first.text)
  ) {
    morphemes = null;
  }
  // FLEx marks an analysis it guessed and nobody approved (analysisStatus
  // "guess", or one of the two finer kinds another tool may write), which is
  // machine work. The status names the kind of guess, and stands where the
  // .fwbackup import names the parser (flexSource in importEngine.js). A
  // guessed word without a morpheme breakdown still has an analysis, which is
  // what an empty list says, as it does for a .fwbackup.
  const machineAgents = [...guesses].sort();
  return {
    piece,
    analysis: {
      kind: 'word',
      surface: first.text,
      forms,
      gloss: Object.keys(gloss).length ? gloss : null,
      pos,
      approved: machineAgents.length === 0,
      machineAgents,
      morphemes: morphemes ?? (machineAgents.length ? [] : null),
    },
  };
}

function readPhrase(ph, census) {
  let given = null;
  let segnum = '';
  const freeTranslation = {};
  const literalTranslation = {};
  const notes = [];
  const noteGroups = new Map();
  for (const item of kids(ph, 'item')) {
    const { type, lang } = item.attrs;
    const v = valueOf(item).trim();
    // The first, as a word takes its first `txt` as its own: a phrase given
    // in two writing systems (an orthographic line and a phonetic one, which
    // is what ELAN and SayMore write from two transcription tiers) took the
    // last as the sentence's text, so its words no longer lined up with it
    // and were dropped.
    if (type === 'txt') {
      if (given == null) {
        given = valueOf(item);
        census.use('phraseText', lang);
      }
    } else if (type === 'gls') {
      if (v) {
        freeTranslation[lang] = v;
        census.use('freeTranslation', lang);
      }
    } else if (type === 'lit') {
      if (v) {
        literalTranslation[lang] = v;
        census.use('literalTranslation', lang);
      }
    } else if (type === 'note') {
      if (!v) continue;
      census.use('note', lang);
      // Items sharing a groupid are one note in several writing systems.
      const group = item.attrs.groupid;
      let note = group != null ? noteGroups.get(group) : null;
      if (!note) {
        note = {};
        notes.push(note);
        if (group != null) noteGroups.set(group, note);
      }
      note[lang] = v;
    } else if (type === 'segnum') segnum = v;
    else census.skip(`“${type}” on sentences`);
  }
  if (ph.attrs['begin-time-offset'] != null || ph.attrs['end-time-offset'] != null) {
    census.skip('Time alignment');
  }
  if (ph.attrs.speaker) census.skip('Speakers');

  const wordsEl = kid(ph, 'words');
  const milestones = kids(wordsEl, 'scrMilestone').length;
  if (milestones) census.skip('Chapter and verse numbers', milestones);
  const pieces = [];
  const analyses = [];
  let empty = 0;
  for (const w of kids(wordsEl, 'word')) {
    const r = readWord(w, census);
    if (!r) {
      empty += 1;
      continue;
    }
    pieces.push(r.piece);
    analyses.push(r.analysis);
  }
  const text = (given != null ? given : joinPhrase(pieces)).trim();
  return {
    text,
    segnum,
    empty,
    segment: {
      guid: ph.attrs.guid ?? null,
      freeTranslation: Object.keys(freeTranslation).length ? freeTranslation : null,
      literalTranslation: Object.keys(literalTranslation).length ? literalTranslation : null,
      notes,
      analyses,
    },
  };
}

const byLang = (items) => {
  const out = {};
  for (const item of items) {
    const v = valueOf(item).trim();
    if (!v) continue;
    const lang = item.attrs.lang ?? '';
    out[lang] = out[lang] ? `${out[lang]}\n${v}` : v;
  }
  return Object.keys(out).length ? out : null;
};

function readText(it, census, warnings, fileLabel) {
  const items = kids(it, 'item');
  const ofType = (...types) => items.filter((i) => types.includes(i.attrs.type));
  const names = byLang(ofType('title'));
  const label = Object.values(names ?? {})[0] ?? fileLabel;
  const known = new Set([
    'title',
    'title-abbreviation',
    'source',
    'comment',
    'description',
    'genre',
  ]);
  for (const item of items) {
    const type = item.attrs.type;
    if (known.has(type) || SILENT_TEXT_ITEMS.has(type)) continue;
    census.skip(type === 'notebook-record' ? 'Notebook records' : `“${type}” on texts`);
  }
  // FLEx names a genre once per writing system, so reading every item made a
  // genre per language rather than per genre ("Narrative" and "Récit" as two).
  // One language's list is the list, and the first one seen is that language.
  const genreItems = ofType('genre').filter((i) => valueOf(i).trim());
  const genreLang = genreItems[0]?.attrs?.lang ?? null;
  const genres = genreItems
    .filter((i) => (i.attrs.lang ?? null) === genreLang)
    .map((i) => valueOf(i).trim());
  const media = kids(kid(it, 'media-files'), 'media').length;
  if (media) census.skip('Media files', media);

  const paragraphs = [];
  let sentence = 0;
  for (const p of kids(kid(it, 'paragraphs'), 'paragraph')) {
    let content = '';
    const segments = [];
    for (const ph of kids(kid(p, 'phrases'), 'phrase')) {
      sentence += 1;
      const r = readPhrase(ph, census);
      const where = `sentence ${r.segnum || sentence}`;
      if (r.empty) {
        warnings.push(
          `${label}: ${r.empty} word${r.empty === 1 ? '' : 's'} with no text left out of ${where}`,
        );
      }
      if (!r.text) {
        const { freeTranslation, literalTranslation, notes } = r.segment;
        if (freeTranslation || literalTranslation || notes.length) {
          warnings.push(`${label}: ${where} has no text and was left out with its translation`);
        }
        continue;
      }
      if (content) content += ' ';
      segments.push({ ...r.segment, beginOffset: content.length });
      content += r.text;
    }
    paragraphs.push({ guid: p.attrs.guid ?? null, content, segments });
  }

  return {
    names,
    abbreviations: byLang(ofType('title-abbreviation')),
    source: byLang(ofType('source')),
    description: byLang(ofType('comment', 'description')),
    genres,
    notebook: null,
    paragraphs,
  };
}

/**
 * Parse one .flextext. Returns { texts, languages, census, warnings }, where
 * each text is in the IR's shape (see parseFwdata) with `guid` its FLEx guid
 * or null, and `languages` is [{lang, vernacular}] in the order declared.
 */
export function parseFlextext(xml, fileName = '', census = makeCensus()) {
  const root = parseTree(xml);
  const doc = kid(root, 'document');
  if (!doc) throw new Error('not a .flextext (no <document> element)');
  const warnings = [];
  const languages = [];
  const texts = kids(doc, 'interlinear-text').map((it, i, all) => {
    for (const l of kids(kid(it, 'languages'), 'language')) {
      if (l.attrs.lang) {
        languages.push({ lang: l.attrs.lang, vernacular: l.attrs.vernacular === 'true' });
      }
    }
    const label = all.length > 1 ? `${fileName} (text ${i + 1})` : fileName;
    return { guid: it.attrs.guid ?? null, ...readText(it, census, warnings, label) };
  });
  return { texts, languages, census, warnings };
}

// --- a set of files -----------------------------------------------------------

const stemOf = (name) => String(name ?? '').replace(/\.[^.]*$/, '') || 'Untitled';
const byCount = (m) => [...m.entries()].sort((a, b) => b[1] - a[1]).map(([lang]) => lang);

/**
 * Parse a set of .flextext files, [{name, xml}], into ONE IR in the shape
 * parseFwdata returns, so buildDocuments and the FLEx import engine take it
 * as they take a backup. It has no lexicon. On top of that shape:
 *   text.guid          the FLEx guid, or "<file>#<n>" for a text without one
 *                      (the key an interrupted import resumes by)
 *   text.fallbackName  the file's name, for a text with no title
 *   posWs              the writing system the categories are written in
 *   unread             [{label, count}]: what the files hold that is not read
 * A text found in two files (the same guid) is read once, from the first.
 */
export function parseFlextextFiles(files) {
  const census = makeCensus();
  const warnings = [];
  const declared = new Map(); // lang → vernacular?
  const texts = [];
  const seen = new Map(); // guid → file it was first read from
  const sorted = [...files].sort((a, b) =>
    a.name.localeCompare(b.name, undefined, { numeric: true }),
  );
  for (const file of sorted) {
    let parsed;
    try {
      parsed = parseFlextext(file.xml, file.name, census);
    } catch (e) {
      throw new Error(`${file.name}: ${e.message}`, { cause: e });
    }
    warnings.push(...parsed.warnings);
    for (const l of parsed.languages) {
      declared.set(l.lang, (declared.get(l.lang) ?? false) || l.vernacular);
    }
    parsed.texts.forEach((t, i) => {
      const fallbackName =
        parsed.texts.length > 1 ? `${stemOf(file.name)} ${i + 1}` : stemOf(file.name);
      if (t.guid) {
        if (seen.has(t.guid)) {
          const name = Object.values(t.names ?? {})[0] ?? fallbackName;
          warnings.push(`“${name}” is in both ${seen.get(t.guid)} and ${file.name}. Read once.`);
          return;
        }
        seen.set(t.guid, file.name);
      }
      let key = t.guid ?? `${file.name}#${i + 1}`;
      for (let n = 2; !t.guid && texts.some((x) => x.guid === key); n += 1) {
        key = `${file.name}#${i + 1} (${n})`;
      }
      texts.push({ ...t, guid: key, fallbackName });
    });
  }

  // The baseline is the writing system most words are written in, whatever
  // the files declare; the other vernacular ones words carry are orthographies.
  const { langs } = census;
  const baseline = byCount(langs.wordFirst)[0] ?? null;
  const anyVernacular = [...declared.values()].some(Boolean);
  const vernacular = [
    ...new Set([
      ...(baseline ? [baseline] : []),
      ...byCount(langs.wordForms).filter((l) => !anyVernacular || declared.get(l)),
      ...[...declared].filter(([, v]) => v).map(([l]) => l),
    ]),
  ];
  // Analysis writing systems, the most used first: the first is the one a
  // project's glosses are taken to be in when there is only one.
  const analysisUse = new Map();
  for (const kind of [
    'wordGloss',
    'morphGloss',
    'freeTranslation',
    'literalTranslation',
    'note',
    'pos',
  ]) {
    for (const [l, n] of langs[kind]) analysisUse.set(l, (analysisUse.get(l) ?? 0) + n);
  }
  const analysis = [
    ...new Set([
      ...byCount(analysisUse).filter((l) => !vernacular.includes(l)),
      ...[...declared].filter(([l, v]) => !v && !vernacular.includes(l)).map(([l]) => l),
    ]),
  ];
  const keys = (m) => [...m.keys()];

  return {
    version: null,
    writingSystems: { vernacular, analysis },
    wsUsage: {
      wordForms: keys(langs.wordForms),
      wordGloss: keys(langs.wordGloss),
      morphGloss: keys(langs.morphGloss),
      freeTranslation: keys(langs.freeTranslation),
      literalTranslation: keys(langs.literalTranslation),
      note: keys(langs.note),
      lexGloss: [],
      lexDefinition: [],
    },
    texts,
    lexicon: [],
    lexiconFields: [],
    customFields: [],
    posWs: byCount(langs.pos)[0] ?? null,
    unread: [...census.unread].map(([label, count]) => ({ label, count })),
    warnings,
  };
}
