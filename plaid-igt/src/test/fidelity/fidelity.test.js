// The fidelity campaign's standing guards. Nothing here needs a server.
//
// 1. The catalog is well formed.
// 2. Every format's loss list answers for every catalog key, in a shape a
//    comparison can act on.
// 3. Every table and column in plaid-core, and every config key plaid-igt or
//    plaid-ui writes, is accounted for: either it is covered by catalog
//    features (so the kitchen sink seeds it and the formats answer for it), or
//    it is written down here as not project data, with the reason.
//
// Guard 3 is the one that fails when a feature lands. Guidelines were added in
// core on 2026-09-15 and silently dropped by the native archive until the same
// day's fix. With this test in place, the migration that created their table
// would have failed here until somebody decided what every format does with
// them.

import { describe, it, expect } from 'vitest';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { FEATURES, FEATURE_KEYS } from './catalog.js';
import { coreSchema, setConfigCalls } from './schema.js';
import { RESERVED_ITEM_KEYS } from '../../domain/vocabFields.js';

// Built with path, not `new URL`: the test environment's URL is happy-dom's.
const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../../../..');
const repo = (p) => path.join(root, p);

const formats = Object.values(import.meta.glob('./formats/*.js', { eager: true })).map(
  (m) => m.default,
);

const KNOWN = new Set(FEATURE_KEYS);
const covers = (...keys) => ({ covers: keys });
const notData = (why) => ({ notData: why });

// ---- 1. the catalog ---------------------------------------------------------------------

describe('fidelity catalog', () => {
  it('has unique, well-formed features', () => {
    expect(new Set(FEATURE_KEYS).size).toBe(FEATURE_KEYS.length);
    for (const f of FEATURES) {
      expect(f.key).toMatch(/^[a-z]+\.[A-Za-z]+$/);
      expect(typeof f.what).toBe('string');
      expect(typeof f.detect).toBe('function');
    }
  });

  it('counts nothing in an empty project', () => {
    const empty = {
      name: 'x',
      config: {},
      layers: [],
      vocabularies: [],
      documents: [],
      guidelines: [],
    };
    const counted = FEATURES.filter((f) => f.detect(empty) !== 0).map((f) => f.key);
    expect(counted).toEqual([]);
  });
});

// ---- 2. the loss lists --------------------------------------------------------------------

const KINDS = new Set(['inherent', 'ruled', 'foreign', 'undecided']);

describe('format loss lists', () => {
  it('exist', () => {
    expect(formats.length).toBeGreaterThan(0);
  });

  for (const format of formats) {
    describe(format.id, () => {
      it('names itself and how it is checked', () => {
        expect(typeof format.name).toBe('string');
        expect(['roundTrip', 'export']).toContain(format.check);
      });

      it('answers for every catalog key and no other', () => {
        const keys = Object.keys(format.features);
        expect(keys.filter((k) => !KNOWN.has(k))).toEqual([]);
        expect(FEATURE_KEYS.filter((k) => !(k in format.features))).toEqual([]);
      });

      it('gives every answer a shape a comparison can act on', () => {
        const bad = [];
        for (const [key, entry] of Object.entries(format.features)) {
          if (entry.carried === true) continue;
          if (entry.carried === 'changed') {
            if (typeof entry.how !== 'string' || !entry.how)
              bad.push(`${key}: 'changed' needs how`);
            continue;
          }
          if (entry.carried !== false) {
            bad.push(`${key}: carried must be true, 'changed' or false`);
            continue;
          }
          if (!KINDS.has(entry.kind)) bad.push(`${key}: unknown kind ${entry.kind}`);
          if (typeof entry.why !== 'string' || !entry.why) bad.push(`${key}: false needs why`);
          if (entry.kind === 'ruled' && !entry.ruling) bad.push(`${key}: ruled needs ruling`);
        }
        expect(bad).toEqual([]);
      });
    });
  }
});

// ---- 3. what core stores and what the app writes ----------------------------------------------

// Every table in plaid-core. A project-data table lists every column, each
// either covered by catalog features or set aside with a reason. A table that
// is not project data says why once.
const TABLES = {
  projects: {
    id: notData('identity, replaced on import'),
    name: notData('named by whoever runs the import'),
    config: notData('checked key by key against the setConfig call sites below'),
  },
  documents: {
    id: notData('identity'),
    name: covers('document.duplicateName', 'document.nameSpecialChars'),
    project_id: notData('ownership'),
    version: notData('optimistic-concurrency counter'),
    created_at: notData('bookkeeping'),
    modified_at: notData('bookkeeping'),
  },
  text_layers: {
    id: notData('identity'),
    name: notData('internal, layers are bound by role'),
    project_id: notData('ownership'),
    order_idx: notData('one baseline text layer per IGT project'),
    config: notData('checked key by key below'),
  },
  token_layers: {
    id: notData('identity'),
    name: notData('internal, layers are bound by role'),
    text_layer_id: notData('structure'),
    project_id: notData('ownership'),
    overlap_mode: notData('fixed by role'),
    parent_token_layer_id: notData('fixed by role'),
    order_idx: notData('fixed by setup'),
    config: notData('checked key by key below'),
  },
  span_layers: {
    id: notData('identity'),
    name: covers(
      'layers.fieldSentence',
      'layers.fieldWord',
      'layers.fieldMorpheme',
      'layers.fieldSameNameTwoScopes',
    ),
    token_layer_id: covers('layers.fieldSentence', 'layers.fieldWord', 'layers.fieldMorpheme'),
    project_id: notData('ownership'),
    order_idx: covers('layers.fieldOrder'),
    config: notData('checked key by key below'),
  },
  relation_layers: {
    id: notData('identity'),
    name: covers('layers.relationLayer'),
    span_layer_id: covers('layers.relationLayer'),
    project_id: notData('ownership'),
    order_idx: covers('layers.relationLayer'),
    config: covers('layers.relationLayer'),
  },
  texts: {
    id: notData('identity'),
    body: covers(
      'text.astral',
      'text.combining',
      'text.rtlScript',
      'text.multiline',
      'text.blankLine',
      'text.markupChars',
      'text.zeroMorph',
      'document.noText',
    ),
    document_id: notData('ownership'),
    text_layer_id: notData('structure'),
  },
  tokens: {
    id: notData('identity'),
    text_id: notData('structure'),
    token_layer_id: covers(
      'token.sentence',
      'token.word',
      'token.segmentedWord',
      'alignment.times',
      'layers.foreignTokenLayer',
    ),
    document_id: notData('ownership'),
    begin: covers('token.word', 'token.untokenizedText', 'alignment.notSentenceExtent'),
    end_: covers('token.word', 'token.untokenizedText', 'alignment.notSentenceExtent'),
    precedence: covers('token.segmentedWord'),
  },
  spans: {
    id: notData('identity'),
    span_layer_id: covers(
      'span.sentenceValue',
      'span.wordValue',
      'span.morphemeValue',
      'span.onForeignLayer',
      'span.onAlignment',
    ),
    document_id: notData('ownership'),
    value: covers(
      'span.wordValue',
      'span.markupChars',
      'span.multilineValue',
      'span.emptyValue',
      'span.delimitedValue',
      'span.offTagset',
    ),
  },
  span_tokens: {
    span_id: covers('span.multiToken', 'span.duplicate'),
    token_id: covers('span.multiToken'),
    order_idx: notData('an annotation’s tokens are a set to every IGT reader'),
  },
  relations: {
    id: notData('identity'),
    relation_layer_id: covers('relation.value'),
    document_id: notData('ownership'),
    source_span_id: covers('relation.value'),
    target_span_id: covers('relation.value'),
    value: covers('relation.value'),
  },
  vocab_layers: {
    id: notData('identity'),
    name: covers('vocab.linked'),
    config: notData('checked key by key below'),
    created_at: notData('bookkeeping'),
    modified_at: notData('bookkeeping'),
  },
  vocab_items: {
    id: notData('identity'),
    form: covers('item.homonyms', 'item.zeroMorph'),
    vocab_layer_id: covers('vocab.second'),
  },
  vocab_links: {
    id: notData('identity'),
    vocab_item_id: covers('link.word', 'link.morpheme', 'link.toSense', 'link.secondVocabulary'),
    document_id: notData('ownership'),
  },
  vocab_link_tokens: {
    vocab_link_id: covers('link.mwe', 'link.duplicateOnToken'),
    token_id: covers(
      'link.mwe',
      'link.mweDiscontinuous',
      'link.mweAcrossSentences',
      'link.onSentence',
    ),
    order_idx: notData('a link’s tokens are a set to every IGT reader'),
  },
  project_vocabs: {
    project_id: covers('vocab.linked'),
    vocab_layer_id: covers('vocab.linked', 'vocab.second'),
  },
  entity_metadata: {
    entity_type: covers(
      'token.wordExtraMetadata',
      'span.extraMetadata',
      'document.metadataUnconfigured',
      'item.extraMetadata',
      'alignment.extraMetadata',
    ),
    entity_id: notData('identity'),
    key: covers(
      'token.wordExtraMetadata',
      'span.extraMetadata',
      'document.metadataUnconfigured',
      'item.extraMetadata',
    ),
    value: covers(
      'token.wordExtraMetadata',
      'span.extraMetadata',
      'document.metadataUnconfigured',
      'item.extraMetadata',
    ),
  },
  comments: {
    id: notData('identity'),
    project_id: notData('ownership'),
    document_id: notData('ownership'),
    vocab_layer_id: notData('ownership'),
    entity_type: covers(
      'comment.document',
      'comment.text',
      'comment.word',
      'comment.annotation',
      'comment.entry',
      'comment.relation',
    ),
    entity_id: covers('comment.word', 'comment.orphaned'),
    author_id: covers('comment.secondAuthor'),
    body: covers('comment.markdown'),
    anchor_label: covers('comment.anchorLabel'),
    created_at: covers('comment.edited'),
    updated_at: covers('comment.edited'),
  },
  guidelines: {
    id: notData('identity'),
    project_id: notData('ownership'),
    title: covers('guideline.present', 'guideline.duplicateTitle'),
    body: covers('guideline.present', 'guideline.emptyBody'),
    pinned: covers('guideline.pinned'),
    created_at: notData('bookkeeping'),
    updated_at: notData('bookkeeping'),
  },

  api_tokens: notData('credentials'),
  audit_retention: notData('audit bookkeeping'),
  audit_writes: notData('the audit log, document history is not carried by any format'),
  data_migrations: notData('schema bookkeeping'),
  invites: notData('access, not data'),
  operation_groups: notData('the audit log'),
  operations: notData('the audit log'),
  project_users: notData('permissions'),
  seen_services: notData('the service registry’s memory of what has connected'),
  user_avatars: notData('user profiles'),
  user_data: notData('per-user preferences'),
  users: notData('user accounts'),
  vocab_maintainers: notData('permissions'),
};

// Every config key plaid-igt and plaid-ui write, by resource, namespace and key.
const CONFIG_KEYS = {
  'projects igt.autoAnalysis': covers('project.autoAnalysis'),
  'projects igt.compose': covers('project.compose'),
  'projects igt.documentMetadata': covers(
    'project.documentMetadataFields',
    'project.documentMetadataTagset',
  ),
  'projects igt.export': covers('project.exportPresets'),
  'projects igt.initialized': notData(
    'written by setup on every project, an import runs setup again',
  ),
  'projects igt.import': notData('an import in flight, removed when it finishes'),
  'projects igt.languages': covers(
    'project.languageObject',
    'project.languageMeta',
    'project.languageCoordinates',
  ),
  'projects igt.serviceDefaults': covers('project.serviceDefaults'),
  'projects igt.speakers': covers('project.speakers'),
  'projects igt.tagsets': covers(
    'project.tagset',
    'project.tagsetModeSuggest',
    'project.tagsetModeClosed',
    'project.tagsetModeMixed',
    'project.tagsetDelimiters',
    'project.tagsetValueDescription',
    'project.tagsetOrdered',
  ),
  'projects plaid.review': covers('project.reviewedMembers'),
  'textLayers plaid.role': notData('structure, how every app finds the layer'),
  'tokenLayers plaid.role': notData('structure, how every app finds the layer'),
  'tokenLayers plaid.preserveOnSplit': notData('written by setup on every token layer'),
  'tokenLayers igt.ignoredTokens': covers(
    'layers.ignoredTokensPunctuation',
    'layers.ignoredTokensLetterLike',
    'layers.ignoredTokensBlacklist',
  ),
  'tokenLayers igt.orthographies': covers('layers.orthography'),
  'spanLayers igt.lang': covers('layers.fieldLang'),
  'spanLayers igt.scope': covers(
    'layers.fieldSentence',
    'layers.fieldWord',
    'layers.fieldMorpheme',
  ),
  'spanLayers igt.tagset': covers('layers.fieldTagset'),
  'vocabLayers igt.fields': covers(
    'vocab.customField',
    'vocab.fieldNotInline',
    'vocab.fieldTagset',
    'vocab.fieldLang',
    'vocab.fieldMultilingual',
    'vocab.fieldItemRef',
    'vocab.fieldItemRefMany',
    'vocab.fieldEntryScope',
  ),
  'vocabLayers igt.tagsets': covers('vocab.fieldTagset', 'vocab.customTagset'),
};

// How the source spells a namespace or key when it is not a literal.
const IDENTIFIERS = {
  IGT_NAMESPACE: 'igt',
  PLAID_NAMESPACE: 'plaid',
  // plaid-ui's ServiceDefaultsSettings writes under the app's own namespace.
  namespace: 'igt',
  ROLE_KEY: 'role',
  PRESERVE_ON_SPLIT_KEY: 'preserveOnSplit',
  REVIEW_KEY: 'review',
  IMPORT_KEY: 'import',
};

// Call sites that write back whatever an archive holds, key by key, rather
// than a key of their own. The archive's contents are what the catalog checks.
const PASS_THROUGH = [
  { file: 'plaid-igt/src/import/native/importEngine.js', resource: 'projects', key: 'key' },
  { file: 'plaid-igt/src/import/native/importEngine.js', resource: 'vocabLayers', key: 'key' },
];

// Keys an entry's metadata reserves for structure (vocabFields.js).
const RESERVED_ITEM_KEY_COVERAGE = {
  form: notData('the item’s own column, never stored as metadata'),
  parent: covers('item.sense', 'item.subsense'),
  senseOrder: covers('item.senseOrder'),
  examples: covers('item.exampleCorpus', 'item.exampleText'),
  flexEntry: covers('item.flexIdentity'),
  flexSense: covers('item.flexIdentity'),
  homograph: covers('item.homographNumber'),
};

const unknownCovered = (entries) =>
  entries.flatMap(([name, c]) =>
    (c.covers || []).filter((k) => !KNOWN.has(k)).map((k) => `${name}: ${k}`),
  );

describe('what core stores and the app writes', () => {
  const schema = coreSchema(repo('plaid-core/resources/migrations'));

  it('accounts for every core table and column', () => {
    const problems = [];
    for (const [table, columns] of schema) {
      const entry = TABLES[table];
      if (!entry) {
        problems.push(
          `table ${table} is new: add catalog features and kitchen-sink seeding if it holds project data, then classify it here`,
        );
        continue;
      }
      if (entry.notData) continue;
      for (const col of columns) {
        if (!entry[col]) problems.push(`column ${table}.${col} is new: classify it`);
      }
      for (const col of Object.keys(entry)) {
        if (!columns.has(col)) problems.push(`column ${table}.${col} no longer exists`);
      }
    }
    for (const table of Object.keys(TABLES)) {
      if (!schema.has(table)) problems.push(`table ${table} no longer exists`);
    }
    expect(problems).toEqual([]);
  });

  it('accounts for every config key the apps write', () => {
    const calls = setConfigCalls([repo('plaid-igt/src'), repo('plaid-ui/src')]);
    expect(calls.length).toBeGreaterThan(20);
    const problems = [];
    for (const call of calls) {
      const file = path.relative(root, call.file);
      if (
        PASS_THROUGH.some(
          (p) => p.file === file && p.resource === call.resource && p.key === call.key,
        )
      ) {
        continue;
      }
      const resolve = (tok) => (/^['"`]/.test(tok) ? tok.slice(1, -1) : IDENTIFIERS[tok]);
      const ns = resolve(call.namespace);
      const key = resolve(call.key);
      if (!ns || !key) {
        problems.push(
          `${file}: cannot read ${call.resource}.setConfig(_, ${call.namespace}, ${call.key})`,
        );
        continue;
      }
      if (!CONFIG_KEYS[`${call.resource} ${ns}.${key}`]) {
        problems.push(`${file}: ${call.resource} ${ns}.${key} is new: classify it in CONFIG_KEYS`);
      }
    }
    expect([...new Set(problems)]).toEqual([]);
  });

  it('accounts for every reserved entry key', () => {
    expect([...RESERVED_ITEM_KEYS].filter((k) => !RESERVED_ITEM_KEY_COVERAGE[k])).toEqual([]);
  });

  it('points only at features the catalog has', () => {
    const tableEntries = Object.entries(TABLES).flatMap(([t, e]) =>
      e.notData ? [] : Object.entries(e).map(([c, v]) => [`${t}.${c}`, v]),
    );
    expect([
      ...unknownCovered(tableEntries),
      ...unknownCovered(Object.entries(CONFIG_KEYS)),
      ...unknownCovered(Object.entries(RESERVED_ITEM_KEY_COVERAGE)),
    ]).toEqual([]);
  });
});
