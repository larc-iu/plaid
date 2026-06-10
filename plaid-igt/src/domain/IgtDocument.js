import { getIgtLayerInfo } from './layerInfo.js';
import { planMorphemeReconcile } from './igtReconcile.js';
import {
  deriveDocumentData,
  deriveSentences,
  deriveAlignmentTokens
} from './derive.js';

import { spanMutations } from './mutations/spans.js';
import { tokenMutations } from './mutations/tokens.js';
import { sentenceMutations } from './mutations/sentences.js';
import { morphemeMutations } from './mutations/morphemes.js';
import { vocabMutations } from './mutations/vocab.js';
import { documentMutations } from './mutations/document.js';
import { alignmentMutations } from './mutations/alignment.js';

const cloneRaw = (raw) => JSON.parse(JSON.stringify(raw));
const cloneVocabs = (vocabularies) => JSON.parse(JSON.stringify(vocabularies));

// Single source of truth for a loaded plaid-igt document. Wraps a raw
// plaid-client document, knows the IGT layer model (sentences > words >
// morphemes, plus alignment + span layers), owns the optimistic-update
// mutations that used to live in the editor's useXxxOperations hooks, and
// exposes a version-counted subscription so React (or any other UI layer)
// can re-render on change.
//
// Framework-agnostic — no React imports here. The React bridge lives in
// useIgtDocument.js.
//
// Vocab links are scoped on the vocab layer, not the document, so the doc
// also holds the project's loaded vocabularies (`_vocabularies`) and applies
// link/unlink patches to that table in `_applyRawPatch`.
export class IgtDocument {
  constructor({ raw, project = null, vocabularies = {}, client = null, projectId = null, asOf = null }) {
    this._raw = raw;
    this._project = project;
    // Fold the document-embedded vocab-links (under raw's token layers) into the
    // separately-loaded vocabularies — `vocabLayers.get` returns items but not
    // links, so this is the only way links survive a fresh load. See
    // mergeRawVocabLinks. Reload re-folds explicitly (it bypasses the ctor).
    this._vocabularies = mergeRawVocabLinks(raw, vocabularies);
    this._client = client;
    this._projectId = projectId;
    // The as-of timestamp this doc was loaded at (null = live). Threaded through
    // _reload so a resync during time-travel stays on the historical snapshot
    // instead of silently jumping to live data.
    this._asOf = asOf;
    this._version = 0;
    // Bumps only when `_raw`/`_vocabularies` actually change (via _applyRawPatch
    // / _reload), NOT on isSaving/error-only emits. Derived caches and the
    // vanilla island gate on this so transient saving toggles don't rebuild the
    // grid or jitter input focus (see plaid-ud's _dataVersion lesson).
    this._dataVersion = 0;
    this._listeners = new Set();
    this._isSaving = false;
    this._error = '';
    // Optional sink for surfacing errors loudly (e.g. a toast). Framework-agnostic:
    // the React mount wrapper sets this to notifyError; tests leave it null.
    this.onError = null;

    // Per-data-version caches. Each is gated on `*CacheVersion === this._dataVersion`.
    this._layerInfoCache = null;
    this._layerInfoCacheVersion = -1;
    this._documentDataCache = null;
    this._documentDataCacheVersion = -1;
    this._sentencesBundleCache = null;
    this._sentencesBundleCacheVersion = -1;
    this._alignmentTokensCache = null;
    this._alignmentTokensCacheVersion = -1;
  }

  // Convenience factory: fetch document + project + project vocabularies and
  // wrap them in an IgtDocument. Mirror of plaid-ud's ConlluDocument.load.
  // `asOf` (an ISO timestamp) loads a historical snapshot for time-travel /
  // read-only viewing; omit/null for the live document.
  static async load(client, projectId, documentId, asOf = null) {
    const at = asOf || undefined;
    const [raw, project] = await Promise.all([
      client.documents.get(documentId, true, at),
      client.projects.get(projectId, at)
    ]);
    const { vocabularies } = await loadProjectVocabularies(client, project, at);
    return new IgtDocument({ raw, project, vocabularies, client, projectId, asOf });
  }

  // ----- read API -----
  get version() { return this._version; }
  get dataVersion() { return this._dataVersion; }
  get raw() { return this._raw; }
  get id() { return this._raw?.id; }
  get name() { return this._raw?.name; }
  get client() { return this._client; }
  get projectId() { return this._projectId; }
  get project() { return this._project; }
  get vocabularies() { return this._vocabularies; }
  get isSaving() { return this._isSaving; }
  get error() { return this._error; }

  get layerInfo() {
    if (this._layerInfoCacheVersion !== this._dataVersion) {
      this._layerInfoCache = getIgtLayerInfo(this._raw);
      this._layerInfoCacheVersion = this._dataVersion;
    }
    return this._layerInfoCache;
  }

  get document() {
    if (this._documentDataCacheVersion !== this._dataVersion) {
      this._documentDataCache = deriveDocumentData(this._raw, this.layerInfo, this._project);
      this._documentDataCacheVersion = this._dataVersion;
    }
    return this._documentDataCache;
  }

  get body() {
    return this.layerInfo.primaryTextLayer?.text?.body ?? '';
  }

  get alignmentTokens() {
    if (this._alignmentTokensCacheVersion !== this._dataVersion) {
      this._alignmentTokensCache = deriveAlignmentTokens(this.layerInfo);
      this._alignmentTokensCacheVersion = this._dataVersion;
    }
    return this._alignmentTokensCache;
  }

  // Sentences + lookup maps share one derivation; expose individually for
  // ergonomic consumer access.
  _sentencesBundle() {
    if (this._sentencesBundleCacheVersion !== this._dataVersion) {
      this._sentencesBundleCache = deriveSentences(this._raw, this.layerInfo, this._vocabularies);
      this._sentencesBundleCacheVersion = this._dataVersion;
    }
    return this._sentencesBundleCache;
  }
  get sentences() { return this._sentencesBundle().sentences; }
  get sortedSentences() { return this._sentencesBundle().sortedSentences; }
  get tokenLookup() { return this._sentencesBundle().tokenLookup; }
  get sentenceLookup() { return this._sentencesBundle().sentenceLookup; }
  get tokenPositionMaps() { return this._sentencesBundle().tokenPositionMaps; }
  get sentenceIndexLookup() { return this._sentencesBundle().sentenceIndexLookup; }
  get findSentenceForToken() { return this._sentencesBundle().findSentenceForToken; }

  // ----- subscription bridge (useSyncExternalStore-compatible) -----
  // Arrow-field properties so identities stay stable across renders of the
  // same doc instance.
  subscribe = (listener) => {
    this._listeners.add(listener);
    return () => { this._listeners.delete(listener); };
  };

  getSnapshot = () => this._version;

  _emit() {
    this._version++;
    this._listeners.forEach(fn => fn());
  }

  setError(msg) {
    if (this._error === msg) return;
    this._error = msg;
    if (msg && this.onError) this.onError(msg);
    this._emit();
  }

  clearError() {
    if (!this._error) return;
    this._error = '';
    this._emit();
  }

  // ============================================================
  // Mutation infrastructure
  // ============================================================

  // Single-flight gate around a mutation: skip if already saving, clear the
  // error at the start, capture and surface errors, refetch the document on
  // failure. Returns true on success / false otherwise so callers can branch.
  async _withSaving(label, fn) {
    if (this._isSaving) return false;
    this._isSaving = true;
    this._error = '';
    this._emit();
    try {
      await fn();
      return true;
    } catch (err) {
      console.error(`${label}:`, err);
      this._error = `${label}: ${err.message || 'Unknown error'}`;
      if (this.onError) this.onError(this._error);
      try { await this._reload(); } catch (reloadErr) {
        console.error('Reload after failure also failed:', reloadErr);
      }
      return false;
    } finally {
      this._isSaving = false;
      this._emit();
    }
  }

  // Apply an optimistic local-state patch. The producer receives a deep clone
  // of `_raw` plus a freshly-computed layerInfo for that clone (mutating
  // through `info.primaryTokenLayer.tokens.push(...)` mutates the clone, since
  // layerInfo references are live into raw). The producer's third arg is a
  // mutable shallow clone of `_vocabularies` for link/unlink patches. Emits.
  _applyRawPatch(producer) {
    const next = cloneRaw(this._raw);
    const nextVocabs = cloneVocabs(this._vocabularies);
    producer(next, getIgtLayerInfo(next), nextVocabs);
    this._raw = next;
    this._vocabularies = nextVocabs;
    this._dataVersion++;
    this._emit();
  }

  // Re-fetch the raw document and project vocabularies from the server. Used
  // in `_withSaving` catch-paths and as the "give up and resync" hook for
  // big-bang multi-batch ops where local replay would be too complex.
  async _reload() {
    if (!this._client || !this.id) return;
    const at = this._asOf || undefined;
    const updated = await this._client.documents.get(this.id, true, at);
    this._raw = updated;
    if (this._project) {
      try {
        const { vocabularies: reloaded, failedCount } = await loadProjectVocabularies(this._client, this._project, at);
        this._vocabularies = mergeRawVocabLinks(updated, reloaded);
        if (failedCount > 0 && this.onError) {
          this.onError(`${failedCount} vocabular${failedCount === 1 ? 'y' : 'ies'} could not be refreshed — vocab links may display stale values. Reload the page if they look wrong.`);
        }
      } catch (err) {
        // The document itself reloaded fine — keep it, but tell the user the
        // vocab table is stale rather than silently rendering old links.
        console.warn('Vocab reload failed:', err);
        if (this.onError) this.onError('Vocabulary data could not be refreshed — vocab links may display stale values. Reload the page if they look wrong.');
      }
    }
    this._dataVersion++;
    this._emit();
  }

  // Reconcile-on-open: repair IGT invariants another app may have broken while
  // editing the shared substrate. Currently the morpheme layer: every word must
  // have a full-width morpheme, and morphemes whose extent matches no word are
  // orphans. Heal downward (the word tokenization is authoritative): delete
  // orphan morphemes and create a default morpheme for each bare word. Loud +
  // recoverable. Deliberately NOT via _withSaving (a heal failure must not
  // reload-and-revert the freshly loaded document).
  async reconcileOnOpen() {
    // Single-flight: a concurrent re-entry (StrictMode double-invoke, a rapid
    // re-open) must not double-create morphemes. Set before the first await.
    if (this._reconciling) return { created: 0, deleted: 0, keptAnnotatedOrphans: 0 };
    const info = this.layerInfo;
    const { wordsNeedingMorpheme, orphanMorphemeIds, keptAnnotatedOrphans } = planMorphemeReconcile(info);
    if (!wordsNeedingMorpheme.length && !orphanMorphemeIds.length) {
      return { created: 0, deleted: 0, keptAnnotatedOrphans };
    }
    const morphemeLayer = info.morphemeTokenLayer;
    const textId = info.primaryTextLayer?.text?.id;
    if (!morphemeLayer?.id || !textId) return { created: 0, deleted: 0, keptAnnotatedOrphans };

    this._reconciling = true;
    try {
      this._client.beginBatch();
      if (orphanMorphemeIds.length) this._client.tokens.bulkDelete(orphanMorphemeIds);
      wordsNeedingMorpheme.forEach(w => {
        this._client.tokens.create(morphemeLayer.id, textId, w.begin, w.end, 1);
      });
      const results = await this._client.submitBatch();
      // Op order: the optional bulkDelete first, then one create per bare word.
      const createResults = orphanMorphemeIds.length ? results.slice(1) : results;
      const newIds = createResults.map(r => r?.body?.id ?? r?.id);
      const removed = new Set(orphanMorphemeIds);

      this._applyRawPatch((next, infoNext) => {
        const layer = infoNext.morphemeTokenLayer;
        if (!layer) return;
        if (!Array.isArray(layer.tokens)) layer.tokens = [];
        if (removed.size) layer.tokens = layer.tokens.filter(m => !removed.has(m.id));
        wordsNeedingMorpheme.forEach((w, i) => {
          const id = newIds[i];
          if (id) layer.tokens.push({ id, text: textId, begin: w.begin, end: w.end, precedence: 1, metadata: {} });
        });
      });
      return { created: wordsNeedingMorpheme.length, deleted: orphanMorphemeIds.length, keptAnnotatedOrphans };
    } catch (err) {
      console.error('reconcileOnOpen failed:', err);
      return { created: 0, deleted: 0, keptAnnotatedOrphans, error: err };
    } finally {
      this._reconciling = false;
    }
  }

  // ============================================================
  // Template mutations
  // ============================================================
  // These two methods serve as the canonical template for the mutation
  // mixins. Conventions to follow:
  //
  // - Validate inputs (id lookups, layer presence) OUTSIDE `_withSaving`.
  //   Guard failures use `setError + return false` so an invalid id doesn't
  //   trigger a needless `_reload` via the catch path.
  // - Wrap the server call + optimistic patch in `_withSaving(label, fn)`.
  // - Inside `_applyRawPatch((next, info, vocabs) => ...)`, re-resolve
  //   layers/tokens via `info` — captured outer references point into the
  //   OLD raw doc and mutating through them is a real bug.
  // - For batched ops, the order matters: `submitBatch` runs ops sequentially
  //   server-side, so an op that depends on a prior shift must come AFTER it.
  //
  // updateOrthography — simplest case: single field update with metadata merge.
  // splitToken — complex case: pre-cleanup of dependent tokens, atomic batch
  //              with returned id, multi-step optimistic patch.

  // Set or update a per-orthography metadata key (`orthog:<name>`) on a word
  // token. No optimistic patch is needed beyond writing the metadata entry —
  // orthographies derive from the token's metadata at render time.
  async updateOrthography(tokenId, orthographyName, value) {
    const info = this.layerInfo;
    const token = (info.primaryTokenLayer?.tokens || []).find(t => t.id === tokenId);
    if (!token) {
      this.setError(`Token ${tokenId} not found`);
      return false;
    }
    const nextMetadata = { ...(token.metadata || {}), [`orthog:${orthographyName}`]: value };
    return this._withSaving(`Failed to update ${orthographyName}`, async () => {
      await this._client.tokens.setMetadata(tokenId, nextMetadata);
      this._applyRawPatch((next, infoNext) => {
        const t = (infoNext.primaryTokenLayer?.tokens || []).find(x => x.id === tokenId);
        if (t) t.metadata = nextMetadata;
      });
    });
  }

  // Split a word token at `splitOffset` (relative to token.begin). Wipes any
  // coincident morpheme (same begin/end) in the same atomic batch — the
  // morpheme's analysis is invalidated by the new boundary and the server-
  // side cascade-split would otherwise produce two nonsense morphemes.
  // Returns true on success / false on guard failure or server error.
  async splitToken(tokenId, splitOffset) {
    const info = this.layerInfo;
    const token = (info.primaryTokenLayer?.tokens || []).find(t => t.id === tokenId);
    if (!token) {
      this.setError(`Token ${tokenId} not found`);
      return false;
    }
    return this._withSaving('Failed to split token', async () => {
      const leftEnd = token.begin + splitOffset + 1;
      const coincident = (info.morphemeTokenLayer?.tokens || [])
        .filter(m => m.begin === token.begin && m.end === token.end)
        .map(m => m.id);

      this._client.beginBatch();
      if (coincident.length > 0) this._client.tokens.bulkDelete(coincident);
      this._client.tokens.split(tokenId, leftEnd);
      const results = await this._client.submitBatch();
      // `tokens.split` is the last queued op; its body is `{ id: <new right id> }`.
      const newRightTokenId = results[results.length - 1]?.body?.id;

      this._applyRawPatch((next, infoNext) => {
        const t = (infoNext.primaryTokenLayer?.tokens || []).find(x => x.id === tokenId);
        const originalEnd = token.end;
        if (t) t.end = leftEnd;
        if (newRightTokenId && infoNext.primaryTokenLayer) {
          if (!Array.isArray(infoNext.primaryTokenLayer.tokens)) infoNext.primaryTokenLayer.tokens = [];
          infoNext.primaryTokenLayer.tokens.push({
            id: newRightTokenId,
            text: token.text,
            begin: leftEnd,
            end: originalEnd,
            metadata: {}
          });
        }
        if (coincident.length > 0 && infoNext.morphemeTokenLayer?.tokens) {
          const removed = new Set(coincident);
          infoNext.morphemeTokenLayer.tokens = infoNext.morphemeTokenLayer.tokens.filter(m => !removed.has(m.id));
        }
      });
    });
  }
}

// ----- helper: load project vocabularies -----
// Per-vocab fetch failures don't reject — the rest of the table still loads —
// but they're COUNTED so callers can surface "your vocab data is incomplete"
// instead of silently rendering a partial table. Returns
// { vocabularies, failedCount }.
async function loadProjectVocabularies(client, project, asOf) {
  const vocabIds = (project?.vocabs || []).map(v => v.id);
  if (vocabIds.length === 0) return { vocabularies: {}, failedCount: 0 };
  const results = await Promise.all(vocabIds.map(async id => {
    try { return await client.vocabLayers.get(id, true, asOf || undefined); }
    catch (err) { console.warn(`Error fetching vocab ${id}:`, err); return null; }
  }));
  const vocabularies = {};
  let failedCount = 0;
  results.forEach(v => { if (v) vocabularies[v.id] = v; else failedCount++; });
  return { vocabularies, failedCount };
}

// ----- helper: fold document-embedded vocab-links into loaded vocabularies -----
// `loadProjectVocabularies` (via `vocabLayers.get`) returns each vocab's *items*
// but NOT its vocab-links. The document GET, however, embeds every
// document-scoped vocab-link (each carrying its `vocabItem`) under the token
// layer its tokens belong to: `raw.textLayers[].tokenLayers[].vocabs[].vocabLinks`.
// Fold those links into the matching `vocabularies[vocabId]` so they survive a
// fresh load / reload. Without this, links only ever exist as in-session
// optimistic patches and vanish on the next load — the word/morpheme renders
// unlinked, looking deleted even though the link is still on the server. A
// single vocab's links can be split across several token layers (e.g. word +
// morpheme), so accumulate and dedupe by link id.
function mergeRawVocabLinks(raw, vocabularies) {
  const vocabs = vocabularies || {};
  const seenByVocab = new Map(); // vocabId -> Set<linkId>
  (raw?.textLayers || []).forEach(textLayer => {
    (textLayer.tokenLayers || []).forEach(tokenLayer => {
      (tokenLayer.vocabs || []).forEach(v => {
        if (!v?.id) return;
        let entry = vocabs[v.id];
        if (!entry) entry = vocabs[v.id] = { id: v.id, name: v.name, items: [], vocabLinks: [] };
        if (!Array.isArray(entry.vocabLinks)) entry.vocabLinks = [];
        let seen = seenByVocab.get(v.id);
        if (!seen) {
          seen = new Set(entry.vocabLinks.map(l => l.id));
          seenByVocab.set(v.id, seen);
        }
        (v.vocabLinks || []).forEach(link => {
          if (link && link.id != null && !seen.has(link.id)) {
            seen.add(link.id);
            entry.vocabLinks.push(link);
          }
        });
      });
    });
  });
  return vocabs;
}

// ----- compose mixins onto the prototype -----
// Each mutation family lives in its own file under ./mutations/. Mixins are
// plain objects of methods; Object.assign-ing them onto the prototype lets
// every method see `this` as the IgtDocument instance and call the shared
// helpers (_withSaving, _applyRawPatch, _reload, layerInfo, etc.).
Object.assign(
  IgtDocument.prototype,
  spanMutations,
  tokenMutations,
  sentenceMutations,
  morphemeMutations,
  vocabMutations,
  documentMutations,
  alignmentMutations
);
