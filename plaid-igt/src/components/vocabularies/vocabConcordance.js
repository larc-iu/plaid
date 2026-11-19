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
import { APP_ROUTES } from '@/appRoutes';
import { documentVocabularies } from '@/domain/documentVocabularies';
import { buildContextRows } from '@/components/projects/search/searchRunner.js';
import { morphemeRangeInWord, segmentationParts } from '@/domain/morphemeInWord';

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
// a document id returning that document's own set (plan.idsFor). `morphemes`
// picks a morpheme hit out inside its word (withMorphemeHits), which the
// entry page's Concordance and Examples ask for, and Search does not.
export async function loadConcordanceGroups(client, hits, docEntries, { morphemes = false } = {}) {
  const domain = { kind: 'lexicon' }; // marks both word- and morpheme-level link hits
  const idsFor = typeof hits === 'function' ? hits : () => hits;
  return Promise.all(
    docEntries.map(async ([docId, count]) => {
      const [raw, hitIds] = await Promise.all([client.documents.get(docId, true), idsFor(docId)]);
      const doc = new IgtDocument({
        raw,
        vocabularies: await documentVocabularies(client, raw),
        client,
      });
      return {
        docId,
        projectId: doc.raw?.project,
        docName: doc.document?.name || '(untitled)',
        docHits: count,
        rows: morphemes
          ? withMorphemeHits(doc, buildContextRows(doc, domain, hitIds), hitIds)
          : buildContextRows(doc, domain, hitIds),
      };
    }),
  );
}

/**
 * The concordance's rows with each morpheme hit picked out in its word (GH
 * #68), on top of what buildContextRows gives Search. Where the word's forms
 * spell it (morphemeRangeInWord), the word's mark gains `inner`, the
 * morpheme's letters in sentence offsets. Where they do not, the row gains
 * `stacks`, one `{ begin, end, parts }` per such word (its extent in the
 * sentence and its segmentationParts), to be set under the word, which keeps
 * its plain mark. `segmentations` holds the same for EVERY word with a
 * morpheme hit, spelled or not, for a reader who asks to see the segmentation
 * always (the Concordance tab's checkbox). A row with no morpheme hit comes
 * back as it was.
 */
export function withMorphemeHits(doc, rows, hitIds) {
  const sentences = new Map((doc.sentences || []).map((s) => [s.id, s]));
  return rows.map((row) => {
    const sentence = sentences.get(row.sentenceId);
    if (!sentence) return row;
    const inner = new Map(); // word begin in the sentence -> [{begin, end}]
    const stacks = [];
    const segmentations = [];
    for (const word of sentence.tokens || []) {
      const hits = (word.morphemes || []).filter((m) => hitIds.has(m.id));
      if (!hits.length) continue;
      const at = word.begin - sentence.begin;
      let unplaced = false;
      for (const hit of hits) {
        const range = morphemeRangeInWord(word, hit);
        if (!range) {
          unplaced = true;
          continue;
        }
        if (!inner.has(at)) inner.set(at, []);
        inner.get(at).push({ begin: at + range.begin, end: at + range.end });
      }
      const stack = {
        begin: at,
        end: word.end - sentence.begin,
        parts: segmentationParts(word, hitIds),
      };
      segmentations.push(stack);
      if (unplaced) stacks.push(stack);
    }
    if (!segmentations.length) return row;
    return {
      ...row,
      marks: row.marks.map((mk) =>
        inner.has(mk.begin) ? { ...mk, inner: inner.get(mk.begin) } : mk,
      ),
      ...(stacks.length ? { stacks } : {}),
      segmentations,
    };
  });
}

// The Analyze-tab link for one sentence of a document, or null when the
// project is unreadable (there is nowhere to go).
export const sentenceTo = (projectId, docId, sentenceId) =>
  projectId ? APP_ROUTES.sentence(projectId, docId, sentenceId) : null;
