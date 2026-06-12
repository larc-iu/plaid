// The automatic analysis pass: as analysis happens (or new text arrives), run
// the built-in helpers over the open document without being asked —
//   1. analysis copies: unanalyzed words whose form has an uncontested prior
//      full analysis project-wide get that analysis copied onto them
//      (domain/analysisMemory.js + bulkApplyAnalyses);
//   2. auto-linking: remaining unlinked words/morphemes get the
//      precedent-or-unique vocab link rule (domain/autoLink.js).
// Everything applied is provenance-stamped and renders as unverified; humans
// confirm by editing, via the popover, or with the confirm-word gesture.
//
// Built-in algorithms ONLY — service-backed linking stays a manual run via
// the Auto-link dialog (no surprise latency/cost mid-typing). The pass is
// debounced off the document's dataVersion, runs single-flight, and is
// enabled/configured per project (config.igt.autoAnalysis, see igtConfig.js).
//
// Source documents are fetched lazily (the QL can't project the full analysis
// structure, so — like the concordance — we ask which documents contain the
// needed forms, fetch the busiest few, and harvest locally) and their tallies
// cached for the session: other documents don't change under us while we edit
// this one, and the cache resets on reopen.

import { IgtDocument } from './IgtDocument.js';
import { readIgnoredTokens, resolveAutoAnalysis } from './igtConfig.js';
import {
  ANALYSIS_COPY_SOURCE, isUnanalyzedWord, tallyAnalyses, mergeTallies,
  buildAnalysisTable, computeAnalysisCopyProposals,
  wordFormDocIndexQuery, rankSourceDocs,
} from './analysisMemory.js';
import {
  AUTO_LINK_SOURCE, precedentQueries, buildPrecedentTable, computeAutoLinkProposals,
} from './autoLink.js';

const DEBOUNCE_MS = 1500;
const MAX_SOURCE_DOCS = 25;

export class AutoAnalysisRunner {
  // onApplied?: ({ copied, linked, firstPass }) => void — called after a pass
  // that changed something (for a one-time notification; passes are otherwise
  // silent: the violet styling is the signal).
  constructor(doc, { onApplied = null } = {}) {
    this.doc = doc;
    this.onApplied = onApplied;
    this._timer = null;
    this._running = false;
    this._pending = false;
    this._stopped = true;
    this._unsubscribe = null;
    this._lastDataVersion = -1;
    this._firstPass = true;
    this._docTallies = new Map(); // docId -> tally (Map<form, Map<sig, {count, analysis}>>)
  }

  start() {
    this._stopped = false;
    this._lastDataVersion = this.doc.dataVersion;
    this._unsubscribe = this.doc.subscribe(() => {
      if (this._stopped) return;
      if (this.doc.dataVersion !== this._lastDataVersion) {
        this._lastDataVersion = this.doc.dataVersion;
        this._schedule();
      }
    });
    // Initial pass: catch the document up on open (reconcile-on-open's heals
    // land as dataVersion bumps and re-debounce this naturally).
    this._schedule();
  }

  stop() {
    this._stopped = true;
    if (this._timer) { clearTimeout(this._timer); this._timer = null; }
    if (this._unsubscribe) { this._unsubscribe(); this._unsubscribe = null; }
  }

  _schedule() {
    if (this._timer) clearTimeout(this._timer);
    this._timer = setTimeout(() => { this._timer = null; this._fire(); }, DEBOUNCE_MS);
  }

  async _fire() {
    if (this._stopped) return;
    if (this._running) { this._pending = true; return; }
    if (this.doc.isSaving) { this._schedule(); return; } // retry after the in-flight op
    this._running = true;
    try {
      await this._pass();
    } catch (err) {
      console.error('Automatic analysis pass failed:', err);
    } finally {
      this._running = false;
      if (this._pending && !this._stopped) { this._pending = false; this._schedule(); }
    }
  }

  async _pass() {
    const doc = this.doc;
    const cfg = resolveAutoAnalysis(doc.project?.config);
    if (!cfg.enabled) return;
    const firstPass = this._firstPass;
    this._firstPass = false;

    let copied = 0;
    let linked = 0;

    if (cfg.copyAnalyses && (cfg.copySegmentation || cfg.copyLinks || cfg.copyFields)) {
      copied = await this._copyPhase(cfg);
      if (this._stopped) return;
    }
    if (cfg.autoLink) {
      linked = await this._linkPhase();
    }
    // Our own applies bump dataVersion; don't let them re-trigger a pass.
    this._lastDataVersion = doc.dataVersion;

    if ((copied || linked) && this.onApplied) {
      this.onApplied({ copied, linked, firstPass });
    }
  }

  async _copyPhase(cfg) {
    const doc = this.doc;
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

    // Local precedent is always fresh; remote documents are fetched once and
    // their tallies cached for the session.
    const localTally = tallyAnalyses(new Map(), doc.sentences, ignoredCfg);
    const remoteTallies = await this._remoteTalliesFor(wordLayerId, forms);
    if (this._stopped) return 0;

    const table = buildAnalysisTable(mergeTallies(localTally, ...remoteTallies));
    // Recompute over the LATEST sentences — the fetches above may have taken
    // a while and the user kept editing (bulkApplyAnalyses revalidates each
    // proposal again anyway).
    const proposals = computeAnalysisCopyProposals({
      sentences: doc.sentences,
      ignoredCfg,
      table,
      copy: { segmentation: cfg.copySegmentation, links: cfg.copyLinks, fields: cfg.copyFields },
    });
    if (!proposals.length) return 0;
    // Don't contend with an in-flight user op for the save gate (a held gate
    // would drop the LOSER silently); back off and let the debounce retry.
    if (doc.isSaving) { this._schedule(); return 0; }
    const n = await doc.bulkApplyAnalyses(proposals, ANALYSIS_COPY_SOURCE);
    return n === false ? 0 : n;
  }

  async _remoteTalliesFor(wordLayerId, forms) {
    const doc = this.doc;
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
      if (this._stopped) break;
      let tally = this._docTallies.get(docId);
      if (!tally) {
        try {
          const raw = await doc.client.documents.get(docId, true);
          const source = new IgtDocument({ raw, vocabularies: {}, client: doc.client });
          const srcIgnored = readIgnoredTokens(source.layerInfo.primaryTokenLayer?.config);
          tally = tallyAnalyses(new Map(), source.sentences, srcIgnored);
        } catch (err) {
          console.warn(`Auto-analysis: could not read document ${docId} for precedent:`, err);
          tally = new Map();
        }
        this._docTallies.set(docId, tally);
      }
      tallies.push(tally);
    }
    return tallies;
  }

  async _linkPhase() {
    const doc = this.doc;
    const vocabIds = Object.keys(doc.vocabularies || {});
    if (!vocabIds.length) return 0;
    const results = await Promise.all(
      precedentQueries(vocabIds).map((q) => doc.client.query(q)));
    if (this._stopped) return 0;
    const precedentTable = buildPrecedentTable(results);
    const proposals = computeAutoLinkProposals({
      sentences: doc.sentences,
      vocabularies: doc.vocabularies,
      precedentTable,
    });
    if (!proposals.length) return 0;
    if (doc.isSaving) { this._schedule(); return 0; }
    const n = await doc.bulkLinkVocab(proposals, AUTO_LINK_SOURCE);
    return n === false ? 0 : n;
  }
}
