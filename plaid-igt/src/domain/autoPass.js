// The built-in analysis pass, run ON DEMAND from the Auto-link dialog — NOT
// automatically. Two built-in helpers over the open document:
//   1. analysis copies (optional, opt-in per run): unanalyzed words whose form
//      has an uncontested prior full analysis project-wide get that analysis
//      copied onto them (analysisMemory.js + bulkApplyAnalyses);
//   2. auto-linking: words/morphemes get the precedent-or-unique vocab link
//      rule (autoLink.js), replacing only machine-unverified links.
// Everything applied is provenance-stamped and renders as unverified; humans
// confirm by editing, the popover, or the confirm-word gesture.
//
// Built-in algorithms ONLY — service-backed linking is a separate path in the
// dialog. Source documents for copy precedent are fetched lazily (the QL can't
// project the full analysis structure, so — like the concordance — we ask which
// documents contain the needed forms, fetch the busiest few, and harvest
// locally) and only for the duration of this one run.

import { IgtDocument } from './IgtDocument.js';
import { readIgnoredTokens } from './igtConfig.js';
import {
  ANALYSIS_COPY_SOURCE, isUnanalyzedWord, tallyAnalyses, mergeTallies,
  buildAnalysisTable, computeAnalysisCopyProposals,
  wordFormDocIndexQuery, rankSourceDocs,
} from './analysisMemory.js';
import {
  AUTO_LINK_SOURCE, precedentQueries, buildPrecedentTable, computeAutoLinkProposals,
} from './autoLink.js';

const MAX_SOURCE_DOCS = 25;

// Run the built-in analysis helpers once over `doc`. Options:
//   link         — run the auto-linker (default true)
//   copy         — run the analysis-copy phase (default false)
//   copyContents — { segmentation, links, fields } for the copy phase
// Returns { copied, linked, ok }. Copy runs first so the linker doesn't
// re-handle words a copy just analyzed; a phase that fails (the mutation
// returns false, having already surfaced the error) short-circuits the rest
// and sets ok=false.
export async function runBuiltinAnalysis(doc, { link = true, copy = false, copyContents = {} } = {}) {
  let copied = 0;
  let linked = 0;
  if (copy) {
    const n = await runCopyPhase(doc, copyContents);
    if (n === false) return { copied, linked, ok: false };
    copied = n;
  }
  if (link) {
    const n = await runLinkPhase(doc);
    if (n === false) return { copied, linked, ok: false };
    linked = n;
  }
  return { copied, linked, ok: true };
}

// Number of words copied, or false on mutation failure.
async function runCopyPhase(doc, copyContents) {
  const info = doc.layerInfo;
  const wordLayerId = info.primaryTokenLayer?.id;
  if (!wordLayerId || !info.morphemeTokenLayer) return 0;
  const ignoredCfg = readIgnoredTokens(info.primaryTokenLayer.config);

  const forms = new Set();
  for (const s of doc.sentences) {
    for (const t of s.tokens) {
      if (isUnanalyzedWord(t, ignoredCfg) && t.content) forms.add(t.content);
    }
  }
  if (!forms.size) return 0;

  const localTally = tallyAnalyses(new Map(), doc.sentences, ignoredCfg);
  const remoteTallies = await remoteTalliesFor(doc, wordLayerId, forms);

  const table = buildAnalysisTable(mergeTallies(localTally, ...remoteTallies));
  const proposals = computeAnalysisCopyProposals({
    sentences: doc.sentences,
    ignoredCfg,
    table,
    copy: copyContents,
  });
  if (!proposals.length) return 0;
  return doc.bulkApplyAnalyses(proposals, ANALYSIS_COPY_SOURCE);
}

// Tallies of identical whole-word analyses from the project's other documents:
// ask which documents hold the target forms, fetch the busiest few, harvest
// locally. Read-failures of a single source are skipped, not fatal.
async function remoteTalliesFor(doc, wordLayerId, forms) {
  const index = await doc.client.query(wordFormDocIndexQuery(wordLayerId));
  const { docIds, truncated } = rankSourceDocs(index, forms, {
    excludeDocId: doc.id,
    maxDocs: MAX_SOURCE_DOCS,
  });
  if (truncated) {
    console.warn(`Auto-analysis: only the ${MAX_SOURCE_DOCS} documents with the most matching words were consulted for precedent.`);
  }
  const tallies = [];
  for (const docId of docIds) {
    try {
      const raw = await doc.client.documents.get(docId, true);
      const source = new IgtDocument({ raw, vocabularies: {}, client: doc.client });
      const srcIgnored = readIgnoredTokens(source.layerInfo.primaryTokenLayer?.config);
      tallies.push(tallyAnalyses(new Map(), source.sentences, srcIgnored));
    } catch (err) {
      console.warn(`Auto-analysis: could not read document ${docId} for precedent:`, err);
    }
  }
  return tallies;
}

// Number of links written, or false on mutation failure.
async function runLinkPhase(doc) {
  const vocabIds = Object.keys(doc.vocabularies || {});
  if (!vocabIds.length) return 0;
  const results = await Promise.all(
    precedentQueries(vocabIds).map((q) => doc.client.query(q)));
  const precedentTable = buildPrecedentTable(results);
  const proposals = computeAutoLinkProposals({
    sentences: doc.sentences,
    vocabularies: doc.vocabularies,
    precedentTable,
  });
  if (!proposals.length) return 0;
  return doc.bulkLinkVocab(proposals, AUTO_LINK_SOURCE);
}
