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

// Cheap up-front plan: the document list sorted by hit count (so we load the
// busiest documents first). No documents fetched here, and no ids: those are
// asked for a document at a time as the documents load, since `limit` is per
// query and an entry with more uses than HIT_LIMIT would otherwise leave whole
// documents with a count and no rows. Returns { totalHits, totalDocs, docs,
// idsFor, truncated, hitIds, hitIdsCapped }, `docs` being [[docId, count], ...]
// sorted desc. `truncated` is about the counts; `hitIdsCapped` about `hitIds`.
export async function planItemConcordance(client, vocabLayerId, itemId) {
  const where = linkWhere(vocabLayerId, itemId);
  const [docRes, idRes] = await Promise.all([
    client.query({
      where: [...where, ['token', '?t', { doc: { var: '?d' } }]],
      return: { group: ['?d'], aggregates: [['count']] },
    }),
    // Not what the rows are located with (see above). This one answers a
    // different question, "is this example's token still linked here", which
    // needs the whole set and gives up honestly when there is more of it than
    // one query returns.
    client.query({ find: ['?t'], where, limit: HIT_LIMIT }),
  ]);

  const docCounts = new Map((docRes?.results || []).map(([d, n]) => [String(d), n]));
  const docs = [...docCounts.entries()].sort((a, b) => b[1] - a[1]);
  const totalHits = docs.reduce((acc, [, n]) => acc + n, 0);
  const idsFor = async (docId) => {
    const res = await client.query({
      find: ['?t'],
      where: [...where, ['token', '?t', { doc: docId }]],
      limit: HIT_LIMIT,
    });
    return new Set((res?.results || []).map((r) => String(r[0])));
  };
  return {
    totalHits,
    totalDocs: docs.length,
    docs,
    idsFor,
    truncated: !!docRes?.truncated,
    hitIds: new Set((idRes?.results || []).map((r) => String(r[0]))),
    hitIdsCapped: !!idRes?.truncated,
  };
}

// Load + derive a batch of documents into concordance groups (one per document),
// locating the hits inside each. `docEntries` is a slice of plan.docs, and
// `hits` is either a Set of token ids the caller already has or a function of
// a document id returning that document's own set (plan.idsFor).
export async function loadConcordanceGroups(client, hits, docEntries) {
  const domain = { kind: 'lexicon' }; // marks both word- and morpheme-level link hits
  const idsFor = typeof hits === 'function' ? hits : () => hits;
  return Promise.all(
    docEntries.map(async ([docId, count]) => {
      const [raw, hitIds] = await Promise.all([client.documents.get(docId, true), idsFor(docId)]);
      const doc = new IgtDocument({ raw, vocabularies: {}, client });
      return {
        docId,
        projectId: doc.raw?.project,
        docName: doc.document?.name || '(untitled)',
        docHits: count,
        rows: buildContextRows(doc, domain, hitIds),
      };
    }),
  );
}

// The Analyze-tab link for one sentence of a document, or null when the
// project is unreadable (there is nowhere to go).
export const sentenceTo = (projectId, docId, sentenceId) =>
  projectId
    ? `/projects/${projectId}/documents/${docId}?tab=analyze&focusSentence=${sentenceId}`
    : null;
