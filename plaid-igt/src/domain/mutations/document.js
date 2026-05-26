// Mutation mixin: document-level operations (baseline text, metadata, name,
// delete, media upload/delete). See IgtDocument.js for the `this` API
// (_withSaving, _applyRawPatch, _reload, layerInfo, body, etc.).

export const documentMutations = {
  // Full baseline-text replacement. The Sentences token layer is
  // `:partitioning`, so wiping its tokens cascades through Words and
  // Morphemes; alignment tokens live on a separate root layer but share text
  // coordinates and must be wiped too so out-of-bounds tokens don't block
  // the text update. After the text changes we re-establish the partition
  // with a single sentence covering the whole body.
  async saveBaselineText(newBody) {
    const info = this.layerInfo;
    const primaryTextLayer = info.primaryTextLayer;
    const sentenceTokenLayer = info.sentenceTokenLayer;
    const alignmentTokenLayer = info.alignmentTokenLayer;

    if (!primaryTextLayer) {
      this.setError('No primary text layer found');
      return false;
    }
    if (!sentenceTokenLayer?.id) {
      this.setError('No sentence layer found');
      return false;
    }

    return this._withSaving('Failed to save baseline text', async () => {
      const textId = primaryTextLayer.text?.id;
      const newLen = newBody.length;
      const sentenceTokenIds = (sentenceTokenLayer.tokens || []).map(t => t.id);
      const alignmentTokenIds = (alignmentTokenLayer?.tokens || []).map(t => t.id);
      const tokensToWipe = [...sentenceTokenIds, ...alignmentTokenIds];

      // Validation passes before lock — don't grab a lock just to throw.
      await this._client.documents.acquireLock(this.id);
      let lockAcquired = true;
      try {
        if (textId) {
          this._client.beginBatch();
          if (tokensToWipe.length > 0) {
            this._client.tokens.bulkDelete(tokensToWipe);
          }
          this._client.texts.update(textId, newBody);
          if (newLen > 0) {
            this._client.tokens.bulkCreate([{
              tokenLayerId: sentenceTokenLayer.id,
              text: textId,
              begin: 0,
              end: newLen
            }]);
          }
          await this._client.submitBatch();
        } else {
          // No existing text — texts.create then a second batch for the
          // sentence partition, since batch ops can't reference ids produced
          // earlier in the same batch.
          const newTextObj = await this._client.texts.create(primaryTextLayer.id, this.id, newBody);
          if (newLen > 0) {
            try {
              await this._client.tokens.bulkCreate([{
                tokenLayerId: sentenceTokenLayer.id,
                text: newTextObj.id,
                begin: 0,
                end: newLen
              }]);
            } catch (bulkCreateError) {
              console.error('Sentence partition create failed after text create; rolling back text:', bulkCreateError);
              try {
                await this._client.texts.delete(newTextObj.id);
              } catch (deleteError) {
                console.error('Failed to roll back text after partition create failure:', deleteError);
              }
              throw bulkCreateError;
            }
          }
        }

        await this._reload();
      } finally {
        if (lockAcquired) {
          try {
            await this._client.documents.releaseLock(this.id);
          } catch (lockError) {
            console.error('Failed to release document lock:', lockError);
          }
        }
      }
    });
  },

  async setMetadata(metadata) {
    return this._withSaving('Failed to save metadata', async () => {
      await this._client.documents.setMetadata(this.id, metadata);
      this._applyRawPatch((next) => {
        next.metadata = metadata;
      });
    });
  },

  async updateName(name) {
    return this._withSaving('Failed to update name', async () => {
      await this._client.documents.update(this.id, name);
      this._applyRawPatch((next) => {
        next.name = name;
      });
    });
  },

  // Combined save for the analyze tab. Merges the partial metadata over the
  // existing metadata so deactivated fields aren't dropped. Issued
  // sequentially (these are document-level, not token-level — not a batch).
  async saveNameAndMetadata(name, metadataPartial) {
    return this._withSaving('Failed to save document', async () => {
      const existingMetadata = this._raw?.metadata || {};
      const completeMetadata = { ...existingMetadata, ...metadataPartial };
      const nameChanged = name !== this._raw?.name;

      if (nameChanged) {
        await this._client.documents.update(this.id, name);
      }
      await this._client.documents.setMetadata(this.id, completeMetadata);

      this._applyRawPatch((next) => {
        if (nameChanged) next.name = name;
        next.metadata = completeMetadata;
      });
    });
  },

  async deleteDocument() {
    return this._withSaving('Failed to delete document', async () => {
      await this._client.documents.delete(this.id);
      // Don't _reload — the document is gone and a fetch would 404.
    });
  },

  async uploadMedia(file) {
    if (!file) return false;
    return this._withSaving('Failed to upload media', async () => {
      await this._client.documents.uploadMedia(this.id, file);
      await this._reload();
    });
  },

  async deleteMedia() {
    return this._withSaving('Failed to delete media', async () => {
      await this._client.documents.deleteMedia(this.id);
      await this._reload();
    });
  }
};
