// Pure query builders for the project Search tab. Each domain (words,
// morphemes, annotation fields, lexicon) maps a (queryText, matchType) pair
// onto plaid query-language bodies. Three query shapes per search:
//   hits      — matching entity ids, for ONE document (capped per document)
//   hitsByDoc — [docId, n] so we know which documents to load
//   freq      — [value, n] frequency rows
// All layer references are ids, so every query is inherently scoped to the
// project that owns those layers (lexicon queries are scoped by the
// project's linked vocab ids).
//
// Match semantics: exact = literal equality (case-sensitive, canonically
// equivalent text equal: core's equality reads a text with another spelling
// in NFC);
// contains = the text as a substring, in any case;
// regex = the user's pattern, read as Java syntax, case-sensitive.
// contains and regex go through translatePattern (plaid-ui domain/javaRegex.js), which
// writes the pattern out for the server and for the browser alike, so Bulk
// Edit's rows (planned in the browser) are the values Search finds.

import { PatternError, translatePattern } from '@ui/domain/javaRegex.js';

// The case behaviour differs between these and it changes what comes back, so
// the label says it rather than leaving it to be discovered: `contains` folds
// case (buildMatchSpec gives it the `i` flag), the other two do not. Searching
// `the` found 17 matches under one and 3 under the other with nothing on screen
// to explain the gap, and on Bulk Edit that gap is a write.
export const MATCH_TYPES = [
  { id: 'contains', label: 'contains (any case)' },
  { id: 'exact', label: 'is exactly (same case)' },
  { id: 'regex', label: 'matches regex (same case)' },
];

/**
 * The query constraint for a (queryText, matchType) pair. Throws a
 * PatternError, whose message says what is wrong, for a pattern that cannot
 * be used.
 */
export function buildMatchSpec(queryText, matchType) {
  if (matchType === 'exact') return queryText;
  const { server, error } = translatePattern(
    queryText,
    matchType === 'regex' ? {} : { literal: true, caseInsensitive: true },
  );
  if (error) throw new PatternError(error);
  return { regex: server };
}

// A value under `metadata`: a bare string beginning with "?" reads there as
// a variable, so an exact string is written as a literal.
const metadataSpec = (spec) => (typeof spec === 'string' ? { literal: spec } : spec);

// The searchable domains for a project, derived from its IGT layer info.
// kind: 'token' | 'morpheme' | 'span' | 'lexicon'.
export function searchDomains(layerInfo, vocabs) {
  const domains = [];
  if (layerInfo.primaryTokenLayer) {
    domains.push({
      id: 'words',
      label: 'Words',
      kind: 'token',
      layerId: layerInfo.primaryTokenLayer.id,
    });
  }
  if (layerInfo.morphemeTokenLayer) {
    domains.push({
      id: 'morphemes',
      label: 'Morphemes',
      kind: 'morpheme',
      layerId: layerInfo.morphemeTokenLayer.id,
    });
  }
  for (const scope of ['word', 'morpheme', 'sentence']) {
    for (const sl of layerInfo.spanLayers?.[scope] || []) {
      domains.push({
        id: `span:${sl.id}`,
        label: `${sl.name} (${scope})`,
        kind: 'span',
        layerId: sl.id,
        scope,
        field: sl.name,
      });
    }
  }
  if ((vocabs || []).length > 0) {
    domains.push({
      id: 'lexicon',
      label: 'Lexicon (linked entries)',
      kind: 'lexicon',
      vocabIds: vocabs.map((v) => v.id),
    });
  }
  return domains;
}

const HIT_LIMIT = 500;

// Hit-id queries FOR ONE DOCUMENT. Lexicon returns ONE QUERY PER VOCAB (merge
// results).
//
// Scoped to a document because `limit` is per query: asked project-wide, a
// search with more than HIT_LIMIT hits came back with the first 500 ids and
// nothing to say which documents they were for, while the grouped counts
// (below) stayed exact. A document whose hits all fell past the cap then drew
// a group headed "24 hits" whose body read "could not be located (it may have
// changed since the search)". Nothing had changed; the ids were never asked
// for. Per document the cap is per document, so a group is empty only when
// that one document really has more than HIT_LIMIT hits.
export function hitsQueries(domain, spec, docId) {
  if (domain.kind === 'token') {
    return [
      {
        find: ['?t'],
        where: [['token', '?t', { layer: domain.layerId, value: spec, doc: docId }]],
        limit: HIT_LIMIT,
      },
    ];
  }
  if (domain.kind === 'morpheme') {
    // Morpheme forms live in token metadata `form` (the token's own value is
    // the parent word's slice of the baseline).
    return [
      {
        find: ['?t'],
        where: [
          [
            'token',
            '?t',
            { layer: domain.layerId, metadata: { form: metadataSpec(spec) }, doc: docId },
          ],
        ],
        limit: HIT_LIMIT,
      },
    ];
  }
  if (domain.kind === 'span') {
    return [
      {
        find: ['?s'],
        where: [['span', '?s', { layer: domain.layerId, value: spec, doc: docId }]],
        limit: HIT_LIMIT,
      },
    ];
  }
  // lexicon: tokens linked to matching items. `vocab-link` takes no
  // constraints of its own, so the document is pinned on the token.
  return domain.vocabIds.map((vid) => ({
    find: ['?t'],
    where: [
      ['vocab', '?v', { layer: vid, form: spec }],
      ['vocab-link', '?t', '?v'],
      ['token', '?t', { doc: docId }],
    ],
    limit: HIT_LIMIT,
  }));
}

export function hitsByDocQueries(domain, spec) {
  const agg = { group: ['?d'], aggregates: [['count']] };
  if (domain.kind === 'token') {
    return [
      {
        where: [['token', '?t', { layer: domain.layerId, value: spec, doc: { var: '?d' } }]],
        return: agg,
      },
    ];
  }
  if (domain.kind === 'morpheme') {
    return [
      {
        where: [
          [
            'token',
            '?t',
            { layer: domain.layerId, metadata: { form: metadataSpec(spec) }, doc: { var: '?d' } },
          ],
        ],
        return: agg,
      },
    ];
  }
  if (domain.kind === 'span') {
    return [
      {
        where: [['span', '?s', { layer: domain.layerId, value: spec, doc: { var: '?d' } }]],
        return: agg,
      },
    ];
  }
  return domain.vocabIds.map((vid) => ({
    where: [
      ['vocab', '?v', { layer: vid, form: spec }],
      ['vocab-link', '?t', '?v'],
      ['token', '?t', { doc: { var: '?d' } }],
    ],
    return: agg,
  }));
}

// Frequency queries: [groupValue, count] rows.
// - token/span: bind the value with a second clause on the same entity var
//   (first clause filters, second binds — verified shape).
// - morpheme: filter on metadata.form, group by the ?t.metadata.form dot path.
// - lexicon: group by the item entity (ids; caller maps id -> form).
export function freqQueries(domain, spec) {
  const agg = { group: null, aggregates: [['count']] };
  if (domain.kind === 'token') {
    return [
      {
        where: [
          ['token', '?t', { layer: domain.layerId, value: spec }],
          ['token', '?t', { value: { var: '?val' } }],
        ],
        return: { ...agg, group: ['?val'] },
      },
    ];
  }
  if (domain.kind === 'morpheme') {
    return [
      {
        where: [['token', '?t', { layer: domain.layerId, metadata: { form: metadataSpec(spec) } }]],
        return: { ...agg, group: ['?t.metadata.form'] },
      },
    ];
  }
  if (domain.kind === 'span') {
    return [
      {
        where: [
          ['span', '?s', { layer: domain.layerId, value: spec }],
          ['span', '?s', { value: { var: '?val' } }],
        ],
        return: { ...agg, group: ['?val'] },
      },
    ];
  }
  return domain.vocabIds.map((vid) => ({
    where: [
      ['vocab', '?v', { layer: vid, form: spec }],
      ['vocab-link', '?t', '?v'],
    ],
    return: { ...agg, group: ['?v'] },
  }));
}

// ---- a governed field's value inventory -----------------------------------

/** Every span in a layer regardless of value (the REGEXP UDF matches on contains). */
const ANY_VALUE = { regex: '.' };

/**
 * The frequency queries for one field a tagset governs (a governedFields
 * record). A morpheme field's values are grouped by what gives their
 * morpheme its morph type, and by its form, because a tagset reads a
 * suffix's gloss otherwise than a stem's (glossReadingOf). The grid takes a
 * morpheme's type from its linked lexicon entry (the entry's own, else its
 * headword's) and falls back to the token's cached metadata.morphType, the
 * type of a morpheme linked to none. The query language has no
 * left join, so a morpheme field takes three queries: the linked morphemes,
 * rows [value, entry type, entry parent, cached type, form, count], the
 * unlinked ones, rows [value, cached type, form, count], and the morphemes
 * linked to two or more entries, which the first counts once per entry. That
 * last is one row per span, token and entry, [span, token, entry, value,
 * entry type, entry parent, cached type, form, count], and is nearly always
 * empty (loadAttested corrects the first by it). Any other field takes one
 * query with rows [value, count].
 */
export const governedFreqQueries = (g, projectId) => {
  if (g.kind === 'metadata') return [metadataFreqQuery(projectId, g.field)];
  const where = [
    ['span', '?s', { layer: g.layerId, value: ANY_VALUE }],
    ['span', '?s', { value: { var: '?val' } }],
  ];
  const aggregates = [['count']];
  if (g.scope !== 'morpheme') return [{ where, return: { group: ['?val'], aggregates } }];
  const morph = [...where, ['covers', '?s', '?t']];
  return [
    {
      where: [...morph, ['vocab-link', '?t', '?v']],
      return: {
        group: [
          '?val',
          '?v.metadata.morphType',
          '?v.metadata.parent',
          '?t.metadata.morphType',
          '?t.metadata.form',
        ],
        aggregates,
      },
    },
    {
      where: [...morph, ['not', ['vocab-link', '?t', '?v']]],
      return: { group: ['?val', '?t.metadata.morphType', '?t.metadata.form'], aggregates },
    },
    {
      where: [
        ...morph,
        ['vocab-link', '?t', '?v'],
        ['vocab-link', '?t', '?w'],
        ['!=', '?v.id', '?w.id'],
      ],
      return: {
        group: [
          '?s',
          '?t',
          '?v',
          '?val',
          '?v.metadata.morphType',
          '?v.metadata.parent',
          '?t.metadata.morphType',
          '?t.metadata.form',
        ],
        aggregates,
      },
    },
  ];
};

/**
 * Every lexicon entry that is another's headword, as [id, morph type,
 * parent, count] rows, for a sense whose own type is empty: it goes by its
 * headword's (vocabDictionary morphTypeOf).
 */
export const headwordTypesQuery = (projectId) => ({
  scope: { projectIds: [projectId] },
  where: [
    ['vocab', '?h', {}],
    ['vocab', '?e', {}],
    ['=', '?h.id', '?e.metadata.parent'],
  ],
  return: {
    group: ['?h', '?h.metadata.morphType', '?h.metadata.parent'],
    aggregates: [['count']],
  },
});

// ---- document metadata -----------------------------------------------------
// Metadata is not a span layer, so it needs its own queries. A document clause
// carries no layer id, and a layer id is what implicitly scopes every other
// query to its project, so these MUST pass an explicit `scope` — without it the
// query would reach documents in projects the caller never asked about.

/** `.` = has at least one character (the REGEXP UDF matches on contains). */
const ANY_TEXT = { regex: '.' };

/**
 * [value, count] rows for one document-metadata field, project-wide.
 *
 * `field` is interpolated into a dot-path, and the query parser splits field
 * references on ".", so a name containing one would silently group by nothing.
 * DocumentMetadataManager rejects periods in field names for this reason.
 */
const metadataFreqQuery = (projectId, field) => ({
  scope: { projectIds: [projectId] },
  where: [['document', '?d', { metadata: { [field]: ANY_TEXT } }]],
  return: { group: [`?d.metadata.${field}`], aggregates: [['count']] },
});

/** The documents whose `field` holds exactly `value`: [{id, name}]. */
export const metadataHitsQuery = (projectId, field, value) => ({
  scope: { projectIds: [projectId] },
  find: ['?d', '?name'],
  where: [
    ['document', '?d', { metadata: { [field]: metadataSpec(value) } }],
    ['document', '?d', { name: { var: '?name' } }],
  ],
});
