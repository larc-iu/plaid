// Mutation mixin: what an optimistic create needs. See IgtDocument.js for the
// `this` API.
//
// Every edit shows before the server answers, creates included. A row an edit
// creates goes into the local document under a PENDING id (plaid-ui's
// pendingIds.js), and DocumentModel's `_settle` puts the server's ids in its
// place once it answers. A send names every id through `settledId`, since an
// edit made while an earlier one was still queued can hold that one's pending
// ids.
//
// The morpheme `derive` synthesizes for an unanalyzed word (virtualMorpheme.js)
// is the common create here: glossing, linking or retyping such a word writes
// its morpheme first. `_planMorphemes` turns virtual ids into pending
// morphemes that show at once, and `_sendMorphemes` makes them on the server
// in one request, inside the send.

import { createdId, createdIds } from '@larc-iu/plaid-client';
import { pendingId, settledId, settleIds } from '@ui/domain/pendingIds.js';
import { isVirtualMorphemeId, virtualMorphemeWordId } from '../virtualMorpheme.js';

export const pendingMutations = {
  // A link names its tokens and its entry, so the vocabularies settle with
  // the document (DocumentModel's `_settle`).
  _settleBeside([, vocabs], ids) {
    settleIds(vocabs, ids);
  },

  // The token a morpheme id names now: a real id passes through (settled), and
  // a virtual one names its word's morpheme when an earlier edit has made it,
  // else null.
  _currentMorphemeId(id) {
    if (!isVirtualMorphemeId(id)) return settledId(id);
    const wordId = virtualMorphemeWordId(id);
    const info = this.layerInfo;
    const word = (info.primaryTokenLayer?.tokens || []).find((t) => t.id === settledId(wordId));
    if (!word) return null;
    const own = (info.morphemeTokenLayer?.tokens || []).filter(
      (m) => m.begin === word.begin && m.end === word.end,
    );
    return own.length ? own[0].id : null;
  },

  /**
   * The tokens `ids` name, morpheme or word, with a pending morpheme planned
   * for each unanalyzed word among them (one per word however often it is
   * named). `metadataFor(virtualId)` gives a new morpheme's metadata, the
   * writer's create stamp added. Returns `{ ids, creates }`: `ids` positional,
   * null where one names nothing; `creates` for `_showMorphemes` and
   * `_sendMorphemes`.
   */
  _planMorphemes(idsIn, metadataFor = () => undefined) {
    const info = this.layerInfo;
    const words = new Map((info.primaryTokenLayer?.tokens || []).map((t) => [t.id, t]));
    const stamp = this.createStamp;
    const creates = [];
    const planned = new Map();
    const ids = idsIn.map((id) => {
      if (!isVirtualMorphemeId(id)) return id == null ? null : settledId(id);
      const current = this._currentMorphemeId(id);
      if (current) return current;
      if (planned.has(id)) return planned.get(id);
      const word = words.get(settledId(virtualMorphemeWordId(id)));
      if (!word || !info.morphemeTokenLayer?.id) return null;
      const meta = metadataFor(id);
      const create = {
        id: pendingId(),
        begin: word.begin,
        end: word.end,
        precedence: 1,
        metadata: stamp || meta ? { ...(meta || {}), ...(stamp || {}) } : {},
      };
      creates.push(create);
      planned.set(id, create.id);
      return create.id;
    });
    return { ids, creates };
  },

  _showMorphemes(info, creates) {
    const layer = info.morphemeTokenLayer;
    if (!layer || !creates.length) return;
    if (!Array.isArray(layer.tokens)) layer.tokens = [];
    const textId = info.primaryTextLayer?.text?.id;
    creates.forEach((c) => layer.tokens.push({ ...c, text: textId }));
  },

  /**
   * Queue the planned morphemes on batch `b`, for the writes after them in
   * the same batch that point at them, so the morphemes and what hangs off
   * them land together or not at all. Answers `tokenRef(id)`, what a later
   * write names a token by (the batch's stand-in for a planned morpheme's id,
   * else the id as the server knows it, `serverId`), and `read(results, ids)`,
   * which records the server's ids for the planned ones from the batch's
   * results.
   */
  _queueMorphemes(b, creates, serverId = settledId) {
    const refs = new Map();
    const at = new Map();
    if (creates.length) {
      const info = this.layerInfo;
      const layerId = info.morphemeTokenLayer.id;
      const textId = info.primaryTextLayer.text.id;
      const metadataOf = (c) => (Object.keys(c.metadata || {}).length ? c.metadata : undefined);
      if (creates.length === 1) {
        const [c] = creates;
        b.tokens.create(layerId, textId, c.begin, c.end, c.precedence, metadataOf(c), undefined, {
          id: c.id,
        });
        const ref = b.ref();
        refs.set(c.id, ref);
        at.set(c.id, [ref.$ref, null]);
      } else {
        b.tokens.bulkCreate(
          creates.map((c) => ({
            id: c.id,
            tokenLayerId: layerId,
            text: textId,
            begin: c.begin,
            end: c.end,
            precedence: c.precedence,
            ...(metadataOf(c) ? { metadata: c.metadata } : {}),
          })),
        );
        creates.forEach((c, k) => {
          const ref = b.ref(-1, k);
          refs.set(c.id, ref);
          at.set(c.id, [ref.$ref, k]);
        });
      }
    }
    return {
      tokenRef: (id) => refs.get(id) ?? serverId(id),
      read: (results, ids) => {
        for (const [id, [n, k]] of at) {
          ids.set(id, k == null ? createdId(results[n]) : createdIds(results[n])[k]);
        }
      },
    };
  },

  // Make the planned morphemes on the server in one request (a bulk create
  // for several), recording each one's id in `ids`. Must run before any batch
  // that points at them: a create's id is only readable outside one.
  async _sendMorphemes(creates, ids) {
    if (!creates.length) return;
    const info = this.layerInfo;
    const layerId = info.morphemeTokenLayer.id;
    const textId = info.primaryTextLayer.text.id;
    const metadataOf = (c) => (Object.keys(c.metadata || {}).length ? c.metadata : undefined);
    if (creates.length === 1) {
      const [c] = creates;
      const result = await this._client.tokens.create(
        layerId,
        textId,
        c.begin,
        c.end,
        c.precedence,
        metadataOf(c),
        undefined,
        { id: c.id },
      );
      ids.set(c.id, createdId(result));
      return;
    }
    const result = await this._client.tokens.bulkCreate(
      creates.map((c) => ({
        id: c.id,
        tokenLayerId: layerId,
        text: textId,
        begin: c.begin,
        end: c.end,
        precedence: c.precedence,
        ...(metadataOf(c) ? { metadata: c.metadata } : {}),
      })),
    );
    const newIds = createdIds(result);
    creates.forEach((c, i) => ids.set(c.id, newIds[i]));
  },
};
