// Mutation mixin: vocabulary-link operations. See IgtDocument.js for the
// `this` API (_withSaving, _applyRawPatch, _reload, layerInfo, etc.).
//
// Vocab links live on the vocab layer (not the document), so optimistic
// patches mutate the third arg of `_applyRawPatch` (a shallow clone of
// `_vocabularies`). A token id here may be a word OR morpheme token; the
// link/create operation is identical either way.

// Locate the existing single-token vocab link for `tokenId` across all
// vocabularies. By convention there is at most one.
const findPriorLink = (vocabularies, tokenId) => {
  for (const vocab of Object.values(vocabularies || {})) {
    const link = (vocab.vocabLinks || []).find(l =>
      Array.isArray(l.tokens) && l.tokens.length === 1 && l.tokens[0] === tokenId
    );
    if (link) return { link, vocabId: vocab.id };
  }
  return { link: null, vocabId: null };
};

// Locate the vocab containing the given vocab item id.
const findVocabForItem = (vocabularies, vocabItemId) => {
  for (const vocab of Object.values(vocabularies || {})) {
    const item = (vocab.items || []).find(i => i.id === vocabItemId);
    if (item) return { vocab, item };
  }
  return { vocab: null, item: null };
};

export const vocabMutations = {
  // Link a vocab item to a token (word or morpheme). If a prior single-token
  // link exists for this token, delete it and create the new link atomically.
  // `metadata` (optional) carries provenance for machine-produced links (see
  // domain/glossGuess.js PROV); human links from the popover pass none.
  async linkVocab(tokenId, vocabItemId, metadata = null) {
    const { vocab: targetVocab, item: vocabItem } = findVocabForItem(this._vocabularies, vocabItemId);
    if (!targetVocab || !vocabItem) {
      this.setError(`Vocab item ${vocabItemId} not found`);
      return false;
    }
    const targetVocabId = targetVocab.id;
    const { link: priorLink, vocabId: priorVocabId } = findPriorLink(this._vocabularies, tokenId);

    return this._withSaving('Failed to link vocab item', async () => {
      let newLinkId;
      if (priorLink) {
        this._client.beginBatch();
        this._client.vocabLinks.delete(priorLink.id);
        this._client.vocabLinks.create(vocabItemId, [tokenId], metadata || undefined);
        const results = await this._client.submitBatch();
        newLinkId = results[results.length - 1]?.body?.id;
      } else {
        const result = await this._client.vocabLinks.create(vocabItemId, [tokenId], metadata || undefined);
        newLinkId = result?.id || result;
      }

      const itemSnapshot = {
        id: vocabItem.id,
        form: vocabItem.form,
        metadata: vocabItem.metadata || {}
      };

      this._applyRawPatch((next, info, vocabs) => {
        if (priorLink && priorVocabId && vocabs[priorVocabId]) {
          vocabs[priorVocabId].vocabLinks = (vocabs[priorVocabId].vocabLinks || [])
            .filter(l => l.id !== priorLink.id);
        }
        const tv = vocabs[targetVocabId];
        if (tv) {
          if (!Array.isArray(tv.vocabLinks)) tv.vocabLinks = [];
          tv.vocabLinks.push({
            id: newLinkId,
            tokens: [tokenId],
            vocabItem: itemSnapshot,
            ...(metadata ? { metadata } : {})
          });
        }
      });
    });
  },

  // Remove the single-token vocab link for `tokenId`, if any.
  async unlinkVocab(tokenId) {
    const { link: priorLink, vocabId: priorVocabId } = findPriorLink(this._vocabularies, tokenId);
    if (!priorLink || !priorVocabId) return false;

    return this._withSaving('Failed to unlink vocab item', async () => {
      await this._client.vocabLinks.delete(priorLink.id);
      this._applyRawPatch((next, info, vocabs) => {
        if (vocabs[priorVocabId]) {
          vocabs[priorVocabId].vocabLinks = (vocabs[priorVocabId].vocabLinks || [])
            .filter(l => l.id !== priorLink.id);
        }
      });
    });
  },

  // Create a brand-new vocab item in `vocabId` and link it to `tokenId`,
  // replacing any prior link for that token. The item is created OUTSIDE the
  // batch so the batched delete+create can reference its id.
  async createAndLinkVocabItem(tokenId, vocabId, form, metadata = {}) {
    if (!this._vocabularies[vocabId]) {
      this.setError(`Vocabulary ${vocabId} not found`);
      return false;
    }
    const { link: priorLink, vocabId: priorVocabId } = findPriorLink(this._vocabularies, tokenId);
    const metadataArg = Object.keys(metadata || {}).length > 0 ? metadata : undefined;

    return this._withSaving('Failed to create and link vocab item', async () => {
      const createResult = await this._client.vocabItems.create(vocabId, form, metadataArg);
      const newItemId = createResult?.id || createResult;

      let newLinkId;
      if (priorLink) {
        this._client.beginBatch();
        this._client.vocabLinks.delete(priorLink.id);
        this._client.vocabLinks.create(newItemId, [tokenId]);
        const results = await this._client.submitBatch();
        newLinkId = results[results.length - 1]?.body?.id;
      } else {
        const linkResult = await this._client.vocabLinks.create(newItemId, [tokenId]);
        newLinkId = linkResult?.id || linkResult;
      }

      const newItem = {
        id: newItemId,
        form,
        metadata: metadata || {}
      };

      this._applyRawPatch((next, info, vocabs) => {
        if (priorLink && priorVocabId && vocabs[priorVocabId]) {
          vocabs[priorVocabId].vocabLinks = (vocabs[priorVocabId].vocabLinks || [])
            .filter(l => l.id !== priorLink.id);
        }
        const tv = vocabs[vocabId];
        if (tv) {
          if (!Array.isArray(tv.items)) tv.items = [];
          tv.items.push(newItem);
          if (!Array.isArray(tv.vocabLinks)) tv.vocabLinks = [];
          tv.vocabLinks.push({
            id: newLinkId,
            tokens: [tokenId],
            vocabItem: { id: newItem.id, form: newItem.form, metadata: newItem.metadata }
          });
        }
      });
    });
  }
};
