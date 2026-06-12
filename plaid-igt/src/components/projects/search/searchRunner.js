// Orchestration for the project Search tab. Runs the query-language queries
// from searchQueries.js, loads the hit documents, and locates each hit inside
// the derived sentences (reusing the IgtDocument derive machinery) so the UI
// can render sentence-context results with highlights.
//
// The QL cannot project scalar fields in `find`, so sentence context comes
// from fetching the hit documents — capped at MAX_DOCS, with honest "N more
// hits in M more documents" accounting from the grouped-by-doc counts.

import { cpSlice } from '@larc-iu/plaid-client';
import { IgtDocument } from '@/domain/IgtDocument';
import { buildMatchSpec, hitsQueries, hitsByDocQueries, freqQueries } from './searchQueries.js';

const MAX_DOCS = 12;
const MAX_FREQ_ROWS = 200;

const morphFormOf = (m) => {
  const meta = m?.metadata;
  if (meta && Object.prototype.hasOwnProperty.call(meta, 'form')) return meta.form ?? '';
  return m?.content ?? '';
};

async function runAll(client, queries) {
  return Promise.all(queries.map((q) => client.query(q)));
}

// ---- hits mode -------------------------------------------------------------

// Locate hit entity ids inside one derived document. Returns sentence-grouped
// rows: { sentenceId, sentenceIndex, marks: [{begin,end}], notes: [string] }.
export function locateHits(doc, domain, hitIds) {
  const bySentence = new Map();
  const sentences = doc.sentences || [];
  const row = (s, idx) => {
    let r = bySentence.get(s.id);
    if (!r) {
      r = { sentenceId: s.id, sentenceIndex: idx, sentence: s, marks: [], notes: [] };
      bySentence.set(s.id, r);
    }
    return r;
  };
  const mark = (r, token) => {
    if (!r.marks.some((m) => m.begin === token.begin && m.end === token.end)) {
      r.marks.push({ begin: token.begin, end: token.end });
    }
  };

  const sentenceScope = domain.kind === 'span' && domain.scope === 'sentence';
  sentences.forEach((s, idx) => {
    if (sentenceScope) {
      const span = s.annotations?.[domain.field];
      if (span?.id && hitIds.has(span.id)) {
        const r = row(s, idx);
        r.notes.push(`${domain.field}: ${span.value}`);
      }
      return;
    }
    for (const t of s.tokens || []) {
      if ((domain.kind === 'token' || domain.kind === 'lexicon') && hitIds.has(t.id)) {
        mark(row(s, idx), t);
      }
      if (domain.kind === 'span' && domain.scope === 'word') {
        const span = t.annotations?.[domain.field];
        if (span?.id && hitIds.has(span.id)) {
          const r = row(s, idx);
          mark(r, t);
          r.notes.push(`${domain.field}: ${span.value}`);
        }
      }
      for (const m of t.morphemes || []) {
        if ((domain.kind === 'morpheme' || domain.kind === 'lexicon') && hitIds.has(m.id)) {
          const r = row(s, idx);
          mark(r, t);
          if (domain.kind === 'morpheme') r.notes.push(`morpheme: ${morphFormOf(m)}`);
        }
        if (domain.kind === 'span' && domain.scope === 'morpheme') {
          const span = m.annotations?.[domain.field];
          if (span?.id && hitIds.has(span.id)) {
            const r = row(s, idx);
            mark(r, t);
            r.notes.push(`${morphFormOf(m)} · ${domain.field}: ${span.value}`);
          }
        }
      }
    }
  });
  return [...bySentence.values()];
}

// Build sentence-context rows for one derived document: slice the sentence text
// (code points), rebase the hit marks to be sentence-relative, and pull a
// sentence-layer translation. Shared by project search + the vocab concordance.
// Sentence fields come from the doc's OWN layerInfo, so this works for documents
// from any project (the vocab concordance spans projects).
export function buildContextRows(doc, domain, hitIds) {
  const sentFields = (doc.layerInfo.spanLayers?.sentence || []).map((l) => l.name);
  return locateHits(doc, domain, hitIds).map((r) => {
    const s = r.sentence;
    const base = s.begin;
    const text = cpSlice(doc.body || '', s.begin, s.end);
    const translation = sentFields
      .map((f) => s.annotations?.[f]?.value ?? '')
      .find((v) => v !== '') || '';
    return {
      sentenceId: r.sentenceId,
      sentenceIndex: r.sentenceIndex,
      text,
      marks: r.marks
        .map((m) => ({ begin: m.begin - base, end: m.end - base }))
        .sort((a, b) => a.begin - b.begin),
      notes: r.notes,
      translation,
    };
  }).sort((a, b) => a.sentenceIndex - b.sentenceIndex);
}

export async function runHitsSearch(client, project, layerInfo, domain, queryText, matchType) {
  const spec = buildMatchSpec(queryText, matchType);
  const [idResults, docResults] = await Promise.all([
    runAll(client, hitsQueries(domain, spec)),
    runAll(client, hitsByDocQueries(domain, spec)),
  ]);

  const hitIds = new Set();
  for (const r of idResults) for (const rowv of r?.results || []) hitIds.add(String(rowv[0]));
  const truncated = idResults.some((r) => r?.truncated);

  const docCounts = new Map();
  for (const r of docResults) {
    for (const [docId, n] of r?.results || []) docCounts.set(String(docId), (docCounts.get(String(docId)) || 0) + n);
  }
  const totalHits = [...docCounts.values()].reduce((a, b) => a + b, 0);
  const docsByCount = [...docCounts.entries()].sort((a, b) => b[1] - a[1]);
  const toLoad = docsByCount.slice(0, MAX_DOCS);

  const docs = await Promise.all(toLoad.map(async ([docId]) => {
    const raw = await client.documents.get(docId, true);
    return new IgtDocument({ raw, project, vocabularies: {}, client, projectId: project.id });
  }));

  const groups = docs.map((doc, i) => ({
    docId: toLoad[i][0],
    docName: doc.document?.name || '(untitled)',
    docHits: toLoad[i][1],
    rows: buildContextRows(doc, domain, hitIds),
  }));

  const loadedHits = toLoad.reduce((a, [, n]) => a + n, 0);
  return {
    mode: 'hits',
    totalHits,
    totalDocs: docCounts.size,
    groups,
    remainingHits: totalHits - loadedHits,
    remainingDocs: docCounts.size - toLoad.length,
    truncated,
  };
}

// ---- frequencies mode ------------------------------------------------------

export async function runFreqSearch(client, domain, queryText, matchType) {
  const spec = buildMatchSpec(queryText, matchType);
  const results = await runAll(client, freqQueries(domain, spec));

  const counts = new Map();
  for (const r of results) {
    for (const [value, n] of r?.results || []) {
      const k = value == null ? '' : String(value);
      counts.set(k, (counts.get(k) || 0) + n);
    }
  }

  // Lexicon rows are item IDs — map to forms via the vocab layers.
  let display = counts;
  if (domain.kind === 'lexicon') {
    const formById = new Map();
    await Promise.all(domain.vocabIds.map(async (vid) => {
      const layer = await client.vocabLayers.get(vid, true);
      for (const it of layer.items || []) formById.set(String(it.id), it.form);
    }));
    display = new Map();
    for (const [id, n] of counts) {
      const form = formById.get(id) ?? id;
      display.set(form, (display.get(form) || 0) + n);
    }
  }

  const rows = [...display.entries()]
    .filter(([v]) => v !== '')
    .sort((a, b) => b[1] - a[1] || (a[0] < b[0] ? -1 : 1));
  return {
    mode: 'freq',
    totalValues: rows.length,
    totalHits: rows.reduce((a, [, n]) => a + n, 0),
    rows: rows.slice(0, MAX_FREQ_ROWS),
  };
}
