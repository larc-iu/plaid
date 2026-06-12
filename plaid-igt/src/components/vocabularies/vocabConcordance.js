// Concordance (KWIC) for a single vocab item: every word/morpheme linked to it,
// shown in sentence context. Reuses the project-search machinery — the QL can't
// project scalar fields, so we fetch the hit documents and locate the hits in
// the derived sentences (IgtDocument).
//
// Split into a cheap PLAN (two queries: hit ids + per-doc counts) and lazy,
// batched document loading, so the UI can infinite-scroll through the usages
// instead of capping. Usages span every project the user can read (same scope
// as the item's usage count); context is derived from each hit document's OWN
// embedded layer tree, so no per-project fetch is needed.

import { IgtDocument } from '@/domain/IgtDocument';
import { buildContextRows } from '@/components/projects/search/searchRunner.js';

const HIT_LIMIT = 1000;

// The `vocab` constraint map has no :id key, but `?v.id` is a valid field path,
// so we pin a single item with an equality predicate.
const linkWhere = (vocabLayerId, itemId) => [
  ['vocab', '?v', { layer: vocabLayerId }],
  ['=', '?v.id', itemId],
  ['vocab-link', '?t', '?v'],
];

// Cheap up-front plan: the hit token ids (to locate inside documents) and the
// document list sorted by hit count (so we load the busiest documents first).
// No documents fetched here. Returns { totalHits, totalDocs, docs, hitIds,
// truncated } where `docs` is [[docId, count], ...] sorted desc.
export async function planItemConcordance(client, vocabLayerId, itemId) {
  const where = linkWhere(vocabLayerId, itemId);
  const [idRes, docRes] = await Promise.all([
    client.query({ find: ['?t'], where, limit: HIT_LIMIT }),
    client.query({
      where: [...where, ['token', '?t', { doc: { var: '?d' } }]],
      return: { group: ['?d'], aggregates: [['count']] },
    }),
  ]);
  const hitIds = new Set((idRes?.results || []).map((r) => String(r[0])));
  const truncated = !!idRes?.truncated;

  const docCounts = new Map((docRes?.results || []).map(([d, n]) => [String(d), n]));
  const docs = [...docCounts.entries()].sort((a, b) => b[1] - a[1]);
  const totalHits = docs.reduce((acc, [, n]) => acc + n, 0);
  return { totalHits, totalDocs: docs.length, docs, hitIds, truncated };
}

// Load + derive a batch of documents into concordance groups (one per document),
// locating `hitIds` inside each. `docEntries` is a slice of plan.docs.
export async function loadConcordanceGroups(client, hitIds, docEntries) {
  const domain = { kind: 'lexicon' }; // marks both word- and morpheme-level link hits
  return Promise.all(docEntries.map(async ([docId, count]) => {
    const raw = await client.documents.get(docId, true);
    const doc = new IgtDocument({ raw, vocabularies: {}, client });
    return {
      docId,
      projectId: doc.raw?.project,
      docName: doc.document?.name || '(untitled)',
      docHits: count,
      rows: buildContextRows(doc, domain, hitIds),
    };
  }));
}
