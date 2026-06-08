import { cpLength, cpSlice, utf16ToCp } from '@larc-iu/plaid-client';
import { getUdLayerInfo, containsToken, missingUdLayerLabels } from '../utils/udLayerUtils.js';
import { interSententialRelationIds, wordsNeedingSyntacticWord } from '../utils/udReconcile.js';
import { parseCoNLLU, buildConlluHierarchy } from '../utils/conlluParser.js';
import { basicTokenize } from '../utils/basicTokenize.js';
import { notifyError } from '../utils/feedback.jsx';

const UNDERSCORE = '_';

const byPosition = (a, b) =>
  (a.begin - b.begin) || (a.end - b.end) || ((a.precedence ?? 0) - (b.precedence ?? 0));

const buildSpanIndex = (layer) => {
  const index = new Map();
  (layer?.spans || []).forEach(span => {
    const spanTokens = Array.isArray(span.tokens) ? span.tokens : [];
    spanTokens
      .filter(tokenId => tokenId != null)
      .forEach(tokenId => {
        if (!index.has(tokenId)) index.set(tokenId, []);
        index.get(tokenId).push(span);
      });
  });
  return index;
};

const cloneRaw = (raw) => JSON.parse(JSON.stringify(raw));

// Single source of truth for a loaded plaid-ud document. Wraps a raw
// plaid-client document, knows the UD 3-layer hierarchy (sentences > words >
// morphemes), owns the optimistic-update logic that used to live in
// TextEditor / useAnnotationHandlers, and exposes a version-counted
// subscription so React (or anything else) can re-render on change.
export class ConlluDocument {
  constructor({ raw, client = null, projectId = null }) {
    this._raw = raw;
    this._client = client;
    this._projectId = projectId;
    // `_version` is the React subscription snapshot — it bumps on EVERY emit
    // (including isSaving/error toggles that change no document data). The
    // derived caches below instead key on `_dataVersion`, which bumps only when
    // `_raw` actually changes, so transient saving re-renders don't rebuild the
    // whole sentence grid (which would re-render every cell mid-edit).
    this._version = 0;
    this._dataVersion = 0;
    this._listeners = new Set();
    this._sentencesCache = null;
    this._sentencesCacheVersion = -1;
    this._layerInfoCache = null;
    this._layerInfoCacheVersion = -1;
    this._conlluCache = null;
    this._conlluCacheVersion = -1;
    this._isSaving = false;
    this._error = '';
  }

  // Convenience factory: fetch a document by id and wrap it.
  static async load(client, projectId, documentId) {
    const raw = await client.documents.get(documentId, true);
    return new ConlluDocument({ raw, client, projectId });
  }

  // Import a CoNLL-U text into a new document in the given project.
  // Builds the sentence > word > morpheme hierarchy, creates the text + all
  // tokens + annotation spans + dependency relations, and returns the newly
  // created document id. On any failure, attempts to delete the partial
  // document so the project isn't left polluted.
  static async importFromConllu(client, projectId, name, conlluText) {
    if (!name || !name.trim()) throw new Error('Document name is required');
    if (!conlluText || !conlluText.trim()) throw new Error('No content to import');

    const parsedData = parseCoNLLU(conlluText);
    if (parsedData.sentences.length === 0) {
      throw new Error('No valid sentences found in CoNLL-U data');
    }

    let createdDocumentId = null;
    try {
      const documentResponse = await client.documents.create(projectId, name);
      createdDocumentId = documentResponse.id;
      const fullDocument = await client.documents.get(createdDocumentId, true);
      const layerInfo = getUdLayerInfo(fullDocument);

      if (!layerInfo.isConfigured) {
        const missingLabels = missingUdLayerLabels(layerInfo.missingLayers).join(', ');
        throw new Error(missingLabels
          ? `Project is missing required UD layer configuration: ${missingLabels}. Configure the project before importing.`
          : 'Project is missing required UD layer configuration. Configure the project before importing.');
      }

      const {
        textLayer,
        sentenceTokenLayer,
        wordTokenLayer,
        morphemeTokenLayer,
        formLayer,
        lemmaLayer,
        uposLayer,
        xposLayer,
        featuresLayer,
        relationLayer
      } = layerInfo;

      const hierarchy = buildConlluHierarchy(parsedData);

      const textResponse = await client.texts.create(textLayer.id, createdDocumentId, hierarchy.text);
      const textId = textResponse.id;

      // Sentences carry arbitrary `# k = v` metadata; words carry MWT
      // surface form on `metadata.form` ONLY when the FORM column was
      // explicitly non-underscore, and MWT MISC on `metadata.misc`.
      const sentenceOps = hierarchy.sentences.map(s => {
        const op = { tokenLayerId: sentenceTokenLayer.id, text: textId, begin: s.begin, end: s.end };
        if (s.metadata && Object.keys(s.metadata).length > 0) op.metadata = s.metadata;
        return op;
      });
      const wordOps = [];
      hierarchy.sentences.forEach(s => s.words.forEach(w => {
        const op = { tokenLayerId: wordTokenLayer.id, text: textId, begin: w.begin, end: w.end };
        const meta = {};
        if (w.isMwt && w.hasExplicitForm && w.surfaceForm) meta.form = w.surfaceForm;
        if (w.misc) meta.misc = w.misc;
        if (Object.keys(meta).length > 0) op.metadata = meta;
        wordOps.push(op);
      }));
      const morphemeOps = [];
      const morphemeMeta = []; // parallel to morphemeOps
      hierarchy.sentences.forEach((s, sentIdx) => {
        s.words.forEach(w => {
          const wordSubstring = cpSlice(hierarchy.text, w.begin, w.end);
          w.morphemes.forEach(m => {
            morphemeOps.push({
              tokenLayerId: morphemeTokenLayer.id,
              text: textId,
              begin: m.begin,
              end: m.end,
              precedence: m.precedence
            });
            morphemeMeta.push({ sentIdx, row: m.row, wordSubstring });
          });
        });
      });

      // Token batch: sentences -> words -> morphemes, atomic.
      client.beginBatch();
      client.tokens.bulkCreate(sentenceOps);
      let morphemeResultIndex = -1;
      if (wordOps.length > 0) client.tokens.bulkCreate(wordOps);
      if (morphemeOps.length > 0) {
        client.tokens.bulkCreate(morphemeOps);
        morphemeResultIndex = (wordOps.length > 0) ? 2 : 1;
      }
      const tokenResults = await client.submitBatch();
      const morphemeIds = morphemeResultIndex >= 0
        ? (tokenResults[morphemeResultIndex]?.body?.ids || [])
        : [];

      // Annotation spans on morphemes. Bundle all five into ONE atomic batch.
      const lemmaSpanIds = parsedData.sentences.map(s => s.tokens.map(() => null));
      const formOps = [];
      const lemmaOps = [];
      const lemmaMeta = [];
      const uposOps = [];
      const xposOps = [];
      const featOps = [];

      morphemeMeta.forEach((meta, i) => {
        const morphemeId = morphemeIds[i];
        if (!morphemeId) return;
        const row = meta.row;
        const rowIndex = row.id - 1;

        if (formLayer && row.form && row.form !== meta.wordSubstring) {
          formOps.push({ spanLayerId: formLayer.id, tokens: [morphemeId], value: row.form });
        }
        if (lemmaLayer && row.lemma) {
          lemmaOps.push({ spanLayerId: lemmaLayer.id, tokens: [morphemeId], value: row.lemma });
          lemmaMeta.push({ sentIdx: meta.sentIdx, rowIndex });
        }
        if (uposLayer && row.upos) {
          uposOps.push({ spanLayerId: uposLayer.id, tokens: [morphemeId], value: row.upos });
        }
        if (xposLayer && row.xpos) {
          xposOps.push({ spanLayerId: xposLayer.id, tokens: [morphemeId], value: row.xpos });
        }
        if (featuresLayer && Array.isArray(row.feats)) {
          row.feats.forEach(f => featOps.push({ spanLayerId: featuresLayer.id, tokens: [morphemeId], value: f }));
        }
      });

      client.beginBatch();
      const spanOpsInOrder = [];
      if (formOps.length) { client.spans.bulkCreate(formOps); spanOpsInOrder.push('form'); }
      if (lemmaOps.length) { client.spans.bulkCreate(lemmaOps); spanOpsInOrder.push('lemma'); }
      if (uposOps.length) { client.spans.bulkCreate(uposOps); spanOpsInOrder.push('upos'); }
      if (xposOps.length) { client.spans.bulkCreate(xposOps); spanOpsInOrder.push('xpos'); }
      if (featOps.length) { client.spans.bulkCreate(featOps); spanOpsInOrder.push('feat'); }
      let spanResults = [];
      if (spanOpsInOrder.length > 0) spanResults = await client.submitBatch();
      const lemmaResultIdx = spanOpsInOrder.indexOf('lemma');
      if (lemmaResultIdx >= 0) {
        const ids = spanResults[lemmaResultIdx]?.body?.ids || [];
        lemmaMeta.forEach((lm, k) => { lemmaSpanIds[lm.sentIdx][lm.rowIndex] = ids[k]; });
      }

      // Dependency relations — a separate follow-up batch since they
      // reference lemma span ids produced above.
      if (relationLayer) {
        const relationOps = [];
        parsedData.sentences.forEach((sentence, sentIdx) => {
          const ids = lemmaSpanIds[sentIdx];
          sentence.tokens.forEach((token, tokIdx) => {
            const targetId = ids[tokIdx];
            if (!token.deprel || !targetId) return;
            if (token.head === 0) {
              relationOps.push({ relationLayerId: relationLayer.id, source: targetId, target: targetId, value: token.deprel });
            } else if (token.head > 0) {
              const sourceId = ids[token.head - 1];
              if (sourceId) {
                relationOps.push({ relationLayerId: relationLayer.id, source: sourceId, target: targetId, value: token.deprel });
              }
            }
          });
        });
        if (relationOps.length > 0) {
          client.beginBatch();
          client.relations.bulkCreate(relationOps);
          await client.submitBatch();
        }
      }

      return { documentId: createdDocumentId };
    } catch (err) {
      if (createdDocumentId) {
        try {
          await client.documents.delete(createdDocumentId);
        } catch (delErr) {
          console.error('Failed to clean up document after import failure:', delErr);
          // Surface the orphan id so the user knows they need to clean up
          // manually. The original error message stays at the front.
          const wrapped = new Error(
            `${err?.message || 'Import failed'} (rollback also failed; ` +
            `manually delete orphan document ${createdDocumentId})`
          );
          wrapped.cause = err;
          throw wrapped;
        }
      }
      throw err;
    }
  }

  get version() { return this._version; }

  get raw() { return this._raw; }
  get id() { return this._raw?.id; }
  get name() { return this._raw?.name; }
  get client() { return this._client; }
  get projectId() { return this._projectId; }
  get isSaving() { return this._isSaving; }
  get error() { return this._error; }

  // ----- React subscription bridge (useSyncExternalStore-compatible) -----
  // Arrow-function fields so identities stay stable across renders.
  subscribe = (listener) => {
    this._listeners.add(listener);
    return () => { this._listeners.delete(listener); };
  };

  getSnapshot = () => this._version;

  _emit() {
    this._version++;
    this._listeners.forEach(fn => fn());
  }

  // Operation/validation errors surface as toasts (the editors no longer render
  // a doc.error banner). We still track `_error` so callers can branch on
  // outcome and so we don't fire a duplicate toast for the same sticky message.
  setError(msg) {
    if (this._error === msg) return;
    this._error = msg;
    if (msg) notifyError(msg);
    this._emit();
  }

  clearError() {
    if (!this._error) return;
    this._error = '';
    this._emit();
  }

  // ----- layer info (cached per version) -----
  get layerInfo() {
    if (this._layerInfoCacheVersion !== this._dataVersion) {
      this._layerInfoCache = getUdLayerInfo(this._raw);
      this._layerInfoCacheVersion = this._dataVersion;
    }
    return this._layerInfoCache;
  }

  get body() {
    return this.layerInfo.textLayer?.text?.body ?? '';
  }

  // ----- derived sentence/word/morpheme hierarchy (cached per version) -----
  get sentences() {
    if (this._sentencesCache && this._sentencesCacheVersion === this._dataVersion) {
      return this._sentencesCache;
    }
    this._sentencesCache = this._buildSentences();
    this._sentencesCacheVersion = this._dataVersion;
    return this._sentencesCache;
  }

  _buildSentences() {
    const body = this.body;
    if (!body) return [];

    const {
      sentenceTokenLayer,
      wordTokenLayer,
      morphemeTokenLayer,
      formLayer,
      lemmaLayer,
      uposLayer,
      xposLayer,
      featuresLayer,
      relationLayer
    } = this.layerInfo;

    const sentenceTokens = [...(sentenceTokenLayer?.tokens || [])].sort(byPosition);
    const wordTokens = [...(wordTokenLayer?.tokens || [])].sort(byPosition);
    const morphemeTokens = [...(morphemeTokenLayer?.tokens || [])].sort(byPosition);

    if (morphemeTokens.length === 0) return [];

    const formIndex = buildSpanIndex(formLayer);
    const lemmaIndex = buildSpanIndex(lemmaLayer);
    const uposIndex = buildSpanIndex(uposLayer);
    const xposIndex = buildSpanIndex(xposLayer);
    const featuresIndex = buildSpanIndex(featuresLayer);

    const relationList = relationLayer?.relations || [];

    const buildMorphemeEntry = (morphemeToken, tokenIndex, word) => {
      const id = morphemeToken.id;
      const substring = cpSlice(body,morphemeToken.begin, morphemeToken.end);
      const formSpan = (formIndex.get(id) || [])[0] || null;
      const lemma = (lemmaIndex.get(id) || [])[0] || null;
      const upos = (uposIndex.get(id) || [])[0] || null;
      const xpos = (xposIndex.get(id) || [])[0] || null;
      const feats = (featuresIndex.get(id) || []).filter(span => span.value);

      const tokenForm = (formSpan?.value != null && formSpan.value !== '') ? formSpan.value : substring;

      return {
        token: morphemeToken,
        tokenForm,
        form: formSpan,
        lemma,
        upos,
        xpos,
        feats,
        word: word || null,
        wordForm: word ? cpSlice(body,word.begin, word.end) : tokenForm,
        spanIds: {
          form: formSpan?.id || null,
          lemma: lemma?.id || null,
          upos: upos?.id || null,
          xpos: xpos?.id || null,
          features: feats.map(span => ({ value: span.value, spanId: span.id }))
        },
        tokenIndex
      };
    };

    const effectiveSentences = sentenceTokens.length > 0
      ? sentenceTokens
      : [{ id: '__all__', begin: 0, end: cpLength(body) }];

    const rows = [];

    effectiveSentences.forEach((sentence, sentenceIdx) => {
      const wordsInSentence = wordTokens.filter(word => containsToken(sentence, word));

      const morphemeEntries = [];
      let tokenIndex = 0;

      if (wordsInSentence.length > 0) {
        wordsInSentence.forEach(word => {
          const wordMorphemes = morphemeTokens.filter(m => containsToken(word, m));
          wordMorphemes.forEach((morpheme, i) => {
            const entry = buildMorphemeEntry(morpheme, tokenIndex + 1, word);
            entry.isFirstMorphemeOfWord = i === 0;
            entry.wordHasMultipleMorphemes = wordMorphemes.length > 1;
            morphemeEntries.push(entry);
            tokenIndex += 1;
          });
        });
      } else {
        morphemeTokens.filter(m => containsToken(sentence, m)).forEach(morpheme => {
          const entry = buildMorphemeEntry(morpheme, tokenIndex + 1, null);
          entry.isFirstMorphemeOfWord = true;
          entry.wordHasMultipleMorphemes = false;
          morphemeEntries.push(entry);
          tokenIndex += 1;
        });
      }

      if (morphemeEntries.length === 0) return;

      const morphemeIds = new Set(morphemeEntries.map(entry => entry.token.id));

      const sentenceLemmaSpans = (lemmaLayer?.spans || []).filter(span => {
        const spanTokens = Array.isArray(span.tokens) ? span.tokens : [];
        return spanTokens.some(tokenId => morphemeIds.has(tokenId));
      });
      const sentenceLemmaSpanIds = new Set(sentenceLemmaSpans.map(span => span.id));
      const relations = relationList.filter(rel => sentenceLemmaSpanIds.has(rel.source));

      rows.push({
        id: sentence.id ?? sentenceIdx,
        text: cpSlice(body,sentence.begin, sentence.end),
        sentenceToken: sentenceTokens.length > 0 ? sentence : null,
        tokens: morphemeEntries,
        relations,
        lemmaSpans: sentenceLemmaSpans
      });
    });

    return rows;
  }

  // ============================================================
  // Mutation infrastructure
  // ============================================================

  // Single-flight gate around mutations: skip if already saving, clear
  // error at the start, capture and surface errors, refetch the document
  // from the server on failure. Returns true on success / false otherwise
  // so callers can branch on outcome.
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
      notifyError(this._error);
      try { await this._reload(); } catch (reloadErr) {
        console.error('Reload after failure also failed:', reloadErr);
      }
      return false;
    } finally {
      this._isSaving = false;
      this._emit();
    }
  }

  // Apply an optimistic local-state patch. The producer receives a deep
  // clone of the raw document plus a freshly-computed layerInfo for that
  // clone, mutates it in place, and the result replaces `_raw`. Emits, so
  // every `_raw` swap goes hand-in-hand with a version bump and a notify —
  // the invariant downstream caches rely on.
  _applyRawPatch(producer) {
    const next = cloneRaw(this._raw);
    producer(next, getUdLayerInfo(next));
    this._raw = next;
    this._dataVersion++;
    this._emit();
  }

  // Re-fetch the raw document from the server. Used in catch-paths and as
  // an explicit "give up and resync" hook after large multi-batch ops.
  // Emits so the version bumps in lockstep with the `_raw` swap.
  async _reload() {
    if (!this._client || !this.id) return;
    const updated = await this._client.documents.get(this.id, true);
    this._raw = updated;
    this._dataVersion++;
    this._emit();
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
      this.setError('Please enter some text before tokenizing');
      return false;
    }
    if (!text?.id) {
      this.setError('Please save the text first before tokenizing');
      return false;
    }
    if (!sentenceTokenLayer?.id || !wordTokenLayer?.id || !morphemeTokenLayer?.id) {
      this.setError('Token layers are not fully configured');
      return false;
    }
    if (sentenceTokens.length || wordTokens.length || morphemeTokens.length) {
      this.setError('Tokens already exist. Use "Clear Tokens" before re-tokenizing.');
      return false;
    }

    return this._withSaving('Failed to create tokens', async () => {
      const body = textContent;
      const len = cpLength(body);

      // Sentences: gap-free partition of [0, len). Runs of newlines end a
      // sentence and are kept with the preceding sentence so there are no gaps.
      // The regex matches in UTF-16 (m.index), so convert each boundary to a
      // code-point offset (sentence tokens are code-point ranges).
      const sentenceRanges = [];
      let start = 0;
      const newlineRun = /\n+/g;
      let m;
      while ((m = newlineRun.exec(body)) !== null) {
        const endCp = utf16ToCp(body, m.index + m[0].length);
        sentenceRanges.push([start, endCp]);
        start = endCp;
      }
      if (start < len) sentenceRanges.push([start, len]);
      if (sentenceRanges.length === 0) sentenceRanges.push([0, len]);

      // Words: Unicode-aware basic tokenization. Punctuation flanked by
      // letters/digits on both sides stays in the word (contractions,
      // hyphenated forms, abbreviations, decimal numbers); edge or standalone
      // punctuation becomes its own one-character token.
      // Locale drives Intl.Segmenter's script-specific word segmentation
      // (esp. ja/zh/th dictionary lookup). Configured per-project on the text
      // layer; defaults to 'und'.
      const tokenizerLocale = this.layerInfo.textLayer?.config?.ud?.tokenizerLocale || 'und';
      const wordRanges = basicTokenize(body, tokenizerLocale);

      this._client.beginBatch();
      this._client.tokens.bulkCreate(sentenceRanges.map(([begin, end]) => ({
        tokenLayerId: sentenceTokenLayer.id, text: text.id, begin, end
      })));
      let morphemeResultIndex = -1;
      if (wordRanges.length > 0) {
        this._client.tokens.bulkCreate(wordRanges.map(([begin, end]) => ({
          tokenLayerId: wordTokenLayer.id, text: text.id, begin, end
        })));
        this._client.tokens.bulkCreate(wordRanges.map(([begin, end]) => ({
          tokenLayerId: morphemeTokenLayer.id, text: text.id, begin, end
        })));
        morphemeResultIndex = 2;
      }
      const batchResults = await this._client.submitBatch();
      const morphemeIds = morphemeResultIndex >= 0
        ? (batchResults[morphemeResultIndex]?.body?.ids || [])
        : [];

      if (lemmaLayer?.id && morphemeIds.length) {
        const lemmaOps = morphemeIds.map((tokenId, i) => ({
          spanLayerId: lemmaLayer.id,
          tokens: [tokenId],
          value: cpSlice(body,wordRanges[i][0], wordRanges[i][1])
        }));
        try {
          await this._client.spans.bulkCreate(lemmaOps);
        } catch (lemmaError) {
          console.error('Failed to create lemma spans:', lemmaError);
        }
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
        await this._client.tokens.bulkDelete(sentenceTokens.map(t => t.id));
      } else if (wordTokens.length > 0) {
        await this._client.tokens.bulkDelete(wordTokens.map(t => t.id));
      } else if (morphemeTokens.length > 0) {
        await this._client.tokens.bulkDelete(morphemeTokens.map(t => t.id));
      }
      await this._reload();
    });
  }

  // Toggle a sentence boundary at a character position (a word's begin
  // offset). The sentence layer is partitioning, so this is a split (add)
  // or merge (remove).
  async toggleSentenceBoundary(charPos) {
    return this._withSaving('Failed to update sentence boundary', async () => {
      const { sentenceTokenLayer, morphemeTokenLayer, lemmaLayer, relationLayer } = this.layerInfo;
      const sentenceTokens = sentenceTokenLayer?.tokens || [];
      const morphemeTokens = morphemeTokenLayer?.tokens || [];

      const startsHere = sentenceTokens.find(s => s.begin === charPos);
      if (startsHere) {
        // Remove the boundary: merge with the preceding sentence. Merging
        // only widens a sentence, so no dependency relation can become invalid.
        const prevSent = sentenceTokens.find(s => s.end === charPos);
        if (!prevSent) return;
        await this._client.tokens.merge(prevSent.id, startsHere.id);
        this._applyRawPatch((next, info) => {
          if (info.sentenceTokenLayer?.tokens) {
            const p = info.sentenceTokenLayer.tokens.find(t => t.id === prevSent.id);
            if (p) p.end = startsHere.end;
            info.sentenceTokenLayer.tokens = info.sentenceTokenLayer.tokens.filter(t => t.id !== startsHere.id);
          }
        });
        return;
      }

      const containing = sentenceTokens.find(s => s.begin < charPos && charPos < s.end);
      if (!containing) return;

      // Any dependency relation whose endpoints land on opposite sides of
      // charPos would cross the new sentence boundary; delete those in the
      // same atomic batch as the split so a relation never spans two
      // sentences. (UD relations are sentence-internal — an app-level
      // invariant the server doesn't model.)
      const beginByMorpheme = new Map(morphemeTokens.map(t => [t.id, t.begin]));
      const beginByLemmaSpan = new Map();
      (lemmaLayer?.spans || []).forEach(span => {
        const tid = Array.isArray(span.tokens) && span.tokens.length > 0 ? span.tokens[0] : null;
        if (tid != null && beginByMorpheme.has(tid)) beginByLemmaSpan.set(span.id, beginByMorpheme.get(tid));
      });
      const crossing = (relationLayer?.relations || []).filter(rel => {
        if (rel.source === rel.target) return false;
        const s = beginByLemmaSpan.get(rel.source);
        const t = beginByLemmaSpan.get(rel.target);
        if (s == null || t == null) return false;
        return (s < charPos) !== (t < charPos);
      });

      this._client.beginBatch();
      this._client.tokens.split(containing.id, charPos);
      crossing.forEach(rel => this._client.relations.delete(rel.id));
      const res = await this._client.submitBatch();
      const newRightSentId = res[0]?.body?.id;
      const removedRelIds = new Set(crossing.map(r => r.id));

      this._applyRawPatch((next, info) => {
        if (info.sentenceTokenLayer?.tokens) {
          const s = info.sentenceTokenLayer.tokens.find(t => t.id === containing.id);
          const oldEnd = containing.end;
          if (s) s.end = charPos;
          if (newRightSentId) {
            info.sentenceTokenLayer.tokens.push({ id: newRightSentId, begin: charPos, end: oldEnd });
          }
        }
        if (info.relationLayer?.relations && removedRelIds.size) {
          info.relationLayer.relations = info.relationLayer.relations.filter(r => !removedRelIds.has(r.id));
        }
      });
    });
  }

  // Reconcile-on-open: repair UD invariants that another app may have broken
  // while editing the shared substrate. Two repairs, both healing DOWNWARD
  // toward the substrate (never reverting it), loud + recoverable (ordinary
  // audited writes):
  //   1. Seed a default full-width syntactic-word for every word that lacks one
  //      (another app, e.g. IGT, can leave words bare — UD annotations live on
  //      the syntactic-word layer, so a bare word is invisible/unannotatable).
  //   2. Delete dependency relations that now cross a sentence boundary (e.g.
  //      after another app split a sentence).
  // Deliberately NOT via _withSaving: this runs once on a freshly loaded doc,
  // and a heal failure must not trigger _withSaving's reload-and-revert (which
  // would discard the just-loaded doc). A single-flight guard plus the editor's
  // per-document gate keep StrictMode's double-invoke from double-healing (which
  // would otherwise seed duplicate syntactic-words).
  async reconcileOnOpen() {
    if (this._reconciling) return { deletedRelations: 0, createdSyntacticWords: 0 };
    this._reconciling = true;
    try {
      const info = this.layerInfo;
      const relIds = interSententialRelationIds(info);
      const { morphemeTokenLayer, textLayer } = info;
      const textId = textLayer?.text?.id;
      const seedExtents = (morphemeTokenLayer?.id && textId)
        ? wordsNeedingSyntacticWord(info)
        : [];

      if (!relIds.length && !seedExtents.length) {
        return { deletedRelations: 0, createdSyntacticWords: 0 };
      }

      let createdSyntacticWords = 0;
      let deletedRelations = 0;

      // (1) Seed one default full-width syntactic-word per bare word. Healed to
      // a valid-but-empty state the normal grid already surfaces (no spans —
      // the user fills annotations in).
      if (seedExtents.length) {
        this._client.beginBatch();
        this._client.tokens.bulkCreate(seedExtents.map(e => ({
          tokenLayerId: morphemeTokenLayer.id,
          text: textId,
          begin: e.begin,
          end: e.end,
          precedence: 0
        })));
        await this._client.submitBatch();
        createdSyntacticWords = seedExtents.length;
      }

      // (2) Drop now-inter-sentential dependency relations. If a concurrent open
      // already deleted them the batch 404s, but the goal state holds — treat
      // not-found as success rather than a failed repair.
      if (relIds.length) {
        try {
          this._client.beginBatch();
          relIds.forEach(id => this._client.relations.delete(id));
          await this._client.submitBatch();
        } catch (err) {
          if (err?.status !== 404) throw err;
        }
        deletedRelations = relIds.length;
      }

      await this._reload();
      return { deletedRelations, createdSyntacticWords };
    } catch (err) {
      console.error('reconcileOnOpen failed:', err);
      return { deletedRelations: 0, createdSyntacticWords: 0, error: err };
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
    const cleanForms = forms.map(f => (f || '').trim()).filter(f => f.length > 0);
    if (cleanForms.length === 0) return false;

    return this._withSaving('Failed to set morphemes', async () => {
      const { textLayer, morphemeTokenLayer, lemmaLayer, formLayer } = this.layerInfo;
      const text = textLayer?.text;
      const morphemeTokens = morphemeTokenLayer?.tokens || [];
      if (!morphemeTokenLayer?.id || !text?.id) {
        throw new Error('Morpheme layer not configured');
      }

      // Use the persisted body for the form-vs-substring comparison and for
      // the word's surface form. Morpheme begin/end are in body coordinates,
      // so substring(body, word.begin, word.end) is the authoritative surface.
      const body = this.body;
      const wordSubstring = cpSlice(body,word.begin, word.end);
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
      const existing = morphemeTokens.filter(m => containsToken(word, m));
      this._client.beginBatch();
      if (existing.length) this._client.tokens.bulkDelete(existing.map(m => m.id));
      this._client.tokens.bulkCreate(cleanForms.map((_, i) => ({
        tokenLayerId: morphemeTokenLayer.id,
        text: text.id,
        begin: word.begin,
        end: word.end,
        precedence: i
      })));
      if (nextWordMetadata !== null) {
        this._client.tokens.setMetadata(word.id, nextWordMetadata);
      }
      const setResults = await this._client.submitBatch();
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
        this._client.beginBatch();
        if (formOps.length) this._client.spans.bulkCreate(formOps);
        if (lemmaOps.length) this._client.spans.bulkCreate(lemmaOps);
        await this._client.submitBatch();
      }

      await this._reload();
    });
  }

  // Delete a word token (cascades its morphemes and their spans + relations
  // server-side). Locally we mirror the cascade so the UI updates
  // immediately without a refetch.
  async deleteWord(wordId) {
    return this._withSaving('Failed to delete word', async () => {
      const { wordTokenLayer, morphemeTokenLayer, lemmaLayer } = this.layerInfo;
      const wordTokens = wordTokenLayer?.tokens || [];
      const morphemeTokens = morphemeTokenLayer?.tokens || [];
      const word = wordTokens.find(w => w.id === wordId);
      const removedMorphIds = new Set(word ? morphemeTokens.filter(m => containsToken(word, m)).map(m => m.id) : []);
      const removedLemmaSpanIds = new Set(
        (lemmaLayer?.spans || [])
          .filter(s => Array.isArray(s.tokens) && s.tokens.some(t => removedMorphIds.has(t)))
          .map(s => s.id)
      );
      // Optimistic: remove the word + its cascade locally before the round trip.
      this._applyRawPatch((next, info) => {
        if (info.wordTokenLayer?.tokens) {
          info.wordTokenLayer.tokens = info.wordTokenLayer.tokens.filter(t => t.id !== wordId);
        }
        if (info.morphemeTokenLayer?.tokens) {
          info.morphemeTokenLayer.tokens = info.morphemeTokenLayer.tokens.filter(t => !removedMorphIds.has(t.id));
        }
        (info.morphemeTokenLayer?.spanLayers || []).forEach(sl => {
          if (Array.isArray(sl.spans)) {
            sl.spans = sl.spans.filter(s => !(Array.isArray(s.tokens) && s.tokens.some(t => removedMorphIds.has(t))));
          }
        });
        if (info.relationLayer?.relations) {
          info.relationLayer.relations = info.relationLayer.relations.filter(r => !removedLemmaSpanIds.has(r.source) && !removedLemmaSpanIds.has(r.target));
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
      this.setError('Token layers are not fully configured');
      return false;
    }

    // A word must land inside some sentence (Sentences is a partitioning
    // layer). If sentences already tile the doc but the selection falls
    // outside every one, refuse — adding a new sentence into an already-
    // tiled doc would break partitioning. Only when no sentences exist yet
    // do we transparently create one covering the whole text.
    const selRange = { begin, end };
    if (sentenceTokens.length > 0 && !sentenceTokens.some(s => containsToken(s, selRange))) {
      this.setError('Selection must be inside an existing sentence');
      return false;
    }

    return this._withSaving('Failed to create word', async () => {
      this._client.beginBatch();
      if (sentenceTokens.length === 0) {
        this._client.tokens.bulkCreate([{ tokenLayerId: sentenceTokenLayer.id, text: text.id, begin: 0, end: textContent.length }]);
      }
      this._client.tokens.bulkCreate([{ tokenLayerId: wordTokenLayer.id, text: text.id, begin, end }]);
      this._client.tokens.bulkCreate([{ tokenLayerId: morphemeTokenLayer.id, text: text.id, begin, end }]);
      const res = await this._client.submitBatch();
      const sentenceId = sentenceTokens.length === 0 ? res[0]?.body?.ids?.[0] : null;
      const wordId = res[res.length - 2]?.body?.ids?.[0];
      const morphemeId = res[res.length - 1]?.body?.ids?.[0];

      let lemmaSpanId = null;
      if (lemmaLayer?.id && morphemeId) {
        try {
          const lr = await this._client.spans.bulkCreate([{ spanLayerId: lemmaLayer.id, tokens: [morphemeId], value: cpSlice(textContent,begin, end) }]);
          lemmaSpanId = lr?.ids?.[0] || null;
        } catch (lemmaError) {
          console.error('Failed to create lemma span:', lemmaError);
        }
      }

      this._applyRawPatch((next, infoNext) => {
        if (sentenceId && infoNext.sentenceTokenLayer) {
          if (!Array.isArray(infoNext.sentenceTokenLayer.tokens)) infoNext.sentenceTokenLayer.tokens = [];
          infoNext.sentenceTokenLayer.tokens.push({ id: sentenceId, begin: 0, end: textContent.length });
        }
        if (wordId && infoNext.wordTokenLayer) {
          if (!Array.isArray(infoNext.wordTokenLayer.tokens)) infoNext.wordTokenLayer.tokens = [];
          infoNext.wordTokenLayer.tokens.push({ id: wordId, begin, end });
        }
        if (morphemeId && infoNext.morphemeTokenLayer) {
          if (!Array.isArray(infoNext.morphemeTokenLayer.tokens)) infoNext.morphemeTokenLayer.tokens = [];
          infoNext.morphemeTokenLayer.tokens.push({ id: morphemeId, begin, end });
        }
        if (lemmaSpanId && morphemeId && infoNext.lemmaLayer) {
          if (!Array.isArray(infoNext.lemmaLayer.spans)) infoNext.lemmaLayer.spans = [];
          infoNext.lemmaLayer.spans.push({ id: lemmaSpanId, tokens: [morphemeId], value: cpSlice(textContent,begin, end) });
        }
      });
    });
  }

  // Adjust a word's character extent (boundary editing). Keeps its
  // morphemes in lockstep — they resize to the new extent in the same
  // atomic batch so the word and its morphemes never disagree.
  async updateWord(wordId, begin, end) {
    return this._withSaving('Failed to update word', async () => {
      const { wordTokenLayer, morphemeTokenLayer } = this.layerInfo;
      const wordTokens = wordTokenLayer?.tokens || [];
      const morphemeTokens = morphemeTokenLayer?.tokens || [];
      const word = wordTokens.find(w => w.id === wordId);
      const morphIds = word ? morphemeTokens.filter(m => containsToken(word, m)).map(m => m.id) : [];
      this._client.beginBatch();
      this._client.tokens.update(wordId, begin, end);
      morphIds.forEach(mid => this._client.tokens.update(mid, begin, end));
      // Optimistic: resize the word + its morphemes locally before the round trip.
      this._applyRawPatch((next, info) => {
        const w = info.wordTokenLayer?.tokens?.find(t => t.id === wordId);
        if (w) { w.begin = begin; w.end = end; }
        morphIds.forEach(mid => {
          const m = info.morphemeTokenLayer?.tokens?.find(t => t.id === mid);
          if (m) { m.begin = begin; m.end = end; }
        });
      });
      await this._client.submitBatch();
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
      features: info.featuresLayer
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

    return this._withSaving(`Failed to update ${field}`, async () => {
      if (field === 'features') {
        // Features are "Key=Value". Adding a key that already exists on this
        // token overwrites the existing value rather than creating a duplicate.
        const key = String(value).split('=')[0];
        const featSpans = targetLayer?.spans || [];
        const existingFeat = featSpans.find(span =>
          Array.isArray(span.tokens) && span.tokens.includes(tokenId) &&
          typeof span.value === 'string' && span.value.split('=')[0] === key
        );
        if (existingFeat) {
          // Optimistic overwrite: update the tag locally before the round trip.
          this._applyRawPatch((next, infoNext) => {
            const layerDoc = infoNext.tokenLayer?.spanLayers?.find(layer =>
              layer.spans?.some(span => span.id === existingFeat.id)
            );
            const spanIndex = layerDoc?.spans?.findIndex(span => span.id === existingFeat.id);
            if (layerDoc?.spans && spanIndex != null && spanIndex !== -1) {
              layerDoc.spans[spanIndex].value = value;
            }
          });
          await this._client.spans.update(existingFeat.id, value);
          return;
        }
        // Create is post-server (a span create needs the server id; the temp-id
        // reconcile's double grid-rebuild isn't worth it — see createRelation).
        const spanResult = await this._client.spans.create(targetLayer.id, [tokenId], value);
        const newSpanId = spanResult?.id || spanResult;
        this._applyRawPatch((next, infoNext) => {
          const featuresLayerDoc = infoNext.featuresLayer && infoNext.featuresLayer.id === targetLayer.id
            ? infoNext.featuresLayer
            : infoNext.tokenLayer?.spanLayers?.find(layer => layer.id === targetLayer.id);
          if (featuresLayerDoc) {
            if (!featuresLayerDoc.spans) featuresLayerDoc.spans = [];
            featuresLayerDoc.spans.push({ id: newSpanId, tokens: [tokenId], value });
          }
        });
        return;
      }

      const spans = targetLayer?.spans || [];
      const existingSpan = spans.find(span =>
        Array.isArray(span.tokens) && span.tokens.includes(tokenId)
      );
      if (existingSpan) {
        // Optimistic: update the value locally before the round trip.
        this._applyRawPatch((next, infoNext) => {
          const targetLayerDoc = infoNext.tokenLayer?.spanLayers?.find(layer =>
            layer.spans?.some(span => span.id === existingSpan.id)
          );
          if (targetLayerDoc?.spans) {
            const spanIndex = targetLayerDoc.spans.findIndex(span => span.id === existingSpan.id);
            if (spanIndex !== -1) {
              targetLayerDoc.spans[spanIndex].value = value;
            }
          }
        });
        await this._client.spans.update(existingSpan.id, value);
      } else {
        // Create is post-server (EditableCell already shows the typed value
        // optimistically via its local state, so there's no visible delay).
        const spanResult = await this._client.spans.create(targetLayer.id, [tokenId], value);
        const newSpanId = spanResult?.id || spanResult;
        this._applyRawPatch((next, infoNext) => {
          const targetLayerDoc = infoNext.tokenLayer?.spanLayers?.find(layer => layer.id === targetLayer.id);
          if (targetLayerDoc) {
            if (!targetLayerDoc.spans) targetLayerDoc.spans = [];
            targetLayerDoc.spans.push({ id: newSpanId, tokens: [tokenId], value });
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
          featuresLayerDoc.spans = featuresLayerDoc.spans.filter(span => span.id !== spanId);
        }
      });
      await this._client.spans.delete(spanId);
    });
  }

  // Create (or replace) a dependency relation between two lemma spans.
  // Source/target may be span ids OR morpheme token ids (the latter is the
  // common case when called from the annotation grid). Special value
  // 'ROOT' marks the dependency root, which is encoded as a self-loop on
  // the target span.
  async createRelation(sourceSpanId, targetSpanId, deprel) {
    const info = this.layerInfo;
    if (!info.relationLayer) {
      this.setError('Relation layer not found. Please ensure the project is properly configured.');
      return false;
    }
    if (!info.lemmaLayer) {
      this.setError('Lemma layer not found. Cannot create dependency relation.');
      return false;
    }

    return this._withSaving('Failed to create relation', async () => {
      // Post-server (NOT optimistic): a relation create needs the server id, so
      // it requires a temp-id placeholder + a second reconcile patch. That
      // double grid-rebuild makes the dependency tree re-measure positions and
      // re-mount arcs twice, which visibly janks the drag-to-draw interaction —
      // worse than just waiting one round trip. Creates show a brief absence,
      // never a wrong value, so post-server is the right trade here.
      const ensureLemmaSpan = async (candidateId) => {
        if (!candidateId || candidateId === 'ROOT') return null;

        const lemmaLayer = info.lemmaLayer;
        const lemmaSpans = lemmaLayer.spans || [];

        const existingById = lemmaSpans.find(span => span.id === candidateId);
        if (existingById) return existingById.id;

        const tokenId = candidateId;
        const existingByToken = lemmaSpans.find(span => {
          const spanTokens = Array.isArray(span.tokens) ? span.tokens : [];
          return spanTokens.some(tokenEntry => {
            if (!tokenEntry) return false;
            if (typeof tokenEntry === 'string') return tokenEntry === tokenId;
            if (typeof tokenEntry === 'object') return tokenEntry.id === tokenId || tokenEntry.tokenId === tokenId || tokenEntry.token === tokenId;
            return false;
          });
        });
        if (existingByToken) return existingByToken.id;

        if (!lemmaLayer.id) {
          this.setError('Lemma layer is missing an identifier. Cannot create lemma span.');
          return null;
        }

        const textLayer = info.textLayer;
        const rawText = textLayer?.text;
        const textBody = typeof rawText === 'string' ? rawText : rawText?.body || '';
        const tokenLayer = info.tokenLayer;
        const token = tokenLayer?.tokens?.find(t => t.id === tokenId);
        const hasOffsets = token && typeof token.begin === 'number' && typeof token.end === 'number' && typeof textBody === 'string';
        const lemmaValue = hasOffsets
          ? cpSlice(textBody, token.begin, token.end)
          : token?.form || token?.text || '';

        const apiResponse = await this._client.spans.create(lemmaLayer.id, [tokenId], lemmaValue);
        const createdSpanId = apiResponse.id || apiResponse;

        this._applyRawPatch((next, infoNext) => {
          const lemmaLayerDoc = infoNext.lemmaLayer;
          if (lemmaLayerDoc) {
            if (!Array.isArray(lemmaLayerDoc.spans)) lemmaLayerDoc.spans = [];
            if (lemmaLayerDoc.spans.findIndex(s => s.id === createdSpanId) === -1) {
              lemmaLayerDoc.spans.push({ id: createdSpanId, tokens: [tokenId], value: lemmaValue });
            }
          }
        });

        return createdSpanId;
      };

      const resolvedSourceId = await ensureLemmaSpan(sourceSpanId);
      const resolvedTargetId = await ensureLemmaSpan(targetSpanId);

      if (!resolvedSourceId || !resolvedTargetId) {
        console.warn('Unable to create relation because lemma spans could not be resolved:', { sourceSpanId, targetSpanId });
        return;
      }

      // Delete any existing incoming relations to the target (one head per node).
      const incomingRelations = (info.relationLayer.relations || []).filter(rel => rel.target === resolvedTargetId);
      for (const existingRel of incomingRelations) {
        try {
          await this._client.relations.delete(existingRel.id);
        } catch (error) {
          console.warn('Failed to delete existing relation:', error);
        }
      }

      const finalDeprel = deprel || (resolvedSourceId === resolvedTargetId ? 'root' : 'dep');
      const apiResponse = await this._client.relations.create(info.relationLayer.id, resolvedSourceId, resolvedTargetId, finalDeprel);
      this._applyRawPatch((next, infoNext) => {
        const relLayer = infoNext.relationLayer;
        if (!relLayer) return;
        if (!Array.isArray(relLayer.relations)) relLayer.relations = [];
        relLayer.relations = relLayer.relations.filter(rel => rel.target !== resolvedTargetId);
        relLayer.relations.push({ id: apiResponse.id || apiResponse, source: resolvedSourceId, target: resolvedTargetId, value: finalDeprel });
      });
    });
  }

  async updateRelation(relationId, deprel) {
    return this._withSaving('Failed to update relation', async () => {
      // Optimistic: reflect the new value immediately, BEFORE the round trip,
      // so the label doesn't flash the previous value while the save is in
      // flight. On failure, _withSaving reloads from the server and reverts.
      this._applyRawPatch((next, infoNext) => {
        const relLayer = infoNext.relationLayer;
        if (!relLayer || !Array.isArray(relLayer.relations)) return;
        const idx = relLayer.relations.findIndex(r => r.id === relationId);
        if (idx !== -1) relLayer.relations[idx].value = deprel;
      });
      await this._client.relations.update(relationId, deprel);
    });
  }

  async deleteRelation(relationId) {
    return this._withSaving('Failed to delete relation', async () => {
      // Optimistic: drop the arc locally before the round trip.
      this._applyRawPatch((next, infoNext) => {
        const relLayer = infoNext.relationLayer;
        if (!relLayer || !Array.isArray(relLayer.relations)) return;
        relLayer.relations = relLayer.relations.filter(r => r.id !== relationId);
      });
      await this._client.relations.delete(relationId);
    });
  }

  // ============================================================
  // CoNLL-U export
  // ============================================================

  // Serialize the current document state to CoNLL-U text. Result is cached
  // per version so repeated calls between mutations are free.
  toConllu() {
    if (this._conlluCacheVersion === this._dataVersion) return this._conlluCache;
    this._conlluCache = this._buildConllu();
    this._conlluCacheVersion = this._dataVersion;
    return this._conlluCache;
  }

  _buildConllu() {
    const info = this.layerInfo;
    if (!info.isConfigured) {
      const missing = missingUdLayerLabels(info.missingLayers);
      const missingList = missing.length > 0 ? missing.join(', ') : 'required UD layers';
      return `# Project configuration incomplete: ${missingList}`;
    }
    const sentenceData = this.sentences;
    if (!sentenceData || sentenceData.length === 0) {
      return '# No tokenized content available';
    }

    const esc = (v) => (v == null || v === '') ? UNDERSCORE : String(v);
    const serializeFeats = (feats) => {
      if (!feats || feats.length === 0) return UNDERSCORE;
      const values = feats.map(f => f.value).filter(Boolean).sort();
      return values.length > 0 ? values.join('|') : UNDERSCORE;
    };

    const output = [];
    const docName = this.name || 'unknown';
    output.push(`# newdoc id = ${docName}`);

    sentenceData.forEach((sentence, sentIdx) => {
      if (sentIdx > 0) output.push('');

      const morphemes = sentence.tokens;
      const idByLemmaSpanId = new Map();
      morphemes.forEach((m, i) => {
        if (m.spanIds?.lemma) idByLemmaSpanId.set(m.spanIds.lemma, i + 1);
      });
      const incomingByTarget = new Map();
      (sentence.relations || []).forEach(rel => incomingByTarget.set(rel.target, rel));

      // Prefer a `sent_id` carried on the sentence token's metadata (round-
      // tripped from import); otherwise synthesize one from doc name + index.
      const sentMeta = sentence.sentenceToken?.metadata || {};
      const sentIdFromMeta = sentMeta.sent_id;
      output.push(sentIdFromMeta
        ? `# sent_id = ${sentIdFromMeta}`
        : `# sent_id = ${docName}-${sentIdx + 1}`);

      // Emit arbitrary `# k = v` metadata sorted alphabetically. If metadata
      // carries `text`, the loop emits it; otherwise we fall back to the
      // sentence's substring of the document body. Skip `sent_id` (emitted
      // above) so it doesn't double-emit.
      let hasTextMetadata = false;
      Object.keys(sentMeta).sort().forEach(key => {
        if (key === 'sent_id') return;
        const value = sentMeta[key];
        if (key === 'text') hasTextMetadata = true;
        if (value === true) output.push(`# ${key}`);
        else output.push(`# ${key} = ${value}`);
      });
      if (!hasTextMetadata) {
        output.push(`# text = ${(sentence.text || '').trim()}`);
      }

      let i = 0;
      while (i < morphemes.length) {
        const word = morphemes[i].word;
        let groupLen = 1;
        if (word) {
          while (i + groupLen < morphemes.length && morphemes[i + groupLen].word?.id === word.id) {
            groupLen += 1;
          }
        }

        // MWT bracket line. Surface form comes from the word token's
        // persisted `metadata.form`. When that's absent (MWT imported with
        // FORM=`_`), emit `_` to round-trip the original "unspecified"
        // semantics — don't fabricate a value from the body substring.
        // Editor-created MWTs get `metadata.form` set in `setWordMorphemes`
        // so they round-trip correctly without going through this branch.
        if (groupLen > 1) {
          const wordMeta = morphemes[i].word?.metadata || {};
          const surfaceForm = wordMeta.form || UNDERSCORE;
          const mwtMisc = wordMeta.misc || UNDERSCORE;
          output.push([
            `${i + 1}-${i + groupLen}`, surfaceForm,
            UNDERSCORE, UNDERSCORE, UNDERSCORE, UNDERSCORE, UNDERSCORE, UNDERSCORE, UNDERSCORE, mwtMisc
          ].join('\t'));
        }

        for (let k = 0; k < groupLen; k++) {
          const m = morphemes[i + k];
          const id = i + k + 1;
          const form = m.tokenForm || UNDERSCORE;
          const lemma = esc(m.lemma?.value);
          const upos = esc(m.upos?.value);
          const xpos = esc(m.xpos?.value);
          const feats = serializeFeats(m.feats);

          let head = UNDERSCORE;
          let deprel = UNDERSCORE;
          const rel = m.spanIds?.lemma ? incomingByTarget.get(m.spanIds.lemma) : null;
          if (rel) {
            if (rel.source === rel.target) {
              head = 0;
              deprel = rel.value || UNDERSCORE;
            } else {
              const h = idByLemmaSpanId.get(rel.source);
              if (h != null) {
                head = h;
                deprel = rel.value || UNDERSCORE;
              }
            }
          }
          const deps = (head === UNDERSCORE || deprel === UNDERSCORE) ? UNDERSCORE : `${head}:${deprel}`;
          output.push([id, form, lemma, upos, xpos, feats, head, deprel, deps, UNDERSCORE].join('\t'));
        }

        i += groupLen;
      }
    });

    return output.join('\n');
  }
}
