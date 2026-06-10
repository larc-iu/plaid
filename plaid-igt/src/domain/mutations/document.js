// Mutation mixin: document-level operations (baseline text, metadata, name,
// delete, media upload/delete). See IgtDocument.js for the `this` API
// (_withSaving, _applyRawPatch, _reload, layerInfo, body, etc.).

import { cpLength } from '@larc-iu/plaid-client';

export const documentMutations = {
  // Baseline-text edit. The server's text update does all the heavy lifting
  // in one transaction: it diffs old vs new body, shifts every token on the
  // text (sentences/words/morphemes/alignment alike), deletes tokens fully
  // inside removed ranges, and gap-fills partitioning layers (Sentences) so
  // the partition stays valid. Interior edits therefore preserve existing
  // tokenization and annotations. The only client-side concern is seeding a
  // sentence partition when the save leaves none (brand-new text, a full
  // replacement that deleted every old sentence, or a previously emptied
  // layer) so the Analyze tab has something to show.
  async saveBaselineText(newBody) {
    const info = this.layerInfo;
    const primaryTextLayer = info.primaryTextLayer;
    const sentenceTokenLayer = info.sentenceTokenLayer;

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
      const newLen = cpLength(newBody);

      if (textId) {
        await this._client.texts.update(textId, newBody);
      } else {
        // No existing text — texts.create, then seed the sentence partition
        // in a follow-up call (it needs the new text's id).
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

      // A replacement that shares nothing with the old body deletes the old
      // sentence tokens outright (an empty partition is server-valid), which
      // would leave the Analyze tab blank. Seed a single full-span sentence
      // whenever the edit leaves a non-empty body with no partition.
      if (newLen > 0) {
        const freshInfo = this.layerInfo;
        const freshTextId = freshInfo.primaryTextLayer?.text?.id;
        const sentencesAfter = freshInfo.sentenceTokenLayer?.tokens || [];
        if (freshTextId && sentencesAfter.length === 0) {
          await this._client.tokens.bulkCreate([{
            tokenLayerId: sentenceTokenLayer.id,
            text: freshTextId,
            begin: 0,
            end: newLen
          }]);
          await this._reload();
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
