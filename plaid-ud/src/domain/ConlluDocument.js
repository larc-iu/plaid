import {
  applyMetadataOps,
  cpLength,
  createdId,
  createdIds,
  cpSlice,
  isMachine,
  isReviewed,
  mergeMetadata,
  metadataOps,
  PLAID_NAMESPACE,
  isReservedMetadataKey,
  PRESERVE_ON_SPLIT_KEY,
  PROVENANCE_KEYS,
  applyTextOps,
  gapsToOps,
  stampInferred,
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
import { notSetUp } from '../../../plaid-ui/src/domain/setupGuard.js';
import { pendingId, settledId } from '../../../plaid-ui/src/domain/pendingIds.js';
import { isUnknownOutcome, statusOf } from '../../../plaid-ui/src/lib/errors.js';
import { expectStored, isConfigConflict } from '../../../plaid-ui/src/domain/configCells.js';
import { rebaseEdits } from '../../../plaid-ui/src/lib/textMerge.js';
import { editLogGaps } from '../../../plaid-ui/src/lib/editLog.js';
import { applyReshape } from '../../../plaid-ui/src/domain/textReshape.js';
import { ensureLayerConstraints } from '../../../plaid-ui/src/lib/layerConstraints.js';
import { rulesNotInForce, wantedConstraints } from '../utils/udConstraints.js';
import {
  relationsCrossing,
  staleSuppressorIds,
  wordsNeedingSyntacticWord,
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

// The lemma a new word starts with is a copy of its form, made by a rule and
// by no person, so a parser may replace it (provenance write contract rule 1).
const LEMMA_FROM_FORM = stampInferred('rule:lemma-from-form');

// What a text save whose draft cannot be put onto the stored text is refused with.
const TEXT_CONFLICT = 'The same passage was changed elsewhere. Discard changes and redo the edit.';

// The body `gaps` make of `base`.
const gapsBody = (base, gaps) => applyTextOps(base, gapsToOps(gaps));

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

  // `rename` and `copyTo` are DocumentModel's: naming a document and copying
  // one are the same operation in every app, and the Details screen all three
  // mount calls them there.

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
  //
  // The shared `plaid` namespace and the provenance keys are never a field: a
  // string there would take the document's settings (its text direction), or
  // the record of who made it, with it.
  async setDocumentMetadata(key, value) {
    if (isReservedMetadataKey(key)) return false;
    const next = value == null || value === '' ? null : String(value);
    if ((this.metadata[key] ?? null) === next) return false;
    const label = 'Failed to save document metadata';
    if (!this._canWrite(label)) return false;
    this._applyRawPatch((raw) => {
      raw.metadata = mergeMetadata(raw.metadata, { [key]: next });
    });
    return this._queueWrite(
      label,
      () => this._client.documents.patchMetadata(this.id, metadataOps({ [key]: next })),
      `Set document ${key}`,
    );
  }

  // Write one sentence metadata field, on the SENTENCE TOKEN, where CoNLL-U's
  // `# k = v` lines have always been read from and written back to (see
  // importFromConllu and toConllu). Same delete-on-empty rule as the document
  // level, and the same reason for a PATCH.
  async setSentenceMetadata(sentenceTokenId, key, value) {
    if (isReservedMetadataKey(key)) return false;
    const info = this.layerInfo;
    const token = (info.sentenceTokenLayer?.tokens || []).find(
      (t) => t.id === settledId(sentenceTokenId),
    );
    if (!token) return false;
    const next = value == null || value === '' ? null : String(value);
    if ((token.metadata?.[key] ?? null) === next) return false;
    const label = 'Failed to save sentence metadata';
    if (!this._canWrite(label)) return false;
    this._applyRawPatch((raw, infoNext) => {
      for (const t of infoNext.sentenceTokenLayer?.tokens || []) {
        if (t.id === token.id) t.metadata = mergeMetadata(t.metadata, { [key]: next });
      }
    });
    return this._queueWrite(
      label,
      () => this._client.tokens.patchMetadata(settledId(token.id), metadataOps({ [key]: next })),
      `Set sentence ${key}`,
    );
  }

  // ============================================================
  // Text-layer operations
  // ============================================================

  // A text save sends the edits made in the box, as the net change over the
  // body they were typed on (PATCH /texts/:id with `edits` and `base`, the
  // digest of that body). The server works out what they do to the tokens
  // over them (plaid.algos.text), which this cannot replay, and answers every
  // row it changed, which is put on screen in place of a refetch.
  //
  // `log` is the box's edit log (plaid-ui lib/editLog.js), or what
  // `sendEditLog` split off it: `{ base, digest, gaps }`. When the stored
  // body is no longer `base`, the gaps are moved onto it (`rebaseEdits`) and
  // sent with its digest, and a save refused as out of date (409,
  // `text-changed`) is moved again onto what the refetch read. Changes to
  // the same passage are refused and nothing is sent. A save whose answer was
  // lost has landed when the stored body is its base with its gaps applied.
  // `onStored(body, digest)` hears the body that was stored. A string is a
  // whole new body, typed over the stored one (for scripts).
  async saveText(log, { onStored = null } = {}) {
    const label = 'Failed to save text';
    if (!this._canWrite(label)) return false;
    const { textLayer } = this.layerInfo;
    const text = textLayer?.text;
    if (!text?.id && !textLayer?.id) return false;
    if (typeof log === 'string') {
      const stored = text?.id ? this._storedText(text.id) : { body: '', digest: null };
      log = {
        base: stored.body,
        digest: stored.digest,
        gaps: log === stored.body ? [] : [{ start: 0, end: [...stored.body].length, value: log }],
      };
    }
    const sentBase = log.base ?? '';
    const sentGaps = log.gaps ?? editLogGaps(log);
    return this._queueWrite(
      label,
      async () => {
        if (!text?.id) {
          const body = gapsBody(sentBase, sentGaps);
          await this._client.texts.create(textLayer.id, this.id, body);
          onStored?.(body, null);
          return;
        }
        let base = sentBase;
        let gaps = sentGaps;
        let digest = log.digest ?? null;
        for (let attempt = 0; ; attempt += 1) {
          const stored = this._storedText(text.id);
          if (stored.body !== base) {
            const moved = rebaseEdits(base, gaps, stored.body);
            if (moved.conflict) throw new Error(TEXT_CONFLICT);
            base = stored.body;
            gaps = moved.gaps;
            digest = stored.digest;
          }
          digest ??= stored.digest;
          if (gaps.length === 0) {
            onStored?.(stored.body, stored.digest);
            return;
          }
          const mine = gapsBody(base, gaps);
          try {
            const answer = await this._client.texts.edit(text.id, gapsToOps(gaps), undefined, {
              base: digest,
            });
            if (typeof answer?.body === 'string') {
              this._applyRawPatch((raw) => {
                Object.assign(raw, applyReshape(raw, text.id, answer));
              });
            } else {
              await this._reloadInSend();
            }
            const now = this._storedText(text.id);
            onStored?.(now.body, now.digest);
            return;
          } catch (err) {
            const textChanged = statusOf(err) === 409 && err?.responseData?.['text-changed'];
            const unknown = isUnknownOutcome(err);
            if (!textChanged && !unknown) throw err;
            if (textChanged && attempt >= 2) throw err;
            await this._reloadInSend();
            if (unknown) {
              const now = this._storedText(text.id);
              if (now.body === mine) {
                onStored?.(now.body, now.digest);
                return;
              }
              if (attempt >= 2) throw err;
            }
          }
        }
      },
      undefined,
      { reload: !text?.id },
    );
  }

  // The body and digest of text `textId` as last read or answered.
  _storedText(textId) {
    const text = this.layerInfo.textLayer?.text;
    return text?.id === textId
      ? { body: text.body ?? '', digest: text.digest ?? null }
      : { body: '', digest: null };
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
      this.setError(notSetUp('UD token layers missing'));
      return false;
    }
    if (sentenceTokens.length || wordTokens.length || morphemeTokens.length) {
      this.setError('Tokens already exist. Use "Clear tokens" before re-tokenizing.');
      return false;
    }
    const label = 'Failed to create tokens';
    if (!this._canWrite(label)) return false;

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
      info.textLayer?.config?.ud?.tokenizerLocale || readProjectLanguage(this._project) || 'und';
    const wordRanges = basicTokenize(body, tokenizerLocale);

    const sentences = sentenceRanges.map(([begin, end]) => ({ id: pendingId(), begin, end }));
    const words = wordRanges.map(([begin, end]) => ({ id: pendingId(), begin, end }));
    const morphemes = wordRanges.map(([begin, end]) => ({ id: pendingId(), begin, end }));
    const lemmas = lemmaLayer?.id
      ? morphemes.map((m, i) => ({
          id: pendingId(),
          tokens: [m.id],
          value: cpSlice(body, wordRanges[i][0], wordRanges[i][1]),
          metadata: LEMMA_FROM_FORM,
        }))
      : [];
    this._applyRawPatch((next, infoNext) => {
      infoNext.sentenceTokenLayer.tokens = sentences.map((t) => ({ ...t }));
      infoNext.wordTokenLayer.tokens = words.map((t) => ({ ...t }));
      infoNext.morphemeTokenLayer.tokens = morphemes.map((t) => ({ ...t }));
      if (lemmas.length && infoNext.lemmaLayer) {
        infoNext.lemmaLayer.spans = lemmas.map((span) => ({ ...span, tokens: [...span.tokens] }));
      }
    });

    return this._queueWrite(label, async () => {
      const ids = new Map();
      const record = (rows, created) =>
        rows.forEach((row, i) => created?.[i] && ids.set(row.id, created[i]));
      const bulk = (layer, rows) =>
        rows.map(({ id, begin, end }) => ({
          id,
          tokenLayerId: layer.id,
          text: text.id,
          begin,
          end,
        }));
      const results = await this._client.batched(async (b) => {
        b.tokens.bulkCreate(bulk(sentenceTokenLayer, sentences));
        if (words.length > 0) {
          b.tokens.bulkCreate(bulk(wordTokenLayer, words));
          b.tokens.bulkCreate(bulk(morphemeTokenLayer, morphemes));
        }
      });
      record(sentences, createdIds(results[0]));
      if (words.length > 0) {
        record(words, createdIds(results[1]));
        record(morphemes, createdIds(results[2]));
      }

      // Default lemma spans (a follow-up call: they reference the morpheme
      // ids produced above). A failure propagates, and the refetch it causes
      // shows the committed tokens minus their lemmas rather than hiding it.
      if (lemmas.length) {
        const created = await this._client.spans.bulkCreate(
          lemmas.map((span) => ({
            id: span.id,
            spanLayerId: lemmaLayer.id,
            tokens: [ids.get(span.tokens[0])],
            value: span.value,
            metadata: span.metadata,
          })),
        );
        record(lemmas, createdIds(created));
      }
      this._settle(ids);
    });
  }

  // Clear all tokens by deleting the sentence (root) tokens, which cascades
  // to words, morphemes, spans and relations server-side, another app's
  // layers nested under them included. Locally the whole cascade goes at once.
  async clearTokens() {
    const label = 'Failed to clear tokens';
    if (!this._canWrite(label)) return false;
    const { sentenceTokenLayer, wordTokenLayer, morphemeTokenLayer } = this.layerInfo;
    const chain = [sentenceTokenLayer, wordTokenLayer, morphemeTokenLayer];
    const rootIndex = chain.findIndex((layer) => layer?.tokens?.length > 0);
    if (rootIndex === -1) return false;
    const roots = chain[rootIndex].tokens.map((t) => t.id);
    this._applyRawPatch((next, infoNext) => {
      const layers = infoNext.textLayer?.tokenLayers || [];
      // The UD layers from the root down, and every layer nested under them.
      const doomed = new Set(
        chain
          .slice(rootIndex)
          .filter(Boolean)
          .map((layer) => layer.id),
      );
      let grew = true;
      while (grew) {
        grew = false;
        for (const layer of layers) {
          if (!doomed.has(layer.id) && doomed.has(layer.parentTokenLayer)) {
            doomed.add(layer.id);
            grew = true;
          }
        }
      }
      for (const layer of layers) {
        if (!doomed.has(layer.id)) continue;
        layer.tokens = [];
        for (const spanLayer of layer.spanLayers || []) {
          spanLayer.spans = [];
          for (const relationLayer of spanLayer.relationLayers || []) {
            relationLayer.relations = [];
          }
        }
      }
    });
    return this._queueWrite(label, () => this._client.tokens.bulkDelete(roots.map(settledId)));
  }

  // Toggle a sentence boundary at a character position (a word's begin
  // offset). The sentence layer is partitioning, so this is a split (add)
  // or merge (remove).
  async toggleSentenceBoundary(charPos) {
    const label = 'Failed to update sentence boundary';
    const { sentenceTokenLayer } = this.layerInfo;
    const sentenceTokens = sentenceTokenLayer?.tokens || [];

    const startsHere = sentenceTokens.find((s) => s.begin === charPos);
    if (startsHere) {
      // Remove the boundary: merge with the preceding sentence. Merging
      // only widens a sentence, so no dependency relation can become invalid.
      const prevSent = sentenceTokens.find((s) => s.end === charPos);
      if (!prevSent) return false;
      if (!this._canWrite(label)) return false;
      this._applyRawPatch((next, info) => {
        if (info.sentenceTokenLayer?.tokens) {
          const p = info.sentenceTokenLayer.tokens.find((t) => t.id === prevSent.id);
          if (p) p.end = startsHere.end;
          info.sentenceTokenLayer.tokens = info.sentenceTokenLayer.tokens.filter(
            (t) => t.id !== startsHere.id,
          );
        }
      });
      return this._queueWrite(label, () =>
        this._client.tokens.merge(settledId(prevSent.id), settledId(startsHere.id)),
      );
    }

    const containing = sentenceTokens.find((s) => s.begin < charPos && charPos < s.end);
    if (!containing) return false;
    if (!this._canWrite(label)) return false;

    // A dependency relation whose endpoints land on opposite sides of charPos
    // would cross the new sentence boundary (UD relations are
    // sentence-internal). The server's same-ancestor rule deletes them in the
    // split's own transaction, read from what is stored, so one drawn since
    // this copy was read goes too. Here they only leave the screen.
    const crossing = relationsCrossing(this.layerInfo, charPos);
    const removedRelIds = new Set(crossing);
    // The split keeps the left half's identity; the right half is new.
    const rightId = pendingId();

    this._applyRawPatch((next, info) => {
      if (info.sentenceTokenLayer?.tokens) {
        const s = info.sentenceTokenLayer.tokens.find((t) => t.id === containing.id);
        if (s) s.end = charPos;
        info.sentenceTokenLayer.tokens.push({ id: rightId, begin: charPos, end: containing.end });
      }
      if (removedRelIds.size) {
        for (const layer of dependencyRelationLayers(info)) {
          if (!Array.isArray(layer.relations)) continue;
          layer.relations = layer.relations.filter((r) => !removedRelIds.has(r.id));
        }
      }
    });

    return this._queueWrite(label, async () => {
      const res = await this._client.tokens.split(settledId(containing.id), charPos, undefined, {
        id: rightId,
      });
      this._settle(new Map([[rightId, createdId(res)]]));
    });
  }

  // Reconcile-on-open: make sure the server holds UD's layer rules, repair
  // what the rules leave to an app, then validate what remains.
  //   1. Layer rules (utils/udConstraints.js), maintainers only: a relation
  //      inside one sentence, one head per word, no cycle, one Form, Lemma,
  //      UPOS and XPOS per word, syntactic words as wide as their word, a
  //      closed list's values. The server applies them in every write,
  //      whoever writes. A project whose layers do not hold them yet gets the
  //      server's repair of its stored data first, then the declaration. A
  //      rule the data still breaks (two heads, a cycle, an off-list value) is
  //      not put in force, and a finding says so.
  //   2. Seed a default full-width syntactic-word for every word that lacks one
  //      (another app, e.g. IGT, can leave words bare — UD annotations live on
  //      the syntactic-word layer, so a bare word is invisible/unannotatable).
  //   3. Delete enhanced-layer suppressors whose basic relation has gone (see
  //      enhancedGraph.js).
  // Then run validateConlluDocument over the reloaded state: residual heal
  // failures come back as `findings` for the caller to log + toast.
  // Deliberately NOT a queued write: this runs once on a freshly loaded doc,
  // and a heal failure must not trigger the queue's reload-and-revert (which
  // would discard the just-loaded doc). A single-flight guard plus the editor's
  // per-document gate keep StrictMode's double-invoke from double-healing (which
  // would otherwise seed duplicate syntactic-words).
  // Every heal write folds under one "Repair on open" audit entry
  // (no entry at all when nothing needed healing — groups are created lazily
  // by the first write).
  describeReconcile(result) {
    return describeUdReconcile(result);
  }

  // Maintainers only, since it is layer config; a failure is not worth
  // interrupting anyone over, because nothing is worse than it was. The write
  // adds only the missing keys to what the layer declared, and names that
  // declaration as `expected`, so a key another app declared after this page
  // loaded is not written over: that write is refused and the next open plans
  // again.
  async _backfillPreserveOnSplit(info) {
    if (!canManageProject(this._project, this._user)) return;
    const ids = planPreserveOnSplit(info, PLAID_NAMESPACE, PRESERVE_ON_SPLIT_KEY, PROVENANCE_KEYS);
    const layers = [info?.sentenceTokenLayer, info?.wordTokenLayer, info?.morphemeTokenLayer];
    for (const id of ids) {
      const layer = layers.find((l) => l?.id === id);
      const options = expectStored(layer, PLAID_NAMESPACE, PRESERVE_ON_SPLIT_KEY);
      const declared = Array.isArray(options.expected) ? options.expected : [];
      const value = [...declared, ...PROVENANCE_KEYS.filter((k) => !declared.includes(k))];
      try {
        await this._client.tokenLayers.setConfig(
          id,
          PLAID_NAMESPACE,
          PRESERVE_ON_SPLIT_KEY,
          value,
          undefined,
          options,
        );
      } catch (err) {
        if (isConfigConflict(err)) continue;
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
      createdSyntacticWords: 0,
      rulesDeclared: false,
      rulesRepaired: false,
      findings: [],
    };
    if (this._reconciling) return ZERO;
    this._reconciling = true;
    try {
      let info = this.layerInfo;
      // Back-fill, the reconcile contract's second step. Provenance lost in a
      // split leaves nothing for a later pass to find, so the declaration has
      // to be in place before the split, not repaired after it.
      await this._backfillPreserveOnSplit(info);
      const addedEnhancedLayer = await this._backfillEnhancedLayer(info);
      if (addedEnhancedLayer) {
        await this._reload();
        info = this.layerInfo;
      }
      const rules = await ensureLayerConstraints(this._client, wantedConstraints(info), {
        canManage: canManageProject(this._project, this._user),
      });
      // The server's repair changed stored rows this screen shows.
      if (rules.repaired) {
        await this._reload();
        info = this.layerInfo;
      }
      const staleIds = staleSuppressorIds(info);
      const { morphemeTokenLayer, textLayer } = info;
      const textId = textLayer?.text?.id;
      const canHeal = Boolean(morphemeTokenLayer?.id && textId);
      const seedExtents = canHeal ? wordsNeedingSyntacticWord(info) : [];

      let createdSyntacticWords = 0;
      if (seedExtents.length) {
        await this._client.batched(async (b) => {
          b.tokens.bulkCreate(
            seedExtents.map((e) => ({
              tokenLayerId: morphemeTokenLayer.id,
              text: textId,
              begin: e.begin,
              end: e.end,
              precedence: 0,
            })),
          );
        });
        createdSyntacticWords = seedExtents.length;
      }

      // Suppressors left over a pair with no relation. A concurrent open may
      // have deleted them already, so a not-found is success.
      if (staleIds.length) {
        try {
          await this._client.batched(async (b) => {
            staleIds.forEach((id) => b.relations.delete(id));
          });
        } catch (err) {
          if (err?.status !== 404) throw err;
        }
      }

      // Re-read only when a heal actually wrote. The batches above land
      // server-side and this instance knows nothing about them, so a heal has
      // to refetch — but a clean pass has nothing to refetch, and its in-memory
      // state IS the server state. This runs behind a blocking spinner on every
      // Annotate open now, so an unconditional reload would make the ordinary
      // case (nothing to repair) pay a full document fetch for the rare one.
      const healed = createdSyntacticWords + staleIds.length > 0;
      const tally = {
        createdSyntacticWords,
        rulesDeclared: rules.changed,
        rulesRepaired: rules.repaired,
      };
      // Every write has landed: the repair is whole, and a failure from here
      // on leaves only the screen behind it. Its findings would describe the
      // document as it was before the repair, so there are none.
      try {
        if (healed) await this._reload();
        // Validate the true server state — even when nothing healed.
        return {
          ...tally,
          findings: [
            ...validateConlluDocument(this.layerInfo),
            ...rulesNotInForce(rules.pending, this.layerInfo),
          ],
        };
      } catch (refreshError) {
        console.error('reconcileOnOpen could not re-read the repaired document:', refreshError);
        return { ...tally, findings: [], refreshError };
      }
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
  // As many forms as the token has words respells them: each word keeps its
  // token and everything on it, and only its Form is written
  // (`_respellWords`). A different count replaces them: the old morphemes go
  // with everything on them, as the server's cascade takes them, and the new
  // ones show under pending ids. `annotationLossForWord` says what goes.
  //
  // Two-batch atomicity: (1) delete-old + create-new morphemes in one
  // atomic batch. (2) Form + Lemma spans for the new morphemes in a second
  // atomic batch (batch ops cannot reference ids created earlier in the
  // same batch).
  async setWordMorphemes(word, forms) {
    const cleanForms = forms.map((f) => (f || '').trim()).filter((f) => f.length > 0);
    if (cleanForms.length === 0) return false;
    const label = 'Failed to set words';
    const { textLayer, morphemeTokenLayer, lemmaLayer, formLayer } = this.layerInfo;
    const text = textLayer?.text;
    if (!morphemeTokenLayer?.id || !text?.id) {
      this.setError(notSetUp('UD word layer missing'));
      return false;
    }
    if (!this._canWrite(label)) return false;
    const morphemeTokens = morphemeTokenLayer.tokens || [];

    // Use the persisted body for the form-vs-substring comparison and for
    // the word's surface form. Morpheme begin/end are in body coordinates,
    // so substring(body, word.begin, word.end) is the authoritative surface.
    const body = this.body;
    const wordSubstring = cpSlice(body, word.begin, word.end);
    const isMwt = cleanForms.length > 1;
    const existingMeta = word.metadata || {};
    // Decide whether the word's `form` needs to change. Only that key is
    // written, so the word's other metadata is never sent from this copy.
    let wordFormOps = null;
    if (isMwt) {
      if (existingMeta.form !== wordSubstring) {
        wordFormOps = [{ op: 'set', path: ['form'], value: wordSubstring }];
      }
    } else if (existingMeta.form != null) {
      wordFormOps = [{ op: 'delete', path: ['form'] }];
    }

    const existing = morphemeTokens.filter((m) => containsToken(word, m));
    if (existing.length === cleanForms.length) {
      const ordered = [...existing].sort((a, b) => (a.precedence ?? 0) - (b.precedence ?? 0));
      return this._respellWords(word, ordered, cleanForms, wordSubstring, wordFormOps, label);
    }
    const removedMorphIds = new Set(existing.map((m) => m.id));
    const removedLemmaSpanIds = new Set(
      (lemmaLayer?.spans || [])
        .filter((s) => Array.isArray(s.tokens) && s.tokens.some((t) => removedMorphIds.has(t)))
        .map((s) => s.id),
    );
    const morphemes = cleanForms.map((_, i) => ({
      id: pendingId(),
      begin: word.begin,
      end: word.end,
      precedence: i,
    }));
    const formSpans = [];
    const lemmaSpans = [];
    morphemes.forEach((m, i) => {
      const form = cleanForms[i];
      if (formLayer?.id && (isMwt || form !== wordSubstring)) {
        formSpans.push({ id: pendingId(), tokens: [m.id], value: form });
      }
      if (lemmaLayer?.id) {
        lemmaSpans.push({
          id: pendingId(),
          tokens: [m.id],
          value: form,
          metadata: LEMMA_FROM_FORM,
        });
      }
    });

    this._applyRawPatch((next, info) => {
      if (wordFormOps) {
        const w = (info.wordTokenLayer?.tokens || []).find((t) => t.id === settledId(word.id));
        if (w) w.metadata = applyMetadataOps(w.metadata, wordFormOps);
      }
      const layer = info.morphemeTokenLayer;
      layer.tokens = (layer.tokens || [])
        .filter((t) => !removedMorphIds.has(t.id))
        .concat(morphemes.map((m) => ({ ...m })));
      (layer.spanLayers || []).forEach((sl) => {
        if (Array.isArray(sl.spans)) {
          sl.spans = sl.spans.filter(
            (s) => !(Array.isArray(s.tokens) && s.tokens.some((t) => removedMorphIds.has(t))),
          );
        }
      });
      for (const relLayer of dependencyRelationLayers(info)) {
        if (!Array.isArray(relLayer.relations)) continue;
        relLayer.relations = relLayer.relations.filter(
          (r) => !removedLemmaSpanIds.has(r.source) && !removedLemmaSpanIds.has(r.target),
        );
      }
      const add = (spanLayer, spans) => {
        if (!spanLayer || spans.length === 0) return;
        if (!Array.isArray(spanLayer.spans)) spanLayer.spans = [];
        spanLayer.spans.push(...spans.map((s) => ({ ...s, tokens: [...s.tokens] })));
      };
      add(info.formLayer, formSpans);
      add(info.lemmaLayer, lemmaSpans);
    });

    return this._queueWrite(label, async () => {
      const ids = new Map();
      // Batch 1: atomic morpheme replacement PLUS the word-metadata write
      // (so the server commits or rolls them back together; no window where
      // morphemes exist with stale or missing `metadata.form`).
      const setResults = await this._client.batched(async (b) => {
        if (existing.length) b.tokens.bulkDelete(existing.map((m) => settledId(m.id)));
        b.tokens.bulkCreate(
          morphemes.map(({ id, begin, end, precedence }) => ({
            id,
            tokenLayerId: morphemeTokenLayer.id,
            text: text.id,
            begin,
            end,
            precedence,
          })),
        );
        if (wordFormOps) b.tokens.patchMetadata(settledId(word.id), wordFormOps);
      });
      // bulkCreate sits at index 1 when we issued a bulkDelete, else index 0;
      // patchMetadata (if any) is the final op and we don't need its result.
      const created = createdIds(setResults[existing.length ? 1 : 0]);
      morphemes.forEach((m, i) => created[i] && ids.set(m.id, created[i]));

      // Batch 2: atomic Form + Lemma spans for the new morphemes. (Separate
      // batch because these ops reference morpheme ids produced above.)
      const ops = (spanLayer, spans) =>
        spans.map((s) => ({
          id: s.id,
          spanLayerId: spanLayer.id,
          tokens: [ids.get(s.tokens[0])],
          value: s.value,
          ...(s.metadata ? { metadata: s.metadata } : {}),
        }));
      if (formSpans.length || lemmaSpans.length) {
        const spanResults = await this._client.batched(async (b) => {
          if (formSpans.length) b.spans.bulkCreate(ops(formLayer, formSpans));
          if (lemmaSpans.length) b.spans.bulkCreate(ops(lemmaLayer, lemmaSpans));
        });
        const [formIds, lemmaIds] = formSpans.length
          ? [createdIds(spanResults[0]), createdIds(spanResults[1])]
          : [null, createdIds(spanResults[0])];
        formSpans.forEach((s, i) => formIds?.[i] && ids.set(s.id, formIds[i]));
        lemmaSpans.forEach((s, i) => lemmaIds?.[i] && ids.set(s.id, lemmaIds[i]));
      }
      this._settle(ids);
    });
  }

  // The Form writes that respell a token's words in place, as many forms as
  // it has words, in order of precedence. A word whose form is the token's
  // own text carries no Form span (see setWordMorphemes). Nothing else on the
  // words is touched.
  _respellWords(word, morphemes, forms, wordSubstring, wordFormOps, label) {
    const { formLayer } = this.layerInfo;
    const isMwt = forms.length > 1;
    const plan = [];
    morphemes.forEach((m, i) => {
      const want = isMwt || forms[i] !== wordSubstring ? forms[i] : null;
      const span = (formLayer?.spans || []).find(
        (s) => Array.isArray(s.tokens) && s.tokens.includes(m.id),
      );
      if (span && want == null) plan.push({ kind: 'delete', span });
      else if (span && span.value !== want) {
        plan.push({
          kind: 'update',
          span,
          value: want,
          stamp: this.writer.editStamp(span.metadata),
        });
      } else if (!span && want != null && formLayer?.id) {
        const stamp = this.writer.createStamp;
        plan.push({ kind: 'create', morpheme: m, id: pendingId(), value: want, stamp });
      }
    });
    if (plan.length === 0 && !wordFormOps) return true;

    this._applyRawPatch((next, info) => {
      if (wordFormOps) {
        const w = (info.wordTokenLayer?.tokens || []).find((t) => t.id === settledId(word.id));
        if (w) w.metadata = applyMetadataOps(w.metadata, wordFormOps);
      }
      const layer = info.formLayer;
      if (!layer) return;
      if (!Array.isArray(layer.spans)) layer.spans = [];
      for (const step of plan) {
        if (step.kind === 'delete') {
          layer.spans = layer.spans.filter((s) => s.id !== step.span.id);
        } else if (step.kind === 'update') {
          const s = layer.spans.find((x) => x.id === step.span.id);
          if (!s) continue;
          s.value = step.value;
          if (step.stamp) s.metadata = mergeMetadata(s.metadata, step.stamp);
        } else {
          layer.spans.push({
            id: step.id,
            tokens: [step.morpheme.id],
            value: step.value,
            ...(step.stamp ? { metadata: step.stamp } : {}),
          });
        }
      }
    });

    return this._queueWrite(label, async () => {
      const creates = [];
      let at = 0;
      const results = await this._client.batched(async (b) => {
        if (wordFormOps) {
          b.tokens.patchMetadata(settledId(word.id), wordFormOps);
          at += 1;
        }
        for (const step of plan) {
          if (step.kind === 'delete') {
            b.spans.delete(settledId(step.span.id));
            at += 1;
          } else if (step.kind === 'update') {
            const id = settledId(step.span.id);
            b.spans.update(id, step.value);
            at += 1;
            if (step.stamp) {
              b.spans.patchMetadata(id, metadataOps(step.stamp));
              at += 1;
            }
          } else {
            creates.push([step.id, at]);
            b.spans.create(
              formLayer.id,
              [settledId(step.morpheme.id)],
              step.value,
              step.stamp || undefined,
              undefined,
              { id: step.id },
            );
            at += 1;
          }
        }
      });
      this._settle(new Map(creates.map(([id, i]) => [id, createdId(results[i])])));
    });
  }

  // What replacing a token's words deletes with them, as the Text Editor
  // asks before it does: the annotations on the words (a lemma that only
  // repeats the word's form is not counted) and the dependency relations
  // attached to them. `forms` counts the words' Form spans: every one on a
  // token of several words, and one that differs from the text on a token of
  // one word. Deleting the token loses them, while retyping its words writes
  // the new forms. `{ annotations, relations, forms }`.
  annotationLossForWord(word) {
    const info = this.layerInfo;
    const morphemes = (info.morphemeTokenLayer?.tokens || []).filter((m) => containsToken(word, m));
    const ids = new Set(morphemes.map((m) => m.id));
    const on = (layer) =>
      (layer?.spans || []).filter(
        (s) => Array.isArray(s.tokens) && s.tokens.some((t) => ids.has(t)),
      );
    const formSpans = on(info.formLayer);
    const forms = new Map(formSpans.map((s) => [s.tokens[0], s.value]));
    const surface = cpSlice(this.body, word.begin, word.end);
    const lemmas = on(info.lemmaLayer);
    const annotations =
      lemmas.filter((s) => s.value != null && s.value !== (forms.get(s.tokens[0]) ?? surface))
        .length +
      on(info.uposLayer).length +
      on(info.xposLayer).length +
      on(info.featuresLayer).length;
    const lemmaIds = new Set(lemmas.map((s) => s.id));
    const relations = dependencyRelationLayers(info)
      .flatMap((layer) => layer.relations || [])
      .filter((r) => !isSuppressor(r) && (lemmaIds.has(r.source) || lemmaIds.has(r.target))).length;
    return {
      annotations,
      relations,
      forms:
        morphemes.length > 1
          ? formSpans.length
          : formSpans.filter((s) => s.value != null && s.value !== surface).length,
    };
  }

  // Delete a word token (cascades its morphemes and their spans + relations
  // server-side). Locally we mirror the cascade so the UI updates
  // immediately without a refetch.
  async deleteWord(rawWordId) {
    const label = 'Failed to delete token';
    if (!this._canWrite(label)) return false;
    const wordId = settledId(rawWordId);
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
    return this._queueWrite(label, () => this._client.tokens.delete(settledId(wordId)));
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
      this.setError(notSetUp('UD token layers missing'));
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

    const label = 'Failed to create token';
    if (!this._canWrite(label)) return false;
    // Token offsets are code points; .length is UTF-16 units and overshoots
    // on astral characters.
    const fullLen = cpLength(textContent);
    const sentence =
      sentenceTokens.length === 0 ? { id: pendingId(), begin: 0, end: fullLen } : null;
    const wordRow = { id: pendingId(), begin, end };
    const morpheme = { id: pendingId(), begin, end };
    const lemma = lemmaLayer?.id
      ? {
          id: pendingId(),
          tokens: [morpheme.id],
          value: cpSlice(textContent, begin, end),
          metadata: LEMMA_FROM_FORM,
        }
      : null;

    this._applyRawPatch((next, infoNext) => {
      const push = (layer, key, row) => {
        if (!layer) return;
        if (!Array.isArray(layer[key])) layer[key] = [];
        layer[key].push(row);
      };
      if (sentence) push(infoNext.sentenceTokenLayer, 'tokens', { ...sentence });
      push(infoNext.wordTokenLayer, 'tokens', { ...wordRow });
      push(infoNext.morphemeTokenLayer, 'tokens', { ...morpheme });
      if (lemma) push(infoNext.lemmaLayer, 'spans', { ...lemma, tokens: [...lemma.tokens] });
    });

    return this._queueWrite(label, async () => {
      const ids = new Map();
      const res = await this._client.batched(async (b) => {
        if (sentence) {
          b.tokens.bulkCreate([
            {
              id: sentence.id,
              tokenLayerId: sentenceTokenLayer.id,
              text: text.id,
              begin: 0,
              end: fullLen,
            },
          ]);
        }
        b.tokens.bulkCreate([
          { id: wordRow.id, tokenLayerId: wordTokenLayer.id, text: text.id, begin, end },
        ]);
        b.tokens.bulkCreate([
          { id: morpheme.id, tokenLayerId: morphemeTokenLayer.id, text: text.id, begin, end },
        ]);
      });
      if (sentence) ids.set(sentence.id, createdIds(res[0])[0]);
      ids.set(wordRow.id, createdIds(res[res.length - 2])[0]);
      const morphemeId = createdIds(res[res.length - 1])[0];
      ids.set(morpheme.id, morphemeId);

      // Default lemma span (follow-up call: it needs the morpheme id). A
      // failure propagates, so the refetch shows a lemma-less word rather
      // than hiding it.
      if (lemma && morphemeId) {
        const lr = await this._client.spans.bulkCreate([
          {
            id: lemma.id,
            spanLayerId: lemmaLayer.id,
            tokens: [morphemeId],
            value: lemma.value,
            metadata: lemma.metadata,
          },
        ]);
        ids.set(lemma.id, createdIds(lr)[0]);
      }
      this._settle(ids);
    });
  }

  // ============================================================
  // Annotation operations (lemma / upos / xpos / form / features)
  // ============================================================

  // Set / update / create an annotation span on a morpheme. For `features`
  // each call creates a new span (multiple features per token allowed);
  // for the other fields the call updates an existing span if one is
  // already attached to the morpheme.
  async updateAnnotation(rawTokenId, field, value) {
    const tokenId = settledId(rawTokenId);
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

    const label = `Failed to update ${field}`;
    if (!this._canWrite(label)) return false;
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
        return this._queueWrite(label, async () => {
          const id = settledId(existingFeat.id);
          if (verifyFeat) {
            await this._client.batched(async (b) => {
              b.spans.update(id, pair);
              b.spans.patchMetadata(id, metadataOps(verifyFeat));
            });
          } else {
            await this._client.spans.update(id, pair);
          }
        });
      }
      // Optimistic create: the span shows under a pending id until the
      // server's comes back. A new span carries the writer's create stamp
      // (null for a verifier).
      const stamp = this.writer.createStamp;
      const newSpanId = pendingId();
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
      return this._queueWrite(label, async () => {
        const spanResult = await this._client.spans.create(
          targetLayer.id,
          [settledId(tokenId)],
          pair,
          stamp || undefined,
          undefined,
          { id: newSpanId },
        );
        this._settle(new Map([[newSpanId, createdId(spanResult)]]));
      });
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
      if (!existingSpan) return true;
      this._applyRawPatch((next, infoNext) => {
        const targetLayerDoc = infoNext.tokenLayer?.spanLayers?.find((layer) =>
          layer.spans?.some((span) => span.id === existingSpan.id),
        );
        if (targetLayerDoc?.spans) {
          targetLayerDoc.spans = targetLayerDoc.spans.filter((s) => s.id !== existingSpan.id);
        }
      });
      return this._queueWrite(label, () => this._client.spans.delete(settledId(existingSpan.id)));
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
      return this._queueWrite(label, async () => {
        const id = settledId(existingSpan.id);
        if (verify) {
          await this._client.batched(async (b) => {
            b.spans.update(id, value);
            b.spans.patchMetadata(id, metadataOps(verify));
          });
        } else {
          await this._client.spans.update(id, value);
        }
      });
    }
    // Optimistic create, as above.
    const stamp = this.writer.createStamp;
    const newSpanId = pendingId();
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
    return this._queueWrite(label, async () => {
      const spanResult = await this._client.spans.create(
        targetLayer.id,
        [settledId(tokenId)],
        value,
        stamp || undefined,
        undefined,
        { id: newSpanId },
      );
      this._settle(new Map([[newSpanId, createdId(spanResult)]]));
    });
  }

  async deleteFeature(rawSpanId) {
    const spanId = settledId(rawSpanId);
    const label = 'Failed to delete feature';
    if (!this._canWrite(label)) return false;
    // Optimistic: drop the feature tag locally before the round trip.
    this._applyRawPatch((next, info) => {
      const featuresLayerDoc = info.featuresLayer;
      if (featuresLayerDoc && Array.isArray(featuresLayerDoc.spans)) {
        featuresLayerDoc.spans = featuresLayerDoc.spans.filter((span) => span.id !== spanId);
      }
    });
    return this._queueWrite(label, () => this._client.spans.delete(settledId(spanId)));
  }

  // The lemma spans a write's relation endpoints name, each given as a span id
  // OR a morpheme token id (the latter is the common case when called from the
  // annotation grid). A word with no lemma span yet is given one under a
  // pending id: `ids` holds what each endpoint resolved to, `pending` the spans
  // to add locally with `_addPendingSpans` and to create with
  // `_createPendingSpans`. The same word named twice (a root) is one span.
  _planLemmaSpans(info, candidateIds) {
    const lemmaSpans = info.lemmaLayer?.spans || [];
    const textBody = info.textLayer?.text?.body || '';
    // Made on the writer's behalf to hang the relation on: their stamp.
    const stamp = this.writer.createStamp;
    const pending = [];
    const ids = candidateIds.map((given) => {
      if (!given || given === 'ROOT') return null;
      // An id the screen still holds from before the server answered.
      const candidateId = settledId(given);
      const existingById = lemmaSpans.find((span) => span.id === candidateId);
      if (existingById) return existingById.id;
      // Span `tokens` is a flat array of token ids.
      const tokenId = candidateId;
      const existingByToken = lemmaSpans.find(
        (span) => Array.isArray(span.tokens) && span.tokens.includes(tokenId),
      );
      if (existingByToken) return existingByToken.id;
      const planned = pending.find((span) => span.tokens[0] === tokenId);
      if (planned) return planned.id;
      const token = info.tokenLayer?.tokens?.find((t) => t.id === tokenId);
      const span = {
        id: pendingId(),
        tokens: [tokenId],
        value: token ? cpSlice(textBody, token.begin, token.end) : '',
        ...(stamp ? { metadata: stamp } : {}),
      };
      pending.push(span);
      return span.id;
    });
    return { ids, pending };
  }

  _addPendingSpans(infoNext, pending) {
    const lemmaLayerDoc = infoNext.lemmaLayer;
    if (!lemmaLayerDoc || pending.length === 0) return;
    if (!Array.isArray(lemmaLayerDoc.spans)) lemmaLayerDoc.spans = [];
    lemmaLayerDoc.spans.push(...pending.map((span) => ({ ...span })));
  }

  // Create the planned spans on the server, recording each one's id in `ids`
  // (pending id to server id).
  async _createPendingSpans(info, pending, ids) {
    for (const span of pending) {
      const created = await this._client.spans.create(
        info.lemmaLayer.id,
        span.tokens.map(settledId),
        span.value,
        span.metadata || undefined,
        undefined,
        { id: span.id },
      );
      ids.set(span.id, createdId(created));
    }
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
      this.setError(notSetUp('UD relation layer missing'));
      return false;
    }
    if (!info.lemmaLayer) {
      this.setError(notSetUp('UD lemma layer missing'));
      return false;
    }

    const label = 'Failed to create relation';
    if (!this._canWrite(label)) return false;
    // Optimistic, as every write is: the relation (and a lemma span for a
    // word that had none) shows under a pending id before the round trip,
    // and the server's ids are swapped in when it answers.
    const {
      ids: [resolvedSourceId, resolvedTargetId],
      pending,
    } = this._planLemmaSpans(info, [sourceSpanId, targetSpanId]);

    if (!resolvedSourceId || !resolvedTargetId) {
      console.warn('Unable to create relation because lemma spans could not be resolved:', {
        sourceSpanId,
        targetSpanId,
      });
      return false;
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
    const relationId = pendingId();
    this._applyRawPatch((next, infoNext) => {
      this._addPendingSpans(infoNext, pending);
      const relLayer = infoNext.relationLayer;
      if (!relLayer) return;
      if (!Array.isArray(relLayer.relations)) relLayer.relations = [];
      relLayer.relations = relLayer.relations.filter((rel) => rel.target !== resolvedTargetId);
      relLayer.relations.push({
        id: relationId,
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

    return this._queueWrite(label, async () => {
      const ids = new Map();
      await this._createPendingSpans(info, pending, ids);
      const serverId = (id) => ids.get(id) || settledId(id);
      const batchResults = await this._client.batched(async (b) => {
        incomingRelations.forEach((rel) => b.relations.delete(serverId(rel.id)));
        staleSuppressors.forEach((id) => b.relations.delete(serverId(id)));
        b.relations.create(
          info.relationLayer.id,
          serverId(resolvedSourceId),
          serverId(resolvedTargetId),
          finalDeprel,
          relStamp || undefined,
          undefined,
          { id: relationId },
        );
      });
      ids.set(relationId, createdId(batchResults[batchResults.length - 1]));
      this._settle(ids);
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
      this.setError(notSetUp('UD enhanced relation layer missing'));
      return false;
    }
    if (!info.lemmaLayer) {
      this.setError(notSetUp('UD lemma layer missing'));
      return false;
    }

    const label = 'Failed to create enhanced relation';
    if (!this._canWrite(label)) return false;
    // Optimistic, for createRelation's reason.
    const {
      ids: [source, target],
      pending,
    } = this._planLemmaSpans(info, [sourceSpanId, targetSpanId]);
    if (!source || !target) return null;

    const rows = info.enhancedRelationLayer.relations || [];
    const basicOverPair = (info.relationLayer?.relations || []).find(
      (rel) => rel.source === source && rel.target === target,
    );
    const value = deprel || basicOverPair?.value || (source === target ? 'root' : 'dep');
    const sameEdge = (r) => r.source === source && r.target === target;
    if (rows.some((r) => sameEdge(r) && !isSuppressor(r) && r.value === value)) return null;

    const suppress = Boolean(basicOverPair) && !rows.some(sameEdge);
    const stamp = this.writer.createStamp;
    const suppressorId = suppress ? pendingId() : null;
    const edgeId = pendingId();
    this._applyRawPatch((next, infoNext) => {
      this._addPendingSpans(infoNext, pending);
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
        id: edgeId,
        source,
        target,
        value,
        ...(stamp ? { metadata: stamp } : {}),
      });
    });

    const ok = await this._queueWrite(label, async () => {
      const ids = new Map();
      await this._createPendingSpans(info, pending, ids);
      const serverId = (id) => ids.get(id) || settledId(id);
      const results = await this._client.batched(async (b) => {
        if (suppress) {
          b.relations.create(
            info.enhancedRelationLayer.id,
            serverId(source),
            serverId(target),
            null,
            { [SUPPRESS_KEY]: true },
            undefined,
            { id: suppressorId },
          );
        }
        b.relations.create(
          info.enhancedRelationLayer.id,
          serverId(source),
          serverId(target),
          value,
          stamp || undefined,
          undefined,
          { id: edgeId },
        );
      });
      if (suppressorId) ids.set(suppressorId, createdId(results[0]));
      ids.set(edgeId, createdId(results[results.length - 1]));
      this._settle(ids);
    });
    return ok ? settledId(edgeId) : false;
  }

  // Say whether the enhanced graph has this BASIC relation. It does unless a
  // suppressor lies over it, so this creates or deletes that one row.
  async setRelationSuppressed(rawRelationId, suppressed) {
    const relationId = settledId(rawRelationId);
    const info = this.layerInfo;
    if (!info.enhancedRelationLayer) {
      this.setError(notSetUp('UD enhanced relation layer missing'));
      return false;
    }
    const basic = (info.relationLayer?.relations || []).find((r) => r.id === relationId);
    if (!basic) return false;
    const existing = suppressorFor(basic, info.enhancedRelationLayer.relations);
    if (Boolean(existing) === Boolean(suppressed)) return true;

    const label = 'Failed to update the enhanced graph';
    if (!this._canWrite(label)) return false;
    if (existing) {
      // Optimistic, as every delete is.
      this._applyRawPatch((next, infoNext) => {
        const layer = infoNext.enhancedRelationLayer;
        if (!Array.isArray(layer?.relations)) return;
        layer.relations = layer.relations.filter((r) => r.id !== existing.id);
      });
      return this._queueWrite(label, () => this._client.relations.delete(settledId(existing.id)));
    }
    // Optimistic too: the suppressor shows under a pending id.
    const id = pendingId();
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
    return this._queueWrite(label, async () => {
      const created = await this._client.relations.create(
        info.enhancedRelationLayer.id,
        settledId(basic.source),
        settledId(basic.target),
        null,
        { [SUPPRESS_KEY]: true },
        undefined,
        { id },
      );
      this._settle(new Map([[id, createdId(created)]]));
    });
  }

  // A relation's label, in the tree or in the enhanced layer: the id says which.
  async updateRelation(rawRelationId, deprel) {
    const relationId = settledId(rawRelationId);
    const label = 'Failed to update relation';
    if (!this._canWrite(label)) return false;
    // Human edit of a machine relation verifies it (provenance write
    // contract) — same shape as updateAnnotation: one optimistic patch,
    // one atomic batch.
    const existing = dependencyRelationLayers(this.layerInfo)
      .flatMap((layer) => layer.relations || [])
      .find((r) => r.id === relationId);
    const verify = this.writer.editStamp(existing?.metadata);
    // Optimistic: reflect the new value immediately, BEFORE the round trip,
    // so the label doesn't flash the previous value while the save is in
    // flight. On failure, the queue reloads from the server and reverts.
    this._applyRawPatch((next, infoNext) => {
      for (const relLayer of dependencyRelationLayers(infoNext)) {
        const found = (relLayer.relations || []).find((r) => r.id === relationId);
        if (!found) continue;
        found.value = deprel;
        if (verify) found.metadata = mergeMetadata(found.metadata, verify);
      }
    });
    return this._queueWrite(label, async () => {
      const id = settledId(relationId);
      if (verify) {
        await this._client.batched(async (b) => {
          b.relations.update(id, deprel);
          b.relations.patchMetadata(id, metadataOps(verify));
        });
      } else {
        await this._client.relations.update(id, deprel);
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
  async deleteRelation(rawRelationId) {
    const relationId = settledId(rawRelationId);
    const label = 'Failed to delete relation';
    if (!this._canWrite(label)) return false;
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
    const doomed = new Set([relationId, ...(freed ? this._suppressorIdsOver(info, [freed]) : [])]);
    // Optimistic: drop the arc locally before the round trip.
    this._applyRawPatch((next, infoNext) => {
      for (const relLayer of dependencyRelationLayers(infoNext)) {
        if (!Array.isArray(relLayer.relations)) continue;
        relLayer.relations = relLayer.relations.filter((r) => !doomed.has(r.id));
      }
    });
    return this._queueWrite(label, async () => {
      if (doomed.size === 1) {
        await this._client.relations.delete(settledId(relationId));
      } else {
        await this._client.batched(async (b) => {
          for (const id of doomed) b.relations.delete(settledId(id));
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
    const label = 'Failed to accept annotations';
    if (!this._canWrite(label)) return false;
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

    if (spanPatchById.size === 0 && relPatchById.size === 0) return true; // nothing to confirm

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

    return this._queueWrite(
      label,
      () =>
        this._client.batched(async (b) => {
          for (const [id, patch] of spanPatchById) {
            b.spans.patchMetadata(settledId(id), metadataOps(patch));
          }
          for (const [id, patch] of relPatchById) {
            b.relations.patchMetadata(settledId(id), metadataOps(patch));
          }
        }),
      'Accept predicted annotations',
      { kind: 'review' },
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
    const label = 'Failed to discard predictions';
    if (!this._canWrite(label)) return false;
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

    if (spanIds.size === 0 && relIds.size === 0) return true; // nothing to discard

    const discardedBasic = (info.relationLayer?.relations || []).filter((rel) =>
      relIds.has(rel.id),
    );
    for (const id of this._suppressorIdsOver(info, discardedBasic)) relIds.add(id);

    // Optimistic: a delete, so the grid empties now and the queue
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

    return this._queueWrite(
      label,
      () =>
        this._client.batched(async (b) => {
          // Relations before spans: a relation whose anchor span is already
          // gone is gone too, and deleting it twice is a 404.
          for (const id of relIds) b.relations.delete(settledId(id));
          for (const id of spanIds) b.spans.delete(settledId(id));
        }),
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
