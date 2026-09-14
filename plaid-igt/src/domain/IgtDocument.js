import {
  isReviewed,
  mergeMetadata,
  PLAID_NAMESPACE,
  PRESERVE_ON_SPLIT_KEY,
  PROVENANCE_KEYS,
  writerPolicy,
} from '@larc-iu/plaid-client';
import { canManageProject } from '@ui/domain/permissions.js';
import { DocumentModel } from '@ui/domain/DocumentModel.js';
import { newHalfMetadata, survivorPatch } from './tokenReshape.js';
import { getIgtLayerInfo } from './layerInfo.js';
import { readSpeakers, IGT_NAMESPACE } from './igtConfig.js';
import {
  planMorphemeReconcile,
  planSpanDedup,
  planVocabLinkDedup,
  applyVocabLinkDedup,
  planMorphTypeSync,
  describeReconcile as describeIgtReconcile,
  planPreserveOnSplit,
  planFieldLangBackfill,
  planVocabFieldLangBackfill,
} from './igtReconcile.js';
import { validateIgtDocument } from './validate.js';
import { deriveDocumentData, deriveSentences, deriveAlignmentTokens } from './derive.js';

import { spanMutations } from './mutations/spans.js';
import { tokenMutations } from './mutations/tokens.js';
import { sentenceMutations } from './mutations/sentences.js';
import { morphemeMutations } from './mutations/morphemes.js';
import { vocabMutations } from './mutations/vocab.js';
import { documentMutations } from './mutations/document.js';
import { alignmentMutations } from './mutations/alignment.js';
import { analysisCopyMutations } from './mutations/analysisCopy.js';

const cloneVocabs = (vocabularies) => JSON.parse(JSON.stringify(vocabularies));

// Single source of truth for a loaded plaid-igt document. Wraps a raw
// plaid-client document, knows the IGT layer model (sentences > words >
// morphemes, plus alignment + span layers), owns the optimistic-update
// mutations that used to live in the editor's useXxxOperations hooks, and
// exposes a version-counted subscription so React (or any other UI layer)
// can re-render on change.
//
// Framework-agnostic — no React imports here. The React bridge lives in
// useDocumentModel.js.
//
// Vocab links are scoped on the vocab layer, not the document, so the doc
// also holds the project's loaded vocabularies (`_vocabularies`) and applies
// link/unlink patches to that table in `_applyRawPatch`.
// Audit-log label for a mutation, derived from its "Failed to <verb phrase>"
// error label: "Failed to merge morphemes" → "Merge morphemes". Keeps every
// mutation a labeled logical operation without a second string per call site.
export class IgtDocument extends DocumentModel {
  constructor({
    raw,
    project = null,
    vocabularies = {},
    client = null,
    projectId = null,
    asOf = null,
    user = null,
  }) {
    super({ raw, client, projectId, project, user, asOf });
    this._writer = null;
    // Fold the document-embedded vocab-links (under raw's token layers) into the
    // separately-loaded vocabularies: `vocabLayers.get` returns items but not
    // links, so this is the only way links survive a fresh load. See
    // mergeRawVocabLinks. A reload re-folds explicitly (it bypasses the ctor).
    this._vocabularies = mergeRawVocabLinks(raw, vocabularies);
  }

  // Convenience factory: fetch document + project + project vocabularies and
  // wrap them in an IgtDocument. Mirror of plaid-ud's ConlluDocument.load.
  // `asOf` (an ISO timestamp) loads a historical snapshot for time-travel /
  // read-only viewing; omit/null for the live document.
  static async load(client, projectId, documentId, asOf = null, { user = null } = {}) {
    const at = asOf || undefined;
    // Time-travel (as-of) is supported ONLY on document GETs server-side; passing
    // an as-of to the project or vocab GETs 400s ("not supported on this endpoint")
    // and dead-ends the editor. Load the document AT the snapshot, but project
    // config + vocab live (layer structure is immutable; live vocab is fine for a
    // read-only historical view).
    // The vocabularies need only the project, so they download alongside the
    // document instead of after it (a large document is seconds of transfer).
    const projectP = client.projects.get(projectId);
    const [raw, project, { vocabularies }] = await Promise.all([
      client.documents.get(documentId, true, at),
      projectP,
      projectP.then((project) => loadProjectVocabularies(client, project)),
    ]);
    return new IgtDocument({ raw, project, vocabularies, client, projectId, asOf, user });
  }

  // Re-read ONLY the document at `asOf`, reusing the project and vocabulary
  // items already in memory. Returns a NEW IgtDocument; `this` is left
  // untouched so the caller can keep rendering it until it swaps.
  //
  // Time-travel used to be a single `documents.get` with an as-of. Unifying the
  // editor on IgtDocument (0ca1cbb) turned every history-rail click into a full
  // four-request `load` — project, document, item-level query, and every vocab
  // layer — measured at ~1.4s against a real project, most of it the vocab
  // fetch. Only the document is snapshot-dependent: `load` deliberately reads
  // project config and vocab LIVE even for a historical view (layer structure is
  // immutable), so re-fetching those per click could not return anything new.
  _snapshot(raw, asOf) {
    return new IgtDocument({
      raw,
      project: this._project,
      // The constructor folds the document's links into whatever it is handed,
      // so hand it the items with the PREVIOUS snapshot's links stripped.
      vocabularies: rebaseVocabLinks(this._vocabularies),
      client: this._client,
      projectId: this._projectId,
      asOf,
      user: this._user,
    });
  }

  // ----- who is writing (provenance) -----
  // The provenance convention tells a VERIFIER from a CONTRIBUTOR: a
  // verifier's work stands as human-made and their edits confirm machine or
  // contributed material; a contributor's work is stamped contributed until a
  // verifier confirms it. Whose work is reviewed is the project's call, under
  // the cross-app `plaid.review` config (isReviewed); a document with no user
  // (scripts, imports, tests) writes as a verifier. The policy itself, what
  // each writer's creates, edits and confirms carry and what their review
  // gestures act on, is the client's writerPolicy; the mutations and the
  // editor read it through the accessors below.

  /** The contributor's user id, or null when the writer is a verifier. */
  get contributorId() {
    const user = this._user;
    if (!user?.id || !this._project) return null;
    return isReviewed(this._project, user.id, { isAdmin: !!user.isAdmin }) ? user.id : null;
  }

  /** The writer's policy (see plaid-client's writerPolicy), for the current user. */
  get writer() {
    const id = this.contributorId;
    if (!this._writer || this._writer.contributorId !== id) this._writer = writerPolicy(id);
    return this._writer;
  }

  get isContributor() {
    return this.writer.isContributor;
  }
  get createStamp() {
    return this.writer.createStamp;
  }
  editStamp(metadata) {
    return this.writer.editStamp(metadata);
  }
  reviewable(metadata) {
    return this.writer.reviewable(metadata);
  }
  reviewableState(state) {
    return this.writer.reviewableState(state);
  }
  confirmStamp(metadata) {
    return this.writer.confirmStamp(metadata);
  }
  adoptStamp(source, detail) {
    return this.writer.adoptStamp(source, detail);
  }

  // ----- read API -----
  get vocabularies() {
    return this._vocabularies;
  }

  get layerInfo() {
    return this._derived('layerInfo', () => getIgtLayerInfo(this._raw));
  }

  // The document's metadata as stored, including keys no metadata field is
  // configured for: `document.metadata` carries only the configured ones, and
  // the marks importers and the Media tab leave are not among them.
  get storedMetadata() {
    return this._raw?.metadata || {};
  }

  get document() {
    return this._derived('document', () =>
      deriveDocumentData(this._raw, this.layerInfo, this._project),
    );
  }

  get body() {
    return this.layerInfo.primaryTextLayer?.text?.body ?? '';
  }

  get alignmentTokens() {
    return this._derived('alignmentTokens', () => deriveAlignmentTokens(this.layerInfo));
  }

  // Speaker-label suggestions for the diarization autocomplete: every speaker
  // actually in use on this document's alignment tokens (live, always fresh)
  // unioned with the project-level `config.igt.speakers` cache (names used in
  // OTHER documents — see `_rememberSpeaker`). Sorted, de-duped, blanks dropped.
  get knownSpeakers() {
    const set = new Set(readSpeakers(this._project?.config));
    for (const t of this.alignmentTokens) {
      const s = t.metadata?.speaker;
      if (s) set.add(s);
    }
    return [...set].filter((s) => typeof s === 'string' && s.trim() !== '').sort();
  }

  // Best-effort append of a newly-used speaker to the project's suggestion
  // cache so it surfaces in other documents. Never throws and never fails the
  // alignment write that triggered it: the live source of truth is the token
  // metadata, this is only autocomplete sugar. A no-op when the name is blank,
  // already cached, or the user lacks project-config write access.
  async _rememberSpeaker(name) {
    const speaker = (name || '').trim();
    if (!speaker || !this._client || !this._projectId) return;
    const known = readSpeakers(this._project?.config);
    if (known.includes(speaker)) return;
    const next = [...known, speaker];
    try {
      await this._client.projects.setConfig(this._projectId, IGT_NAMESPACE, 'speakers', next);
      if (this._project) {
        this._project.config = this._project.config || {};
        this._project.config[IGT_NAMESPACE] = {
          ...(this._project.config[IGT_NAMESPACE] || {}),
          speakers: next,
        };
        this._emit();
      }
    } catch (err) {
      console.warn('Could not record speaker in project config:', err);
    }
  }

  // Sentences + lookup maps share one derivation; expose individually for
  // ergonomic consumer access.
  _sentencesBundle() {
    return this._derived('sentences', () =>
      deriveSentences(this._raw, this.layerInfo, this._vocabularies),
    );
  }
  get sentences() {
    return this._sentencesBundle().sentences;
  }
  get sortedSentences() {
    return this._sentencesBundle().sortedSentences;
  }
  get tokenLookup() {
    return this._sentencesBundle().tokenLookup;
  }
  get sentenceLookup() {
    return this._sentencesBundle().sentenceLookup;
  }
  get tokenPositionMaps() {
    return this._sentencesBundle().tokenPositionMaps;
  }
  get sentenceIndexLookup() {
    return this._sentencesBundle().sentenceIndexLookup;
  }
  get findSentenceForToken() {
    return this._sentencesBundle().findSentenceForToken;
  }

  // ============================================================
  // Mutation infrastructure (the lifecycle itself is DocumentModel's)
  // ============================================================

  // A patch producer receives the clone of `_raw`, a freshly computed layerInfo
  // for that clone (mutating through `info.primaryTokenLayer.tokens.push(...)`
  // mutates the clone, since layerInfo references are live into raw), and a
  // mutable clone of `_vocabularies` for link and unlink patches.
  _patchContext(next) {
    return [getIgtLayerInfo(next), cloneVocabs(this._vocabularies)];
  }
  _afterPatch(next, [, nextVocabs]) {
    this._vocabularies = nextVocabs;
  }

  // A reload refreshes the project vocabularies with the document, at the same
  // snapshot. The document itself is kept even when the vocabularies cannot
  // be: the user is told the links may be stale rather than shown old ones
  // silently.
  async _adoptReload(updated) {
    if (!this._project) return;
    const at = this._asOf || undefined;
    try {
      const { vocabularies: reloaded, failedCount } = await loadProjectVocabularies(
        this._client,
        this._project,
        at,
      );
      this._vocabularies = mergeRawVocabLinks(updated, reloaded);
      if (failedCount > 0 && this.onError) {
        this.onError(
          `${failedCount} vocabular${failedCount === 1 ? 'y' : 'ies'} could not be refreshed. Vocab links may display stale values. Reload the page if they look wrong.`,
        );
      }
    } catch (err) {
      console.warn('Vocab reload failed:', err);
      if (this.onError)
        this.onError(
          'Vocabulary data could not be refreshed. Vocab links may display stale values. Reload the page if they look wrong.',
        );
    }
  }

  // Reconcile-on-open: repair IGT invariants another app may have broken while
  // editing the shared substrate, then validate what remains. Repairs:
  //  - Morphemes: a morpheme whose extent matches no word is an orphan (e.g.
  //    left behind when another app merges two words). Heal downward (the word
  //    tokenization is authoritative) by deleting EVERY orphan, including
  //    annotated ones (the gloss loss is rare and recoverable via document
  //    history; a kept orphan was invisible+immortal). A word with no morpheme
  //    is NOT repaired here: derive synthesizes one and the first write makes
  //    it real, so there is nothing to write on open (virtualMorpheme.js).
  //  - Duplicate spans at any scope (word/morpheme/sentence): a token merge
  //    elsewhere reparents the dying token's spans onto the survivor, leaving
  //    >1 span per layer — invisible here (derive renders only the first). Heal
  //    losslessly: concatenate distinct values into the first span and delete
  //    the rest, so a human can revise the joined value.
  // Then run validateIgtDocument over the healed state: residual heal failures
  // and un-healable app-contract violations come back as `findings` for the
  // caller to log + toast. Loud + recoverable. Deliberately NOT via _withSaving
  // (a heal failure must not reload-and-revert the freshly loaded document).
  // Every heal write folds under ONE audit entry, relabelled by
  // `describeReconcile` to name the repair that ran (no entry at all when
  // nothing needed healing, since groups are created lazily by the first
  // write).
  describeReconcile(result) {
    return describeIgtReconcile(result);
  }

  // Declared on the layer so a split in ANY app preserves it, including one
  // that has never heard of these keys. Maintainers only, since it is layer
  // config; a failure is not worth interrupting anyone over, because nothing
  // is worse than it was.
  async _backfillPreserveOnSplit(info) {
    if (!canManageProject(this._project, this._user)) return;
    const ids = planPreserveOnSplit(info, PLAID_NAMESPACE, PRESERVE_ON_SPLIT_KEY, PROVENANCE_KEYS);
    for (const id of ids) {
      try {
        await this._client.tokenLayers.setConfig(id, PLAID_NAMESPACE, PRESERVE_ON_SPLIT_KEY, [
          ...PROVENANCE_KEYS,
        ]);
      } catch (err) {
        console.error('Could not declare preserveOnSplit on a layer:', err);
        return;
      }
    }
  }

  // A field's language, recorded from its name once: "Gloss (nl)" was how the
  // FLEx importer said "nl" before fields recorded a language, and the
  // exporters read the record now, not the name. Maintainers only, and a
  // failure is not worth interrupting anyone over.
  async _backfillFieldLangs(info) {
    if (!canManageProject(this._project, this._user)) return;
    const spanLayers = Object.values(info.spanLayers || {}).flat();
    try {
      for (const { id, lang } of planFieldLangBackfill(spanLayers)) {
        await this._client.spanLayers.setConfig(id, IGT_NAMESPACE, 'lang', lang);
      }
      for (const vocab of Object.values(this._vocabularies || {})) {
        const fields = planVocabFieldLangBackfill(vocab);
        if (fields) {
          await this._client.vocabLayers.setConfig(vocab.id, IGT_NAMESPACE, 'fields', fields);
        }
      }
    } catch (err) {
      console.error('Could not record a field language:', err);
    }
  }

  async _reconcile() {
    const ZERO = {
      deleted: 0,
      deletedAnnotatedOrphans: 0,
      dedupedSpans: 0,
      dedupedLinks: 0,
      syncedMorphTypes: 0,
      findings: [],
    };
    // Single-flight: a concurrent re-entry (StrictMode double-invoke, a rapid
    // re-open) must not double-create morphemes.
    if (this._reconciling) return ZERO;
    this._reconciling = true;
    try {
      const info = this.layerInfo;
      // Back-fill, the reconcile contract's second step: a project made before
      // `preserveOnSplit` existed picks it up the next time a maintainer opens
      // a document. It has to be in place BEFORE a split, since provenance lost
      // that way leaves nothing for a later pass to find.
      await this._backfillPreserveOnSplit(info);
      await this._backfillFieldLangs(info);
      const { orphanMorphemeIds, deletedAnnotatedOrphans } = planMorphemeReconcile(info);
      const dedupPlans = planSpanDedup(info);
      const linkPlans = planVocabLinkDedup(this._vocabularies);
      const typePlans = planMorphTypeSync(this.sentences);

      const morphemeLayer = info.morphemeTokenLayer;
      const morphemeWork = Boolean(morphemeLayer?.id && orphanMorphemeIds.length);

      if (morphemeWork || dedupPlans.length || linkPlans.length || typePlans.length) {
        await this._client.batched(async (b) => {
          if (morphemeWork) b.tokens.bulkDelete(orphanMorphemeIds);
          dedupPlans.forEach((p) => {
            if (p.needsUpdate) b.spans.update(p.keepSpanId, p.mergedValue);
            p.deleteSpanIds.forEach((id) => b.spans.delete(id));
          });
          linkPlans.forEach((p) => {
            p.deleteLinks.forEach((l) => b.vocabLinks.delete(l.linkId));
          });
          // Cached morph types that drifted from their lexicon entry's.
          typePlans.forEach((p) => {
            b.tokens.patchMetadata(p.morphemeId, { morphType: p.morphType });
          });
        });
        const removed = new Set(orphanMorphemeIds);

        this._applyRawPatch((next, infoNext, vocabs) => {
          if (linkPlans.length) applyVocabLinkDedup(vocabs, linkPlans);
          if (typePlans.length) {
            const byId = new Map(typePlans.map((p) => [p.morphemeId, p.morphType]));
            (infoNext.morphemeTokenLayer?.tokens || []).forEach((m) => {
              if (byId.has(m.id)) m.metadata = { ...(m.metadata || {}), morphType: byId.get(m.id) };
            });
          }
          if (morphemeWork) {
            const layer = infoNext.morphemeTokenLayer;
            if (layer && Array.isArray(layer.tokens)) {
              layer.tokens = layer.tokens.filter((m) => !removed.has(m.id));
            }
          }
          if (dedupPlans.length) {
            // Dedup can happen at any scope, so index every span layer by id.
            const byId = new Map(
              [
                ...(infoNext.spanLayers?.word || []),
                ...(infoNext.spanLayers?.morpheme || []),
                ...(infoNext.spanLayers?.sentence || []),
              ].map((sl) => [sl.id, sl]),
            );
            dedupPlans.forEach((p) => {
              const sl = byId.get(p.layerId);
              if (!sl || !Array.isArray(sl.spans)) return;
              const dead = new Set(p.deleteSpanIds);
              sl.spans = sl.spans.filter((s) => !dead.has(s.id));
              const keep = sl.spans.find((s) => s.id === p.keepSpanId);
              if (keep && p.needsUpdate) keep.value = p.mergedValue;
            });
          }
        });
      }

      // Validate AFTER healing — whether or not anything was healed — so a heal
      // that silently failed, or an un-healable app-contract violation, still
      // surfaces. validate is pure + read-only; the caller logs + toasts.
      const findings = validateIgtDocument(this.layerInfo, this.alignmentTokens, {
        sentences: this.sentences,
        vocabularies: this._vocabularies,
      });

      return {
        deleted: morphemeWork ? orphanMorphemeIds.length : 0,
        deletedAnnotatedOrphans,
        dedupedSpans: dedupPlans.reduce((n, p) => n + p.deleteSpanIds.length, 0),
        dedupedLinks: linkPlans.reduce((n, p) => n + p.deleteLinks.length, 0),
        syncedMorphTypes: typePlans.length,
        findings,
      };
    } catch (err) {
      console.error('reconcileOnOpen failed:', err);
      return { ...ZERO, error: err };
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
  // - Inside `_client.batched(async (b) => ...)`, every write goes on `b`: a
  //   write made on `this._client` there leaves the transaction.
  // - For batched ops, the order matters: the server runs a batch's ops
  //   sequentially, so an op that depends on a prior shift must come AFTER it.
  //
  // updateOrthography — simplest case: single field update with metadata merge.
  // splitToken — complex case: pre-cleanup of dependent tokens, atomic batch
  //              with returned id, multi-step optimistic patch.

  // Set or update a per-orthography metadata key (`orthog:<name>`) on a word
  // token. No optimistic patch is needed beyond writing the metadata entry —
  // orthographies derive from the token's metadata at render time.
  async updateOrthography(tokenId, orthographyName, value) {
    const info = this.layerInfo;
    const token = (info.primaryTokenLayer?.tokens || []).find((t) => t.id === tokenId);
    if (!token) {
      this.setError(`Token ${tokenId} not found`);
      return false;
    }
    const nextMetadata = { ...(token.metadata || {}), [`orthog:${orthographyName}`]: value };
    return this._withSaving(`Failed to update ${orthographyName}`, async () => {
      await this._client.tokens.setMetadata(tokenId, nextMetadata);
      this._applyRawPatch((next, infoNext) => {
        const t = (infoNext.primaryTokenLayer?.tokens || []).find((x) => x.id === tokenId);
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
    const token = (info.primaryTokenLayer?.tokens || []).find((t) => t.id === tokenId);
    if (!token) {
      this.setError(`Token ${tokenId} not found`);
      return false;
    }
    return this._withSaving('Failed to split token', async () => {
      const leftEnd = token.begin + splitOffset + 1;
      const coincident = (info.morphemeTokenLayer?.tokens || [])
        .filter((m) => m.begin === token.begin && m.end === token.end)
        .map((m) => m.id);

      const results = await this._client.batched(async (b) => {
        if (coincident.length > 0) b.tokens.bulkDelete(coincident);
        b.tokens.split(tokenId, leftEnd);
      });
      // `tokens.split` is the last queued op; its body is `{ id: <new right id> }`.
      const newRightTokenId = results[results.length - 1]?.body?.id;

      // What the two halves carry: see domain/tokenReshape.js. The server
      // leaves the left half's metadata alone and gives the right half none,
      // which would render one word as two different kinds of thing and leave
      // a transcription of the whole word on a half of it.
      const leftPatch = survivorPatch(token.metadata, {}, (m) => this.editStamp(m));
      const rightMetadata = newHalfMetadata(token.metadata, (m) => this.editStamp(m));
      if (leftPatch || (newRightTokenId && rightMetadata)) {
        await this._client.batched(async (b) => {
          if (leftPatch) b.tokens.patchMetadata(tokenId, leftPatch);
          if (newRightTokenId && rightMetadata)
            b.tokens.patchMetadata(newRightTokenId, rightMetadata);
        });
      }

      this._applyRawPatch((next, infoNext) => {
        const t = (infoNext.primaryTokenLayer?.tokens || []).find((x) => x.id === tokenId);
        const originalEnd = token.end;
        if (t) {
          t.end = leftEnd;
          if (leftPatch) t.metadata = mergeMetadata(t.metadata || {}, leftPatch);
        }
        if (newRightTokenId && infoNext.primaryTokenLayer) {
          if (!Array.isArray(infoNext.primaryTokenLayer.tokens))
            infoNext.primaryTokenLayer.tokens = [];
          infoNext.primaryTokenLayer.tokens.push({
            id: newRightTokenId,
            begin: leftEnd,
            end: originalEnd,
            metadata: rightMetadata ? { ...rightMetadata } : {},
          });
        }
        if (coincident.length > 0 && infoNext.morphemeTokenLayer?.tokens) {
          const removed = new Set(coincident);
          infoNext.morphemeTokenLayer.tokens = infoNext.morphemeTokenLayer.tokens.filter(
            (m) => !removed.has(m.id),
          );
        }
      });
    });
  }
}

// ----- helper: load project vocabularies -----
// Per-vocab fetch failures don't reject — the rest of the table still loads —
// but they're COUNTED so callers can surface "your vocab data is incomplete"
// instead of silently rendering a partial table. Returns
// { vocabularies, failedCount }. Exported for callers that construct
// IgtDocuments from pre-fetched parts (e.g. export/runExport.js).
export async function loadProjectVocabularies(client, project, asOf) {
  const vocabIds = (project?.vocabs || []).map((v) => v.id);
  if (vocabIds.length === 0) return { vocabularies: {}, failedCount: 0 };
  const results = await Promise.all(
    vocabIds.map(async (id) => {
      try {
        return await client.vocabLayers.get(id, true, asOf || undefined);
      } catch (err) {
        console.warn(`Error fetching vocab ${id}:`, err);
        return null;
      }
    }),
  );
  const vocabularies = {};
  let failedCount = 0;
  results.forEach((v) => {
    if (v) vocabularies[v.id] = v;
    else failedCount++;
  });
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
// `vocabLayers.get` returns items but NOT links — links live on the document and
// are folded in by mergeRawVocabLinks, which mutates the object it is given.
// Strip those folded links so the same (expensive) item arrays can be re-folded
// against a different snapshot. This is why `_reload` re-fetches instead of
// re-merging: merging a second raw onto an already-merged set would keep the
// first snapshot's links.
export function rebaseVocabLinks(vocabularies) {
  const out = {};
  for (const [id, v] of Object.entries(vocabularies || {})) {
    out[id] = { ...v, vocabLinks: [] };
  }
  return out;
}

function mergeRawVocabLinks(raw, vocabularies) {
  const vocabs = vocabularies || {};
  const seenByVocab = new Map(); // vocabId -> Set<linkId>
  (raw?.textLayers || []).forEach((textLayer) => {
    (textLayer.tokenLayers || []).forEach((tokenLayer) => {
      (tokenLayer.vocabs || []).forEach((v) => {
        if (!v?.id) return;
        let entry = vocabs[v.id];
        if (!entry) entry = vocabs[v.id] = { id: v.id, name: v.name, items: [], vocabLinks: [] };
        if (!Array.isArray(entry.vocabLinks)) entry.vocabLinks = [];
        let seen = seenByVocab.get(v.id);
        if (!seen) {
          seen = new Set(entry.vocabLinks.map((l) => l.id));
          seenByVocab.set(v.id, seen);
        }
        (v.vocabLinks || []).forEach((link) => {
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
  alignmentMutations,
  analysisCopyMutations,
);
