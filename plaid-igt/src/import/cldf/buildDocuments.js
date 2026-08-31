// CLDF ExampleTable → importable document models. Pure.
//
// CLDF stores no character offsets: an example is a Primary_Text plus an
// ORDERED Analyzed_Word list, exactly the shape the FLEx importer already
// solves, so word offsets are re-derived by walking the baseline (../align.js).
// Two things make it harder than FLEx:
//
//  - An analyzed word carries morpheme joints that the primary text does not
//    ("perro=s" vs "perros"), so each form is tried verbatim FIRST (a real
//    hyphen in the surface, "well-known") and then with its joints removed.
//  - A dataset may have no usable Primary_Text at all, in which case the
//    baseline is synthesized by joining the analyzed words. That is a real
//    loss of the original spacing and punctuation, and it is reported.
//
// Morphemes need no alignment: a Plaid morpheme shares its word's full extent
// and carries `metadata.form`, so splitting the analyzed word is enough.
//
// morphType is inferred ONLY for clitics. Leipzig's "-" says a boundary exists
// but not what sits on either side ("un-break-able" gives no way to know
// "break" is the stem), so guessing would assert what the data does not say.
// "=" does mean clitic, and inferring just that inverts the exporter's joiner
// rule exactly, so a round trip reproduces the same joints.

import { utf16ToCp } from '@larc-iu/plaid-client';
import { matchesAt } from '../align.js';
import { cell, list, customColumnsOf } from './readDataset.js';

/** Leipzig morpheme joints. */
const JOINT_RE = /([-=])/;

/**
 * Split an analyzed word into morpheme pieces.
 * "perro=s" → [{form:'perro', before:null}, {form:'s', before:'='}]
 */
export function splitAnalyzed(word) {
  const parts = String(word ?? '').split(JOINT_RE);
  const pieces = [];
  let before = null;
  for (const part of parts) {
    if (part === '-' || part === '=') {
      before = part;
      continue;
    }
    pieces.push({ form: part, before });
    before = null;
  }
  return pieces.length ? pieces : [{ form: '', before: null }];
}

/**
 * The clitic type a joint implies, or null when it implies nothing.
 *
 * "=" says a clitic boundary is here, but NOT which side the clitic is on:
 * "perro=s" (host + enclitic) and "se=lo" (proclitic + host) are structurally
 * identical, so no rule can tell them apart. The piece after the "=" is taken
 * to be the clitic because enclitics are the commoner case, and because
 * marking one side keeps the joint a "=" on re-export (the exporter writes
 * "=" when EITHER side is a clitic). A wrong guess costs one morphType edit
 * and changes nothing in the display.
 */
const morphTypeOf = (pieces, i) => (pieces[i].before === '=' ? 'enclitic' : null);

/** The surface form of an analyzed word: its pieces with the joints removed. */
export const surfaceOf = (word) =>
  splitAnalyzed(word)
    .map((p) => p.form)
    .join('');

/**
 * Align an ordered list of word forms against body[begin, end).
 * Each form is tried verbatim before its joint-stripped surface, so a real
 * hyphen in the text wins over a morpheme boundary reading.
 * Returns {spans: [{beginU16, endU16} | null], warnings}.
 */
export function alignWords(body, begin, end, forms) {
  const spans = [];
  const warnings = [];
  let cursor = begin;
  for (const form of forms) {
    const candidates = [...new Set([form, surfaceOf(form)])].filter((c) => c !== '');
    if (!candidates.length) {
      spans.push(null);
      continue;
    }
    while (cursor < end && /\s/.test(body[cursor])) cursor += 1;
    let at = cursor;
    let matchEnd = false;
    for (const c of candidates) {
      matchEnd = matchesAt(body, at, c);
      if (matchEnd !== false) break;
    }
    if (matchEnd === false) {
      // Bounded forward search inside the sentence: punctuation, a dropped
      // word, or an analysis that does not match its own primary text.
      outer: for (let probe = cursor + 1; probe < end; probe += 1) {
        for (const c of candidates) {
          const m = matchesAt(body, probe, c);
          if (m !== false && m <= end) {
            at = probe;
            matchEnd = m;
            break outer;
          }
        }
      }
      if (matchEnd === false) {
        warnings.push(`could not align "${form}"`);
        spans.push(null);
        continue;
      }
    }
    spans.push({ beginU16: at, endU16: matchEnd });
    cursor = matchEnd;
  }
  return { spans, warnings };
}

// ---- options ----------------------------------------------------------------

// Columns our own exporter writes that are bookkeeping, not annotation.
const SKIP_COLUMNS = new Set(['Plaid_ID', 'Speaker']);
// Our exporter's custom-column prefixes, so a round trip lands back where it
// started rather than flattening everything to sentence scope.
const PREFIXES = [
  ['Sentence_', 'Sentence'],
  ['Word_', 'Word'],
  ['Morpheme_', 'Morpheme'],
  ['Orthography_', 'Orthography'],
];

const recognizePrefix = (name) => {
  for (const [prefix, scope] of PREFIXES) {
    if (name.startsWith(prefix) && name.length > prefix.length) {
      return { scope, name: name.slice(prefix.length) };
    }
  }
  return null;
};

/**
 * Heuristic import options for a dataset: whether the gloss is morpheme- or
 * word-scoped, and what to do with each custom column.
 *
 * Gloss scope is read from the data rather than guessed: morpheme scope only
 * when some row actually has a word whose form and gloss split into the same
 * number of pieces (LGR_Conformance says so too, when the dataset states it,
 * but many do not).
 */
export function deriveImportOptions(dataset) {
  const examples = dataset.components?.ExampleTable;
  let morphemeAligned = false;
  for (const row of examples?.rows || []) {
    if (cell(examples, row, 'lgrConformance') === 'MORPHEME_ALIGNED') {
      morphemeAligned = true;
      break;
    }
    const words = list(examples, row, 'analyzedWord');
    const glosses = list(examples, row, 'gloss');
    const hit = words.some((w, i) => {
      const wp = splitAnalyzed(w).length;
      return wp > 1 && wp === splitAnalyzed(glosses[i] ?? '').length;
    });
    if (hit) {
      morphemeAligned = true;
      break;
    }
  }

  const customColumns = {};
  for (const name of customColumnsOf(examples)) {
    if (SKIP_COLUMNS.has(name)) continue;
    const known = recognizePrefix(name);
    if (known) {
      customColumns[name] = known;
      continue;
    }
    // A column we do not recognize is off by default, at sentence scope: with
    // no prefix telling us otherwise, the whole row is the only extent we can
    // honestly claim it applies to.
    customColumns[name] = { scope: 'Sentence', name, enabled: false };
  }

  return {
    glossScope: morphemeAligned ? 'Morpheme' : 'Word',
    glossField: 'Gloss',
    translationField: 'Translation',
    commentField: 'Note',
    customColumns,
  };
}

/** The columns a dataset offers for mapping, with whether they can be per-word. */
export function customColumnChoices(dataset) {
  const examples = dataset.components?.ExampleTable;
  return customColumnsOf(examples)
    .filter((n) => !SKIP_COLUMNS.has(n))
    .map((name) => ({
      name,
      // Only a list column can align with Analyzed_Word.
      canBePerWord: !!examples.columns.find((c) => c.name === name)?.separator,
      suggested: recognizePrefix(name),
    }));
}

// ---- media -------------------------------------------------------------------

/**
 * The media file a contribution points at, resolved to bytes inside the same
 * archive. A MediaTable row may name the file either as a relative
 * Download_URL (a file sitting beside the dataset, which is what our own
 * exporter writes) or as Path_In_Zip. An absolute URL cannot be resolved
 * without going to the network, so it is reported rather than fetched.
 */
function resolveMedia(dataset, contributionId, warnings) {
  const table = dataset.components?.MediaTable;
  if (!table) return null;
  const row = (table.rows || []).find(
    (r) => cell(table, r, 'contributionReference') === contributionId,
  );
  if (!row) return null;
  const url = cell(table, row, 'downloadUrl');
  const inZip = cell(table, row, 'pathInZip');
  const name = cell(table, row, 'name') || 'media';
  if (url && /^[a-z][a-z0-9+.-]*:/i.test(url)) {
    warnings.push(`Media for "${name}" is a remote URL (${url}) and was not downloaded`);
    return null;
  }
  const path = inZip || url;
  if (!path) return null;
  const bytes = dataset.entries?.[`${dataset.baseDir}${path}`] ?? dataset.entries?.[path];
  if (!bytes) {
    warnings.push(`Media file "${path}" is not in the archive`);
    return null;
  }
  return { bytes, name: path.split('/').at(-1) };
}

// ---- the build ---------------------------------------------------------------

const asInt = (v) => {
  const n = Number.parseInt(v, 10);
  return Number.isFinite(n) ? n : null;
};

/**
 * @returns {{documents, languages, lexicon, schema, stats, warnings}}
 *   documents: [{id, name, metadata, body, sentences, words, warnings}]
 *   All begin/end are CODE POINTS in body space.
 */
export function buildCldfDocuments(dataset, options = {}) {
  const o = { ...deriveImportOptions(dataset), ...options };
  const examples = dataset.components?.ExampleTable;
  const contributions = dataset.components?.ContributionTable;
  const warnings = [];

  // Custom columns that survived the user's choices, split by scope.
  const custom = Object.entries(o.customColumns || {})
    .filter(([, m]) => m && m.enabled !== false)
    .map(([column, m]) => ({ column, ...m }));

  // --- languages ---
  const languageTable = dataset.components?.LanguageTable;
  const languageById = new Map();
  for (const row of languageTable?.rows || []) {
    languageById.set(cell(languageTable, row, 'id'), {
      name: cell(languageTable, row, 'name'),
      glottocode: cell(languageTable, row, 'glottocode'),
      iso639P3: cell(languageTable, row, 'iso639P3code'),
      latitude: cell(languageTable, row, 'latitude') || null,
      longitude: cell(languageTable, row, 'longitude') || null,
    });
  }

  // --- contributions (document identity) ---
  const contributionById = new Map();
  for (const row of contributions?.rows || []) {
    const meta = {};
    for (const [term, label] of [
      ['description', 'Description'],
      ['contributor', 'Contributor'],
      ['citation', 'Citation'],
    ]) {
      const v = cell(contributions, row, term);
      if (v) meta[label] = v;
    }
    // Columns the ContributionTable carries beyond the CLDF terms are document
    // metadata, which is exactly what our own exporter puts there.
    for (const name of customColumnsOf(contributions)) {
      if (name === 'Plaid_ID') continue;
      const v = row[name] ?? '';
      if (v) meta[name] = v;
    }
    contributionById.set(cell(contributions, row, 'id'), {
      name: cell(contributions, row, 'name'),
      metadata: meta,
    });
  }

  // --- group example rows into documents ---
  const groups = new Map();
  for (const row of examples?.rows || []) {
    const key = cell(examples, row, 'contributionReference') || '';
    if (!groups.has(key)) groups.set(key, []);
    groups.get(key).push(row);
  }
  if (!groups.size) groups.set('', []);

  const objectLanguageIds = new Set();
  const metaLanguageIds = new Set();
  const documents = [];
  let synthesizedBodies = 0;

  for (const [key, rows] of groups) {
    // Position orders a text's lines when the dataset states it; file order
    // otherwise (which is what a dataset without Position is asserting).
    const ordered = rows.every((r) => asInt(cell(examples, r, 'position')) !== null)
      ? [...rows].sort(
          (a, b) => asInt(cell(examples, a, 'position')) - asInt(cell(examples, b, 'position')),
        )
      : rows;

    const contribution = contributionById.get(key);
    const docWarnings = [];
    const texts = [];
    const parsed = [];

    for (const row of ordered) {
      const analyzed = list(examples, row, 'analyzedWord').filter((w) => w !== '');
      const primary = cell(examples, row, 'primaryText');
      // No primary text: synthesize one from the analyzed words. The original
      // spacing and punctuation are not recoverable, so say so.
      const synthesized = primary === '' && analyzed.length > 0;
      const text = synthesized ? analyzed.map(surfaceOf).join(' ') : primary;
      if (text === '') {
        docWarnings.push(`Example ${cell(examples, row, 'id') || '?'} has no text; skipped`);
        continue;
      }
      if (synthesized) synthesizedBodies += 1;
      const lang = cell(examples, row, 'languageReference');
      if (lang) objectLanguageIds.add(lang);
      const metaLang = cell(examples, row, 'metaLanguageReference');
      if (metaLang) metaLanguageIds.add(metaLang);
      texts.push(text);
      parsed.push({ row, analyzed, text });
    }
    if (!parsed.length) continue;

    const body = texts.join('\n');
    const sentences = [];
    const words = [];
    let offset = 0;

    parsed.forEach(({ row, analyzed, text }, si) => {
      const beginU16 = offset;
      // The sentence layer partitions the text, so each sentence absorbs its
      // trailing newline and the last one runs to the end of the body.
      const isLast = si === parsed.length - 1;
      const endU16 = isLast ? body.length : offset + text.length + 1;
      offset = endU16;

      const fields = {};
      const translated = cell(examples, row, 'translatedText');
      if (translated && o.translationField) fields[o.translationField] = translated;
      const comment = cell(examples, row, 'comment');
      if (comment && o.commentField) fields[o.commentField] = comment;
      for (const c of custom) {
        if (c.scope !== 'Sentence') continue;
        const v = (row[c.column] ?? '').trim();
        if (v) fields[c.name] = v;
      }
      sentences.push({
        begin: utf16ToCp(body, beginU16),
        end: utf16ToCp(body, endU16),
        fields,
      });

      const glosses = list(examples, row, 'gloss');
      const { spans, warnings: alignWarnings } = alignWords(
        body,
        beginU16,
        beginU16 + text.length,
        analyzed,
      );
      for (const w of alignWarnings) {
        docWarnings.push(`Example ${cell(examples, row, 'id') || si + 1}: ${w}`);
      }

      analyzed.forEach((word, wi) => {
        const span = spans[wi];
        if (!span) return;
        const pieces = splitAnalyzed(word);
        const glossPieces = splitAnalyzed(glosses[wi] ?? '');
        const aligned = o.glossScope === 'Morpheme' && glossPieces.length === pieces.length;
        const wordFields = {};
        const morphemeLists = new Map();

        for (const c of custom) {
          if (c.scope === 'Sentence') continue;
          const values = (row[c.column] ?? '').split('\t');
          const value = values[wi] ?? '';
          if (c.scope === 'Word' && value) wordFields[c.name] = value;
          if (c.scope === 'Morpheme') morphemeLists.set(c.name, splitAnalyzed(value));
          if (c.scope === 'Orthography' && value) {
            wordFields[`orthog:${c.name}`] = value;
          }
        }

        // A gloss the morphemes cannot absorb still has to land somewhere, so
        // it goes on the word (or the single morpheme in word-scope mode).
        const wholeGloss = glosses[wi] ?? '';
        if (o.glossScope === 'Word' || !aligned) {
          if (wholeGloss) wordFields[o.glossField] = wholeGloss;
          if (o.glossScope === 'Morpheme' && wholeGloss && pieces.length > 1) {
            docWarnings.push(
              `Example ${cell(examples, row, 'id') || si + 1}: gloss "${wholeGloss}" does not ` +
                `segment like "${word}"; kept on the word`,
            );
          }
        }

        words.push({
          begin: utf16ToCp(body, span.beginU16),
          end: utf16ToCp(body, span.endU16),
          sentenceIndex: si,
          fields: wordFields,
          morphemes: pieces.map((p, mi) => {
            const fields = {};
            if (aligned && o.glossScope === 'Morpheme') {
              const g = glossPieces[mi].form;
              if (g) fields[o.glossField] = g;
            }
            for (const [name, list_] of morphemeLists) {
              const v = list_[mi]?.form ?? '';
              if (v) fields[name] = v;
            }
            return { form: p.form, morphType: morphTypeOf(pieces, mi), fields };
          }),
        });
      });
    });

    const media = resolveMedia(dataset, key, docWarnings);
    documents.push({
      id: key || 'cldf',
      name: contribution?.name || dataset.title || 'Imported text',
      metadata: contribution?.metadata || {},
      body,
      sentences,
      words,
      mediaBytes: media?.bytes ?? null,
      mediaName: media?.name ?? null,
      warnings: docWarnings,
    });
  }

  // Documents with no ContributionTable name would all collide, so number them.
  if (documents.length > 1) {
    const counts = new Map();
    for (const d of documents) counts.set(d.name, (counts.get(d.name) ?? 0) + 1);
    const seen = new Map();
    for (const d of documents) {
      if (counts.get(d.name) === 1) continue;
      const n = (seen.get(d.name) ?? 0) + 1;
      seen.set(d.name, n);
      d.name = `${d.name} ${n}`;
    }
  }

  if (synthesizedBodies) {
    warnings.push(
      `${synthesizedBodies} example${synthesizedBodies === 1 ? '' : 's'} had no Primary_Text, so ` +
        'the baseline was rebuilt from the analyzed words. Original spacing and punctuation are ' +
        'not recoverable.',
    );
  }

  // --- lexicon (EntryTable + SenseTable) ---
  const entries = dataset.components?.EntryTable;
  const senses = dataset.components?.SenseTable;
  const sensesByEntry = new Map();
  for (const row of senses?.rows || []) {
    const key = cell(senses, row, 'entryReference');
    if (!sensesByEntry.has(key)) sensesByEntry.set(key, []);
    sensesByEntry.get(key).push(cell(senses, row, 'description'));
  }
  const lexicon = [];
  for (const row of entries?.rows || []) {
    const id = cell(entries, row, 'id');
    const form = cell(entries, row, 'headword');
    if (!form) continue;
    const metadata = {};
    const pos = cell(entries, row, 'partOfSpeech');
    if (pos) metadata.pos = pos;
    const glosses = sensesByEntry.get(id) || [];
    if (glosses.length) metadata.gloss = glosses[0];
    // A CLDF entry may have many senses; Plaid's vocab item has one gloss, so
    // the rest are kept as a definition rather than dropped.
    if (glosses.length > 1) metadata.definition = glosses.slice(1).join('; ');
    for (const name of customColumnsOf(entries)) {
      if (name === 'Plaid_ID' || name === 'Vocabulary') continue;
      const v = row[name] ?? '';
      if (!v) continue;
      metadata[name.startsWith('Entry_') ? name.slice('Entry_'.length) : name] = v;
    }
    lexicon.push({ id, form, metadata });
  }

  // --- schema for the setup wizard ---
  const fieldSet = new Map();
  const addField = (name, scope) => {
    if (name) fieldSet.set(`${scope}:${name}`, { name, scope });
  };
  if (documents.some((d) => d.sentences.some((s) => o.translationField in s.fields))) {
    addField(o.translationField, 'Sentence');
  }
  if (documents.some((d) => d.sentences.some((s) => o.commentField in s.fields))) {
    addField(o.commentField, 'Sentence');
  }
  const usesGloss = (scope) =>
    documents.some((d) =>
      d.words.some((w) =>
        scope === 'Word'
          ? o.glossField in w.fields
          : w.morphemes.some((m) => o.glossField in m.fields),
      ),
    );
  if (usesGloss('Word')) addField(o.glossField, 'Word');
  if (usesGloss('Morpheme')) addField(o.glossField, 'Morpheme');
  for (const c of custom) {
    if (c.scope === 'Orthography') continue;
    addField(c.name, c.scope);
  }
  const orthographies = custom.filter((c) => c.scope === 'Orthography').map((c) => c.name);
  const documentMetadata = [...new Set(documents.flatMap((d) => Object.keys(d.metadata)))].map(
    (name) => ({ name }),
  );

  // --- project language identity ---
  const pick = (ids) => (ids.size === 1 ? languageById.get([...ids][0]) : null);
  const languages = {
    object: pick(objectLanguageIds) || null,
    meta: pick(metaLanguageIds) || null,
  };
  if (objectLanguageIds.size > 1) {
    warnings.push(
      `This dataset covers ${objectLanguageIds.size} object languages. A Plaid project documents ` +
        'one, so no language identity was set. You can set it in Settings afterwards.',
    );
  }

  const stats = {
    documents: documents.length,
    sentences: documents.reduce((n, d) => n + d.sentences.length, 0),
    words: documents.reduce((n, d) => n + d.words.length, 0),
    morphemes: documents.reduce(
      (n, d) => n + d.words.reduce((m, w) => m + w.morphemes.length, 0),
      0,
    ),
    unalignedWords: documents.reduce(
      (n, d) => n + d.warnings.filter((w) => w.includes('could not align')).length,
      0,
    ),
    lexiconEntries: lexicon.length,
    warnings: warnings.length + documents.reduce((n, d) => n + d.warnings.length, 0),
  };

  return {
    documents,
    languages,
    lexicon,
    schema: { fields: [...fieldSet.values()], orthographies, documentMetadata },
    stats,
    warnings,
  };
}
