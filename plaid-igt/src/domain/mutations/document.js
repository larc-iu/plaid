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
  wasReplayed,
} from '@larc-iu/plaid-client';
import { lineSentenceRanges } from '../../utils/tokenizationUtils.js';
import { notSetUp } from '@ui/domain/setupGuard.js';
import { isTextChanged, statusOf } from '@ui/lib/errors.js';
import { sendTextPlan } from '@ui/lib/textSave.js';
import { pendingId } from '@ui/domain/pendingIds.js';
import { mergeText, rebaseEdits } from '@ui/lib/textMerge.js';
import { storedHolds } from '@ui/lib/editLog.js';
import { applyReshape } from '@ui/domain/textReshape.js';
import { getIgtLayerInfo } from '../layerInfo.js';
import { readIgnoredTokens, readTokenizeNewText } from '../igtConfig.js';
import { newTextWords } from '../newTextWords.js';
import { underKeys } from './alignment.js';
import { VAD_METADATA_KEY } from '../media/speechDetectionKey.js';

// One sentence per line of a freshly saved text. The server keeps the
// partition in step with later edits; the Tokenize tab moves the breaks.
const sentenceSeed = (tokenLayerId, text, body) =>
  lineSentenceRanges(body).map(({ begin, end }) => ({ tokenLayerId, text, begin, end }));

// What a save whose draft cannot be put onto the stored text is refused with.
const BASELINE_CONFLICT = 'The same passage was changed elsewhere. Cancel and redo the edit.';

// What a save is refused with when the server gives no digest for the text:
// an edit never goes without one.
const NO_DIGEST = 'The saved text could not be read. Reload the page and save again.';

// The new words of a Baseline save (newTextWords.js) as the word layer takes
// them, on the text `textId`.
const wordCreates = (tokenLayerId, text, words) =>
  words.map(({ begin, end }) => ({ tokenLayerId, text, begin, end }));

// A batch refused because a new word of it lies over a word the server put
// there: the edit placed a word where newTextWords did not foresee one.
// Nothing of the batch is stored.
const wordsOverlap = (err) =>
  statusOf(err) === 409 &&
  /Bulk-created token overlaps|Tokens in batch overlap/i.test(
    String(err?.responseData?.error ?? err?.message ?? ''),
  );

// The vocabulary links igt keeps beside the document (`vocabs`, a patch's
// mutable copy), brought up to date from a text edit's `reshape` as the
// document's own are (applyReshape): deleted links dropped, and a link whose
// tokens changed given its new ones.
export function reshapeVocabLinks(vocabs, reshape) {
  const gone = new Set(reshape?.deleted?.vocabLinks ?? []);
  const moved = new Map((reshape?.vocabLinks ?? []).map((link) => [link.id, link.tokens]));
  if (!gone.size && !moved.size) return;
  for (const vocab of Object.values(vocabs || {})) {
    if (!Array.isArray(vocab?.vocabLinks)) continue;
    vocab.vocabLinks = vocab.vocabLinks
      .filter((link) => !gone.has(link.id))
      .map((link) =>
        Array.isArray(moved.get(link.id)) ? { ...link, tokens: moved.get(link.id) } : link,
      );
  }
}

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
  //
  // `tokenize`: a text made here gets the words of the project's "Tokenize new
  // text" (`_newWords`) in the batch that makes it. The Baseline tab asks for
  // it, scripts and the Media tab do not.
  async saveBaselineText(newBody, base = this.body, { tokenize = false } = {}) {
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

    // Minted outside the send, so a resend of it names the same text.
    const newTextId = primaryTextLayer.text?.id ? null : pendingId();
    const words =
      newTextId && tokenize ? this._newWords('', [{ start: 0, end: 0, value: newBody }]) : [];
    return this._queueWrite('Failed to save baseline text', async () => {
      const textId = primaryTextLayer.text?.id;

      let sent = newBody;
      if (textId) {
        sent = await this._sendBaselineUpdate(textId, newBody, base);
      } else {
        // No existing text: the text and its sentences, one per line, in one
        // batch, the text under an id minted here, so the sentences can name
        // it. A lost answer is sent again under the same keys by the queue
        // and answered from what the first one stored.
        await this._client.batched(async (b) => {
          b.texts.create(primaryTextLayer.id, this.id, newBody, undefined, undefined, {
            id: newTextId,
          });
          if (cpLength(newBody) > 0) {
            b.tokens.bulkCreate(sentenceSeed(sentenceTokenLayer.id, newTextId, newBody));
          }
          if (words.length) {
            b.tokens.bulkCreate(wordCreates(info.primaryTokenLayer.id, newTextId, words));
          }
        });
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
  // `digest`, the digest of `base` the server issued, or null when it was not
  // known. They go to the server as edits at the caret with the digest of the
  // text they apply to (texts.edit), so an insert or a delete stands exactly
  // where it was typed and only a stretch typed over is read as a whole-body
  // save reads it. The answer says what the edit did to the tokens, and the
  // document is patched from it instead of read again.
  //
  // When the stored body is no longer `base` (someone saved meanwhile, or the
  // server refused the digest), the gaps are moved onto the stored body with
  // `rebaseEdits` and sent with its digest. Changes to the same passage are
  // refused, with the draft left in the tab. An edit never goes without the
  // digest it applies to.
  //
  // `outcome`, when given, is told what became of a save that failed, for
  // the tab to know whether its edits are stored: `landed`, the edit is
  // stored (a step after it failed), and `conflict`, it was refused because
  // the same passage changed elsewhere. A lost answer is no outcome: the
  // queue sends the save again until it is answered, for as long as the page
  // is open.
  async editBaselineText({ base, digest, gaps }, outcome = {}) {
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
      return this.saveBaselineText(applyTextOps(base, gapsToOps(gaps)), base, { tokenize: true });
    }
    const textId = primaryTextLayer.text.id;
    // What is sent, kept here and not in the send: a send run again after its
    // answer was lost sends exactly the request that was lost, under the same
    // keys, and is answered from what it stored. `keys` is null until the
    // plan is made on the stored text (`_planBaselineEdit`), and a plan made
    // again after a refusal takes new ones.
    const plan = {
      base,
      digest,
      gaps,
      seed: false,
      words: [],
      keys: null,
      sentUnder: null,
      landed: false,
    };
    Object.assign(outcome, { landed: false, conflict: false });
    return this._queueWrite('Failed to save baseline text', async () => {
      Object.assign(outcome, { landed: false, conflict: false });
      try {
        await this._saveBaselineEdit(textId, plan);
      } catch (err) {
        outcome.landed = plan.landed;
        outcome.conflict =
          !plan.landed && (err?.message === BASELINE_CONFLICT || isTextChanged(err));
        throw err;
      }
    });
  },

  // The send of `editBaselineText`.
  async _saveBaselineEdit(textId, plan) {
    if (await this._sendBaselineEdit(textId, plan)) await this._reloadInSend();
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
  },

  // The edit half of `editBaselineText`, from inside its send. A text with no
  // sentences gets its partition in the same batch as the edit, measured on
  // the body the edit makes, and the words of "Tokenize new text"
  // (`plan.words`) go in that batch too. A lost answer is sent again by the
  // queue: the plan is sent again as it was, under its keys, and answered
  // from what the first send stored. Answers whether the document is to be
  // read: a batch is not patched from its answer, and an answer to a request
  // sent before under the same keys may be the first one's, replayed, with
  // the body as it was then, and so may one the client replayed inside its
  // own resend (`wasReplayed`). `plan.landed` is set once the edit is stored.
  async _sendBaselineEdit(textId, plan) {
    // Whether the request last sent went under keys it was sent with before,
    // whether its answer was replayed from them, and whether it was a batch.
    let again = false;
    let replayed = false;
    let batched = false;
    const sendOnce = async () => {
      const ops = gapsToOps(plan.gaps);
      again = plan.sentUnder === plan.keys && plan.keys != null;
      plan.sentUnder = plan.keys;
      replayed = false;
      batched = plan.seed || plan.words.length > 0;
      await underKeys(this._client, plan.keys, async () => {
        if (batched) {
          // The tokens after it are stamped with the version from before the
          // batch, so the edit is stamped too, and checked first.
          const info = this.layerInfo;
          const body = applyTextOps(plan.base, ops);
          await this._client.batched(async (b) => {
            b.texts.edit(textId, ops, undefined, { base: plan.digest, versioned: true });
            if (plan.seed) {
              b.tokens.bulkCreate(sentenceSeed(info.sentenceTokenLayer.id, textId, body));
            }
            if (plan.words.length) {
              b.tokens.bulkCreate(wordCreates(info.primaryTokenLayer.id, textId, plan.words));
            }
          });
          plan.landed = true;
          return;
        }
        const answer = await this._client.texts.edit(textId, ops, undefined, {
          base: plan.digest,
        });
        plan.landed = true;
        this._applyRawPatch((next, infoNext, vocabs) => {
          Object.assign(next, applyReshape(next, textId, answer));
          reshapeVocabLinks(vocabs, answer?.reshape);
        });
        replayed = wasReplayed(answer);
      });
    };
    const result = await sendTextPlan({
      prepare: async () => {
        if (!plan.keys) await this._planBaselineEdit(plan, await this._storedText());
        return true;
      },
      send: async () => {
        try {
          await sendOnce();
        } catch (err) {
          // A new word over one the edit placed: the batch stored nothing,
          // and the edit goes again without the words, under new keys.
          if (!plan.words.length || !wordsOverlap(err)) throw err;
          plan.words = [];
          plan.keys = this._client.keySeed?.() ?? null;
          await sendOnce();
        }
      },
      sentBefore: () => again,
      readStored: () => this._readStoredText(),
      holds: (stored) => storedHolds(plan.base, plan.gaps, stored.body),
      replan: async (stored) =>
        this._planBaselineEdit(plan, stored ?? (await this._readStoredText())),
      conflict: BASELINE_CONFLICT,
    });
    if ('stored' in result) {
      plan.landed = true;
      return false;
    }
    return batched || again || replayed;
  },

  // The body stored and its digest, from the copy on screen when it knows the
  // digest of what it shows, else read.
  async _storedText() {
    const digest = this.layerInfo.primaryTextLayer?.text?.digest ?? null;
    return digest ? { body: this.body, digest } : this._readStoredText();
  },

  // The document read, from inside a send, and put on screen with the edits
  // queued behind shown on top (as `_reloadInSend` does). Answers the body
  // stored and its digest, as read: the screen may show more on top of it.
  async _readStoredText() {
    const updated = await this._fetch();
    await this._adoptReload(updated);
    this._showUnsent(updated);
    if (this._writes.queued > 1) this._writes.reloadWhenDrained = true;
    const text = getIgtLayerInfo(updated).primaryTextLayer?.text;
    return { body: text?.body ?? '', digest: text?.digest ?? null };
  },

  // `plan` made on `stored` (`{ body, digest }`): its gaps moved onto the
  // stored body when that is no longer its base (a conflict throws), the
  // digest of the stored body, whether the text needs its first sentences,
  // and new keys. Throws rather than let an edit go without a digest.
  _planBaselineEdit(plan, stored) {
    if (!stored.digest) throw new Error(NO_DIGEST);
    if (stored.body !== plan.base) {
      const moved = rebaseEdits(plan.base, plan.gaps, stored.body);
      if (moved.conflict) throw new Error(BASELINE_CONFLICT);
      plan.gaps = moved.gaps;
      plan.base = stored.body;
    }
    plan.digest = stored.digest;
    const body = applyTextOps(plan.base, gapsToOps(plan.gaps));
    plan.seed =
      cpLength(body) > 0 && (this.layerInfo.sentenceTokenLayer?.tokens || []).length === 0;
    plan.words = this._newWords(plan.base, plan.gaps);
    plan.keys = this._client.keySeed?.() ?? null;
  },

  // The words "Tokenize new text" gives a save of `gaps` over `base`, the
  // body stored (newTextWords.js), read off the word layer on screen: none
  // when the project has it off.
  _newWords(base, gaps) {
    const wordLayer = this.layerInfo.primaryTokenLayer;
    if (!wordLayer?.id || !readTokenizeNewText(wordLayer.config)) return [];
    return newTextWords({
      base,
      gaps,
      words: wordLayer.tokens || [],
      ignored: readIgnoredTokens(wordLayer.config),
    });
  },

  // The update half of `saveBaselineText`, from inside its send. Answers the
  // body it stored.
  //
  // A text with no sentences gets its partition in the same batch as the
  // update, so a lost answer cannot leave the text saved and unsegmented. A
  // lost answer is sent again by the queue under the same keys.
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
        if (isTextChanged(err) && attempt < 2) {
          await this._reloadInSend();
          continue;
        }
        throw err;
      }
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

  // The speech-detection cuts were measured on the recording, so they go with
  // it, in the same operation. The delete names the recording on screen, so
  // one replaced by someone else since is refused rather than deleted, and
  // the refetch after the refusal shows the current one.
  async deleteMedia() {
    const label = 'Failed to delete media';
    if (!this._canWrite(label)) return false;
    const mediaVersion = mediaVersionOf(this._raw?.mediaUrl);
    const ops =
      this._raw?.metadata?.[VAD_METADATA_KEY] != null
        ? metadataOps({ [VAD_METADATA_KEY]: null })
        : [];
    this._applyRawPatch((next) => {
      next.mediaUrl = null;
      if (ops.length) next.metadata = applyMetadataOps(next.metadata, ops);
    });
    return this._queueWrite(label, async () => {
      try {
        await this._client.documents.deleteMedia(this.id, undefined, { mediaVersion });
      } catch (err) {
        throw recordingReplaced(err) ?? err;
      }
      if (ops.length) await this._client.documents.patchMetadata(this.id, ops);
    });
  },
};

// The `?v=` of a document's media URL, which names the recording it holds.
function mediaVersionOf(mediaUrl) {
  if (!mediaUrl) return undefined;
  const query = String(mediaUrl).split('?')[1] ?? '';
  return new URLSearchParams(query).get('v') || undefined;
}

// A delete refused because the stored recording is another one, worded for
// the screen. Not a status the toast words as a conflict: the page refetches
// and shows the current recording, which is what the message says.
function recordingReplaced(err) {
  if (statusOf(err) !== 409 || !err?.responseData?.['media-changed']) return null;
  return Object.assign(new Error('Replaced elsewhere. Showing the current recording.'), {
    cause: err,
    mediaChanged: true,
  });
}
