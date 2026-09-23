// Mutation mixin: document-level operations (baseline text, metadata, delete,
// media upload/delete). See IgtDocument.js for the `this` API (_queueWrite,
// _applyRawPatch, _reload, layerInfo, body, etc.).
//
// Renaming a document and copying it are NOT here: they are `rename` and
// `copyTo` on the shared DocumentModel, which every app's document inherits.

import { applyMetadataOps, cpLength } from '@larc-iu/plaid-client';
import { lineSentenceRanges } from '../../utils/tokenizationUtils.js';

// One sentence per line of a freshly saved text. The server keeps the
// partition in step with later edits; the Tokenize tab moves the breaks.
const sentenceSeed = (tokenLayerId, text, body) =>
  lineSentenceRanges(body).map(({ begin, end }) => ({ tokenLayerId, text, begin, end }));

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
  //
  // The one write here that reloads instead of patching: what a whole-body
  // update does to the tokens is the server's diff (plaid.algos.text), which
  // this does not replay. The Baseline tab's textarea already shows the text.
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

    return this._queueWrite('Failed to save baseline text', async () => {
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
            await this._client.tokens.bulkCreate(
              sentenceSeed(sentenceTokenLayer.id, newTextObj.id, newBody),
            );
          } catch (bulkCreateError) {
            console.error(
              'Sentence partition create failed after text create; rolling back text:',
              bulkCreateError,
            );
            try {
              await this._client.texts.delete(newTextObj.id);
            } catch (deleteError) {
              console.error(
                'Failed to roll back text after partition create failure:',
                deleteError,
              );
            }
            throw bulkCreateError;
          }
        }
      }

      await this._reload();

      // A replacement that shares nothing with the old body deletes the old
      // sentence tokens outright (an empty partition is server-valid), which
      // would leave the Analyze tab blank. Seed the partition again, one
      // sentence per line, whenever the edit leaves a non-empty body with none.
      if (newLen > 0) {
        const freshInfo = this.layerInfo;
        const freshTextId = freshInfo.primaryTextLayer?.text?.id;
        const sentencesAfter = freshInfo.sentenceTokenLayer?.tokens || [];
        if (freshTextId && sentencesAfter.length === 0) {
          await this._client.tokens.bulkCreate(
            sentenceSeed(sentenceTokenLayer.id, freshTextId, newBody),
          );
          await this._reload();
        }
      }
    });
  },

  // Edit the document's metadata with path ops that name only the keys being
  // changed, so a key another tab or a service wrote since this copy was
  // loaded survives. The local copy takes the same ops the server applies.
  async patchMetadata(ops, label = 'Failed to save metadata') {
    if (!this._canWrite(label)) return false;
    if (!ops.length) return true;
    this._applyRawPatch((next) => {
      next.metadata = applyMetadataOps(next.metadata, ops);
    });
    return this._queueWrite(label, () => this._client.documents.patchMetadata(this.id, ops));
  },

  // Set top-level keys of the document's metadata, leaving the rest alone. A
  // key set to undefined is removed.
  async mergeMetadata(partial) {
    const ops = Object.entries(partial || {}).map(([key, value]) =>
      value === undefined ? { op: 'delete', path: [key] } : { op: 'set', path: [key], value },
    );
    return this.patchMetadata(ops);
  },

  // Combined save for the Details tab: the name, and the fields whose value
  // the form changed. A field left as it was is not written, so a value
  // someone else saved to it meanwhile stays.
  async saveNameAndMetadata(name, metadataPartial) {
    const label = 'Failed to save document';
    if (!this._canWrite(label)) return false;
    const current = this._raw?.metadata || {};
    const ops = Object.entries(metadataPartial || {})
      .filter(([key, value]) => (value ?? '') !== (current[key] ?? ''))
      .map(([key, value]) => ({ op: 'set', path: [key], value }));
    const nameChanged = name !== this._raw?.name;
    if (!nameChanged && ops.length === 0) return true;
    this._applyRawPatch((next) => {
      if (nameChanged) next.name = name;
      next.metadata = applyMetadataOps(next.metadata, ops);
    });
    return this._queueWrite(label, async () => {
      if (nameChanged) await this._client.documents.update(this.id, name);
      if (ops.length) await this._client.documents.patchMetadata(this.id, ops);
    });
  },

  async deleteDocument() {
    return this._queueWrite('Failed to delete document', async () => {
      await this._client.documents.delete(this.id);
      // Don't _reload — the document is gone and a fetch would 404.
    });
  },

  // `onProgress` gets `{ loaded, total }` in bytes as the file goes up, which
  // is what shows while it does; the reload that follows (the document now
  // carries its media, at an address only the server knows) is not counted.
  async uploadMedia(file, { onProgress } = {}) {
    if (!file) return false;
    return this._queueWrite('Failed to upload media', async () => {
      await this._client.documents.uploadMedia(this.id, file, undefined, { onProgress });
      await this._reload();
    });
  },

  async deleteMedia() {
    const label = 'Failed to delete media';
    if (!this._canWrite(label)) return false;
    this._applyRawPatch((next) => {
      next.mediaUrl = null;
    });
    return this._queueWrite(label, () => this._client.documents.deleteMedia(this.id));
  },
};
