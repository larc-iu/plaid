// The built-in analysis pass, run ON DEMAND from the Auto-analyze dialog — NOT
// automatically. Two built-in helpers over the open document:
//   1. analysis copies (optional, opt-in per run): unanalyzed words whose form
//      has an uncontested prior full analysis project-wide get that analysis
//      copied onto them (analysisMemory.js + bulkApplyAnalyses);
//   2. auto-linking: words/morphemes get the precedent-or-unique vocab link
//      rule (autoLink.js), replacing only machine-unverified links; then runs
//      of words that match a phrase entry, or an expression this document
//      already has, are linked as multi-word expressions.
// Everything applied is provenance-stamped and renders as unverified; humans
// confirm by editing, the popover, or the confirm-word gesture.
//
// Built-in algorithms ONLY — service-backed linking is a separate path in the
// dialog. Source documents for copy precedent are fetched lazily (the QL can't
// project the full analysis structure, so — like the concordance — we ask which
// documents contain the needed forms, fetch the busiest few, and harvest
// locally) and only for the duration of this one run.
//
// A built-in phase stops on request the same way a service does: `shouldStop`
// is read at checkpoints between units of work, and the writes sit between
// checkpoints so a phase that has begun writing always finishes. Without this a
// built-in step was the one part of Auto-analyze that could not be interrupted,
// and it is the slowest: precedent means fetching up to MAX_SOURCE_DOCS other
// documents one at a time.

import { IgtDocument } from './IgtDocument.js';
import { readIgnoredTokens } from './igtConfig.js';
import {
  ANALYSIS_COPY_SOURCE,
  isUnanalyzedWord,
  tallyAnalyses,
  mergeTallies,
  buildAnalysisTable,
  computeAnalysisCopyProposals,
  wordFormDocIndexQuery,
  rankSourceDocs,
} from './analysisMemory.js';
import {
  AUTO_LINK_SOURCE,
  MWE_LINK_SOURCE,
  computeAutoLinkProposals,
  computeMweProposals,
} from './autoLink.js';
import { linkPrecedentQueries, createTally, foldLinkRows } from './precedent.js';

const MAX_SOURCE_DOCS = 25;

// The stop, thrown at a checkpoint and caught once, in runBuiltinAnalysis. This
// is the services' contract in miniature: every long loop already reports
// progress, so the place it reports is the place it can be stopped.
class Stopped extends Error {}
const checkpoint = (shouldStop) => {
  if (shouldStop()) throw new Stopped();
};

// Run the built-in analysis helpers once over `doc`. Options:
//   link         — run the auto-linker (default true)
//   copy         — run the analysis-copy phase (default false)
//   copyContents — { segmentation, links, fields } for the copy phase
//   onProgress   — ({percent, message}) as the phases advance
//   shouldStop   — read at each checkpoint, true ends the run there
// Returns { copied, linked, ok, stopped }. Copy runs first so the linker doesn't
// re-handle words a copy just analyzed; a phase that fails (the mutation
// returns false, having already surfaced the error) short-circuits the rest
// and sets ok=false.
//
// A stop is not a failure: ok stays true and whatever a completed phase wrote
// stays written. The counts are what the completed phases reported, so a phase
// stopped after one of its two writes reports nothing rather than a partial
// figure. No caller shows a count for a run that was stopped.
//
// Reporting matters here rather than being a nicety: gathering precedent means
// fetching other documents one at a time, which on a big project is the longest
// silence in the whole Auto-analyze run.
export async function runBuiltinAnalysis(
  doc,
  {
    link = true,
    copy = false,
    copyContents = {},
    onProgress = () => {},
    shouldStop = () => false,
  } = {},
) {
  let copied = 0;
  let linked = 0;
  try {
    if (copy) {
      const n = await runCopyPhase(doc, copyContents, onProgress, shouldStop);
      if (n === false) return { copied, linked, ok: false, stopped: false };
      copied = n;
    }
    checkpoint(shouldStop);
    if (link) {
      const n = await runLinkPhase(doc, onProgress, shouldStop);
      if (n === false) return { copied, linked, ok: false, stopped: false };
      linked = n;
    }
  } catch (err) {
    if (!(err instanceof Stopped)) throw err;
    return { copied, linked, ok: true, stopped: true };
  }
  return { copied, linked, ok: true, stopped: false };
}

// Number of words copied, or false on mutation failure. Throws Stopped if the
// run is stopped at a checkpoint, which is always before a write.
async function runCopyPhase(doc, copyContents, onProgress, shouldStop = () => false) {
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
  const remoteTallies = await remoteTalliesFor(doc, wordLayerId, forms, onProgress, shouldStop);

  const table = buildAnalysisTable(mergeTallies(localTally, ...remoteTallies));
  const proposals = computeAnalysisCopyProposals({
    sentences: doc.sentences,
    ignoredCfg,
    table,
    copy: copyContents,
  });
  if (!proposals.length) return 0;
  // Last chance: the write below is one operation and is not interrupted.
  checkpoint(shouldStop);
  onProgress({ percent: null, message: `Copying onto ${proposals.length} words…` });
  return doc.bulkApplyAnalyses(proposals, ANALYSIS_COPY_SOURCE);
}

// Tallies of identical whole-word analyses from the project's other documents:
// ask which documents hold the target forms, fetch the busiest few, harvest
// locally. Read-failures of a single source are skipped, not fatal.
async function remoteTalliesFor(
  doc,
  wordLayerId,
  forms,
  onProgress = () => {},
  shouldStop = () => false,
) {
  onProgress({ percent: null, message: 'Looking for previous analyses…' });
  const index = await doc.client.query(wordFormDocIndexQuery(wordLayerId));
  const { docIds, truncated } = rankSourceDocs(index, forms, {
    excludeDocId: doc.id,
    maxDocs: MAX_SOURCE_DOCS,
  });
  if (truncated) {
    console.warn(
      `Auto-analysis: only the ${MAX_SOURCE_DOCS} documents with the most matching words were consulted for precedent.`,
    );
  }
  const tallies = [];
  for (const [i, docId] of docIds.entries()) {
    // Named one by one: this loop is seconds per document on a large corpus,
    // which also makes it the one place a stop most needs to be noticed.
    checkpoint(shouldStop);
    onProgress({
      percent: (i / docIds.length) * 100,
      message: `Reading document ${i + 1} of ${docIds.length}…`,
    });
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

// Number of links written, or false on mutation failure. Throws Stopped as the
// copy phase does. The two writes below are each preceded by a checkpoint, so a
// stop lands between them rather than inside one.
async function runLinkPhase(doc, onProgress = () => {}, shouldStop = () => false) {
  const vocabIds = Object.keys(doc.vocabularies || {});
  if (!vocabIds.length) return 0;
  onProgress({ percent: null, message: 'Reading the lexicon…' });
  const results = await Promise.all(linkPrecedentQueries(vocabIds).map((q) => doc.client.query(q)));
  const ignoredCfg = readIgnoredTokens(doc.layerInfo.primaryTokenLayer?.config);
  // The query covers the open document too, so nothing is folded from it.
  const precedent = foldLinkRows(createTally(), results, ignoredCfg);
  const proposals = computeAutoLinkProposals({
    sentences: doc.sentences,
    vocabularies: doc.vocabularies,
    precedent,
    ignoredCfg,
  });
  let linked = 0;
  if (proposals.length) {
    checkpoint(shouldStop);
    onProgress({ percent: null, message: `Linking ${proposals.length} words…` });
    const n = await doc.bulkLinkVocab(proposals, AUTO_LINK_SOURCE);
    if (n === false) return false;
    linked += n;
  }
  // Multi-word expressions second, over the reloaded document: runs of words
  // matching a phrase entry, or an expression this document already has.
  const mweProposals = computeMweProposals({
    sentences: doc.sentences,
    vocabularies: doc.vocabularies,
    ignoredCfg,
  });
  if (mweProposals.length) {
    checkpoint(shouldStop);
    onProgress({ percent: null, message: 'Linking multi-word expressions…' });
    const n = await doc.bulkLinkMwes(mweProposals, MWE_LINK_SOURCE);
    if (n === false) return false;
    linked += n;
  }
  return linked;
}
