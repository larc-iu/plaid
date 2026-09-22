import {
  cpLength,
  cpSlice,
  isMachine,
  isReviewed,
  mergeMetadata,
  PLAID_NAMESPACE,
  PRESERVE_ON_SPLIT_KEY,
  PROVENANCE_KEYS,
  writerPolicy,
} from '@larc-iu/plaid-client';
// By its real path rather than through `@ui`: this file is loaded by the
// `node --test` suite, where no alias exists. It is the same file the alias
// resolves to, and it imports nothing itself, which is what lets node load it.
import { canManageProject } from '../../../plaid-ui/src/domain/permissions.js';
import { DocumentModel } from '../../../plaid-ui/src/domain/DocumentModel.js';
import {
  getUdLayerInfo,
  containsToken,
  readProjectLanguage,
  dependencyRelationLayers,
} from '../utils/udLayerUtils.js';
import { SUPPRESS_KEY, isSuppressor, suppressorFor } from './enhancedGraph.js';
import {
  interSententialRelationIds,
  relationsCrossing,
  staleSuppressorIds,
  wordsNeedingSyntacticWord,
  orphanSyntacticWords,
  planSpanDedup,
  planPreserveOnSplit,
  describeReconcile as describeUdReconcile,
} from '../utils/udReconcile.js';
import { validateConlluDocument } from './validate.js';
import { importConlluDocument } from './conlluImport.js';
import { buildSentenceRows } from './sentenceRows.js';
import { buildConllu, conlluLosses } from './conlluSerialize.js';
import { ensureEnhancedRelationLayer } from './udProjectSetup.js';
import { basicTokenize, newlineSentenceRanges } from '../utils/basicTokenize.js';
import { normalizeFeature, featureRefusal } from '../utils/feats.js';

export class ConlluDocument extends DocumentModel {
  constructor({ raw, client = null, projectId = null, project = null, user = null, asOf = null }) {
    super({ raw, client, projectId, project, user, asOf });
    this._writer = null;
  }

  // Convenience factory: fetch a document by id and wrap it. `project` and
  // `user`, when given, make the document write as that person (see `writer`).
  static async load(client, projectId, documentId, { project = null, user = null } = {}) {
    const raw = await client.documents.get(documentId, true);
    return new ConlluDocument({ raw, client, projectId, project, user });
  }

  _snapshot(raw, asOf) {
    return new ConlluDocument({
      raw,
      client: this._client,
      projectId: this._projectId,
      project: this._project,
      user: this._user,
      asOf,
    });
  }

  // ----- who is writing (provenance) -----
  // Whose work is reviewed is the project's call, under the cross-app
  // `plaid.review` config (isReviewed). A reviewed person is a CONTRIBUTOR,
  // whose creates and edits are stamped contributed until a verifier confirms
  // them; everyone else, and a document with no user, is a VERIFIER, whose
  // edits and confirmations settle machine or contributed material. The
  // policy is the client's writerPolicy; every human write below reads it.

  /** The contributor's user id, or null when the writer is a verifier. */
  get contributorId() {
    const user = this._user;
    if (!user?.id || !this._project) return null;
    return isReviewed(this._project, user.id, { isAdmin: !!user.isAdmin }) ? user.id : null;
  }

  /** The writer's policy (plaid-client's writerPolicy) for the current user. */
  get writer() {
    const id = this.contributorId;
    if (!this._writer || this._writer.contributorId !== id) this._writer = writerPolicy(id);
    return this._writer;
  }

  // Import a CoNLL-U text into a new document in the given project. The work
  // is `importConlluDocument`, which reads no loaded document at all: this is
  // the name every caller knows it by.
  static importFromConllu(client, projectId, name, conlluText, precomputedLayerInfo = null) {
    return importConlluDocument(client, projectId, name, conlluText, precomputedLayerInfo);
  }

  // ----- layer info (cached per data version) -----
  get layerInfo() {
    return this._derived('layerInfo', () => getUdLayerInfo(this._raw));
  }

  get body() {
    return this.layerInfo.textLayer?.text?.body ?? '';
  }

  // ----- derived sentence/word/morpheme hierarchy (cached per version) -----
  get sentences() {
    return this._derived('sentences', () => this._buildSentences());
  }

  // The rows come from `buildSentenceRows`, which needs nothing but the body
  // and the layer info.
  _buildSentences() {
    return buildSentenceRows(this.body, this.layerInfo);
  }

  // ============================================================
  // Mutation infrastructure (the lifecycle itself is DocumentModel's)
  // ============================================================

  // A patch producer receives the clone of `_raw` and a freshly computed
  // layerInfo for that clone.
  _patchContext(next) {
    return [getUdLayerInfo(next)];
  }

  // ============================================================
  // Document-level operations
  // ============================================================

  // Rename the document. Optimistic like every other update: the new name is
  // in the raw document before the round trip, so the breadcrumb and the tab
  // strip follow immediately rather than after it.
  async rename(name) {
    const next = name.trim();
    if (!next || next === this.name) return false;
    return this._withSaving('Failed to rename document', async () => {
      this._applyRawPatch((raw) => {
        raw.name = next;
      });
      await this._client.documents.update(this.id, next);
    });
  }

  // Copy the document into the same project. NOT optimistic and not a patch of
  // this document: the copy is a different document with a server-minted id,
  // and the caller navigates to it. Returns the new document, or null.
  //
  // Same project only, and comments do not travel, which is the server's
  // ruling, not this method's choice.
  async copyTo(name) {
    let created = null;
    const ok = await this._withSaving('Failed to copy document', async () => {
      created = await this._client.documents.copy(this.id, name.trim() || `${this.name} (copy)`);
    });
    return ok ? created : null;
  }

  /** The document's own metadata, never null. */
  get metadata() {
    return this._raw?.metadata || {};
  }

  // Write one document metadata field. An empty value DELETES the key rather
  // than storing a blank, so a field cleared in the UI stops exporting instead
  // of exporting an empty `# key =` line.
  //
  // A PATCH, not a replace: another app sharing this document may keep its own
  // keys here, and a full setMetadata would take them with it.
  async setDocumentMetadata(key, value) {
    const next = value == null || value === '' ? null : String(value);
    if ((this.metadata[key] ?? null) === next) return false;
    return this._withSaving(
      'Failed to save document metadata',
      async () => {
        this._applyRawPatch((raw) => {
          raw.metadata = mergeMetadata(raw.metadata, { [key]: next });
        });
        await this._client.documents.patchMetadata(this.id, { [key]: next });
      },
      `Set document ${key}`,
    );
  }

  // Write one sentence metadata field, on the SENTENCE TOKEN, where CoNLL-U's
  // `# k = v` lines have always been read from and written back to (see
  // importFromConllu and toConllu). Same delete-on-empty rule as the document
  // level, and the same reason for a PATCH.
  async setSentenceMetadata(sentenceTokenId, key, value) {
    const info = this.layerInfo;
    const token = (info.sentenceTokenLayer?.tokens || []).find((t) => t.id === sentenceTokenId);
    if (!token) return false;
    const next = value == null || value === '' ? null : String(value);
    if ((token.metadata?.[key] ?? null) === next) return false;
    return this._withSaving(
      'Failed to save sentence metadata',
      async () => {
        this._applyRawPatch((raw, infoNext) => {
          for (const t of infoNext.sentenceTokenLayer?.tokens || []) {
            if (t.id === sentenceTokenId) t.metadata = mergeMetadata(t.metadata, { [key]: next });
          }
        });
        await this._client.tokens.patchMetadata(sentenceTokenId, { [key]: next });
      },
      `Set sentence ${key}`,
    );
  }

  // ============================================================
  // Text-layer operations
  // ============================================================

  async saveText(newBody) {
    return this._withSaving('Failed to save text', async () => {
      const { textLayer } = this.layerInfo;
      const text = textLayer?.text;
      if (text?.id) {
        await this._client.texts.update(text.id, newBody);
      } else if (textLayer?.id) {
        await this._client.texts.create(textLayer.id, this.id, newBody);
      }
      await this._reload();
    });
  }

  // ============================================================
  // Token operations
  // ============================================================

  // Whitespace-tokenize the document body into the full sentence > word >
  // morpheme hierarchy. Issues a single atomic batch (sentences -> words
  // -> morphemes) and follows up with default lemma spans for each
  // morpheme.
  async tokenize(textContent) {
    const info = this.layerInfo;
    const text = info.textLayer?.text;
    const { sentenceTokenLayer, wordTokenLayer, morphemeTokenLayer, lemmaLayer } = info;
    const sentenceTokens = sentenceTokenLayer?.tokens || [];
    const wordTokens = wordTokenLayer?.tokens || [];
    const morphemeTokens = morphemeTokenLayer?.tokens || [];

    if (!textContent.trim()) {
      this.setError('No text to tokenize.');
      return false;
    }
    if (!text?.id) {
      this.setError('The text is not saved.');
      return false;
    }
    if (!sentenceTokenLayer?.id || !wordTokenLayer?.id || !morphemeTokenLayer?.id) {
      this.setError('Token layers are not fully configured.');
      return false;
    }
    if (sentenceTokens.length || wordTokens.length || morphemeTokens.length) {
      this.setError('Tokens already exist. Use "Clear tokens" before re-tokenizing.');
      return false;
    }

    return this._withSaving('Failed to create tokens', async () => {
      const body = textContent;

      // Sentences: a gap-free partition of [0, len), broken at runs of newlines.
      const sentenceRanges = newlineSentenceRanges(body);

      // Words: Unicode-aware basic tokenization. Punctuation flanked by
      // letters/digits on both sides stays in the word (contractions,
      // hyphenated forms, abbreviations, decimal numbers); edge or standalone
      // punctuation becomes its own one-character token.
      // Locale drives Intl.Segmenter's script-specific word segmentation
      // (esp. ja/zh/th dictionary lookup). The text layer's own locale wins,
      // since it can carry a script subtag the project language does not
      // (zh-Hans); otherwise the project's language stands in, and 'und' last.
      const tokenizerLocale =
        this.layerInfo.textLayer?.config?.ud?.tokenizerLocale ||
        readProjectLanguage(this._project) ||
        'und';
      const wordRanges = basicTokenize(body, tokenizerLocale);

      let morphemeResultIndex = -1;
      const batchResults = await this._client.batched(async (b) => {
        b.tokens.bulkCreate(
          sentenceRanges.map(([begin, end]) => ({
            tokenLayerId: sentenceTokenLayer.id,
            text: text.id,
            begin,
            end,
          })),
        );
        if (wordRanges.length > 0) {
          b.tokens.bulkCreate(
            wordRanges.map(([begin, end]) => ({
              tokenLayerId: wordTokenLayer.id,
              text: text.id,
              begin,
              end,
            })),
          );
          b.tokens.bulkCreate(
            wordRanges.map(([begin, end]) => ({
              tokenLayerId: morphemeTokenLayer.id,
              text: text.id,
              begin,
              end,
            })),
          );
          morphemeResultIndex = 2;
        }
      });
      const morphemeIds =
        morphemeResultIndex >= 0 ? batchResults[morphemeResultIndex]?.body?.ids || [] : [];

      // Default lemma spans (a follow-up call — they reference the morpheme
      // ids produced above). Let a failure propagate: _withSaving toasts and
      // reloads, which surfaces the committed tokens minus their lemmas
      // rather than silently swallowing the inconsistency.
      if (lemmaLayer?.id && morphemeIds.length) {
        const lemmaOps = morphemeIds.map((tokenId, i) => ({
          spanLayerId: lemmaLayer.id,
          tokens: [tokenId],
          value: cpSlice(body, wordRanges[i][0], wordRanges[i][1]),
        }));
        await this._client.spans.bulkCreate(lemmaOps);
      }

      await this._reload();
    });
  }

  // Clear all tokens by deleting the sentence (root) tokens — cascades to
  // words, morphemes, spans and relations server-side.
  async clearTokens() {
    return this._withSaving('Failed to clear tokens', async () => {
      const { sentenceTokenLayer, wordTokenLayer, morphemeTokenLayer } = this.layerInfo;
      const sentenceTokens = sentenceTokenLayer?.tokens || [];
      const wordTokens = wordTokenLayer?.tokens || [];
      const morphemeTokens = morphemeTokenLayer?.tokens || [];
      if (sentenceTokens.length > 0) {
        await this._client.tokens.bulkDelete(sentenceTokens.map((t) => t.id));
      } else if (wordTokens.length > 0) {
        await this._client.tokens.bulkDelete(wordTokens.map((t) => t.id));
      } else if (morphemeTokens.length > 0) {
        await this._client.tokens.bulkDelete(morphemeTokens.map((t) => t.id));
      }
      await this._reload();
    });
  }

  // Toggle a sentence boundary at a character position (a word's begin
  // offset). The sentence layer is partitioning, so this is a split (add)
  // or merge (remove).
  async toggleSentenceBoundary(charPos) {
    return this._withSaving('Failed to update sentence boundary', async () => {
      const { sentenceTokenLayer } = this.layerInfo;
      const sentenceTokens = sentenceTokenLayer?.tokens || [];

      const startsHere = sentenceTokens.find((s) => s.begin === charPos);
      if (startsHere) {
        // Remove the boundary: merge with the preceding sentence. Merging
        // only widens a sentence, so no dependency relation can become invalid.
        const prevSent = sentenceTokens.find((s) => s.end === charPos);
        if (!prevSent) return;
        await this._client.tokens.merge(prevSent.id, startsHere.id);
        this._applyRawPatch((next, info) => {
          if (info.sentenceTokenLayer?.tokens) {
            const p = info.sentenceTokenLayer.tokens.find((t) => t.id === prevSent.id);
            if (p) p.end = startsHere.end;
            info.sentenceTokenLayer.tokens = info.sentenceTokenLayer.tokens.filter(
              (t) => t.id !== startsHere.id,
            );
          }
        });
        return;
      }

      const containing = sentenceTokens.find((s) => s.begin < charPos && charPos < s.end);
      if (!containing) return;

      // Any dependency relation whose endpoints land on opposite sides of
      // charPos would cross the new sentence boundary; delete those in the
      // same atomic batch as the split so a relation never spans two
      // sentences. (UD relations are sentence-internal — an app-level
      // invariant the server doesn't model.)
      const crossing = relationsCrossing(this.layerInfo, charPos);

      const res = await this._client.batched(async (b) => {
        b.tokens.split(containing.id, charPos);
        crossing.forEach((id) => b.relations.delete(id));
      });
      const newRightSentId = res[0]?.body?.id;
      const removedRelIds = new Set(crossing);

      this._applyRawPatch((next, info) => {
        if (info.sentenceTokenLayer?.tokens) {
          const s = info.sentenceTokenLayer.tokens.find((t) => t.id === containing.id);
          const oldEnd = containing.end;
          if (s) s.end = charPos;
          if (newRightSentId) {
            info.sentenceTokenLayer.tokens.push({
              id: newRightSentId,
              begin: charPos,
              end: oldEnd,
            });
          }
        }
        if (removedRelIds.size) {
          for (const layer of dependencyRelationLayers(info)) {
            if (!Array.isArray(layer.relations)) continue;
            layer.relations = layer.relations.filter((r) => !removedRelIds.has(r.id));
          }
        }
      });
    });
  }

  // Reconcile-on-open: repair UD invariants that another app may have broken
  // while editing the shared substrate, then validate what remains. All repairs
  // heal DOWNWARD toward the substrate (never reverting it), loud + recoverable
  // (ordinary audited writes):
  //   1. Seed a default full-width syntactic-word for every word that lacks one
  //      (another app, e.g. IGT, can leave words bare — UD annotations live on
  //      the syntactic-word layer, so a bare word is invisible/unannotatable).
  //   2. Delete orphan syntactic-words (matching no word) left behind when
  //      another app re-tokenized words — incl. annotated ones (gloss loss is
  //      rare and recoverable via document history; they otherwise render as
  //      spurious extra morphemes).
  //   3. Losslessly dedup duplicate single-valued spans (Form/Lemma/UPOS/XPOS)
  //      on a morpheme (only the first is visible in the grid).
  //   4. Delete dependency relations that now cross a sentence boundary (e.g.
  //      after another app split a sentence), in the tree and in the enhanced
  //      layer alike, and enhanced-layer suppressors whose basic relation has
  //      gone (see enhancedGraph.js).
  // Then run validateConlluDocument over the reloaded state: residual heal
  // failures and un-healable contracts (e.g. a node with >1 head) come back as
  // `findings` for the caller to log + toast.
  // Deliberately NOT via _withSaving: this runs once on a freshly loaded doc,
  // and a heal failure must not trigger _withSaving's reload-and-revert (which
  // would discard the just-loaded doc). A single-flight guard plus the editor's
  // per-document gate keep StrictMode's double-invoke from double-healing (which
  // would otherwise seed duplicate syntactic-words).
  // Every heal write folds under one "Reconcile layers on open" audit entry
  // (no entry at all when nothing needed healing — groups are created lazily
  // by the first write).
  describeReconcile(result) {
    return describeUdReconcile(result);
  }

  // Maintainers only, since it is layer config; a failure is not worth
  // interrupting anyone over, because nothing is worse than it was.
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

  // The same back-fill for the enhanced relation layer, which a project from
  // before it existed lacks. True when a layer was made, so the caller re-reads.
  async _backfillEnhancedLayer(info) {
    if (info.enhancedRelationLayer || !canManageProject(this._project, this._user)) return false;
    try {
      return Boolean(await ensureEnhancedRelationLayer(this._client, info.lemmaLayer));
    } catch (err) {
      console.error('Could not add the enhanced dependency layer:', err);
      return false;
    }
  }

  async _reconcile() {
    const ZERO = {
      deletedRelations: 0,
      createdSyntacticWords: 0,
      deletedOrphans: 0,
      deletedAnnotatedOrphans: 0,
      dedupedSpans: 0,
      findings: [],
    };
    if (this._reconciling) return ZERO;
    this._reconciling = true;
    try {
      const info = this.layerInfo;
      // Back-fill, the reconcile contract's second step. Provenance lost in a
      // split leaves nothing for a later pass to find, so the declaration has
      // to be in place before the split, not repaired after it.
      await this._backfillPreserveOnSplit(info);
      const addedEnhancedLayer = await this._backfillEnhancedLayer(info);
      const crossingIds = interSententialRelationIds(info);
      // A suppressor can be both stale and crossing, and a second delete of
      // one id is a 404 that takes the batch with it.
      const crossingSet = new Set(crossingIds);
      const staleIds = staleSuppressorIds(info).filter((id) => !crossingSet.has(id));
      const relIds = [...crossingIds, ...staleIds];
      const { morphemeTokenLayer, textLayer } = info;
      const textId = textLayer?.text?.id;
      const canHeal = Boolean(morphemeTokenLayer?.id && textId);
      const seedExtents = canHeal ? wordsNeedingSyntacticWord(info) : [];
      const orphans = orphanSyntacticWords(info);
      // Don't dedup spans on orphan tokens we're about to delete (the cascade
      // takes those spans anyway; touching them in the same batch would 404).
      const orphanIdSet = new Set(orphans.ids);
      const dedupPlans = planSpanDedup(info).filter((p) => !orphanIdSet.has(p.tokenId));

      let createdSyntacticWords = 0;
      let deletedRelations = 0;
      let deletedOrphans = 0;
      let dedupedSpans = 0;

      // Batch A (atomic): seed bare words + delete orphan syntactic-words +
      // lossless span dedup. Disjoint targets, all expected to succeed.
      if (seedExtents.length || orphans.ids.length || dedupPlans.length) {
        await this._client.batched(async (b) => {
          if (seedExtents.length) {
            b.tokens.bulkCreate(
              seedExtents.map((e) => ({
                tokenLayerId: morphemeTokenLayer.id,
                text: textId,
                begin: e.begin,
                end: e.end,
                precedence: 0,
              })),
            );
          }
          if (orphans.ids.length) b.tokens.bulkDelete(orphans.ids);
          dedupPlans.forEach((p) => {
            if (p.needsUpdate) b.spans.update(p.keepSpanId, p.mergedValue);
            p.deleteSpanIds.forEach((id) => b.spans.delete(id));
          });
        });
        createdSyntacticWords = seedExtents.length;
        deletedOrphans = orphans.ids.length;
        dedupedSpans = dedupPlans.reduce((n, p) => n + p.deleteSpanIds.length, 0);
      }

      // Batch B (404-tolerant): drop now-inter-sentential dependency relations.
      // A concurrent open may have already deleted them, or an orphan delete
      // above may have cascaded them — treat not-found as success.
      if (relIds.length) {
        try {
          await this._client.batched(async (b) => {
            relIds.forEach((id) => b.relations.delete(id));
          });
        } catch (err) {
          if (err?.status !== 404) throw err;
        }
        // Reported as what the annotator lost. A suppressor is housekeeping,
        // stale or crossing: one that crossed went with the relation it lay
        // over, which is the loss and is counted once.
        const suppressorIds = new Set(
          (info.enhancedRelationLayer?.relations || []).filter(isSuppressor).map((r) => r.id),
        );
        deletedRelations = crossingIds.filter((id) => !suppressorIds.has(id)).length;
      }

      // Re-read only when a heal actually wrote. The batches above land
      // server-side and this instance knows nothing about them, so a heal has
      // to refetch — but a clean pass has nothing to refetch, and its in-memory
      // state IS the server state. This runs behind a blocking spinner on every
      // Annotate open now, so an unconditional reload would make the ordinary
      // case (nothing to repair) pay a full document fetch for the rare one.
      const healed =
        addedEnhancedLayer ||
        createdSyntacticWords + deletedOrphans + dedupedSpans + relIds.length > 0;
      if (healed) await this._reload();
      // Validate the true server state — even when nothing healed.
      const findings = validateConlluDocument(this.layerInfo);
      return {
        deletedRelations,
        createdSyntacticWords,
        deletedOrphans,
        deletedAnnotatedOrphans: orphans.annotatedCount,
        dedupedSpans,
        findings,
      };
    } catch (err) {
      console.error('reconcileOnOpen failed:', err);
      return { ...ZERO, error: err };
    } finally {
      this._reconciling = false;
    }
  }

  // Set a word's morphemes from a list of forms. One form = an ordinary
  // word; multiple forms = a multiword token. Every morpheme spans the
  // FULL word extent (overlap allowed); a Form span carries each morpheme's
  // surface form.
  //
  // Two-batch atomicity: (1) delete-old + create-new morphemes in one
  // atomic batch. (2) Form + Lemma spans for the new morphemes in a second
  // atomic batch (batch ops cannot reference ids created earlier in the
  // same batch).
  async setWordMorphemes(word, forms) {
    const cleanForms = forms.map((f) => (f || '').trim()).filter((f) => f.length > 0);
    if (cleanForms.length === 0) return false;

    return this._withSaving('Failed to set words', async () => {
      const { textLayer, morphemeTokenLayer, lemmaLayer, formLayer } = this.layerInfo;
      const text = textLayer?.text;
      const morphemeTokens = morphemeTokenLayer?.tokens || [];
      if (!morphemeTokenLayer?.id || !text?.id) {
        throw new Error('Word layer not configured');
      }

      // Use the persisted body for the form-vs-substring comparison and for
      // the word's surface form. Morpheme begin/end are in body coordinates,
      // so substring(body, word.begin, word.end) is the authoritative surface.
      const body = this.body;
      const wordSubstring = cpSlice(body, word.begin, word.end);
      const isMwt = cleanForms.length > 1;
      const existingMeta = word.metadata || {};
      // Decide whether the word's metadata needs to change.
      let nextWordMetadata = null;
      if (isMwt) {
        if (existingMeta.form !== wordSubstring) {
          nextWordMetadata = { ...existingMeta, form: wordSubstring };
        }
      } else if (existingMeta.form != null) {
        const { form: _drop, ...remaining } = existingMeta;
        nextWordMetadata = remaining;
      }

      // Batch 1 — atomic morpheme replacement PLUS the word-metadata write
      // (so the server commits or rolls them back together; no window where
      // morphemes exist with stale or missing `metadata.form`).
      const existing = morphemeTokens.filter((m) => containsToken(word, m));
      const setResults = await this._client.batched(async (b) => {
        if (existing.length) b.tokens.bulkDelete(existing.map((m) => m.id));
        b.tokens.bulkCreate(
          cleanForms.map((_, i) => ({
            tokenLayerId: morphemeTokenLayer.id,
            text: text.id,
            begin: word.begin,
            end: word.end,
            precedence: i,
          })),
        );
        if (nextWordMetadata !== null) {
          b.tokens.setMetadata(word.id, nextWordMetadata);
        }
      });
      // bulkCreate sits at index 1 when we issued a bulkDelete, else index 0;
      // setMetadata (if any) is the final op and we don't need its result.
      const createIndex = existing.length ? 1 : 0;
      const ids = setResults[createIndex]?.body?.ids || [];

      // Batch 2 — atomic Form + Lemma spans for the new morphemes. (Separate
      // batch because these ops reference morpheme ids produced above.)
      const formOps = [];
      const lemmaOps = [];
      ids.forEach((tokenId, i) => {
        const form = cleanForms[i];
        if (formLayer?.id && (cleanForms.length > 1 || form !== wordSubstring)) {
          formOps.push({ spanLayerId: formLayer.id, tokens: [tokenId], value: form });
        }
        if (lemmaLayer?.id) {
          lemmaOps.push({ spanLayerId: lemmaLayer.id, tokens: [tokenId], value: form });
        }
      });
      if (formOps.length || lemmaOps.length) {
        await this._client.batched(async (b) => {
          if (formOps.length) b.spans.bulkCreate(formOps);
          if (lemmaOps.length) b.spans.bulkCreate(lemmaOps);
        });
      }

      await this._reload();
    });
  }

  // Delete a word token (cascades its morphemes and their spans + relations
  // server-side). Locally we mirror the cascade so the UI updates
  // immediately without a refetch.
  async deleteWord(wordId) {
    return this._withSaving('Failed to delete token', async () => {
      const { wordTokenLayer, morphemeTokenLayer, lemmaLayer } = this.layerInfo;
      const wordTokens = wordTokenLayer?.tokens || [];
      const morphemeTokens = morphemeTokenLayer?.tokens || [];
      const word = wordTokens.find((w) => w.id === wordId);
      const removedMorphIds = new Set(
        word ? morphemeTokens.filter((m) => containsToken(word, m)).map((m) => m.id) : [],
      );
      const removedLemmaSpanIds = new Set(
        (lemmaLayer?.spans || [])
          .filter((s) => Array.isArray(s.tokens) && s.tokens.some((t) => removedMorphIds.has(t)))
          .map((s) => s.id),
      );
      // Optimistic: remove the word + its cascade locally before the round trip.
      this._applyRawPatch((next, info) => {
        if (info.wordTokenLayer?.tokens) {
          info.wordTokenLayer.tokens = info.wordTokenLayer.tokens.filter((t) => t.id !== wordId);
        }
        if (info.morphemeTokenLayer?.tokens) {
          info.morphemeTokenLayer.tokens = info.morphemeTokenLayer.tokens.filter(
            (t) => !removedMorphIds.has(t.id),
          );
        }
        (info.morphemeTokenLayer?.spanLayers || []).forEach((sl) => {
          if (Array.isArray(sl.spans)) {
            sl.spans = sl.spans.filter(
              (s) => !(Array.isArray(s.tokens) && s.tokens.some((t) => removedMorphIds.has(t))),
            );
          }
        });
        for (const layer of dependencyRelationLayers(info)) {
          if (!Array.isArray(layer.relations)) continue;
          layer.relations = layer.relations.filter(
            (r) => !removedLemmaSpanIds.has(r.source) && !removedLemmaSpanIds.has(r.target),
          );
        }
      });
      await this._client.tokens.delete(wordId);
    });
  }

  // Manually create a word (e.g. from a text selection) plus its 1:1
  // morpheme and a default lemma. Word + morpheme go in one atomic batch
  // (the morpheme nests in the just-created word); the lemma span follows
  // since it needs the morpheme id.
  async createWord(begin, end, textContent) {
    const info = this.layerInfo;
    const { textLayer, sentenceTokenLayer, wordTokenLayer, morphemeTokenLayer, lemmaLayer } = info;
    const text = textLayer?.text;
    const sentenceTokens = sentenceTokenLayer?.tokens || [];

    if (!text?.id || !sentenceTokenLayer?.id || !wordTokenLayer?.id || !morphemeTokenLayer?.id) {
      this.setError('Token layers are not fully configured.');
      return false;
    }

    // A word must land inside some sentence (Sentences is a partitioning
    // layer). If sentences already tile the doc but the selection falls
    // outside every one, refuse — adding a new sentence into an already-
    // tiled doc would break partitioning. Only when no sentences exist yet
    // do we transparently create one covering the whole text.
    const selRange = { begin, end };
    if (sentenceTokens.length > 0 && !sentenceTokens.some((s) => containsToken(s, selRange))) {
      this.setError('Selection must be inside an existing sentence.');
      return false;
    }

    return this._withSaving('Failed to create token', async () => {
      // Token offsets are code points; .length is UTF-16 units and overshoots
      // on astral characters.
      const fullLen = cpLength(textContent);
      const res = await this._client.batched(async (b) => {
        if (sentenceTokens.length === 0) {
          b.tokens.bulkCreate([
            { tokenLayerId: sentenceTokenLayer.id, text: text.id, begin: 0, end: fullLen },
          ]);
        }
        b.tokens.bulkCreate([{ tokenLayerId: wordTokenLayer.id, text: text.id, begin, end }]);
        b.tokens.bulkCreate([{ tokenLayerId: morphemeTokenLayer.id, text: text.id, begin, end }]);
      });
      const sentenceId = sentenceTokens.length === 0 ? res[0]?.body?.ids?.[0] : null;
      const wordId = res[res.length - 2]?.body?.ids?.[0];
      const morphemeId = res[res.length - 1]?.body?.ids?.[0];

      // Default lemma span (follow-up call — needs the morpheme id). Let a
      // failure propagate so _withSaving toasts + reloads instead of leaving
      // a silently lemma-less word.
      let lemmaSpanId = null;
      if (lemmaLayer?.id && morphemeId) {
        const lr = await this._client.spans.bulkCreate([
          {
            spanLayerId: lemmaLayer.id,
            tokens: [morphemeId],
            value: cpSlice(textContent, begin, end),
          },
        ]);
        lemmaSpanId = lr?.ids?.[0] || null;
      }

      this._applyRawPatch((next, infoNext) => {
        if (sentenceId && infoNext.sentenceTokenLayer) {
          if (!Array.isArray(infoNext.sentenceTokenLayer.tokens))
            infoNext.sentenceTokenLayer.tokens = [];
          infoNext.sentenceTokenLayer.tokens.push({ id: sentenceId, begin: 0, end: fullLen });
        }
        if (wordId && infoNext.wordTokenLayer) {
          if (!Array.isArray(infoNext.wordTokenLayer.tokens)) infoNext.wordTokenLayer.tokens = [];
          infoNext.wordTokenLayer.tokens.push({ id: wordId, begin, end });
        }
        if (morphemeId && infoNext.morphemeTokenLayer) {
          if (!Array.isArray(infoNext.morphemeTokenLayer.tokens))
            infoNext.morphemeTokenLayer.tokens = [];
          infoNext.morphemeTokenLayer.tokens.push({ id: morphemeId, begin, end });
        }
        if (lemmaSpanId && morphemeId && infoNext.lemmaLayer) {
          if (!Array.isArray(infoNext.lemmaLayer.spans)) infoNext.lemmaLayer.spans = [];
          infoNext.lemmaLayer.spans.push({
            id: lemmaSpanId,
            tokens: [morphemeId],
            value: cpSlice(textContent, begin, end),
          });
        }
      });
    });
  }

  // ============================================================
  // Annotation operations (lemma / upos / xpos / form / features)
  // ============================================================

  // Set / update / create an annotation span on a morpheme. For `features`
  // each call creates a new span (multiple features per token allowed);
  // for the other fields the call updates an existing span if one is
  // already attached to the morpheme.
  async updateAnnotation(tokenId, field, value) {
    const info = this.layerInfo;
    const layerByField = {
      form: info.formLayer,
      lemma: info.lemmaLayer,
      upos: info.uposLayer,
      xpos: info.xposLayer,
      features: info.featuresLayer,
    };
    if (!Object.prototype.hasOwnProperty.call(layerByField, field)) {
      this.setError(`Unknown field: ${field}`);
      return false;
    }
    const targetLayer = layerByField[field];
    if (!targetLayer) {
      console.warn(`Layer for ${field} not found, cannot create annotation`);
      return false;
    }

    // FEATS is the one field whose value has structure, and every write of one
    // lands here, so the pair is read once for all of them (src/utils/feats.js).
    let feature = null;
    if (field === 'features') {
      feature = normalizeFeature(value);
      if (!feature) {
        this.setError('A feature is written Key=Value.');
        return false;
      }
      const refusal = featureRefusal(feature.pair);
      if (refusal) {
        this.setError(refusal);
        return false;
      }
    }

    return this._withSaving(`Failed to update ${field}`, async () => {
      if (field === 'features') {
        // Adding a name the token already carries overwrites that value rather
        // than creating a duplicate, so the write is keyed by the name alone.
        const { key, pair } = feature;
        const featSpans = targetLayer?.spans || [];
        const existingFeat = featSpans.find(
          (span) =>
            Array.isArray(span.tokens) &&
            span.tokens.includes(tokenId) &&
            normalizeFeature(span.value)?.key === key,
        );
        if (existingFeat) {
          // A person's edit carries the writer's stamp (see the existing-span
          // branch below for the full rationale).
          const verifyFeat = this.writer.editStamp(existingFeat.metadata);
          // Optimistic overwrite: update the tag locally before the round trip.
          this._applyRawPatch((next, infoNext) => {
            const layerDoc = infoNext.tokenLayer?.spanLayers?.find((layer) =>
              layer.spans?.some((span) => span.id === existingFeat.id),
            );
            const spanIndex = layerDoc?.spans?.findIndex((span) => span.id === existingFeat.id);
            if (layerDoc?.spans && spanIndex != null && spanIndex !== -1) {
              layerDoc.spans[spanIndex].value = pair;
              if (verifyFeat) {
                layerDoc.spans[spanIndex].metadata = mergeMetadata(
                  layerDoc.spans[spanIndex].metadata,
                  verifyFeat,
                );
              }
            }
          });
          if (verifyFeat) {
            await this._client.batched(async (b) => {
              b.spans.update(existingFeat.id, pair);
              b.spans.patchMetadata(existingFeat.id, verifyFeat);
            });
          } else {
            await this._client.spans.update(existingFeat.id, pair);
          }
          return;
        }
        // Create is post-server (a span create needs the server id; the temp-id
        // reconcile's double grid-rebuild isn't worth it — see createRelation).
        // A new span carries the writer's create stamp (null for a verifier).
        const stamp = this.writer.createStamp;
        const spanResult = await this._client.spans.create(
          targetLayer.id,
          [tokenId],
          pair,
          stamp || undefined,
        );
        const newSpanId = spanResult?.id || spanResult;
        this._applyRawPatch((next, infoNext) => {
          const featuresLayerDoc =
            infoNext.featuresLayer && infoNext.featuresLayer.id === targetLayer.id
              ? infoNext.featuresLayer
              : infoNext.tokenLayer?.spanLayers?.find((layer) => layer.id === targetLayer.id);
          if (featuresLayerDoc) {
            if (!featuresLayerDoc.spans) featuresLayerDoc.spans = [];
            featuresLayerDoc.spans.push({
              id: newSpanId,
              tokens: [tokenId],
              value: pair,
              ...(stamp ? { metadata: stamp } : {}),
            });
          }
        });
        return;
      }

      const spans = targetLayer?.spans || [];
      const existingSpan = spans.find(
        (span) => Array.isArray(span.tokens) && span.tokens.includes(tokenId),
      );
      const cleared = value === null || value === undefined || value === '';
      if (cleared && field !== 'lemma') {
        // Clearing a UPOS/XPOS/Form cell DELETES the span (like removing a
        // feature) rather than leaving a null-valued span behind — which would
        // keep carrying the machine's provenance, so a value later typed from
        // scratch by a human would read as "machine-made, human-verified".
        // Lemma is the exception: dependency relations hang off lemma spans,
        // so a cleared lemma keeps its (null-valued) span.
        if (!existingSpan) return;
        this._applyRawPatch((next, infoNext) => {
          const targetLayerDoc = infoNext.tokenLayer?.spanLayers?.find((layer) =>
            layer.spans?.some((span) => span.id === existingSpan.id),
          );
          if (targetLayerDoc?.spans) {
            targetLayerDoc.spans = targetLayerDoc.spans.filter((s) => s.id !== existingSpan.id);
          }
        });
        await this._client.spans.delete(existingSpan.id);
        return;
      }
      if (existingSpan) {
        // A person's edit carries the writer's stamp (provenance write
        // contract rule 3): a verifier's confirms a machine-made or contributed
        // span, a contributor's marks it contributed. Value and metadata land
        // in ONE optimistic patch (single _dataVersion bump, so the styling
        // changes with the value, no double repaint) and one atomic batch
        // (single document-version bump, OCC-safe).
        const verify = this.writer.editStamp(existingSpan.metadata);
        // Optimistic: update the value (+ metadata) locally before the round trip.
        this._applyRawPatch((next, infoNext) => {
          const targetLayerDoc = infoNext.tokenLayer?.spanLayers?.find((layer) =>
            layer.spans?.some((span) => span.id === existingSpan.id),
          );
          if (targetLayerDoc?.spans) {
            const spanIndex = targetLayerDoc.spans.findIndex((span) => span.id === existingSpan.id);
            if (spanIndex !== -1) {
              targetLayerDoc.spans[spanIndex].value = value;
              if (verify) {
                targetLayerDoc.spans[spanIndex].metadata = mergeMetadata(
                  targetLayerDoc.spans[spanIndex].metadata,
                  verify,
                );
              }
            }
          }
        });
        if (verify) {
          await this._client.batched(async (b) => {
            b.spans.update(existingSpan.id, value);
            b.spans.patchMetadata(existingSpan.id, verify);
          });
        } else {
          await this._client.spans.update(existingSpan.id, value);
        }
      } else {
        // Create is post-server (EditableCell already shows the typed value
        // optimistically via its local state, so there's no visible delay).
        // A new span carries the writer's create stamp (null for a verifier).
        const stamp = this.writer.createStamp;
        const spanResult = await this._client.spans.create(
          targetLayer.id,
          [tokenId],
          value,
          stamp || undefined,
        );
        const newSpanId = spanResult?.id || spanResult;
        this._applyRawPatch((next, infoNext) => {
          const targetLayerDoc = infoNext.tokenLayer?.spanLayers?.find(
            (layer) => layer.id === targetLayer.id,
          );
          if (targetLayerDoc) {
            if (!targetLayerDoc.spans) targetLayerDoc.spans = [];
            targetLayerDoc.spans.push({
              id: newSpanId,
              tokens: [tokenId],
              value,
              ...(stamp ? { metadata: stamp } : {}),
            });
          }
        });
      }
    });
  }

  async deleteFeature(spanId) {
    return this._withSaving('Failed to delete feature', async () => {
      // Optimistic: drop the feature tag locally before the round trip.
      this._applyRawPatch((next, info) => {
        const featuresLayerDoc = info.featuresLayer;
        if (featuresLayerDoc && Array.isArray(featuresLayerDoc.spans)) {
          featuresLayerDoc.spans = featuresLayerDoc.spans.filter((span) => span.id !== spanId);
        }
      });
      await this._client.spans.delete(spanId);
    });
  }

  // The lemma span a relation endpoint names, made if the word has none yet.
  // `candidateId` may be a span id OR a morpheme token id (the latter is the
  // common case when called from the annotation grid).
  async _ensureLemmaSpan(info, candidateId) {
    if (!candidateId || candidateId === 'ROOT') return null;

    const lemmaLayer = info.lemmaLayer;
    const lemmaSpans = lemmaLayer.spans || [];

    const existingById = lemmaSpans.find((span) => span.id === candidateId);
    if (existingById) return existingById.id;

    // Span `tokens` is a flat array of token ids.
    const tokenId = candidateId;
    const existingByToken = lemmaSpans.find(
      (span) => Array.isArray(span.tokens) && span.tokens.includes(tokenId),
    );
    if (existingByToken) return existingByToken.id;

    const textBody = info.textLayer?.text?.body || '';
    const token = info.tokenLayer?.tokens?.find((t) => t.id === tokenId);
    const lemmaValue = token ? cpSlice(textBody, token.begin, token.end) : '';

    // Made on the writer's behalf to hang the relation on: their stamp.
    const stamp = this.writer.createStamp;
    const apiResponse = await this._client.spans.create(
      lemmaLayer.id,
      [tokenId],
      lemmaValue,
      stamp || undefined,
    );
    const createdSpanId = apiResponse.id || apiResponse;

    this._applyRawPatch((next, infoNext) => {
      const lemmaLayerDoc = infoNext.lemmaLayer;
      if (lemmaLayerDoc) {
        if (!Array.isArray(lemmaLayerDoc.spans)) lemmaLayerDoc.spans = [];
        if (lemmaLayerDoc.spans.findIndex((s) => s.id === createdSpanId) === -1) {
          lemmaLayerDoc.spans.push({
            id: createdSpanId,
            tokens: [tokenId],
            value: lemmaValue,
            ...(stamp ? { metadata: stamp } : {}),
          });
        }
      }
    });

    return createdSpanId;
  }

  // Suppressors lying over these pairs, each given as a basic relation or as a
  // bare `{source, target}`. A suppressor says the enhanced graph leaves out
  // the basic relation over its pair, so it goes when that relation goes. Left
  // behind it would suppress nothing, and would quietly suppress the next
  // relation drawn over the same pair. Reconcile clears the ones another
  // writer leaves, at the next open; this clears them at both moments a
  // relation over the pair changes hands.
  _suppressorIdsOver(info, pairs) {
    const rows = info.enhancedRelationLayer?.relations || [];
    if (rows.length === 0) return [];
    return pairs.map((rel) => suppressorFor(rel, rows)?.id).filter(Boolean);
  }

  // Create (or replace) a dependency relation between two lemma spans.
  // Source/target may be span ids OR morpheme token ids (the latter is the
  // common case when called from the annotation grid). Special value
  // 'ROOT' marks the dependency root, which is encoded as a self-loop on
  // the target span.
  async createRelation(sourceSpanId, targetSpanId, deprel) {
    const info = this.layerInfo;
    if (!info.relationLayer) {
      this.setError('Relation layer not found.');
      return false;
    }
    if (!info.lemmaLayer) {
      this.setError('Lemma layer not found.');
      return false;
    }

    return this._withSaving('Failed to create relation', async () => {
      // Post-server (NOT optimistic): a relation create needs the server id, so
      // it requires a temp-id placeholder + a second reconcile patch. That
      // double grid-rebuild makes the dependency tree re-measure positions and
      // re-mount arcs twice, which visibly janks the drag-to-draw interaction —
      // worse than just waiting one round trip. Creates show a brief absence,
      // never a wrong value, so post-server is the right trade here.
      const resolvedSourceId = await this._ensureLemmaSpan(info, sourceSpanId);
      const resolvedTargetId = await this._ensureLemmaSpan(info, targetSpanId);

      if (!resolvedSourceId || !resolvedTargetId) {
        console.warn('Unable to create relation because lemma spans could not be resolved:', {
          sourceSpanId,
          targetSpanId,
        });
        return;
      }

      // Replace atomically: delete any existing incoming relations to the
      // target (one head per node) and create the new relation in ONE batch,
      // so a mid-flight failure can't leave the node headless (deletes landed,
      // create didn't) or double-headed (delete failed, create landed).
      const incomingRelations = (info.relationLayer.relations || []).filter(
        (rel) => rel.target === resolvedTargetId,
      );
      // Every suppressor this write makes meaningless: the ones over the
      // incoming relations it REPLACES, and any already lying over the pair it
      // CREATES. The second is one guard covering every stale source, not just
      // this editor's own: an agent `set_head`, a script, the Python client
      // each move a basic relation and leave a suppressor over the pair they
      // left, and only reconcile-on-OPEN sweeps those. A person with the
      // document open when one runs would otherwise redraw that very arc and
      // see it born faded, with no enhanced head and nothing on screen saying
      // why.
      const staleSuppressors = [
        ...new Set(
          this._suppressorIdsOver(info, [
            ...incomingRelations,
            { source: resolvedSourceId, target: resolvedTargetId },
          ]),
        ),
      ];
      const finalDeprel = deprel || (resolvedSourceId === resolvedTargetId ? 'root' : 'dep');
      // A re-pointed head is a person's relation: it carries the writer's
      // create stamp (null for a verifier, so a verifier's stays plain).
      const relStamp = this.writer.createStamp;
      const batchResults = await this._client.batched(async (b) => {
        incomingRelations.forEach((rel) => b.relations.delete(rel.id));
        staleSuppressors.forEach((id) => b.relations.delete(id));
        b.relations.create(
          info.relationLayer.id,
          resolvedSourceId,
          resolvedTargetId,
          finalDeprel,
          relStamp || undefined,
        );
      });
      const newRelationId = batchResults[batchResults.length - 1]?.body?.id;
      this._applyRawPatch((next, infoNext) => {
        const relLayer = infoNext.relationLayer;
        if (!relLayer) return;
        if (!Array.isArray(relLayer.relations)) relLayer.relations = [];
        relLayer.relations = relLayer.relations.filter((rel) => rel.target !== resolvedTargetId);
        relLayer.relations.push({
          id: newRelationId,
          source: resolvedSourceId,
          target: resolvedTargetId,
          value: finalDeprel,
          ...(relStamp ? { metadata: relStamp } : {}),
        });
        const enhanced = infoNext.enhancedRelationLayer;
        if (staleSuppressors.length && Array.isArray(enhanced?.relations)) {
          enhanced.relations = enhanced.relations.filter((r) => !staleSuppressors.includes(r.id));
        }
      });
    });
  }

  // Add an edge to the ENHANCED graph: one the basic tree does not have. Same
  // endpoints as createRelation takes, a self-loop for a root included. Unlike
  // the tree, the graph lets a word have any number of heads, so nothing is
  // replaced.
  //
  // Drawn over the very pair a basic relation already joins, the edge is a
  // RELABEL (`nmod` in the tree, `nmod:of` in the graph), so the basic relation
  // is suppressed in the same batch. The rare graph that wants both labels over
  // one pair gets there by lifting the suppression afterwards.
  //
  // Resolves to the new relation's id (so the tree can open its label), to null
  // when that exact edge already exists, and to false on failure.
  async createEnhancedRelation(sourceSpanId, targetSpanId, deprel) {
    const info = this.layerInfo;
    if (!info.enhancedRelationLayer) {
      this.setError('Enhanced relation layer not found.');
      return false;
    }
    if (!info.lemmaLayer) {
      this.setError('Lemma layer not found.');
      return false;
    }

    let createdId = null;
    const ok = await this._withSaving('Failed to create enhanced relation', async () => {
      // Post-server, for createRelation's reason.
      const source = await this._ensureLemmaSpan(info, sourceSpanId);
      const target = await this._ensureLemmaSpan(info, targetSpanId);
      if (!source || !target) return;

      const rows = info.enhancedRelationLayer.relations || [];
      const basicOverPair = (info.relationLayer?.relations || []).find(
        (rel) => rel.source === source && rel.target === target,
      );
      const value = deprel || basicOverPair?.value || (source === target ? 'root' : 'dep');
      const sameEdge = (r) => r.source === source && r.target === target;
      if (rows.some((r) => sameEdge(r) && !isSuppressor(r) && r.value === value)) return;

      const suppress = Boolean(basicOverPair) && !rows.some(sameEdge);
      const stamp = this.writer.createStamp;
      const results = await this._client.batched(async (b) => {
        if (suppress) {
          b.relations.create(info.enhancedRelationLayer.id, source, target, null, {
            [SUPPRESS_KEY]: true,
          });
        }
        b.relations.create(
          info.enhancedRelationLayer.id,
          source,
          target,
          value,
          stamp || undefined,
        );
      });
      createdId = results[results.length - 1]?.body?.id || null;
      const suppressorId = suppress ? results[0]?.body?.id : null;
      this._applyRawPatch((next, infoNext) => {
        const layer = infoNext.enhancedRelationLayer;
        if (!layer) return;
        if (!Array.isArray(layer.relations)) layer.relations = [];
        if (suppressorId) {
          layer.relations.push({
            id: suppressorId,
            source,
            target,
            value: null,
            metadata: { [SUPPRESS_KEY]: true },
          });
        }
        layer.relations.push({
          id: createdId,
          source,
          target,
          value,
          ...(stamp ? { metadata: stamp } : {}),
        });
      });
    });
    return ok ? createdId : false;
  }

  // Say whether the enhanced graph has this BASIC relation. It does unless a
  // suppressor lies over it, so this creates or deletes that one row.
  async setRelationSuppressed(relationId, suppressed) {
    const info = this.layerInfo;
    if (!info.enhancedRelationLayer) {
      this.setError('Enhanced relation layer not found.');
      return false;
    }
    const basic = (info.relationLayer?.relations || []).find((r) => r.id === relationId);
    if (!basic) return false;
    const existing = suppressorFor(basic, info.enhancedRelationLayer.relations);
    if (Boolean(existing) === Boolean(suppressed)) return true;

    return this._withSaving('Failed to update the enhanced graph', async () => {
      if (existing) {
        // Optimistic, as every delete is.
        this._applyRawPatch((next, infoNext) => {
          const layer = infoNext.enhancedRelationLayer;
          if (!Array.isArray(layer?.relations)) return;
          layer.relations = layer.relations.filter((r) => r.id !== existing.id);
        });
        await this._client.relations.delete(existing.id);
        return;
      }
      const created = await this._client.relations.create(
        info.enhancedRelationLayer.id,
        basic.source,
        basic.target,
        null,
        { [SUPPRESS_KEY]: true },
      );
      const id = created?.id || created;
      this._applyRawPatch((next, infoNext) => {
        const layer = infoNext.enhancedRelationLayer;
        if (!layer) return;
        if (!Array.isArray(layer.relations)) layer.relations = [];
        layer.relations.push({
          id,
          source: basic.source,
          target: basic.target,
          value: null,
          metadata: { [SUPPRESS_KEY]: true },
        });
      });
    });
  }

  // A relation's label, in the tree or in the enhanced layer: the id says which.
  async updateRelation(relationId, deprel) {
    return this._withSaving('Failed to update relation', async () => {
      // Human edit of a machine relation verifies it (provenance write
      // contract) — same shape as updateAnnotation: one optimistic patch,
      // one atomic batch.
      const existing = dependencyRelationLayers(this.layerInfo)
        .flatMap((layer) => layer.relations || [])
        .find((r) => r.id === relationId);
      const verify = this.writer.editStamp(existing?.metadata);
      // Optimistic: reflect the new value immediately, BEFORE the round trip,
      // so the label doesn't flash the previous value while the save is in
      // flight. On failure, _withSaving reloads from the server and reverts.
      this._applyRawPatch((next, infoNext) => {
        for (const relLayer of dependencyRelationLayers(infoNext)) {
          const found = (relLayer.relations || []).find((r) => r.id === relationId);
          if (!found) continue;
          found.value = deprel;
          if (verify) found.metadata = mergeMetadata(found.metadata, verify);
        }
      });
      if (verify) {
        await this._client.batched(async (b) => {
          b.relations.update(relationId, deprel);
          b.relations.patchMetadata(relationId, verify);
        });
      } else {
        await this._client.relations.update(relationId, deprel);
      }
    });
  }

  // Delete a relation from the tree or from the enhanced layer. Either way it
  // takes with it a suppressor the delete leaves saying nothing:
  //
  //   - a BASIC relation takes the suppressor lying over it, which said the
  //     graph left that relation out and now has no relation to leave out.
  //   - an EXTRA that was the only one over a pair the tree joins takes it
  //     too. That shape is a RELABEL (`nmod` in the tree, `nmod:of` in the
  //     graph, stored as a suppressor plus an extra), and deleting the label
  //     asks for the label to go, not for the word to be cut out of the
  //     enhanced graph, so the tree's relation comes back into it. Grew's
  //     `del_edge` reads the same condition (rewrite/diff.js, `relabelUndone`).
  //     A pair whose suppressor stands alone is a plain leaving-out, which
  //     this must not undo.
  async deleteRelation(relationId) {
    return this._withSaving('Failed to delete relation', async () => {
      const info = this.layerInfo;
      const basic = (info.relationLayer?.relations || []).find((r) => r.id === relationId);
      const rows = info.enhancedRelationLayer?.relations || [];
      const extra = basic ? null : rows.find((r) => r.id === relationId && !isSuppressor(r));
      const lastExtraOverPair =
        extra &&
        !rows.some(
          (r) =>
            r.id !== relationId &&
            !isSuppressor(r) &&
            r.source === extra.source &&
            r.target === extra.target,
        );
      const freed = basic || (lastExtraOverPair ? extra : null);
      const doomed = new Set([
        relationId,
        ...(freed ? this._suppressorIdsOver(info, [freed]) : []),
      ]);
      // Optimistic: drop the arc locally before the round trip.
      this._applyRawPatch((next, infoNext) => {
        for (const relLayer of dependencyRelationLayers(infoNext)) {
          if (!Array.isArray(relLayer.relations)) continue;
          relLayer.relations = relLayer.relations.filter((r) => !doomed.has(r.id));
        }
      });
      if (doomed.size === 1) {
        await this._client.relations.delete(relationId);
      } else {
        await this._client.batched(async (b) => {
          for (const id of doomed) b.relations.delete(id);
        });
      }
    });
  }

  // Confirm the proposals on the given tokens WITHOUT changing their values:
  // merge the writer's confirm stamp on every span (form/lemma/upos/xpos/
  // features) and incoming dependency relation this writer reviews, so a later
  // re-parse's protect-guard leaves the reviewed material alone. For a verifier
  // that is provConfirmed on machine-made or contributed material; a
  // contributor's acceptance of a machine proposal records it as their
  // contribution. Anything else is skipped (confirmStamp returns null). Used by
  // the editor's per-token Ctrl+Enter and per-sentence "Accept predictions"
  // gestures.
  async confirmTokens(tokenIds) {
    const idSet = new Set(tokenIds || []);
    if (idSet.size === 0) return false;
    return this._withSaving(
      'Failed to confirm annotations',
      async () => {
        const info = this.layerInfo;
        const spanLayers = [
          info.formLayer,
          info.lemmaLayer,
          info.uposLayer,
          info.xposLayer,
          info.featuresLayer,
        ].filter(Boolean);

        // Machine-unverified spans on the target tokens.
        const spanPatchById = new Map();
        for (const layer of spanLayers) {
          for (const span of layer.spans || []) {
            if (Array.isArray(span.tokens) && span.tokens.some((t) => idSet.has(t))) {
              const verify = this.writer.confirmStamp(span.metadata);
              if (verify) spanPatchById.set(span.id, verify);
            }
          }
        }

        // Incoming dependency relations: the dependent is the relation's TARGET
        // lemma span, so map target span → its tokens and match against the set.
        const lemmaTokensBySpan = new Map(
          (info.lemmaLayer?.spans || []).map((s) => [s.id, s.tokens || []]),
        );
        const relPatchById = new Map();
        const allRelations = dependencyRelationLayers(info).flatMap((l) => l.relations || []);
        for (const rel of allRelations) {
          const targetTokens = lemmaTokensBySpan.get(rel.target) || [];
          if (targetTokens.some((t) => idSet.has(t))) {
            const verify = this.writer.confirmStamp(rel.metadata);
            if (verify) relPatchById.set(rel.id, verify);
          }
        }

        if (spanPatchById.size === 0 && relPatchById.size === 0) return; // nothing to confirm

        // Optimistic: stamp confirmed locally so the inferred styling clears now.
        this._applyRawPatch((next, infoNext) => {
          for (const layer of [
            infoNext.formLayer,
            infoNext.lemmaLayer,
            infoNext.uposLayer,
            infoNext.xposLayer,
            infoNext.featuresLayer,
          ]) {
            for (const span of layer?.spans || []) {
              const patch = spanPatchById.get(span.id);
              if (patch) span.metadata = mergeMetadata(span.metadata, patch);
            }
          }
          for (const layer of dependencyRelationLayers(infoNext)) {
            for (const rel of layer.relations || []) {
              const patch = relPatchById.get(rel.id);
              if (patch) rel.metadata = mergeMetadata(rel.metadata, patch);
            }
          }
        });

        await this._client.batched(async (b) => {
          for (const [id, patch] of spanPatchById) b.spans.patchMetadata(id, patch);
          for (const [id, patch] of relPatchById) b.relations.patchMetadata(id, patch);
        });
      },
      'Confirm predicted annotations',
    );
  }

  // Throw away the unreviewed MACHINE proposal on the given tokens: delete the
  // machine-made spans (form/lemma/upos/xpos/features) and machine-made
  // incoming dependency relations, and leave everything else exactly as it is.
  // The mirror of confirmTokens, for a proposal that is wrong wholesale rather
  // than worth correcting cell by cell. Used by the editor's per-word
  // Ctrl/Cmd+Backspace and per-sentence "Discard predictions" gestures.
  //
  // MACHINE material only, for every writer: narrower than plaid-igt, whose
  // discard takes whatever that writer reviews and so lets a verifier delete a
  // contributor's hand annotation with one chord. The convention's own rule is
  // that a contributor's work is a person's work, and a gesture that throws it
  // away without naming it is not one to give a keyboard shortcut. A verifier
  // who disagrees with a contributor still edits the cell.
  //
  // A lemma span is the tree's node: deleting one takes its relations with it.
  // So a machine lemma span that anchors a relation this gesture is NOT
  // deleting (a head someone re-pointed by hand) is kept, and only its value
  // would have been the machine's. Losing a person's relation to a cascade is
  // the one way this gesture could destroy work.
  async discardTokens(tokenIds) {
    const idSet = new Set(tokenIds || []);
    if (idSet.size === 0) return false;
    return this._withSaving(
      'Failed to discard predictions',
      async () => {
        const info = this.layerInfo;

        // Machine-made incoming relations first: the dependent is the
        // relation's TARGET lemma span.
        const lemmaTokensBySpan = new Map(
          (info.lemmaLayer?.spans || []).map((s) => [s.id, s.tokens || []]),
        );
        const relIds = new Set();
        const keptRelSpanIds = new Set();
        const allRelations = dependencyRelationLayers(info).flatMap((l) => l.relations || []);
        for (const rel of allRelations) {
          // A suppressor is a note about a basic relation, not anybody's
          // annotation of these words: it keeps nothing alive, and it goes
          // with the relation it lies over (below).
          if (isSuppressor(rel)) continue;
          if (!isMachine(rel.metadata)) {
            // Somebody vouched for this one. Both its anchors have to survive.
            keptRelSpanIds.add(rel.source);
            keptRelSpanIds.add(rel.target);
            continue;
          }
          const targetTokens = lemmaTokensBySpan.get(rel.target) || [];
          if (targetTokens.some((t) => idSet.has(t))) relIds.add(rel.id);
          // A machine relation anchored elsewhere on a lemma span this gesture
          // deletes goes with it. It is the same machine's proposal, and the
          // optimistic patch below drops it so the tree matches the server.
        }

        // Machine-made spans on the target tokens, minus any lemma span a
        // surviving relation still hangs on.
        const spanIds = new Set();
        for (const layer of [
          info.formLayer,
          info.lemmaLayer,
          info.uposLayer,
          info.xposLayer,
          info.featuresLayer,
        ].filter(Boolean)) {
          const isLemma = layer.id === info.lemmaLayer?.id;
          for (const span of layer.spans || []) {
            if (!Array.isArray(span.tokens) || !span.tokens.some((t) => idSet.has(t))) continue;
            if (!isMachine(span.metadata)) continue;
            if (isLemma && keptRelSpanIds.has(span.id)) continue;
            spanIds.add(span.id);
          }
        }

        if (spanIds.size === 0 && relIds.size === 0) return; // nothing to discard

        const discardedBasic = (info.relationLayer?.relations || []).filter((rel) =>
          relIds.has(rel.id),
        );
        for (const id of this._suppressorIdsOver(info, discardedBasic)) relIds.add(id);

        // Optimistic: a delete, so the grid empties now and _withSaving
        // reloads on failure.
        this._applyRawPatch((next, infoNext) => {
          for (const layer of [
            infoNext.formLayer,
            infoNext.lemmaLayer,
            infoNext.uposLayer,
            infoNext.xposLayer,
            infoNext.featuresLayer,
          ]) {
            if (layer && Array.isArray(layer.spans)) {
              layer.spans = layer.spans.filter((span) => !spanIds.has(span.id));
            }
          }
          for (const relLayer of dependencyRelationLayers(infoNext)) {
            if (!Array.isArray(relLayer.relations)) continue;
            relLayer.relations = relLayer.relations.filter(
              (rel) => !relIds.has(rel.id) && !spanIds.has(rel.source) && !spanIds.has(rel.target),
            );
          }
        });

        await this._client.batched(async (b) => {
          // Relations before spans: a relation whose anchor span is already
          // gone is gone too, and deleting it twice is a 404.
          for (const id of relIds) b.relations.delete(id);
          for (const id of spanIds) b.spans.delete(id);
        });
      },
      'Discard predicted annotations',
    );
  }

  // ============================================================
  // CoNLL-U export
  // ============================================================

  // Serialize the current document state to CoNLL-U text. Result is cached
  // per version so repeated calls between mutations are free.
  toConllu() {
    return this._derived('conllu', () => this._buildConllu());
  }

  // The serializer is `buildConllu`, which needs nothing but these three.
  // An unconfigured document hands it no rows: `sentences` is the whole grid
  // model, and building one for a document that answers with a sentinel line
  // is work nobody reads. The sentinel itself stays in the serializer, so
  // there is one place that writes it.
  _buildConllu() {
    const info = this.layerInfo;
    const sentences = info.isConfigured ? this.sentences : null;
    return buildConllu({ name: this.name, layerInfo: info, sentences });
  }

  // What the file the export writes cannot say (conlluSerialize.js), one line
  // each. Cached with the text it is about.
  conlluLosses() {
    return this._derived('conlluLosses', () =>
      this.layerInfo.isConfigured ? conlluLosses({ sentences: this.sentences }) : [],
    );
  }
}
