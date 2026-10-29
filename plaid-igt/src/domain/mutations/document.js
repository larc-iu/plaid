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
  composeText,
  cpLength,
  gapsToOps,
  isReservedMetadataKey,
  metadataOps,
  wasReplayed,
} from '@larc-iu/plaid-client';
import { lineSentenceRanges } from '../../utils/tokenizationUtils.js';
import { notSetUp } from '@ui/domain/setupGuard.js';
import { isTextChanged, statusOf } from '@ui/lib/errors.js';
import { makeTextPlan, planOn, sendTextPlan, sendingPlan } from '@ui/lib/textSave.js';
import { pendingId } from '@ui/domain/pendingIds.js';
import { storedHolds } from '@ui/lib/editLog.js';
import { applyReshape } from '@ui/domain/textReshape.js';
import { getIgtLayerInfo } from '../layerInfo.js';
import { readTokenizeNewText } from '../igtConfig.js';
import { underKeys } from './alignment.js';
import { VAD_METADATA_KEY } from '../media/speechDetectionKey.js';
import { followedForms, soleForms } from '../soleMorphemeForms.js';

// How many morpheme forms one bulk token update writes.
const FORM_CHUNK = 500;

// One sentence per line of a freshly saved text. The server keeps the
// partition in step with later edits; the Tokenize tab moves the breaks.
const sentenceSeed = (tokenLayerId, text, body) =>
  lineSentenceRanges(body).map(({ begin, end }) => ({ tokenLayerId, text, begin, end }));

// What a save whose draft cannot be put onto the stored text is refused with.
const BASELINE_CONFLICT = 'The same passage was changed elsewhere. Cancel and redo the edit.';

// What a save is refused with when the server gives no digest for the text:
// an edit never goes without one.
const NO_DIGEST = 'The saved text could not be read. Reload the page and save again.';

// The word layer a text save of `info` (layer info, getIgtLayerInfo) names
// for "Tokenize new text", whose words the server makes for the text the save
// types: none when the project has it off. The Baseline save and the Media
// tab's transcript rows send it alike, and the words come in the answer.
export const tokenizeLayerOf = (info) => {
  const wordLayer = info?.primaryTokenLayer;
  return wordLayer?.id && readTokenizeNewText(wordLayer.config) ? wordLayer.id : undefined;
};

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

// The one edit that turns `base` into `body`, as gaps of `base` in code
// points: the start and end the two share are kept. None when they are equal.
function wholeEdit(base, body) {
  const a = [...base];
  const b = [...body];
  let start = 0;
  while (start < a.length && start < b.length && a[start] === b[start]) start += 1;
  let back = 0;
  while (
    back < a.length - start &&
    back < b.length - start &&
    a[a.length - 1 - back] === b[b.length - 1 - back]
  ) {
    back += 1;
  }
  const value = b.slice(start, b.length - back).join('');
  return start === a.length - back && value === '' ? [] : [{ start, end: a.length - back, value }];
}

export const documentMutations = {
  // A whole body saved as the document's text, for scripts and for the
  // Baseline tab's first save. `base` is the body it was typed over.
  //
  // A text not made yet is made with its sentences, one per line, in one
  // batch, the text under an id minted here, so the sentences can name it,
  // and both are shown before it is sent. A
  // lost answer is sent again under the same keys by the queue and answered
  // from what the first one stored. `tokenize`: it also gets the words of the
  // project's "Tokenize new text" (`tokenizeLayerOf`), which the server makes.
  // The Baseline tab asks for it, scripts do not.
  //
  // A text that exists takes the body as the one edit that turns `base` into
  // it (the start and end they share kept), sent as the Baseline tab sends
  // its edits (`editBaselineText`). That edit is one stretch typed over, so
  // every word between the first change and the last goes.
  async saveBaselineText(typedBody, base = this.body, { tokenize = false } = {}) {
    const info = this.layerInfo;
    const primaryTextLayer = info.primaryTextLayer;
    if (primaryTextLayer?.text?.id) {
      return this.editBaselineText({ base, digest: null, gaps: wholeEdit(base, typedBody) });
    }
    // A new text as the server stores it, composed, so the sentences made
    // with it are measured on the text that is stored.
    const newBody = composeText(typedBody).text;
    const sentenceTokenLayer = info.sentenceTokenLayer;

    if (!primaryTextLayer) {
      this.refuse(notSetUp('No primary text layer found'));
      return false;
    }
    if (!sentenceTokenLayer?.id) {
      this.refuse(notSetUp('No sentence layer found'));
      return false;
    }

    const label = 'Failed to save baseline text';
    if (!this._canWrite(label)) return false;
    // Minted outside the send, so a resend of it names the same rows.
    const newTextId = pendingId();
    const sentences =
      cpLength(newBody) > 0
        ? sentenceSeed(sentenceTokenLayer.id, newTextId, newBody).map((s) => ({
            id: pendingId(),
            ...s,
          }))
        : [];
    // Shown before it is sent, so a write made while it is on its way plans
    // on the text it makes and sends no second create. Over a copy that has
    // a text (this one shown again over a read) it shows nothing.
    this._applyRawPatch((next, infoNext) => {
      if (infoNext.primaryTextLayer.text) return;
      infoNext.primaryTextLayer.text = { id: newTextId, body: newBody, metadata: {} };
      infoNext.sentenceTokenLayer.tokens = sentences.map(({ id, text, begin, end }) => ({
        id,
        text,
        begin,
        end,
      }));
    });
    const tokenizeLayer = tokenize ? tokenizeLayerOf(info) : undefined;
    return this._queueWrite(label, async () => {
      await this._client.batched(async (b) => {
        this._ensureText(b, { id: newTextId, body: newBody }, { tokenizeLayer });
        if (sentences.length) b.tokens.bulkCreate(sentences);
      });
      // Made under the ids shown, which are no longer pending.
      this._settle(new Map([newTextId, ...sentences.map((s) => s.id)].map((id) => [id, id])));
      await this._reloadInSend();
    });
  },

  // The Baseline tab's save: the edits typed in the box, as gaps of `base`
  // (`{ start, end, value }` in code points, see plaid-ui's editLog.js), and
  // `digest`, the digest of `base` the server issued, or null when it was not
  // known. They go to the server as edits at the caret with the digest of the
  // text they apply to (texts.edit), so each stands exactly where it was
  // typed, a stretch typed over as a delete and an insert there. The answer
  // says what the edit did to the tokens, and the document is patched from
  // it instead of read again.
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
      this.refuse(notSetUp('No primary text layer found'));
      return false;
    }
    if (!info.sentenceTokenLayer?.id) {
      this.refuse(notSetUp('No sentence layer found'));
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
      ...makeTextPlan({ base, digest, gaps }),
      seed: false,
      landed: false,
      // The sole morphemes spelled as their word before the edit
      // (`_followSoleForms`), read at the first send.
      forms: null,
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
    plan.forms ??= soleForms(this.layerInfo, this.body);
    plan.sentences ??= new Set((this.layerInfo.sentenceTokenLayer?.tokens || []).map((s) => s.id));
    if (await this._sendBaselineEdit(textId, plan)) await this._reloadInSend();
    await this._followSoleForms(plan.forms);
    const body = this.body;
    const sentenceLayer = this.layerInfo.sentenceTokenLayer;
    const sentencesAfter = sentenceLayer?.tokens || [];
    if (cpLength(body) > 0 && sentencesAfter.length === 0) {
      // A text whose sentences were never made gets them, one per line.
      await this._client.tokens.bulkCreate(sentenceSeed(sentenceLayer.id, textId, body));
      await this._reloadInSend();
    } else if (sentencesAfter.length === 1 && !plan.sentences.has(sentencesAfter[0].id)) {
      // An edit that left the text none of its sentences (it took them all,
      // or they were never made and the edit made words) leaves the one the
      // server made over the whole text, which is cut into one sentence per
      // line, as a new text's are. Each cut keeps the sentence on its left.
      const cuts = sentenceSeed(sentenceLayer.id, textId, body)
        .slice(1)
        .map((s) => s.begin)
        .reverse();
      if (cuts.length) {
        await this._client.batched(async (b) => {
          for (const at of cuts) b.tokens.split(sentencesAfter[0].id, at);
        });
        await this._reloadInSend();
      }
    }
  },

  // A word with one morpheme whose form spelled the whole word, respelled by
  // the edit, gets its morpheme's form respelled with it (Luke, H17), after
  // the edit and in the same operation. `before` is `soleForms` of the
  // document as it was.
  async _followSoleForms(before) {
    const writes = followedForms(before, this.layerInfo, this.body);
    if (!writes.length) return;
    for (let i = 0; i < writes.length; i += FORM_CHUNK) {
      await this._client.tokens.bulkUpdate(
        writes.slice(i, i + FORM_CHUNK).map(({ id, form }) => ({
          id,
          metadata: [{ op: 'set', path: ['form'], value: form }],
        })),
      );
    }
    const forms = new Map(writes.map(({ id, form }) => [id, form]));
    this._applyRawPatch((next, infoNext) => {
      for (const m of infoNext.morphemeTokenLayer?.tokens || []) {
        if (forms.has(m.id)) m.metadata = { ...m.metadata, form: forms.get(m.id) };
      }
    });
  },

  // The edit half of `editBaselineText`, from inside its send. The edit names
  // the word layer of "Tokenize new text" (`tokenizeLayerOf`), and the server
  // makes the words of the text it types, which come in its answer. A text
  // with no token gets its partition in the same batch as the edit, measured
  // on the body the edit makes, when that body has nothing to compose
  // (`_planBaselineEdit`). A lost answer is sent again by the
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
      again = sendingPlan(plan);
      replayed = false;
      batched = plan.seed;
      const tokenizeLayer = tokenizeLayerOf(this.layerInfo);
      await underKeys(this._client, plan.keys, async () => {
        if (batched) {
          // The tokens after it are stamped with the version from before the
          // batch, so the edit is stamped too, and checked first. The text
          // holds no token and the new body has nothing to compose, so the
          // server stores it as sent.
          const info = this.layerInfo;
          const body = applyTextOps(plan.base, ops);
          await this._client.batched(async (b) => {
            b.texts.edit(textId, ops, undefined, {
              base: plan.digest,
              versioned: true,
              tokenizeLayer,
            });
            b.tokens.bulkCreate(sentenceSeed(info.sentenceTokenLayer.id, textId, body));
          });
          plan.landed = true;
          return;
        }
        const answer = await this._client.texts.edit(textId, ops, undefined, {
          base: plan.digest,
          tokenizeLayer,
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
      prepare: async () => plan.keys != null || this._planBaselineEdit(plan, this._storedText()),
      send: sendOnce,
      sentBefore: () => again,
      readStored: () => this._readStoredText(),
      holds: (stored) => storedHolds(plan.base, plan.gaps, stored.body),
      replan: async (stored) => {
        plan.keys = null;
        await this._planBaselineEdit(plan, stored);
      },
      conflict: BASELINE_CONFLICT,
    });
    if ('stored' in result) {
      plan.landed = true;
      return false;
    }
    return batched || again || replayed;
  },

  // The body stored and its digest, from the copy on screen when it knows the
  // digest of what it shows, else null: the plan reads it (`planOn`).
  _storedText() {
    const digest = this.layerInfo.primaryTextLayer?.text?.digest ?? null;
    return digest ? { body: this.body, digest } : null;
  },

  // The document read, from inside a send, and put on screen with the edits
  // queued behind shown on top (`_reloadInSend`). Answers the body stored and
  // its digest, as read: the screen may show more on top of it.
  async _readStoredText() {
    const updated = await this._reloadInSend();
    const text = getIgtLayerInfo(updated).primaryTextLayer?.text;
    return { body: text?.body ?? '', digest: text?.digest ?? null };
  },

  // `plan` made ready on `stored` (`{ body, digest }`, or null to read it) by
  // plaid-ui's planOn, the rule ud's Text Editor plans by too: its gaps moved
  // onto the stored body (a conflict throws), its digest (a text with none
  // is read once more, then refused), and new keys. And whether the text
  // needs its first sentences in the edit's batch: only when it holds no
  // token at all and composing the new body changes nothing. Where tokens
  // are, or the words "Tokenize new text" makes, their edges decide which
  // characters the server composes, so the body it stores is known only from
  // its answer, and the sentences are seeded after it (`_saveBaselineEdit`).
  // False when the gaps change nothing.
  async _planBaselineEdit(plan, stored) {
    const ready = await planOn(plan, stored, {
      read: () => this._readStoredText(),
      keySeed: () => this._client.keySeed?.(),
      conflict: BASELINE_CONFLICT,
      unread: NO_DIGEST,
    });
    const after = applyTextOps(plan.base, gapsToOps(plan.gaps));
    plan.seed =
      cpLength(after) > 0 &&
      composeText(after).text === after &&
      (this.layerInfo.primaryTextLayer?.tokenLayers || []).every((l) => !l.tokens?.length);
    return ready;
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
