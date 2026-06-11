// Pure query builders for the project Search tab. Each domain (words,
// morphemes, annotation fields, lexicon) maps a (queryText, matchType) pair
// onto plaid query-language bodies. Three query shapes per search:
//   hits      — matching entity ids (capped)
//   hitsByDoc — [docId, n] so we know which documents to load
//   freq      — [value, n] frequency rows
// All layer references are ids, so every query is inherently scoped to the
// project that owns those layers (lexicon queries are scoped by the
// project's linked vocab ids).
//
// Match semantics: exact = literal equality (case-sensitive);
// contains = escaped substring regex, case-insensitive;
// regex = the user's pattern verbatim (server-side Java regex), case-sensitive.

export const MATCH_TYPES = [
  { id: 'contains', label: 'contains' },
  { id: 'exact', label: 'is exactly' },
  { id: 'regex', label: 'matches regex' },
];

const escapeRegex = (s) => s.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');

export function buildMatchSpec(queryText, matchType) {
  if (matchType === 'exact') return queryText;
  if (matchType === 'regex') return { regex: queryText };
  return { regex: escapeRegex(queryText), flags: 'i' };
}

// The searchable domains for a project, derived from its IGT layer info.
// kind: 'token' | 'morpheme' | 'span' | 'lexicon'.
export function searchDomains(layerInfo, vocabs) {
  const domains = [];
  if (layerInfo.primaryTokenLayer) {
    domains.push({ id: 'words', label: 'Words', kind: 'token', layerId: layerInfo.primaryTokenLayer.id });
  }
  if (layerInfo.morphemeTokenLayer) {
    domains.push({ id: 'morphemes', label: 'Morphemes', kind: 'morpheme', layerId: layerInfo.morphemeTokenLayer.id });
  }
  for (const scope of ['word', 'morpheme', 'sentence']) {
    for (const sl of layerInfo.spanLayers?.[scope] || []) {
      domains.push({ id: `span:${sl.id}`, label: `${sl.name} (${scope})`, kind: 'span', layerId: sl.id, scope, field: sl.name });
    }
  }
  if ((vocabs || []).length > 0) {
    domains.push({ id: 'lexicon', label: 'Lexicon (linked items)', kind: 'lexicon', vocabIds: vocabs.map((v) => v.id) });
  }
  return domains;
}

const HIT_LIMIT = 500;

// Hit-id queries. Lexicon returns ONE QUERY PER VOCAB (merge results).
export function hitsQueries(domain, spec) {
  if (domain.kind === 'token') {
    return [{ find: ['?t'], where: [['token', '?t', { layer: domain.layerId, value: spec }]], limit: HIT_LIMIT }];
  }
  if (domain.kind === 'morpheme') {
    // Morpheme forms live in token metadata `form` (the token's own value is
    // the parent word's slice of the baseline).
    return [{ find: ['?t'], where: [['token', '?t', { layer: domain.layerId, metadata: { form: spec } }]], limit: HIT_LIMIT }];
  }
  if (domain.kind === 'span') {
    return [{ find: ['?s'], where: [['span', '?s', { layer: domain.layerId, value: spec }]], limit: HIT_LIMIT }];
  }
  // lexicon: tokens linked to matching items
  return domain.vocabIds.map((vid) => ({
    find: ['?t'],
    where: [['vocab', '?v', { layer: vid, form: spec }], ['vocab-link', '?t', '?v']],
    limit: HIT_LIMIT,
  }));
}

export function hitsByDocQueries(domain, spec) {
  const agg = { group: ['?d'], aggregates: [['count']] };
  if (domain.kind === 'token') {
    return [{ where: [['token', '?t', { layer: domain.layerId, value: spec, doc: { var: '?d' } }]], return: agg }];
  }
  if (domain.kind === 'morpheme') {
    return [{ where: [['token', '?t', { layer: domain.layerId, metadata: { form: spec }, doc: { var: '?d' } }]], return: agg }];
  }
  if (domain.kind === 'span') {
    return [{ where: [['span', '?s', { layer: domain.layerId, value: spec, doc: { var: '?d' } }]], return: agg }];
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
    return [{
      where: [
        ['token', '?t', { layer: domain.layerId, value: spec }],
        ['token', '?t', { value: { var: '?val' } }],
      ],
      return: { ...agg, group: ['?val'] },
    }];
  }
  if (domain.kind === 'morpheme') {
    return [{
      where: [['token', '?t', { layer: domain.layerId, metadata: { form: spec } }]],
      return: { ...agg, group: ['?t.metadata.form'] },
    }];
  }
  if (domain.kind === 'span') {
    return [{
      where: [
        ['span', '?s', { layer: domain.layerId, value: spec }],
        ['span', '?s', { value: { var: '?val' } }],
      ],
      return: { ...agg, group: ['?val'] },
    }];
  }
  return domain.vocabIds.map((vid) => ({
    where: [['vocab', '?v', { layer: vid, form: spec }], ['vocab-link', '?t', '?v']],
    return: { ...agg, group: ['?v'] },
  }));
}
