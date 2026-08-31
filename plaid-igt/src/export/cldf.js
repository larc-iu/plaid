// CLDF (Cross-Linguistic Data Formats, https://cldf.clld.org) serialization.
//
// A CLDF dataset is a set of CSV files plus a CSVW/JSON-LD descriptor
// (`cldf-metadata.json`) that binds columns to an ontology by `propertyUrl`.
// We emit a TextCorpus: `examples.csv` (ExampleTable) is the heart, with
// ContributionTable (one row per document), LanguageTable, optional
// EntryTable/SenseTable from the project's vocabularies, and an optional
// MediaTable. A module declares only its MINIMUM components, so carrying the
// extra ones is conformant.
//
// The mapping is deliberately narrow because CLDF is narrow. One sentence
// becomes one example row:
//
//   Primary_Text    the baseline slice (or a chosen orthography)
//   Analyzed_Word   one tab-separated item per word token, morpheme-segmented
//                   with -/= joints exactly as the interlinear view shows them
//   Gloss           the parallel list, joined from the SAME morpheme array so
//                   the two lines cannot drift out of alignment
//   Translated_Text one chosen sentence field
//
// CLDF has one Gloss slot and one Translated_Text slot, so everything else a
// project annotates is either carried as a custom column (a column with no
// propertyUrl, which conformant readers ignore and humans can still read) or
// dropped. `cldfLossSummary` reports which is which BEFORE the export runs, so
// the lossiness is a stated property rather than a discovery.
//
// Nothing here touches the DOM or the client: `buildCldfDataset` takes loaded
// documents and returns file contents.

import { morphFormOf, joinMorphemeTexts } from '../domain/igtExport.js';
import { readVocabFields } from '../domain/igtConfig.js';
import { phraseSpeakerFor } from './flextext.js';

const TERMS = 'http://cldf.clld.org/v1.0/terms.rdf#';
const term = (name) => `${TERMS}${name}`;

/** The baseline (rather than a named orthography) as a Primary_Text source. */
export const BASELINE = '__baseline__';

// ---- CSV (RFC 4180, the CSVW default dialect) ------------------------------

const csvCell = (v) => {
  const s = v === null || v === undefined ? '' : String(v);
  return /[",\r\n]/.test(s) ? `"${s.replace(/"/g, '""')}"` : s;
};
const csvRow = (cells) => cells.map(csvCell).join(',');

/** Header + rows as CRLF-delimited CSV. */
export const toCsv = (header, rows) => `${[csvRow(header), ...rows.map(csvRow)].join('\r\n')}\r\n`;

// A list cell's items are joined by a separator (tab for the aligned lists), so
// an item may never contain it. Collapse any whitespace that would corrupt the
// list into a single space.
const listItem = (v) => String(v ?? '').replace(/[\t\r\n]+/g, ' ');

// ---- identifiers -----------------------------------------------------------

// CLDF ids are constrained to [a-zA-Z0-9_\-]+ by every module's ID column.
const cldfId = (value, fallback) => {
  const cleaned = String(value ?? '')
    .normalize('NFKD')
    .replace(/[^a-zA-Z0-9_-]+/g, '-')
    .replace(/^-+|-+$/g, '');
  return cleaned || fallback;
};

/**
 * A language's dataset id: the most stable identifier it has. Two languages
 * that resolve to the same id are the same language (a monolingual dictionary
 * legitimately glosses in the object language), and collapse to one row.
 */
export const languageId = (lang, fallback) =>
  cldfId(lang?.glottocode || lang?.iso639P3 || lang?.name, fallback);

// ---- column model ----------------------------------------------------------
//
// One description per column drives BOTH the CSV header and the table's schema
// in cldf-metadata.json, so a column can never be written to one and missing
// from the other. `propertyUrl` absent = a custom column (Plaid data with no
// CLDF equivalent). `get(row)` pulls the value out of a prepared row object.

const col = (name, opts = {}) => ({ name, ...opts });

const columnSchema = (c) => {
  const out = { name: c.name };
  if (c.required) out.required = true;
  if (c.propertyUrl) out.propertyUrl = term(c.propertyUrl);
  if (c.description) out['dc:description'] = c.description;
  out.datatype = c.datatype || 'string';
  if (c.separator) {
    out.separator = c.separator;
    // A column's `null` defaults to "", so an empty item in a separated list
    // parses back as a missing value and breaks the alignment (pycldf's
    // Example.igt() raises on it). In an aligned list an empty item is a real,
    // present, empty slot — an unglossed word — so declare that no string in
    // these columns means null.
    out.null = [];
  }
  return out;
};

/**
 * Build one table: drop optional columns that are empty in every row (an
 * enabled-but-unused tier should not leave a dead column behind), then render
 * the CSV and the matching table schema.
 */
function buildTable({ url, conformsTo, columns, rows, foreignKeys = [] }) {
  const kept = columns.filter((c) => c.required || rows.some((r) => (r[c.name] ?? '') !== ''));
  const names = kept.map((c) => c.name);
  const keptNames = new Set(names);
  const schema = { columns: kept.map(columnSchema) };
  const fks = foreignKeys.filter((fk) => keptNames.has(fk.columnReference));
  if (fks.length) schema.foreignKeys = fks;
  const table = { url, tableSchema: schema };
  if (conformsTo) table['dc:conformsTo'] = term(conformsTo);
  return {
    file: {
      path: url,
      data: toCsv(
        names,
        rows.map((r) => names.map((n) => r[n] ?? '')),
      ),
    },
    table,
  };
}

const foreignKey = (columnReference, resource) => ({
  columnReference,
  reference: { resource, columnReference: 'ID' },
});

// ---- interlinear lines -----------------------------------------------------

/** A word token's morpheme-segmented surface form, falling back to the token. */
const analyzedWordOf = (token) => {
  const morphemes = token.morphemes || [];
  const joined = morphemes.length ? joinMorphemeTexts(morphemes, morphemes.map(morphFormOf)) : '';
  return listItem(joined || token.content || '');
};

/** The gloss aligned to that word, built from the same morpheme array. */
const glossOf = (token, field, scope) => {
  if (!field) return '';
  if (scope === 'morpheme') {
    const morphemes = token.morphemes || [];
    if (!morphemes.length) return '';
    return listItem(
      joinMorphemeTexts(
        morphemes,
        morphemes.map((m) => m.annotations?.[field]?.value ?? ''),
      ),
    );
  }
  return listItem(token.annotations?.[field]?.value ?? '');
};

/**
 * The row's Leipzig conformance, computed rather than asserted. Both lists are
 * built from the same token array, so they are always equal-length: that IS
 * word alignment. Morpheme alignment additionally needs every joint in the
 * word line to have a counterpart in the gloss line, which holds only when
 * every morpheme of every segmented word is glossed. A half-glossed sentence
 * claims neither.
 */
function lgrConformance(tokens, field, scope) {
  if (!tokens.length) return '';
  if (scope === 'morpheme' && field) {
    const segmented = tokens.filter((t) => (t.morphemes || []).length > 1);
    const allGlossed = segmented.every((t) =>
      (t.morphemes || []).every((m) => String(m.annotations?.[field]?.value ?? '').trim() !== ''),
    );
    if (segmented.length && allGlossed) return 'MORPHEME_ALIGNED';
  }
  return 'WORD_ALIGNED';
}

/**
 * The sentence's baseline text, gaps included, or a chosen orthography.
 *
 * Trimmed, because the sentence layer PARTITIONS the text: a sentence span
 * runs to the start of the next one, so it carries the newline that separates
 * them. That separator is not part of the sentence, and leaving it in puts a
 * trailing newline inside a CSV cell.
 */
function primaryTextOf(sentence, source) {
  const tokens = sentence.tokens || [];
  if (source && source !== BASELINE) {
    return tokens
      .map((t) => t.orthographies?.[source] ?? '')
      .filter((s) => s !== '')
      .join(' ')
      .trim();
  }
  const pieces = sentence.pieces || [];
  if (pieces.length)
    return pieces
      .map((p) => p.content ?? '')
      .join('')
      .trim();
  return tokens
    .map((t) => t.content ?? '')
    .join(' ')
    .trim();
}

// ---- options ---------------------------------------------------------------

export const DEFAULT_CLDF_OPTIONS = Object.freeze({
  glossField: null,
  glossScope: 'morpheme',
  translationField: null,
  commentField: null,
  primaryText: BASELINE,
  extras: { sentence: [], word: [], morpheme: [], orthographies: [] },
  speakers: true,
  dictionary: true,
  includeMedia: true,
});

const resolveOptions = (options) => ({
  ...DEFAULT_CLDF_OPTIONS,
  ...(options || {}),
  extras: { ...DEFAULT_CLDF_OPTIONS.extras, ...(options?.extras || {}) },
});

/**
 * Heuristic defaults, the same naming conventions the .flextext preset reads:
 * a morpheme field named like a gloss becomes Gloss, a sentence field named
 * like a translation becomes Translated_Text, one named like a note becomes
 * Comment. Everything else rides along as a custom column, which is the
 * choice that loses nothing until the user narrows it.
 */
export function defaultCldfOptions(layers) {
  const pick = (names, re) => (names || []).find((n) => re.test(n)) ?? null;
  const glossField =
    pick(layers?.morphFields, /gloss/i) ??
    (layers?.morphFields?.length ? layers.morphFields[0] : null);
  const glossScope = glossField ? 'morpheme' : 'word';
  const wordGloss = glossField ? null : pick(layers?.wordFields, /gloss/i);
  const translationField = pick(layers?.sentFields, /translat|free|gls/i);
  const commentField = pick(layers?.sentFields, /note|comment/i);
  const chosen = new Set([glossField, wordGloss, translationField, commentField]);
  return {
    ...DEFAULT_CLDF_OPTIONS,
    glossField: glossField ?? wordGloss,
    glossScope,
    translationField,
    commentField,
    primaryText: BASELINE,
    extras: {
      sentence: (layers?.sentFields || []).filter((n) => !chosen.has(n)),
      word: (layers?.wordFields || []).filter((n) => !chosen.has(n)),
      morpheme: (layers?.morphFields || []).filter((n) => !chosen.has(n)),
      orthographies: [...(layers?.orthographies || [])],
    },
  };
}

/**
 * What this preset does with each tier of the project: bound to a CLDF term,
 * carried as a custom column, or dropped. Rendered in the preset editor so the
 * loss is visible before the export runs.
 */
export function cldfLossSummary(layers, options) {
  const o = resolveOptions(options);
  const mapped = [];
  const custom = [];
  const dropped = [];
  const label = (name, kind) => `${name} (${kind})`;

  if (o.glossField) mapped.push(`${o.glossField} → Gloss`);
  if (o.translationField) mapped.push(`${o.translationField} → Translated_Text`);
  if (o.commentField) mapped.push(`${o.commentField} → Comment`);
  if (o.primaryText !== BASELINE) mapped.push(`${o.primaryText} → Primary_Text`);

  const bound = new Set([o.glossField, o.translationField, o.commentField]);
  const bucket = (names, kind, extras) => {
    for (const name of names || []) {
      if (bound.has(name)) continue;
      if (o.primaryText === name) continue;
      (extras.includes(name) ? custom : dropped).push(label(name, kind));
    }
  };
  bucket(layers?.sentFields, 'sentence', o.extras.sentence);
  bucket(layers?.wordFields, 'word', o.extras.word);
  bucket(layers?.morphFields, 'morpheme', o.extras.morpheme);
  bucket(layers?.orthographies, 'orthography', o.extras.orthographies);
  return { mapped, custom, dropped };
}

// ---- the dataset ------------------------------------------------------------

const metadataColumnName = (raw, used) => {
  const base =
    String(raw ?? '')
      .replace(/[\r\n",]+/g, ' ')
      .trim() || 'Field';
  let name = base;
  for (let n = 2; used.has(name); n++) name = `${base} (${n})`;
  used.add(name);
  return name;
};

/**
 * documents: [{ igtDoc, mediaFile, mediaType }] in export order.
 * vocabularies: [{ id, name, config, items }] (empty to skip the dictionary).
 * Returns { files: [{path, data}], warnings: [string] }.
 */
export function buildCldfDataset({
  project,
  languages,
  documents = [],
  vocabularies = [],
  options,
  exportedAt = null,
}) {
  const o = resolveOptions(options);
  const warnings = [];

  // --- languages ---
  const objId = languageId(languages?.object, 'object');
  const metaId = languageId(languages?.meta, 'meta');
  const hasMeta = !!(
    languages?.meta &&
    (languages.meta.name || languages.meta.glottocode || languages.meta.iso639P3)
  );
  const languageRows = [];
  const pushLanguage = (id, lang, fallbackName) => {
    languageRows.push({
      ID: id,
      Name: lang?.name || fallbackName,
      Glottocode: lang?.glottocode || '',
      ISO639P3code: lang?.iso639P3 || '',
      Latitude: lang?.latitude ?? '',
      Longitude: lang?.longitude ?? '',
    });
  };
  pushLanguage(objId, languages?.object, 'Unidentified object language');
  if (hasMeta && metaId !== objId) pushLanguage(metaId, languages?.meta, 'Meta language');
  if (!languages?.object?.glottocode && !languages?.object?.iso639P3) {
    warnings.push(
      'The object language has no Glottocode or ISO 639-3 code, so this dataset cannot be ' +
        'linked to other CLDF datasets. Set it under Settings → Languages.',
    );
  }
  // A translation with no stated meta language is a dangling claim, so say so.
  if (o.translationField && !hasMeta) {
    warnings.push(
      'No meta language is configured, so translations carry no Meta_Language_ID. ' +
        'Set it under Settings → Languages.',
    );
  }

  // --- contributions (one per document) + examples ---
  const contributionRows = [];
  const exampleRows = [];
  const mediaRows = [];
  const metadataNames = new Map();
  // Reserved because the ContributionTable always writes them.
  const usedMetadataColumns = new Set(['ID', 'Name', 'Plaid_ID']);
  // Document metadata the importer reads back off a CLDF term, so writing it
  // to that term's own column is what makes the round trip lossless. Renaming
  // "Description" out of the way instead turned it into "Description (2)".
  // Source stays untermed on purpose: CLDF's source is a list of BibTeX keys
  // resolved against sources.bib, and a Plaid metadata string is not that.
  const CONTRIBUTION_TERMS = {
    Description: 'description',
    Contributor: 'contributor',
    Citation: 'citation',
  };
  const termedMetadata = new Set();

  documents.forEach(({ igtDoc, mediaFile = null, mediaType = '' }, docIndex) => {
    const doc = igtDoc.document || {};
    const contributionId = String(docIndex + 1);
    const contribution = {
      ID: contributionId,
      Name: doc.name ?? '',
      Plaid_ID: doc.id ?? '',
    };
    for (const [key, value] of Object.entries(doc.metadata || {})) {
      if (value === null || value === undefined || value === '') continue;
      if (CONTRIBUTION_TERMS[key]) {
        termedMetadata.add(key);
        contribution[key] = String(value);
        continue;
      }
      if (!metadataNames.has(key)) {
        metadataNames.set(key, metadataColumnName(key, usedMetadataColumns));
      }
      contribution[metadataNames.get(key)] = String(value);
    }
    contributionRows.push(contribution);

    if (mediaFile) {
      mediaRows.push({
        ID: `m${docIndex + 1}`,
        Name: doc.name ?? '',
        Media_Type: mediaType || 'application/octet-stream',
        // The file rides in this same archive, so the URL is relative to the
        // metadata descriptor. Path_In_Zip is for a file inside a DIFFERENT
        // zip that Download_URL points at, which is not our situation.
        Download_URL: mediaFile,
        Contribution_ID: contributionId,
      });
    }

    const alignmentTokens = igtDoc.alignmentTokens || [];
    (igtDoc.sortedSentences || []).forEach((sentence, i) => {
      const tokens = sentence.tokens || [];
      const analyzed = tokens.map(analyzedWordOf);
      const glosses = tokens.map((t) => glossOf(t, o.glossField, o.glossScope));
      const translated = o.translationField
        ? (sentence.annotations?.[o.translationField]?.value ?? '')
        : '';
      const row = {
        ID: `${contributionId}-${i + 1}`,
        Language_ID: objId,
        Primary_Text: primaryTextOf(sentence, o.primaryText),
        Analyzed_Word: analyzed.join('\t'),
        Gloss: o.glossField ? glosses.join('\t') : '',
        Translated_Text: translated,
        Meta_Language_ID: hasMeta ? metaId : '',
        LGR_Conformance: lgrConformance(tokens, o.glossField, o.glossScope),
        Comment: o.commentField ? (sentence.annotations?.[o.commentField]?.value ?? '') : '',
        Contribution_ID: contributionId,
        Position: String(i + 1),
        Plaid_ID: sentence.id ?? '',
      };
      if (o.speakers) row.Speaker = phraseSpeakerFor(sentence, alignmentTokens) || '';
      for (const name of o.extras.sentence) {
        row[`Sentence_${name}`] = sentence.annotations?.[name]?.value ?? '';
      }
      for (const name of o.extras.word) {
        row[`Word_${name}`] = tokens
          .map((t) => listItem(t.annotations?.[name]?.value ?? ''))
          .join('\t');
      }
      for (const name of o.extras.morpheme) {
        row[`Morpheme_${name}`] = tokens
          .map((t) => {
            const morphemes = t.morphemes || [];
            return morphemes.length
              ? listItem(
                  joinMorphemeTexts(
                    morphemes,
                    morphemes.map((m) => m.annotations?.[name]?.value ?? ''),
                  ),
                )
              : '';
          })
          .join('\t');
      }
      for (const name of o.extras.orthographies) {
        row[`Orthography_${name}`] = tokens
          .map((t) => listItem(t.orthographies?.[name] ?? ''))
          .join('\t');
      }
      exampleRows.push(row);
    });
  });

  // --- dictionary (entries + senses) ---
  const entryRows = [];
  const senseRows = [];
  const extraVocabColumns = new Map();
  if (o.dictionary) {
    const reserved = new Set(['gloss', 'definition', 'pos']);
    let entryN = 0;
    let senseN = 0;
    for (const vocab of vocabularies) {
      const fields = Object.keys(readVocabFields(vocab.config) || {});
      for (const item of vocab.items || []) {
        entryN += 1;
        const entryId = `e${entryN}`;
        const meta = item.metadata || {};
        const entry = {
          ID: entryId,
          Language_ID: objId,
          Headword: item.form ?? '',
          Part_Of_Speech: meta.pos ?? '',
          Vocabulary: vocab.name ?? '',
          Plaid_ID: item.id ?? '',
        };
        for (const field of fields) {
          if (reserved.has(field.toLowerCase())) continue;
          const value = meta[field];
          if (value === null || value === undefined || value === '') continue;
          const name = `Entry_${field}`;
          extraVocabColumns.set(name, field);
          entry[name] = String(value);
        }
        entryRows.push(entry);

        // SenseTable.Description is required, so an item with nothing to say
        // gets an entry and no sense rather than an empty required cell.
        const description = meta.gloss || meta.definition || '';
        if (description === '') continue;
        senseN += 1;
        senseRows.push({
          ID: `s${senseN}`,
          Entry_ID: entryId,
          Description: String(description),
          Definition: meta.gloss && meta.definition ? String(meta.definition) : '',
        });
      }
    }
    const entriesWithoutSense = entryRows.length - senseRows.length;
    if (entriesWithoutSense > 0) {
      warnings.push(
        `${entriesWithoutSense} lexicon ${
          entriesWithoutSense === 1 ? 'entry has' : 'entries have'
        } no gloss or definition, so ${
          entriesWithoutSense === 1 ? 'it has' : 'they have'
        } no sense row.`,
      );
    }
  }

  // --- tables ---
  const built = [];
  const add = (spec) => {
    if (!spec.rows.length) return;
    built.push(buildTable(spec));
  };

  add({
    url: 'languages.csv',
    conformsTo: 'LanguageTable',
    rows: languageRows,
    columns: [
      col('ID', { required: true, propertyUrl: 'id' }),
      col('Name', { propertyUrl: 'name' }),
      col('Glottocode', { propertyUrl: 'glottocode' }),
      col('ISO639P3code', { propertyUrl: 'iso639P3code' }),
      col('Latitude', { propertyUrl: 'latitude', datatype: 'decimal' }),
      col('Longitude', { propertyUrl: 'longitude', datatype: 'decimal' }),
    ],
  });

  add({
    url: 'contributions.csv',
    conformsTo: 'ContributionTable',
    rows: contributionRows,
    columns: [
      col('ID', { required: true, propertyUrl: 'id' }),
      col('Name', { propertyUrl: 'name' }),
      col('Plaid_ID', { description: 'The document id in the originating Plaid project.' }),
      ...[...termedMetadata].map((key) => col(key, { propertyUrl: CONTRIBUTION_TERMS[key] })),
      ...[...metadataNames.values()].map((name) =>
        col(name, { description: 'Document metadata from the originating Plaid project.' }),
      ),
    ],
  });

  add({
    url: 'examples.csv',
    conformsTo: 'ExampleTable',
    rows: exampleRows,
    foreignKeys: [
      foreignKey('Language_ID', 'languages.csv'),
      foreignKey('Meta_Language_ID', 'languages.csv'),
      foreignKey('Contribution_ID', 'contributions.csv'),
    ],
    columns: [
      col('ID', { required: true, propertyUrl: 'id' }),
      col('Language_ID', { required: true, propertyUrl: 'languageReference' }),
      col('Primary_Text', { required: true, propertyUrl: 'primaryText' }),
      col('Analyzed_Word', { propertyUrl: 'analyzedWord', separator: '\t' }),
      col('Gloss', { propertyUrl: 'gloss', separator: '\t' }),
      col('Translated_Text', { propertyUrl: 'translatedText' }),
      col('Meta_Language_ID', { propertyUrl: 'metaLanguageReference' }),
      col('LGR_Conformance', { propertyUrl: 'lgrConformance' }),
      col('Comment', { propertyUrl: 'comment' }),
      col('Contribution_ID', { propertyUrl: 'contributionReference' }),
      col('Position', { propertyUrl: 'position', datatype: 'integer' }),
      col('Plaid_ID', { description: 'The sentence token id in the originating Plaid project.' }),
      col('Speaker', { description: 'Speaker of this sentence, from the time-alignment layer.' }),
      ...o.extras.sentence.map((n) =>
        col(`Sentence_${n}`, { description: `Sentence-scoped "${n}" annotation.` }),
      ),
      ...o.extras.word.map((n) =>
        col(`Word_${n}`, {
          description: `Word-scoped "${n}" annotation, aligned with Analyzed_Word.`,
          separator: '\t',
        }),
      ),
      ...o.extras.morpheme.map((n) =>
        col(`Morpheme_${n}`, {
          description: `Morpheme-scoped "${n}" annotation, aligned with Analyzed_Word.`,
          separator: '\t',
        }),
      ),
      ...o.extras.orthographies.map((n) =>
        col(`Orthography_${n}`, {
          description: `The "${n}" orthography, aligned with Analyzed_Word.`,
          separator: '\t',
        }),
      ),
    ],
  });

  add({
    url: 'entries.csv',
    conformsTo: 'EntryTable',
    rows: entryRows,
    foreignKeys: [foreignKey('Language_ID', 'languages.csv')],
    columns: [
      col('ID', { required: true, propertyUrl: 'id' }),
      col('Language_ID', { required: true, propertyUrl: 'languageReference' }),
      col('Headword', { required: true, propertyUrl: 'headword' }),
      col('Part_Of_Speech', { propertyUrl: 'partOfSpeech' }),
      col('Vocabulary', { description: 'The Plaid vocabulary layer this entry came from.' }),
      col('Plaid_ID', { description: 'The vocabulary item id in the originating Plaid project.' }),
      ...[...extraVocabColumns.entries()].map(([name, field]) =>
        col(name, { description: `Lexicon field "${field}" from the originating Plaid project.` }),
      ),
    ],
  });

  add({
    url: 'senses.csv',
    conformsTo: 'SenseTable',
    rows: senseRows,
    foreignKeys: [foreignKey('Entry_ID', 'entries.csv')],
    columns: [
      col('ID', { required: true, propertyUrl: 'id' }),
      col('Entry_ID', { required: true, propertyUrl: 'entryReference' }),
      col('Description', { required: true, propertyUrl: 'description' }),
      col('Definition', { description: 'A longer definition, when the sense also has a gloss.' }),
    ],
  });

  add({
    url: 'media.csv',
    conformsTo: 'MediaTable',
    rows: mediaRows,
    foreignKeys: [foreignKey('Contribution_ID', 'contributions.csv')],
    columns: [
      col('ID', { required: true, propertyUrl: 'id' }),
      col('Name', { propertyUrl: 'name' }),
      col('Media_Type', { required: true, propertyUrl: 'mediaType' }),
      col('Download_URL', { propertyUrl: 'downloadUrl', datatype: 'anyURI' }),
      col('Contribution_ID', { propertyUrl: 'contributionReference' }),
    ],
  });

  const metadata = {
    '@context': ['http://www.w3.org/ns/csvw', { '@language': 'en' }],
    'dc:conformsTo': term('TextCorpus'),
    'dc:title': project?.name || 'Plaid export',
    'dc:description':
      'Interlinear glossed text exported from Plaid. Columns without a propertyUrl carry ' +
      'project-specific annotation that has no CLDF equivalent.',
    ...(exportedAt ? { 'dc:created': exportedAt } : {}),
    dialect: { commentPrefix: null },
    tables: built.map((b) => b.table),
  };

  return {
    files: [
      { path: 'cldf-metadata.json', data: `${JSON.stringify(metadata, null, 2)}\n` },
      ...built.map((b) => b.file),
    ],
    warnings,
  };
}
