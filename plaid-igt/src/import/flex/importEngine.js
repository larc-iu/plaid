// FLEx import engine — turns buildDocuments() output into plaid API writes.
//
// Layer/vocab CREATION is the setup wizard's job (the import flow pre-fills
// the wizard from deriveImportConfig and runs the normal setup). This engine
// runs AFTER setup against the resolved project: it imports the lexicon into
// the project vocabulary, then each document (text, sentence partition, word
// tokens with orthographies, morpheme tokens, annotation spans, vocab links).
//
// Resumability: a document is only marked done (metadata.flexImported) after
// every write for it succeeded. On resume, done documents are skipped and
// half-imported ones are deleted and redone. Lexicon items are deduped by
// their FLEx sense guid (metadata.flexSense).

import { stampInferred, confirmedInferred, metadataOps, entryForm } from '@larc-iu/plaid-client';
import {
  ImportCancelled,
  importStamp,
  priorImports,
  writeVocabConfig,
  settlePrior,
} from '../resume.js';
import { CHUNK, bulkInChunks, withMintedIds } from '../../domain/bulk.js';
import { ENTRY_ROLES, isReservedFieldName } from '../../domain/vocabFields.js';
import { documentProgress } from '../progress.js';
import {
  IGT_NAMESPACE,
  SENTENCE_ROLES,
  orthographyKey,
  readVocabFields,
} from '../../domain/igtConfig.js';
import { withLangSuffix } from '../../domain/fieldNames.js';
import { recordProjectLanguages } from '../projectLanguages.js';
import {
  createDocumentShell,
  finishDocument,
  resolveIgtTargets,
  writeAlignments,
  writeDocumentLayers,
} from '../project.js';
import { createEntriesOnce, itemsBySourceKey, mergeFieldSchema, placeSenses } from '../lexicon.js';
import { FIELD_SCOPES, FIELD_TYPES } from '../../domain/vocabFields.js';
import { pickEn } from './fwdataParser.js';

// Everything a word carries comes out of ONE WfiAnalysis: its gloss, its
// category, and the morph bundles the segmentation is built from. FLEx records
// whether a person approved that analysis or whether only its parser proposed
// it (agent evaluations, see isHumanApproved in fwdataParser). An unapproved
// one is machine work nobody has checked, and imports as exactly that: violet
// in the grid, reachable by the review sweep, settled by editing or confirming
// it. An approved one is a person's work and carries no stamp, like anything
// typed by hand.
//
// Span-level stamping was left out of the 2026-06-11 import round because the
// island had no confirm-on-touch for spans and a stamp would have gone stale on
// the first human edit. `mutations/spans.js` merges `doc.editStamp` into every
// span edit now, so that reason is gone.
//
// Sentence-scope values (free and literal translations, notes) hang off the
// SEGMENT rather than an analysis and have no approval to read, so they are
// never stamped. Neither is the lone default morpheme given to a word FLEx
// never analyzed: there is no analysis behind it to be unapproved.
//
// The source names the FLEx agent that proposed it where FLEx says which
// ("flex-import:M3Parser"), which is the app-specific id shape the provenance
// convention already documents. Several agents join with "+", sorted, so the
// same project always yields the same string.
const flexSource = (word) => {
  const agents = word?.machineAgents ?? [];
  return agents.length ? `flex-import:${agents.join('+')}` : 'flex-import';
};

// Only where FLEx POSITIVELY says a machine produced it, which means a
// non-human agent approved the analysis. An analysis FLEx records no opinion
// on at all is not evidence of a machine: `inferred` means "a machine wrote
// this", and claiming it without a parser behind it would assert more than the
// source says. Across the sample backups every analysis attached to a text is
// either human-approved or unevaluated, so this is rare in practice; FLEx's
// parser proposes into the wordform inventory and a person attaches one.
const unapprovedStamp = (word) =>
  word && word.approved === false && word.morphemes && word.machineAgents?.length
    ? stampInferred(flexSource(word))
    : null;

/**
 * senseGuid -> the morph type the entry gives it, mirroring the way `entryMeta`
 * stamps `morphType` on every item an entry becomes. Keyed by each sense's guid
 * AND by the entry's own, since a one-sense entry is linked by either.
 *
 * A morpheme linked to a typed entry goes by the entry's type and stores none
 * of its own (derive.js `effectiveMorphType`).
 */
const senseMorphTypes = (lexicon) => {
  const out = new Map();
  for (const entry of lexicon || []) {
    const type = entry?.morphType;
    if (type == null || type === '') continue;
    if (entry.guid) out.set(entry.guid, type);
    for (const sense of entry.senses || []) if (sense?.guid) out.set(sense.guid, type);
  }
  return out;
};

/**
 * A lexicon key for an analysis writing system: the primary ws keeps the bare
 * built-in key (`gloss`), whose language the vocab's field schema records, and
 * every other one carries its tag (`gloss (ru)`). Annotation fields are named
 * by their own rule in deriveImportConfig.
 */
const entryKey = (base, ws, primaryWs) => (ws === primaryWs ? base : withLangSuffix(base, ws));

/**
 * Derive the wizard pre-fill from a parse: orthographies, annotation fields
 * (one per analysis ws that actually occurs), document metadata fields, and
 * the field→(scope, ws) mapping the engine later imports values through.
 *
 * opts.analysisWss — restrict annotation fields (and lexicon glosses /
 * definitions) to these analysis writing systems (default: every ws that
 * occurs in the data).
 * opts.lexiconFields — names of the other FLEx lexicon fields (Comment,
 * GeneralNote, …; see ir.lexiconFields) to import as vocab item fields
 * (default: none).
 * opts.posWs — which of ir.posWss the parts of speech are read in (default:
 * the one the file names its own categories in).
 */
// FLEx pins each custom field to one writing system in <CustomField
// wsSelector>: -1 analysis, -2 vernacular, and the plural -3..-6 forms of the
// same two. A value itself arrives as a bare string, so the field's writing
// system is the only record of what language it is in, and the LIFT export
// needs it to tag the <form> correctly. Lexicon classes only.
const VERNACULAR_SELECTORS = new Set(['-2', '-4', '-6']);

function customFieldWritingSystems(ir, baselineWs, primaryAnalysisWs) {
  const out = {};
  for (const f of ir?.customFields ?? []) {
    if (f?.class !== 'LexEntry' && f?.class !== 'LexSense') continue;
    if (!f?.name) continue;
    out[f.name] = VERNACULAR_SELECTORS.has(String(f.wsSelector)) ? baselineWs : primaryAnalysisWs;
  }
  return out;
}

export function deriveImportConfig(ir, build, opts = {}) {
  const wsAllowed = opts.analysisWss ? new Set(opts.analysisWss) : null;
  // The first analysis writing system the person KEPT. Reading the file's own
  // first one whatever they ticked gave the bare `gloss` key to a language
  // the import was leaving out: every entry's built-in gloss came back empty,
  // the kept glosses went to a field declared not to show, and the project
  // recorded the dropped language as its own.
  const analysisWss = ir.writingSystems.analysis;
  const primaryAnalysisWs =
    analysisWss.find((ws) => !wsAllowed || wsAllowed.has(ws)) ?? analysisWss[0] ?? 'en';
  const perWs = [];
  const addField = (kind, scope, base, wss) => {
    for (const ws of wss) {
      if (wsAllowed && !wsAllowed.has(ws)) continue;
      perWs.push({ kind, scope, ws, base });
    }
  };
  // A part of speech is read as the category's English abbreviation when it
  // has one (pickEn), else its first form, so that is the language the POS
  // fields are in. It is recorded because it is NOT the primary analysis
  // language in general: the first real user glosses in Papuan Malay and names
  // her categories in English only, and FLEx matches an imported `pos` against
  // its categories in the writing system the file claims, creating a new
  // category when nothing matches.
  // A file says which writing systems it names its categories in (`posWss`,
  // most used first) and which of them it reads as its own (`posWs`). The two
  // are the same category, so exactly one is read, and `opts.posWs` is the
  // review screen's answer to which.
  const posWss = ir.posWss ?? (ir.posWs ? [ir.posWs] : []);
  const posWs =
    (opts.posWs && posWss.includes(opts.posWs) ? opts.posWs : null) ??
    ir.posWs ??
    (analysisWss.includes('en') && (!wsAllowed || wsAllowed.has('en')) ? 'en' : primaryAnalysisWs);
  addField('wordGloss', 'Word', 'Gloss', ir.wsUsage.wordGloss);
  if (build.documents.some((d) => d.words.some((w) => w.pos?.[posWs]))) {
    perWs.push({ kind: 'wordPos', scope: 'Word', ws: posWs, name: 'POS' });
  }
  addField('morphGloss', 'Morpheme', 'Gloss', ir.wsUsage.morphGloss);
  if (build.documents.some((d) => d.words.some((w) => w.morphemes?.some((m) => m.pos?.[posWs])))) {
    perWs.push({ kind: 'morphPos', scope: 'Morpheme', ws: posWs, name: 'POS' });
  }
  addField('freeTranslation', 'Sentence', 'Translation', ir.wsUsage.freeTranslation);
  addField('literalTranslation', 'Sentence', 'Literal Translation', ir.wsUsage.literalTranslation);
  addField('note', 'Sentence', 'Note', ir.wsUsage.note);
  // Every field carries its tag once the import makes fields in more than one
  // language ("Gloss (pmy)" beside "Gloss (en)"), and none when there is only
  // one. None of them is the default: each records its own language
  // (config.igt.lang), and a bare name among tagged ones left the reader to
  // guess which it was. Which analysis writing system FLEx happens to list
  // first means nothing to a person reading the fields. The CLDF importer
  // names its translations by the same rule.
  const languages = new Set(perWs.filter((f) => f.base).map((f) => f.ws));
  // Each gloss field pairs with the lexicon's gloss in its language, the key
  // the lexicon import writes it under, and each POS field with `pos`.
  const lexiconFieldOf = ({ kind, ws }) =>
    kind === 'wordGloss' || kind === 'morphGloss'
      ? entryKey('gloss', ws, primaryAnalysisWs)
      : kind === 'wordPos' || kind === 'morphPos'
        ? 'pos'
        : null;
  // Each sentence field's role is the FLEx item it holds.
  const sentenceRoleOf = ({ kind }) =>
    ({
      freeTranslation: SENTENCE_ROLES.TRANSLATION,
      literalTranslation: SENTENCE_ROLES.LITERAL_TRANSLATION,
      note: SENTENCE_ROLES.NOTE,
    })[kind] ?? null;
  const fields = perWs.map(({ base, ...f }) => ({
    ...(base ? { ...f, name: languages.size > 1 ? withLangSuffix(base, f.ws) : base } : f),
    lexiconField: lexiconFieldOf(f),
    ...(f.scope === 'Sentence' ? { sentenceRole: sentenceRoleOf(f) } : {}),
  }));

  // Alternate text titles (e.g. the English names of vernacular-titled texts)
  // and the abbreviations. A document field records no language of its own,
  // so its name is the only place to say which one it is in, and each is
  // tagged even where there is only one: a bare "Abbreviation" would go back
  // to FLEx under whatever tag the export uses for glosses.
  const titleWss = new Set();
  const abbrWss = new Set();
  for (const d of build.documents) {
    for (const ws of Object.keys(d.names)) {
      if (d.names[ws] !== d.name) titleWss.add(ws);
    }
    for (const [ws] of abbreviationsOf(d)) abbrWss.add(ws);
  }
  // Every text carries these three itself, so they are offered whether or not
  // this import fills them. Everything else is declared only where a text has
  // it: an empty "Abbreviation (nl)" beside a filled "Abbreviation (en)" reads
  // as a mistake, and the notebook fields exist only for a text given a record.
  const filled = new Set(build.documents.flatMap((d) => Object.keys(documentMetadataOf(d))));
  const documentMetadata = [
    ...[...titleWss].map((ws) => ({ name: withLangSuffix('Title', ws) })),
    ...[...abbrWss].map((ws) => ({ name: withLangSuffix('Abbreviation', ws) })),
    { name: 'Source' },
    { name: 'Description' },
    { name: 'Genre' },
    ...NOTEBOOK_FIELDS.filter((name) => filled.has(name)).map((name) => ({ name })),
  ];

  return {
    // {ws, name}: ws is the FLEx writing-system tag, name the (renamable)
    // plaid orthography name shown in the UI.
    orthographies: build.orthographyWss.map((ws) => ({ ws, name: ws })),
    customFieldWs: customFieldWritingSystems(ir, build.baselineWs, primaryAnalysisWs),
    fields,
    documentMetadata,
    primaryAnalysisWs,
    posWs,
    analysisWss: opts.analysisWss ?? null,
    lexiconFields: opts.lexiconFields ?? [],
    baselineWs: build.baselineWs,
  };
}

/**
 * Resolve engine write targets from a set-up project. Throws when a layer or
 * field the import needs is missing (setup incomplete).
 */
export function resolveTargets(project, config) {
  const targets = resolveIgtTargets(project, config.fields);
  // The engine writes a field's spans by the config row it came from, since
  // two rows can name one field at two scopes.
  const fieldLayers = new Map();
  for (const f of config.fields) {
    fieldLayers.set(f, targets.spanLayerByScopeName.get(`${f.scope}:${f.name}`));
  }
  return { ...targets, fieldLayers };
}

// Item metadata keys that are bookkeeping or structured data are never a
// field in the vocab's schema: the reserved keys, matched the way the field
// editor refuses them (see isReservedFieldName).

/**
 * Import the lexicon as vocab items, one per FLEx sense (multi-sense entries
 * produce several same-form items; the auto-linker already treats ambiguous
 * forms conservatively). Returns Map<senseGuid, vocabItemId>.
 *
 * Multilingual values (gloss, definition, the opt-in `lexiconFields`) are
 * written per analysis writing system (see entryKey): the primary ws under the
 * bare key (`gloss`), the others suffixed (`gloss (ru)`). `analysisWss`
 * (null = all) limits which are kept.
 *
 * Resume-safe: items already in the vocab with a matching metadata.flexSense
 * are reused, not duplicated.
 */
export async function importLexicon({
  client,
  vocabId,
  lexicon,
  baselineWs,
  primaryAnalysisWs = 'en',
  posWs = 'en',
  analysisWss = null,
  lexiconFields = [],
  customFieldWs = {},
  variants = false,
  resume = false,
  onProgress,
  shouldStop,
}) {
  const existing = await client.vocabLayers.get(vocabId, true);
  const senseToItem = itemsBySourceKey(existing.items, 'flexSense');

  const wsOk = analysisWss ? new Set(analysisWss) : null;
  // What this import knows of each key it writes, for the field schema: the
  // writing system of a per-language key, and the role of a gloss or a
  // definition. Never read back from the key's name.
  const keyLang = new Map();
  const perWs = (base, m) => {
    const out = {};
    for (const [ws, text] of Object.entries(m ?? {})) {
      if (wsOk && !wsOk.has(ws)) continue;
      const key = entryKey(base, ws, primaryAnalysisWs);
      out[key] = text;
      keyLang.set(key, ws);
    }
    return out;
  };
  const keyRole = new Map([
    ['gloss', ENTRY_ROLES.GLOSS],
    ['definition', ENTRY_ROLES.DEFINITION],
    ['pos', ENTRY_ROLES.POS],
  ]);
  const senseText = (base, m) => {
    const out = perWs(base, m);
    for (const key of Object.keys(out)) keyRole.set(key, base);
    return out;
  };
  const wanted = new Set(lexiconFields);
  const extras = (extra) => {
    const out = {};
    for (const [name, m] of Object.entries(extra ?? {})) {
      if (wanted.has(name)) Object.assign(out, perWs(name, m));
    }
    return out;
  };

  const pending = [];
  // Every metadata key written, in first-seen order, for the field schema.
  // The settled core fields come first even when no item fills them.
  const fieldKeys = new Set(['gloss', 'pos', 'definition', 'morphType', 'lexemeForm']);
  const note = (metadata) => {
    for (const k of Object.keys(metadata)) if (!isReservedFieldName(k)) fieldKeys.add(k);
  };
  const pickWs = (m) => (m == null ? null : (m[baselineWs] ?? pickEn(m)));
  for (const entry of lexicon) {
    // The item form is the entry's CITATION form (the dictionary headword)
    // when one exists, else the lexeme form; when they differ, the lexeme
    // form is kept as metadata.
    const lexemeForm = pickWs(entry.forms);
    // Stored without affix or clitic markers, FLEx's type kept (R38).
    const { form, morphType } = entryForm(
      entry.morphType ?? null,
      pickWs(entry.citationForm) ?? lexemeForm,
    );
    if (!form) continue;
    // FLEx custom-field values (entry-level + sense-level) become item
    // metadata under the custom field's own name; so do the opt-in extra
    // fields, entry-level ones on every sense of the entry. A sense-level
    // value wins over an entry-level one under the same name.
    const entryMeta = (sense) => ({
      ...(morphType != null && { morphType }),
      ...(entry.homograph ? { homograph: entry.homograph } : {}),
      ...(lexemeForm != null && lexemeForm !== form && { lexemeForm }),
      ...(entry.custom ?? {}),
      ...(sense?.custom ?? {}),
      ...extras(entry.extra),
      ...extras(sense?.extra),
      flexEntry: entry.guid,
      flexSense: sense?.guid ?? entry.guid,
    });
    // An entry with more than one sense is a CONTAINER (its form and
    // entry-level fields, no gloss) with every FLEx sense under it, numbered
    // as FLEx numbered them. With one sense, the sense is the entry.
    const container = entry.senses.length > 1;
    if (container) {
      const metadata = entryMeta(null);
      note(metadata);
      pending.push({ key: entry.guid, form, metadata });
    }
    for (const sense of entry.senses) {
      const examples = (sense.examples ?? [])
        .map((ex) => ({
          text: pickWs(ex.text),
          ...(pickEn(ex.translations?.[0]) != null && { translation: pickEn(ex.translations[0]) }),
        }))
        .filter((ex) => ex.text);
      const metadata = {
        // gloss first: the editor popover's no-config fallback shows the
        // first metadata value.
        ...senseText('gloss', sense.gloss),
        ...senseText('definition', sense.definition),
        // One category, named in each analysis writing system: the entry
        // takes it in the one the import reads, as the words do.
        ...(sense.pos?.[posWs] != null && { pos: sense.pos[posWs] }),
        ...(examples.length ? { examples } : {}),
        ...entryMeta(sense),
      };
      note(metadata);
      pending.push({ key: sense.guid, form, metadata });
    }
    // Entries with no senses still become one item (form-only).
    if (entry.senses.length === 0) {
      const metadata = entryMeta(null);
      note(metadata);
      pending.push({ key: entry.guid, form, metadata });
    }
  }

  // Declare the vocab's field schema so gloss/POS render inline in the editor
  // popover and as table columns (idempotent; cheap relative to the import).
  // A vocab that already has a schema (an existing lexicon being extended)
  // keeps its fields, order and inline flags; keys new to it are appended.
  // A gloss or definition keeps the bare name for the PRIMARY analysis writing
  // system and carries the tag in the name for every other one ("gloss (ru)"),
  // so the bare key's language is known here and nowhere else. Record it, or
  // the LIFT export has to fall back to the preset's analysis tag and a lexicon
  // glossed in one non-English language goes out mislabelled.
  const BARE_PRIMARY = new Set(['gloss', 'definition']);
  await mergeFieldSchema({
    client,
    vocabId,
    existing,
    keys: fieldKeys,
    // `lang` records the writing system of every per-language key this
    // import writes ("gloss (ru)" is in ru), and `role` what a gloss, a
    // definition or the part of speech is, whatever the key is called.
    declare: (n) => {
      const role = keyRole.get(n);
      const lang = keyLang.get(n) ?? customFieldWs[n];
      return {
        inline: n === 'gloss' || n === 'pos',
        ...(lang ? { lang } : {}),
        ...(BARE_PRIMARY.has(n) ? { lang: primaryAnalysisWs } : {}),
        ...(role ? { role } : {}),
      };
    },
    // The wizard seeds every new vocabulary with gloss and definition before
    // the import runs, so for a FLEx import "already declared" is the usual
    // case, not the exception, and the language went unrecorded on every
    // lexicon a wizard made. A field that carries no language yet takes the
    // one this import knows. One that has a language keeps it: a lexicon
    // someone declared by hand is not this import's to relabel.
    redeclare: (n, field) =>
      BARE_PRIMARY.has(n) && !field.lang ? { ...field, lang: primaryAnalysisWs } : field,
  });

  // The items this run made. A RESUME heals everything an earlier run left
  // unplaced; a fresh import into a lexicon someone already has arranges only
  // what it adds, so a sense they made a separate entry stays one.
  const check = () => {
    if (shouldStop?.()) throw new ImportCancelled();
  };
  const created = await createEntriesOnce({
    client,
    vocabId,
    entries: pending,
    known: senseToItem,
    check,
    onProgress: (done, total) => onProgress?.({ phase: 'lexicon', done, total }),
  });

  const only = resume ? null : created;
  await placeEntrySenses({ client, lexicon, senseToItem, existing, only, check });
  if (variants)
    await placeVariants({ client, vocabId, lexicon, senseToItem, existing, only, shouldStop });
  return senseToItem;
}

// The vocabulary keeps FLEx's sense structure: an entry with several senses
// is a container item, its senses are senses of it in FLEx order, and a
// subsense is a sense of the sense that owned it.
// Written after creation, since a parent is an item id; only items made in
// this run are placed, so an entry already in the lexicon is left as it is.
// `only` is set for a fresh import into a lexicon already arranged by hand, so
// a sense they made a separate entry stays one.
async function placeEntrySenses({ client, lexicon, senseToItem, existing, only, check }) {
  const patches = [];
  for (const entry of lexicon) {
    if (entry.senses.length < 2) continue;
    const root = senseToItem.get(entry.guid);
    if (!root) continue;
    for (const s of entry.senses) {
      const id = senseToItem.get(s.guid);
      const parent = s.parentSense ? senseToItem.get(s.parentSense) : root;
      if (!id || !parent || id === parent) continue;
      patches.push({ id, parent, senseOrder: s.senseIndex + 1 });
    }
  }
  await placeSenses({ client, existing, places: patches, only, check });
}

// The fields FLEx's variants and complex forms land in. A variant entry
// points at what it varies, a complex form at what it is built from, and each
// keeps the name FLEx gives the relation ("Dialectal Variant", "Compound").
// All four are entry-scope: FLEx owns the relation at the entry, not the sense.
const VARIANT_FIELDS = {
  variantOf: { inline: false, type: FIELD_TYPES.ITEM, many: true, scope: FIELD_SCOPES.ENTRY },
  variantType: { inline: false, scope: FIELD_SCOPES.ENTRY },
  components: { inline: false, type: FIELD_TYPES.ITEM, many: true, scope: FIELD_SCOPES.ENTRY },
  componentType: { inline: false, scope: FIELD_SCOPES.ENTRY },
};

/**
 * Variants and complex forms, written after creation for the same reason the
 * sense tree is: a reference is an item id. Only items made in this run are
 * given references, so an entry already in the lexicon keeps what it has.
 * The fields are declared only if something landed in them.
 */
async function placeVariants({
  client,
  vocabId,
  lexicon,
  senseToItem,
  existing,
  only = null,
  shouldStop,
}) {
  // The item that IS an entry: the container of a multi-sense entry, or a
  // senseless entry's own item, else the item its first sense became.
  const headOf = (entry) =>
    senseToItem.get(entry.guid) ??
    (entry.senses.length ? senseToItem.get(entry.senses[0].guid) : undefined);
  const byGuid = new Map(lexicon.map((e) => [e.guid, e]));
  // A component is a LexEntry or a LexSense; either way it is one of our items.
  const itemFor = (guid) => {
    const direct = senseToItem.get(guid);
    if (direct) return direct;
    const entry = byGuid.get(guid);
    return entry ? headOf(entry) : undefined;
  };

  // Same rule as placeSenses: write a reference the entry does not have yet,
  // so an interrupted run is healed and a person's own edit is not.
  const existingMeta = new Map((existing.items || []).map((it) => [it.id, it.metadata || {}]));
  const patches = new Map();
  for (const entry of lexicon) {
    if (!entry.entryRefs?.length) continue;
    const id = headOf(entry);
    if (!id || (only && !only.has(id))) continue;
    const patch = patches.get(id) ?? {};
    for (const ref of entry.entryRefs) {
      const targets = ref.components.map(itemFor).filter((t) => t && t !== id);
      if (!targets.length) continue;
      const field = ref.variant ? 'variantOf' : 'components';
      patch[field] = [...new Set([...(patch[field] ?? []), ...targets])];
      if (ref.types.length) {
        const typeField = ref.variant ? 'variantType' : 'componentType';
        const types = new Set([
          ...(patch[typeField] ? patch[typeField].split(', ') : []),
          ...ref.types,
        ]);
        patch[typeField] = [...types].join(', ');
      }
    }
    // Drop what the entry already carries: a value there is either this
    // import's own from an earlier run, or somebody's edit.
    const held = existingMeta.get(id);
    if (held) for (const k of Object.keys(patch)) if (held[k] != null) delete patch[k];
    if (Object.keys(patch).length) patches.set(id, patch);
  }
  if (!patches.size) return;

  const layer = await client.vocabLayers.get(vocabId);
  const fieldsConfig = { ...(readVocabFields(layer.config) ?? {}) };
  const used = new Set([...patches.values()].flatMap((p) => Object.keys(p)));
  let added = false;
  for (const name of Object.keys(VARIANT_FIELDS)) {
    if (!used.has(name) || name in fieldsConfig) continue;
    fieldsConfig[name] = VARIANT_FIELDS[name];
    added = true;
  }
  if (added) {
    await writeVocabConfig(layer, IGT_NAMESPACE, 'fields', fieldsConfig, () =>
      client.vocabLayers.setConfig(vocabId, IGT_NAMESPACE, 'fields', fieldsConfig),
    );
  }

  const entries = [...patches.entries()];
  for (let i = 0; i < entries.length; i += CHUNK) {
    if (shouldStop?.()) throw new ImportCancelled();
    await client.vocabItems.bulkUpdate(
      entries.slice(i, i + CHUNK).map(([id, patch]) => ({ id, metadata: metadataOps(patch) })),
    );
  }
}

// What a text's notebook record contributes, in the order FLEx's Info tab
// shows it. Named as FLEx labels them: "Sources" is the record's own list of
// people, beside the text's own "Source" string.
const NOTEBOOK_FIELDS = [
  'Researchers',
  'Sources',
  'Participants',
  'Locations',
  'Anthropology Categories',
];

/**
 * Roled participant groups → "Ana, Bo; Narrator: Cy". FLEx groups participants
 * by the role they played, and the group with no role is a plain list.
 */
const participantsText = (groups) =>
  groups
    .map((g) => (g.role ? `${g.role}: ${g.people.join(', ')}` : g.people.join(', ')))
    .join('; ');

/**
 * A text's abbreviations as [ws, abbreviation], one per distinct string: the
 * same string in two writing systems is one fact and is kept once, under the
 * first writing system FLEx lists it in.
 */
const abbreviationsOf = (doc) => {
  const seen = new Set();
  return Object.entries(doc.abbreviations || {}).filter(([, abbr]) => {
    if (!abbr || seen.has(abbr)) return false;
    seen.add(abbr);
    return true;
  });
};

/** Flatten a document's FLEx metadata onto the configured metadata fields. */
function documentMetadataOf(doc) {
  const md = {};
  for (const [ws, title] of Object.entries(doc.names)) {
    if (title !== doc.name) md[withLangSuffix('Title', ws)] = title;
  }
  for (const [ws, abbr] of abbreviationsOf(doc)) md[withLangSuffix('Abbreviation', ws)] = abbr;
  if (doc.source) md.Source = pickEn(doc.source);
  if (doc.description) md.Description = pickEn(doc.description);
  if (doc.genres?.length) md.Genre = doc.genres.join(', ');
  const nb = doc.notebook;
  if (nb) {
    if (nb.researchers.length) md.Researchers = nb.researchers.join(', ');
    if (nb.sources.length) md.Sources = nb.sources.join(', ');
    if (nb.participants.length) md.Participants = participantsText(nb.participants);
    if (nb.locations.length) md.Locations = nb.locations.join(', ');
    if (nb.anthroCodes.length) md['Anthropology Categories'] = nb.anthroCodes.join(', ');
  }
  return md;
}
// The steps one document goes through, in order, so progress can report how
// far into a document it is and not just which document.
const DOCUMENT_STEPS = [
  'Creating document',
  'Creating text',
  'Creating sentences',
  'Creating words',
  'Creating morphemes',
  'Creating annotations',
  'Linking lexicon',
  'Creating time alignment',
  'Uploading media',
];

/** Import one document end to end. Assumes it does not exist yet. */
async function importDocument({
  client,
  projectId,
  targets,
  config,
  doc,
  senseToItem,
  senseTypes = null,
  orthographyNames,
  index = 0,
  total = 1,
  onProgress,
  shouldStop,
  warnings = null,
}) {
  const progress = documentProgress({
    onProgress,
    doc: doc.name,
    index,
    total,
    steps: DOCUMENT_STEPS,
  });
  const check = () => {
    if (shouldStop?.()) throw new ImportCancelled();
  };

  // A text FLEx left unsegmented still partitions: one sentence over the
  // whole body, so the editor has a row to hang the word tokens off.
  const sentences = doc.sentences.length
    ? doc.sentences
    : [{ begin: 0, end: [...doc.body].length }];
  const {
    documentId: docId,
    textId,
    sentenceIds,
  } = await createDocumentShell({
    client,
    projectId,
    targets,
    name: doc.name,
    metadata: (id) => importStamp(documentMetadataOf(doc), doc.guid, id),
    body: doc.body,
    tokenEdges: doc.tokenEdges,
    sentences,
    progress,
    check,
  });

  if (textId) {
    // Morphemes carry metadata.form and morphType, and a word's analysis only
    // FLEx's parser guessed is stamped as that machine's on its morphemes and
    // its spans.
    const fieldsBy = (kind) => config.fields.filter((f) => f.kind === kind);
    const span = (f, value, word = null) =>
      value == null
        ? []
        : [{ layerId: targets.fieldLayers.get(f), value, metadata: unapprovedStamp(word) }];
    const spansOf = (prefix, unit, word) => [
      ...fieldsBy(`${prefix}Gloss`).flatMap((f) => span(f, unit.gloss?.[f.ws], word)),
      ...fieldsBy(`${prefix}Pos`).flatMap((f) => span(f, unit.pos?.[f.ws], word)),
    ];
    const { morphemeIds } = await writeDocumentLayers({
      client,
      targets,
      textId,
      sentenceIds,
      sentenceSpans: doc.sentences.map((s) => [
        ...fieldsBy('freeTranslation').flatMap((f) => span(f, s.freeTranslation?.[f.ws])),
        ...fieldsBy('literalTranslation').flatMap((f) => span(f, s.literalTranslation?.[f.ws])),
        ...fieldsBy('note').flatMap((f) => {
          const notes = s.notes.map((n) => n[f.ws]).filter(Boolean);
          return notes.length ? span(f, notes.join('\n')) : [];
        }),
      ]),
      words: doc.words.map((w) => ({
        begin: w.begin,
        end: w.end,
        metadata: Object.fromEntries(
          Object.entries(orthographyNames)
            .filter(([ws]) => w.forms?.[ws] != null)
            .map(([ws, name]) => [orthographyKey(name), w.forms[ws]]),
        ),
        spans: spansOf('word', w, w),
        // A word FLEx never analyzed gets NO morpheme row (see
        // writeDocumentLayers).
        morphemes: (w.morphemes || []).map((m) => {
          const metadata = { ...unapprovedStamp(w) };
          const form = m.forms?.[config.baselineWs] ?? pickEn(m.forms);
          if (form != null) metadata.form = form;
          // A morpheme linked to a typed entry goes by the entry's type and
          // stores none. The interlinear's own type is kept for a morpheme
          // whose entry has none, and for one linked to no entry.
          const linked = m.senseGuid && senseToItem.get(m.senseGuid);
          const entryType = linked ? senseTypes?.get(m.senseGuid) : null;
          if (!entryType && m.morphType != null) metadata.morphType = m.morphType;
          return { metadata, spans: spansOf('morph', m, w) };
        }),
      })),
      check,
      progress,
    });

    // Vocab links morpheme → lexicon item. FLEx's human-approved analyses
    // import as confirmed; analyses only its morphological parser guessed
    // (never confirmed by the user) keep the unconfirmed-inferred shape, so
    // they render in the needs-review style and confirm-on-touch applies.
    // An import with no lexicon (a .flextext) has nothing to link.
    if (senseToItem.size) progress('Linking lexicon');
    const links = doc.words.flatMap((w, wi) =>
      (w.morphemes || []).flatMap((m, mi) => {
        const itemId = m.senseGuid && senseToItem.get(m.senseGuid);
        const tokenId = morphemeIds[wi][mi];
        if (!itemId || !tokenId) return [];
        return [
          {
            vocabItem: itemId,
            tokens: [tokenId],
            metadata:
              w.approved === true
                ? // OUR linker made this link, from the sense FLEx names, and
                  // FLEx's own human approval is what confirms it.
                  confirmedInferred('flex-import')
                : stampInferred(flexSource(w)),
          },
        ];
      }),
    );
    await bulkInChunks(withMintedIds(links), check, (part) => client.vocabLinks.bulkCreate(part));

    // Where each sentence sits in its recording, for a text FLEx kept times
    // for: one token per timed sentence.
    const aligned = await writeAlignments({
      client,
      targets,
      textId,
      alignments: doc.alignments,
      check,
      progress,
    });
    if (!aligned) {
      warnings?.push(
        `"${doc.name}": ${doc.alignments.length} timed sentences were left untimed. This project is not set up for time alignment.`,
      );
    }
  }

  // The recording the text's sentences point to, when the user picked it. A
  // run that finishes with a failed upload leaves nothing to resume: its
  // warning sends the user to the Media tab.
  await finishDocument({
    client,
    documentId: docId,
    name: doc.name,
    media: doc.mediaFile,
    stamp: { metadata: documentMetadataOf(doc), sourceId: doc.guid },
    onProgress,
    progress,
    check,
    warnings,
  });
  return docId;
}

/**
 * Run a full import against a set-up project. Skips documents already marked
 * imported; deletes and redoes half-imported ones. onProgress receives
 * {phase: 'lexicon'|'document'|'done', ...} updates throughout.
 */
// The whole import is ONE logical operation in the audit log (vocabulary +
// every document); each write keeps its own description underneath. Resumable
// retries start a fresh operation, which is the honest reading of the log.
// `operation` names it in the log, and `format` ('fwbackup' or 'flextext')
// is the file it came from, which the operation records as its ref. A null
// `vocabId` imports the texts alone (a .flextext has no lexicon), and then
// `lexicon` is not read.
export async function runImport({
  operation = 'Import FLEx project',
  format = 'fwbackup',
  ...args
}) {
  return args.client.withOperation(operation, () => runImportImpl(args), {
    kind: 'import',
    ref: `format:${format}`,
  });
}

async function runImportImpl({
  client,
  projectId,
  build,
  lexicon,
  config,
  vocabId,
  onProgress,
  shouldStop,
}) {
  const project = await client.projects.get(projectId);
  const targets = resolveTargets(project, config);
  await recordProjectLanguages(client, project, {
    object: config.baselineWs,
    meta: config.primaryAnalysisWs,
  });
  const orthographyNames = Object.fromEntries(
    (config.orthographies ?? []).map((o) => [o.ws ?? o.name, o.name]),
  );

  // Built from the parsed lexicon rather than threaded out of importLexicon,
  // whose return shape (the senseGuid -> item id Map) is contractual.
  const senseTypes = senseMorphTypes(lexicon);
  const senseToItem = !vocabId
    ? new Map()
    : await importLexicon({
        client,
        vocabId,
        lexicon,
        baselineWs: config.baselineWs,
        primaryAnalysisWs: config.primaryAnalysisWs,
        posWs: config.posWs,
        customFieldWs: config.customFieldWs ?? {},
        analysisWss: config.analysisWss ?? null,
        lexiconFields: config.lexiconFields ?? [],
        variants: config.variants === true,
        resume: config.resume === true,
        onProgress,
        shouldStop,
      });

  // Resume bookkeeping: what an earlier run made, by FLEx text guid.
  const prior = await priorImports(client, projectId);

  const results = { imported: 0, skipped: 0, redone: 0, warnings: [] };
  for (let i = 0; i < build.documents.length; i += 1) {
    if (shouldStop?.()) throw new ImportCancelled();
    const doc = build.documents[i];
    onProgress?.({
      phase: 'document',
      doc: doc.name,
      index: i,
      total: build.documents.length,
      step: 'Starting',
    });
    if (!(await settlePrior(client, prior, doc.guid, results))) continue;
    await importDocument({
      client,
      projectId,
      targets,
      config,
      doc,
      senseToItem,
      senseTypes,
      orthographyNames,
      index: i,
      total: build.documents.length,
      onProgress,
      shouldStop,
      warnings: results.warnings,
    });
    results.imported += 1;
  }
  onProgress?.({ phase: 'done', ...results });
  return results;
}
