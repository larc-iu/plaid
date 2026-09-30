// Mutation mixin: document-level operations (baseline text, metadata, media
// upload/delete). See IgtDocument.js for the `this` API (_queueWrite,
// _applyRawPatch, _reload, layerInfo, body, etc.). Deleting a document is the
// shared Details page's.
//
// Renaming a document and copying it are NOT here: they are `rename` and
// `copyTo` on the shared DocumentModel, which every app's document inherits.

import {
  applyMetadataOps,
  applyTextOps,
  cpLength,
  gapsToOps,
  isReservedMetadataKey,
  metadataOps,
} from '@larc-iu/plaid-client';
import { lineSentenceRanges } from '../../utils/tokenizationUtils.js';
import { notSetUp } from '@ui/domain/setupGuard.js';
import { isUnknownOutcome, statusOf } from '@ui/lib/errors.js';
import { mergeText, rebaseEdits } from '@ui/lib/textMerge.js';
import { applyReshape } from '@ui/domain/textReshape.js';

// One sentence per line of a freshly saved text. The server keeps the
// partition in step with later edits; the Tokenize tab moves the breaks.
const sentenceSeed = (tokenLayerId, text, body) =>
  lineSentenceRanges(body).map(({ begin, end }) => ({ tokenLayerId, text, begin, end }));

// What a save whose draft cannot be put onto the stored text is refused with.
const BASELINE_CONFLICT = 'The same passage was changed elsewhere. Cancel and redo the edit.';

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
  // `base` is the body the draft was typed over (the Baseline tab's Edit).
  // The draft is sent whole, so a draft typed on a copy someone else has
  // since saved over would put their passages back as they were. When the
  // stored body is no longer `base`, the draft's changes are merged onto it
  // (`mergeText`) and the merged text is sent, and a save refused as
  // out of date (409) is merged again onto what the refetch read. Changes to
  // the same passage are refused, with the draft left in the tab.
  //
  // The one write here that reloads instead of patching: what a whole-body
  // update does to the tokens is the server's diff (plaid.algos.text), which
  // this does not replay. The Baseline tab's textarea already shows the text.
  async saveBaselineText(newBody, base = this.body) {
    const info = this.layerInfo;
    const primaryTextLayer = info.primaryTextLayer;
    const sentenceTokenLayer = info.sentenceTokenLayer;

    if (!primaryTextLayer) {
      this.setError(notSetUp('No primary text layer found'));
      return false;
    }
    if (!sentenceTokenLayer?.id) {
      this.setError(notSetUp('No sentence layer found'));
      return false;
    }

    return this._queueWrite('Failed to save baseline text', async () => {
      const textId = primaryTextLayer.text?.id;

      let sent = newBody;
      if (textId) {
        sent = await this._sendBaselineUpdate(textId, newBody, base);
      } else {
        // No existing text — texts.create, then seed the sentence partition
        // in a follow-up call (it needs the new text's id). A create whose
        // answer was lost is looked up, and when it landed the seed below
        // the reload makes its sentences.
        const newTextObj = await this._client.texts
          .create(primaryTextLayer.id, this.id, newBody)
          .catch(async (err) => {
            if (!isUnknownOutcome(err)) throw err;
            if (await this._landedAs(newBody)) return null;
            throw err;
          });
        if (newTextObj && cpLength(newBody) > 0) {
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

      await this._reloadInSend();

      // A replacement that shares nothing with the old body deletes the old
      // sentence tokens outright (an empty partition is server-valid), which
      // would leave the Analyze tab blank. Seed the partition again, one
      // sentence per line, whenever the edit leaves a non-empty body with none.
      if (cpLength(sent) > 0) {
        const freshInfo = this.layerInfo;
        const freshTextId = freshInfo.primaryTextLayer?.text?.id;
        const sentencesAfter = freshInfo.sentenceTokenLayer?.tokens || [];
        if (freshTextId && sentencesAfter.length === 0) {
          await this._client.tokens.bulkCreate(
            sentenceSeed(sentenceTokenLayer.id, freshTextId, this.body),
          );
          await this._reloadInSend();
        }
      }
    });
  },

  // The Baseline tab's save: the edits typed in the box, as gaps of `base`
  // (`{ start, end, value }` in code points, see plaid-ui's editLog.js), and
  // `digest`, the digest of `base` the server issued. They go to the server
  // as edits at the caret with that digest (texts.edit), so an insert or a
  // delete stands exactly where it was typed and only a stretch typed over is
  // read as a whole-body save reads it. The answer says what the edit did to
  // the tokens, and the document is patched from it instead of read again.
  //
  // When the stored body is no longer `base` (someone saved meanwhile, or the
  // server refused the digest), the gaps are moved onto the stored body with
  // `rebaseEdits` and sent again with its digest. Changes to the same passage
  // are refused, with the draft left in the tab.
  async editBaselineText({ base, digest, gaps }) {
    const info = this.layerInfo;
    const primaryTextLayer = info.primaryTextLayer;
    if (!primaryTextLayer) {
      this.setError(notSetUp('No primary text layer found'));
      return false;
    }
    if (!info.sentenceTokenLayer?.id) {
      this.setError(notSetUp('No sentence layer found'));
      return false;
    }
    // A text not made yet has no edits to send: it is created whole.
    if (!primaryTextLayer.text?.id) {
      return this.saveBaselineText(applyTextOps(base, gapsToOps(gaps)), base);
    }
    return this._queueWrite('Failed to save baseline text', async () => {
      const textId = primaryTextLayer.text.id;
      const { seeded } = await this._sendBaselineEdit(textId, base, digest, gaps);
      if (seeded) await this._reloadInSend();
      // An edit that took every sentence with it leaves a text with none, so
      // the partition is seeded again, one sentence per line.
      const body = this.body;
      const sentencesAfter = this.layerInfo.sentenceTokenLayer?.tokens || [];
      if (cpLength(body) > 0 && sentencesAfter.length === 0) {
        await this._client.tokens.bulkCreate(
          sentenceSeed(this.layerInfo.sentenceTokenLayer.id, textId, body),
        );
        await this._reloadInSend();
      }
    });
  },

  // The edit half of `editBaselineText`, from inside its send. A text with no
  // sentences gets its partition in the same batch as the edit, measured on
  // the body the edit makes. A lost answer is looked up: the edit landed when
  // the stored body is the one it makes.
  async _sendBaselineEdit(textId, base, digest, gaps) {
    for (let attempt = 0; ; attempt += 1) {
      // A body changed here and not yet answered has no digest: read the
      // stored one, so the edit never goes without its precondition.
      if (!(this.layerInfo.primaryTextLayer?.text?.digest ?? null)) await this._reloadInSend();
      const stored = this.body;
      const storedDigest = this.layerInfo.primaryTextLayer?.text?.digest ?? null;
      if (stored !== base) {
        const moved = rebaseEdits(base, gaps, stored);
        if (moved.conflict) throw new Error(BASELINE_CONFLICT);
        ({ gaps } = moved);
        base = stored;
        digest = storedDigest;
      }
      const ops = gapsToOps(gaps);
      const body = applyTextOps(base, ops);
      const sentenceLayer = this.layerInfo.sentenceTokenLayer;
      const seed = cpLength(body) > 0 && (sentenceLayer?.tokens || []).length === 0;
      try {
        if (seed) {
          // The sentences after it are stamped with the version from before
          // the batch, so the edit is stamped too, and checked first.
          await this._client.batched(async (b) => {
            b.texts.edit(textId, ops, undefined, { base: digest, versioned: true });
            b.tokens.bulkCreate(sentenceSeed(sentenceLayer.id, textId, body));
          });
          return { body, seeded: true };
        }
        const answer = await this._client.texts.edit(textId, ops, undefined, { base: digest });
        this._applyRawPatch((next) => {
          Object.assign(next, applyReshape(next, textId, answer));
        });
        return { body, seeded: false };
      } catch (err) {
        if (statusOf(err) === 409 && attempt < 2) {
          await this._reloadInSend();
          continue;
        }
        if (isUnknownOutcome(err) && (await this._landedAs(body))) return { body, seeded: false };
        throw err;
      }
    }
  },

  // The update half of `saveBaselineText`, from inside its send. Answers the
  // body it stored.
  //
  // A text with no sentences gets its partition in the same batch as the
  // update, so a lost answer cannot leave the text saved and unsegmented. A
  // save whose answer was lost is looked up: when the stored body is the one
  // sent, it landed, and the save goes on as if it had been answered.
  async _sendBaselineUpdate(textId, newBody, base) {
    for (let attempt = 0; ; attempt += 1) {
      const merged = this.body === base ? { text: newBody } : mergeText(base, newBody, this.body);
      if (merged.conflict) throw new Error(BASELINE_CONFLICT);
      const body = merged.text;
      const sentenceLayer = this.layerInfo.sentenceTokenLayer;
      const seed = cpLength(body) > 0 && (sentenceLayer?.tokens || []).length === 0;
      try {
        if (seed) {
          await this._client.batched(async (b) => {
            b.texts.update(textId, body);
            b.tokens.bulkCreate(sentenceSeed(sentenceLayer.id, textId, body));
          });
        } else {
          await this._client.texts.update(textId, body);
        }
        return body;
      } catch (err) {
        if (statusOf(err) === 409 && attempt < 2) {
          await this._reloadInSend();
          continue;
        }
        if (isUnknownOutcome(err) && (await this._landedAs(body))) return body;
        throw err;
      }
    }
  },

  // After a save whose answer was lost, from inside its send: whether the
  // stored text is now `body`, read back from the server.
  async _landedAs(body) {
    try {
      await this._reloadInSend();
      return Boolean(this.layerInfo.primaryTextLayer?.text?.id) && this.body === body;
    } catch (readError) {
      console.error('Could not read the text back after a lost answer:', readError);
      return false;
    }
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
  // key set to null is removed, as the client's metadataOps has it.
  async setMetadataKeys(partial) {
    return this.patchMetadata(metadataOps(partial));
  },

  // Combined save for the Details tab: the name, and the fields whose value
  // the form changed, in one queued write. The name is written as `rename`
  // writes it (`_planRename`): trimmed, and never blank. A field left as it
  // was is not written, so a value someone else saved to it meanwhile stays.
  async saveNameAndMetadata(name, metadataPartial) {
    const label = 'Failed to save document';
    if (!this._canWrite(label)) return false;
    const current = this._raw?.metadata || {};
    // `plaid` and the provenance keys are Plaid's own, never a field's value.
    const ops = Object.entries(metadataPartial || {})
      .filter(([key]) => !isReservedMetadataKey(key))
      .filter(([key, value]) => (value ?? '') !== (current[key] ?? ''))
      .map(([key, value]) => ({ op: 'set', path: [key], value }));
    const nextName = this._planRename(name);
    if (!nextName && ops.length === 0) return true;
    this._applyRawPatch((next) => {
      if (nextName) next.name = nextName;
      next.metadata = applyMetadataOps(next.metadata, ops);
    });
    return this._queueWrite(label, async () => {
      if (nextName) await this._client.documents.update(this.id, nextName);
      if (ops.length) await this._client.documents.patchMetadata(this.id, ops);
    });
  },

  // `onProgress` gets `{ loaded, total }` in bytes as the file goes up, which
  // is what shows while it does; the reload that follows (the document now
  // carries its media, at an address only the server knows) is not counted.
  async uploadMedia(file, { onProgress } = {}) {
    if (!file) return false;
    return this._queueWrite('Failed to upload media', async () => {
      await this._client.documents.uploadMedia(this.id, file, undefined, { onProgress });
      await this._reloadInSend();
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
