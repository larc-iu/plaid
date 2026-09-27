// Mutation mixin: vocabulary-link operations. See IgtDocument.js for the
// `this` API (_queueWrite, _applyRawPatch, _reload, layerInfo, etc.).
//
// Vocab links live on the vocab layer (not the document), so optimistic
// patches mutate the third arg of `_applyRawPatch` (a shallow clone of
// `_vocabularies`). A token id here may be a word OR morpheme token; the
// link/create operation is identical either way.

import {
  stampInferred,
  isMachine,
  mergeMetadata,
  metadataOps,
  createdId,
  createdIds,
} from '@larc-iu/plaid-client';
import { isValidMorphType } from '../affixMarkers.js';
import { pendingId, settledId } from '@ui/domain/pendingIds.js';
import { lexiconView } from '../vocabDictionary.js';

// Not the shared CHUNK (domain/bulk.js): this writes through an ATOMIC BATCH
// rather than a bulk endpoint, and a link replacement emits 2 ops apiece
// (delete + create), so it is plaid-core's 1000-op cap that bounds it.
const REPLACE_CHUNK = 400;

/**
 * The morph-type cache a link has to keep in step.
 *
 * A morpheme linked to a lexicon entry goes by the ENTRY's type (its own, else
 * its headword's), and `derive` reads the entry over the token's cached
 * `metadata.morphType`. The cache is what unlinked morphemes and consumers that
 * never load the lexicon read, so a link that leaves it stale is a repair
 * waiting to happen: reconcile-on-open syncs it the next time anyone opens the
 * document, under a label that says nothing about what changed. Writing it with
 * the link is the same move `setVocabItemMorphType` already makes when an
 * entry's type changes.
 *
 * `planned` are morphemes an edit is making (pending, see pending.js), which
 * count as morphemes with no type yet.
 *
 * Returns a `typeFor(tokenId, vocabId, itemId)` that answers the type to write,
 * or null when there is nothing to write: the token is a WORD rather than a
 * morpheme (a word has no morph type), the entry chain resolves to no type, or
 * the cache already agrees. One lexicon view per vocabulary, built on demand,
 * since a bulk link can name hundreds of tokens across a handful of entries.
 */
const morphTypeCache = (doc, planned = []) => {
  const morphemes = new Map(
    [...(doc.layerInfo.morphemeTokenLayer?.tokens || []), ...planned].map((m) => [m.id, m]),
  );
  const views = new Map();
  const viewFor = (vocabId) => {
    if (!views.has(vocabId)) {
      const vocab = doc._vocabularies?.[vocabId];
      views.set(vocabId, vocab ? lexiconView(vocab.items || []) : null);
    }
    return views.get(vocabId);
  };
  return (tokenId, vocabId, itemId) => {
    const token = morphemes.get(tokenId);
    if (!token) return null;
    const type = viewFor(vocabId)?.morphTypeOf(itemId) ?? null;
    if (!type) return null;
    return (token.metadata?.morphType ?? null) === type ? null : type;
  };
};

// Locate the existing single-token vocab link for `tokenId` across all
// vocabularies. By convention there is at most one.
const findPriorLink = (vocabularies, tokenId) => {
  for (const vocab of Object.values(vocabularies || {})) {
    const link = (vocab.vocabLinks || []).find(
      (l) => Array.isArray(l.tokens) && l.tokens.length === 1 && l.tokens[0] === tokenId,
    );
    if (link) return { link, vocabId: vocab.id };
  }
  return { link: null, vocabId: null };
};

// Locate any vocab link by id across all vocabularies.
const findLinkById = (vocabularies, linkId) => {
  for (const vocab of Object.values(vocabularies || {})) {
    const link = (vocab.vocabLinks || []).find((l) => l.id === linkId);
    if (link) return { link, vocabId: vocab.id };
  }
  return { link: null, vocabId: null };
};

// Locate the vocab containing the given vocab item id.
const findVocabForItem = (vocabularies, vocabItemId) => {
  for (const vocab of Object.values(vocabularies || {})) {
    const item = (vocab.items || []).find((i) => i.id === vocabItemId);
    if (item) return { vocab, item };
  }
  return { vocab: null, item: null };
};

export const vocabMutations = {
  // Apply auto-link proposals (the built-in rule or any proposal provider).
  // `proposals` is [{ tokenId, vocabItemId }]. Provenance write contract: a
  // token with no link gets one; a token whose only link is machine-unverified
  // is RE-linked when the proposal differs; human and human-confirmed links are
  // left untouched (and a same-item proposal is a no-op). Every new link is
  // stamped { prov: 'inferred', provSource } (NO provConfirmed — a human
  // confirms by touching it). Creates go through the uncapped bulk endpoint
  // (so an arbitrarily large first run is one tx); the rarer replacements run
  // as chunked atomic delete+create batches. Ends with one _reload(). Returns
  // the number of links written (false on failure).
  async bulkLinkVocab(proposals, provSource) {
    let creates = []; // { tokenId, item }
    let replaces = []; // { tokenId, item, priorLinkId }
    for (const p of proposals || []) {
      const { vocab, item } = findVocabForItem(this._vocabularies, p.vocabItemId);
      if (!item) continue;
      const { link } = findPriorLink(this._vocabularies, p.tokenId);
      if (!link) {
        creates.push({ tokenId: p.tokenId, item, vocabId: vocab.id });
        continue;
      }
      // Replace only machine-unverified links, and only when the item changes.
      if (!isMachine(link.metadata)) continue;
      if (link.vocabItem?.id === item.id) continue;
      replaces.push({ tokenId: p.tokenId, item, vocabId: vocab.id, priorLinkId: link.id });
    }
    if (!creates.length && !replaces.length) return 0;
    const metadata = stampInferred(provSource);

    const ok = await this._queueWrite('Failed to auto-link', async () => {
      // Proposals can name an unanalyzed word's morpheme, which auto-link reads
      // by the form the word gives it. One bulk create turns those into tokens
      // before anything links to them, and before the batches below. A proposal
      // whose word is gone drops out rather than linking to nothing.
      const resolved = await this.materializeMorphemeIds([
        ...creates.map((c) => c.tokenId),
        ...replaces.map((r) => r.tokenId),
      ]);
      creates.forEach((c, i) => {
        c.tokenId = resolved[i];
      });
      replaces.forEach((r, i) => {
        r.tokenId = resolved[creates.length + i];
      });
      const live = (x) => Boolean(x.tokenId);
      creates = creates.filter(live);
      replaces = replaces.filter(live);
      if (creates.length) {
        // The dedicated endpoint has no per-batch op cap, so even a document
        // with thousands of unlinked tokens links in a single tx.
        await this._client.vocabLinks.bulkCreate(
          creates.map((c) => ({ vocabItem: c.item.id, tokens: [c.tokenId], metadata })),
        );
      }
      // Replacements: the stale links go in one bulk delete and the new ones in
      // one bulk create, both in the same batch so a token is never left with
      // two links or none. Two ops a chunk rather than two per replacement.
      for (let i = 0; i < replaces.length; i += REPLACE_CHUNK) {
        const chunk = replaces.slice(i, i + REPLACE_CHUNK);
        await this._client.batched(async (b) => {
          b.vocabLinks.bulkDelete(chunk.map((r) => r.priorLinkId));
          b.vocabLinks.bulkCreate(
            chunk.map((r) => ({ vocabItem: r.item.id, tokens: [r.tokenId], metadata })),
          );
        });
      }
      // The morph-type caches those links just made stale, chunked like the
      // replacements above. A link whose token is a word, or whose entry chain
      // has no type, contributes nothing.
      const typeFor = morphTypeCache(this);
      const cachePatches = [];
      for (const x of [...creates, ...replaces]) {
        const type = typeFor(x.tokenId, x.vocabId, x.item.id);
        if (type) cachePatches.push({ tokenId: x.tokenId, type });
      }
      for (let i = 0; i < cachePatches.length; i += REPLACE_CHUNK) {
        await this._client.tokens.bulkUpdate(
          cachePatches.slice(i, i + REPLACE_CHUNK).map((c) => ({
            id: c.tokenId,
            metadata: [{ op: 'set', path: ['morphType'], value: c.type }],
          })),
        );
      }
      await this._reloadInSend();
    });
    return ok ? creates.length + replaces.length : false;
  },

  // Confirm-on-touch for a proposed link: merge the writer's confirm stamp
  // (provConfirmed for a verifier; a contributor's vouching is itself a
  // contribution) so it renders (and queries) accordingly. No-op when there
  // is nothing for this writer to confirm.
  async confirmVocabLink(tokenId) {
    const { link, vocabId } = findPriorLink(this._vocabularies, tokenId);
    if (!link || !vocabId) return false;
    const confirm = this.confirmStamp(link.metadata);
    if (!confirm) return false;
    const label = 'Failed to confirm link';
    if (!this._canWrite(label)) return false;
    this._applyRawPatch((next, info, vocabs) => {
      const l = (vocabs[vocabId]?.vocabLinks || []).find((x) => x.id === link.id);
      if (l) l.metadata = mergeMetadata(l.metadata, confirm);
    });
    return this._queueWrite(label, () =>
      this._client.vocabLinks.patchMetadata(settledId(link.id), metadataOps(confirm)),
    );
  },

  // Link a vocab item to a token (word or morpheme). If a prior single-token
  // link exists for this token, delete it and create the new link atomically.
  // `metadata` (optional) carries provenance for machine-produced links (see
  // the shared provenance helpers); human links from the popover pass none
  // and carry the writer's create stamp.
  async linkVocab(tokenId, vocabItemId, metadata = null) {
    const { vocab: targetVocab, item: vocabItem } = findVocabForItem(
      this._vocabularies,
      vocabItemId,
    );
    if (!targetVocab || !vocabItem) {
      this.setError(`Vocab item ${vocabItemId} not found`);
      return false;
    }
    const label = 'Failed to link the entry';
    if (!this._canWrite(label)) return false;
    // Linking an unanalyzed word's morpheme makes the morpheme too: a link
    // needs a token to point at. A word id passes through.
    const {
      ids: [targetTokenId],
      creates,
    } = this._planMorphemes([tokenId]);
    if (!targetTokenId) {
      this.setError(`Token ${tokenId} not found`);
      return false;
    }
    const targetVocabId = targetVocab.id;
    const { link: priorLink, vocabId: priorVocabId } = findPriorLink(
      this._vocabularies,
      targetTokenId,
    );
    const stamp = metadata || this.createStamp;
    const cachedType = morphTypeCache(this, creates)(targetTokenId, targetVocabId, vocabItemId);
    // A morpheme made here is made with the type; one already there takes it
    // in the link's batch.
    if (cachedType) creates.forEach((c) => (c.metadata = { ...c.metadata, morphType: cachedType }));
    const patchType = cachedType && !creates.length;
    const linkId = pendingId();
    // The shape a document read gives a link's entry: id, layer, and form.
    const itemSnapshot = { id: vocabItem.id, layer: targetVocabId, form: vocabItem.form };

    this._applyRawPatch((next, info, vocabs) => {
      this._showMorphemes(info, creates);
      if (priorLink && priorVocabId && vocabs[priorVocabId]) {
        vocabs[priorVocabId].vocabLinks = (vocabs[priorVocabId].vocabLinks || []).filter(
          (l) => l.id !== priorLink.id,
        );
      }
      const tv = vocabs[targetVocabId];
      if (tv) {
        if (!Array.isArray(tv.vocabLinks)) tv.vocabLinks = [];
        tv.vocabLinks.push({
          id: linkId,
          tokens: [targetTokenId],
          vocabItem: itemSnapshot,
          ...(stamp ? { metadata: stamp } : {}),
        });
      }
      if (patchType) {
        const m = (info.morphemeTokenLayer?.tokens || []).find((x) => x.id === targetTokenId);
        if (m) m.metadata = { ...(m.metadata || {}), morphType: cachedType };
      }
    });

    return this._queueWrite(label, async () => {
      const ids = new Map();
      const serverId = (id) => ids.get(id) || settledId(id);
      await this._sendMorphemes(creates, ids);
      const token = serverId(targetTokenId);
      if (priorLink || patchType) {
        // Indexed, not `results.at(-1)`: the cache patch rides at the end, so
        // the create is not the last op.
        const createAt = priorLink ? 1 : 0;
        const results = await this._client.batched(async (b) => {
          if (priorLink) b.vocabLinks.delete(settledId(priorLink.id));
          b.vocabLinks.create(settledId(vocabItemId), [token], stamp || undefined);
          if (patchType) {
            b.tokens.patchMetadata(token, [{ op: 'set', path: ['morphType'], value: cachedType }]);
          }
        });
        ids.set(linkId, createdId(results[createAt]));
      } else {
        const result = await this._client.vocabLinks.create(
          settledId(vocabItemId),
          [token],
          stamp || undefined,
        );
        ids.set(linkId, createdId(result));
      }
      this._settle(ids);
    });
  },

  // Link several tokens to one entry in one operation: "every other ‹roa›
  // in this text", from the popover. Only tokens with no link of their own
  // are taken, so nothing anyone linked is relinked. Never automatic: FLEx
  // does this on every link, which the first real user called mightily
  // annoying, so it is a row you choose.
  async linkVocabMany(tokenIds, vocabItemId) {
    const { vocab: targetVocab, item: vocabItem } = findVocabForItem(
      this._vocabularies,
      vocabItemId,
    );
    if (!targetVocab || !vocabItem) {
      this.setError(`Vocab item ${vocabItemId} not found`);
      return false;
    }
    const label = 'Failed to link entries';
    if (!this._canWrite(label)) return false;
    const plan = this._planLinkMany(tokenIds, targetVocab, vocabItem);
    if (!plan.links.length) return false;
    this._applyRawPatch((next, info, vocabs) => this._showLinkMany(info, vocabs, plan));
    return this._queueWrite(label, async () => {
      const ids = new Map();
      await this._sendMorphemes(plan.creates, ids);
      await this._sendLinkMany(plan, ids);
      this._settle(ids);
    });
  },

  // Linking several tokens to one entry, in three parts so a
  // create-and-link-all can run it inside its own edit: the plan (only tokens
  // with no link of their own are taken, and unanalyzed words' morphemes are
  // planned under pending ids), the patch, and the send. `excluding` names
  // tokens the caller links itself.
  _planLinkMany(tokenIds, targetVocab, vocabItem, { excluding = [] } = {}) {
    const { ids, creates } = this._planMorphemes([...new Set(tokenIds)]);
    const skip = new Set(excluding);
    const targets = [...new Set(ids.filter(Boolean))].filter(
      (id) => !skip.has(id) && !findPriorLink(this._vocabularies, id).link,
    );
    const used = new Set(targets);
    const planned = creates.filter((c) => used.has(c.id));
    // One entry, so one resolved type, but each token answers for its own
    // cache: a word in the set takes none, and a morpheme that already agrees
    // is left alone. A morpheme made here is made with it.
    const typeFor = morphTypeCache(this, planned);
    const typed = targets.filter((id) => typeFor(id, targetVocab.id, vocabItem.id));
    const cachedType = typed.length ? typeFor(typed[0], targetVocab.id, vocabItem.id) : null;
    const made = new Set(planned.map((c) => c.id));
    if (cachedType) {
      planned.forEach((c) => (c.metadata = { ...c.metadata, morphType: cachedType }));
    }
    return {
      creates: planned,
      links: targets.map((token) => ({ id: pendingId(), token })),
      cacheIds: cachedType ? typed.filter((id) => !made.has(id)) : [],
      cachedType,
      vocabId: targetVocab.id,
      item: vocabItem,
      stamp: this.createStamp || undefined,
    };
  },

  _showLinkMany(info, vocabs, plan) {
    this._showMorphemes(info, plan.creates);
    const itemSnapshot = { id: plan.item.id, layer: plan.vocabId, form: plan.item.form };
    const tv = vocabs[plan.vocabId];
    if (tv) {
      if (!Array.isArray(tv.vocabLinks)) tv.vocabLinks = [];
      plan.links.forEach((l) =>
        tv.vocabLinks.push({
          id: l.id,
          tokens: [l.token],
          vocabItem: itemSnapshot,
          ...(plan.stamp ? { metadata: plan.stamp } : {}),
        }),
      );
    }
    if (plan.cacheIds.length) {
      const cached = new Set(plan.cacheIds);
      (info.morphemeTokenLayer?.tokens || []).forEach((m) => {
        if (cached.has(m.id)) m.metadata = { ...(m.metadata || {}), morphType: plan.cachedType };
      });
    }
  },

  // One bulk create for the links and one bulk update for the caches: two ops
  // however many tokens were selected. The create goes FIRST so its ids are
  // always results[0], and they come back in the order they were sent.
  async _sendLinkMany(plan, ids) {
    if (!plan.links.length) return;
    const serverId = (id) => ids.get(id) || settledId(id);
    const itemId = serverId(plan.item.id);
    const results = await this._client.batched(async (b) => {
      b.vocabLinks.bulkCreate(
        plan.links.map((l) => ({
          vocabItem: itemId,
          tokens: [serverId(l.token)],
          ...(plan.stamp ? { metadata: plan.stamp } : {}),
        })),
      );
      if (plan.cacheIds.length) {
        b.tokens.bulkUpdate(
          plan.cacheIds.map((id) => ({
            id: serverId(id),
            metadata: [{ op: 'set', path: ['morphType'], value: plan.cachedType }],
          })),
        );
      }
    });
    const newIds = createdIds(results[0]);
    plan.links.forEach((l, i) => ids.set(l.id, newIds[i]));
  },

  // Remove the single-token vocab link for `tokenId`, if any.
  async unlinkVocab(tokenId) {
    const { link: priorLink, vocabId: priorVocabId } = findPriorLink(this._vocabularies, tokenId);
    if (!priorLink || !priorVocabId) return false;
    const label = 'Failed to unlink the entry';
    if (!this._canWrite(label)) return false;
    this._applyRawPatch((next, info, vocabs) => {
      if (vocabs[priorVocabId]) {
        vocabs[priorVocabId].vocabLinks = (vocabs[priorVocabId].vocabLinks || []).filter(
          (l) => l.id !== priorLink.id,
        );
      }
    });
    return this._queueWrite(label, () => this._client.vocabLinks.delete(settledId(priorLink.id)));
  },

  // Create a brand-new vocab item in `vocabId` and link it to `tokenId`,
  // replacing any prior link for that token. The item is created OUTSIDE the
  // batch so the batched delete+create can reference its id.
  // Set (or clear, null) a lexicon entry's morph type — the source of truth
  // for every morpheme linked to it (derive.js reads the entry's type over the
  // token's cached metadata.morphType). The entry patch and a cache patch on
  // each morpheme of THIS document linked to the entry go in one batch, so the
  // grid is right immediately rather than on the next reconcile-on-open.
  async setVocabItemMorphType(vocabId, itemId, morphType) {
    if (!isValidMorphType(morphType)) {
      this.setError(`Unknown morpheme type "${morphType}"`);
      return false;
    }
    const vocab = this._vocabularies[vocabId];
    if (!vocab) {
      this.setError(`Vocabulary ${vocabId} not found`);
      return false;
    }
    const label = 'Failed to set entry type';
    if (!this._canWrite(label)) return false;
    const morphemeIds = new Set((this.layerInfo.morphemeTokenLayer?.tokens || []).map((m) => m.id));
    const linkedMorphemes = (vocab.vocabLinks || [])
      .filter((l) => l.vocabItem?.id === itemId && Array.isArray(l.tokens) && l.tokens.length === 1)
      .map((l) => l.tokens[0])
      .filter((id) => morphemeIds.has(id));
    const setType = (meta) => {
      const next = { ...(meta || {}) };
      if (morphType == null) delete next.morphType;
      else next.morphType = morphType;
      return next;
    };
    this._applyRawPatch((next, info, vocabs) => {
      const v = vocabs[vocabId];
      if (!v) return;
      (v.items || []).forEach((it) => {
        if (it.id === itemId) it.metadata = setType(it.metadata);
      });
      if (morphType != null) {
        const linked = new Set(linkedMorphemes);
        (info.morphemeTokenLayer?.tokens || []).forEach((m) => {
          if (linked.has(m.id)) m.metadata = { ...(m.metadata || {}), morphType };
        });
      }
    });
    return this._queueWrite(label, () =>
      this._client.batched(async (b) => {
        b.vocabItems.patchMetadata(settledId(itemId), [
          morphType == null
            ? { op: 'delete', path: ['morphType'] }
            : { op: 'set', path: ['morphType'], value: morphType },
        ]);
        // A cleared entry type stops overriding; the cache keeps its last value.
        if (morphType != null) {
          linkedMorphemes.forEach((id) =>
            b.tokens.patchMetadata(settledId(id), [
              { op: 'set', path: ['morphType'], value: morphType },
            ]),
          );
        }
      }),
    );
  },

  // ---- multi-word expressions (MWEs) -------------------------------------------
  // An MWE is one link over two or more WORD tokens (see
  // domain/mwe.js). These never touch a word's own single-token link:
  // a word keeps its entry and can sit inside any number of MWEs.

  // The member word tokens in text order, or null (with the error set) when
  // the selection is not two or more distinct words of this document.
  _mweMembers(tokenIds) {
    const ids = [...new Set(tokenIds || [])];
    const words = this.layerInfo.primaryTokenLayer?.tokens || [];
    const byId = new Map(words.map((w) => [w.id, w]));
    const members = ids.map((id) => byId.get(id)).filter(Boolean);
    if (members.length < 2 || members.length !== ids.length) {
      this.setError('A multi-word expression needs two or more words');
      return null;
    }
    return members.sort((a, b) => a.begin - b.begin).map((w) => w.id);
  },

  // Link an entry to several words at once. `metadata` carries provenance for
  // machine-made links; a human link from the popover passes none and
  // carries the writer's create stamp.
  async linkMwe(tokenIds, vocabItemId, metadata = null) {
    const { vocab, item } = findVocabForItem(this._vocabularies, vocabItemId);
    if (!vocab || !item) {
      this.setError(`Vocab item ${vocabItemId} not found`);
      return false;
    }
    const tokens = this._mweMembers(tokenIds);
    if (!tokens) return false;
    const label = 'Failed to link multi-word expression';
    if (!this._canWrite(label)) return false;
    const vocabId = vocab.id;
    const itemSnapshot = { id: item.id, form: item.form, metadata: item.metadata || {} };
    const stamp = metadata || this.createStamp;
    const linkId = pendingId();
    this._applyRawPatch((next, info, vocabs) => {
      const tv = vocabs[vocabId];
      if (!tv) return;
      if (!Array.isArray(tv.vocabLinks)) tv.vocabLinks = [];
      tv.vocabLinks.push({
        id: linkId,
        tokens,
        vocabItem: itemSnapshot,
        ...(stamp ? { metadata: stamp } : {}),
      });
    });
    return this._queueWrite(label, async () => {
      const result = await this._client.vocabLinks.create(
        settledId(vocabItemId),
        tokens.map(settledId),
        stamp || undefined,
      );
      this._settle(new Map([[linkId, createdId(result)]]));
    });
  },

  // Create a new entry (its morph type in `metadata`, phrase or discontiguous
  // phrase) and link it to the words. The item is created outside the link
  // call so the link can reference its id. `replaceLinkId` names an existing
  // MWE link over these words to retire in the same batch (the popover's
  // "+ Create" on an already-linked expression).
  async createAndLinkMwe(tokenIds, vocabId, form, metadata = {}, replaceLinkId = null) {
    if (!this._vocabularies[vocabId]) {
      this.setError(`Vocabulary ${vocabId} not found`);
      return false;
    }
    const tokens = this._mweMembers(tokenIds);
    if (!tokens) return false;
    const label = 'Failed to create and link multi-word expression';
    if (!this._canWrite(label)) return false;
    const metadataArg = Object.keys(metadata || {}).length > 0 ? metadata : undefined;
    const stamp = this.createStamp || undefined;
    const newItem = { id: pendingId(), form, metadata: metadata || {} };
    const linkId = pendingId();
    this._applyRawPatch((next, info, vocabs) => {
      if (replaceLinkId) {
        Object.values(vocabs).forEach((v) => {
          if (Array.isArray(v.vocabLinks))
            v.vocabLinks = v.vocabLinks.filter((l) => l.id !== replaceLinkId);
        });
      }
      const tv = vocabs[vocabId];
      if (!tv) return;
      if (!Array.isArray(tv.items)) tv.items = [];
      tv.items.push({ ...newItem });
      if (!Array.isArray(tv.vocabLinks)) tv.vocabLinks = [];
      tv.vocabLinks.push({
        id: linkId,
        tokens,
        vocabItem: { ...newItem },
        ...(stamp ? { metadata: stamp } : {}),
      });
    });
    return this._queueWrite(label, async () => {
      const ids = new Map();
      const createResult = await this._client.vocabItems.create(vocabId, form, metadataArg);
      const itemId = createdId(createResult);
      ids.set(newItem.id, itemId);
      const members = tokens.map(settledId);
      if (replaceLinkId) {
        const results = await this._client.batched(async (b) => {
          b.vocabLinks.delete(settledId(replaceLinkId));
          b.vocabLinks.create(itemId, members, stamp);
        });
        ids.set(linkId, createdId(results[results.length - 1]));
      } else {
        const linkResult = await this._client.vocabLinks.create(itemId, members, stamp);
        ids.set(linkId, createdId(linkResult));
      }
      this._settle(ids);
    });
  },

  // Point an existing MWE at a different entry: the same words, a new
  // link (delete + create in one atomic batch). A human choice, so the
  // machine provenance of the old link does not carry over; the new link
  // carries the writer's create stamp.
  async relinkMwe(linkId, vocabItemId) {
    const { link: prior, vocabId: priorVocabId } = findLinkById(this._vocabularies, linkId);
    if (!prior) return false;
    const { vocab, item } = findVocabForItem(this._vocabularies, vocabItemId);
    if (!vocab || !item) {
      this.setError(`Vocab item ${vocabItemId} not found`);
      return false;
    }
    const label = 'Failed to change multi-word expression';
    if (!this._canWrite(label)) return false;
    const tokens = [...prior.tokens];
    const vocabId = vocab.id;
    const itemSnapshot = { id: item.id, form: item.form, metadata: item.metadata || {} };
    const stamp = this.createStamp || undefined;
    const newLinkId = pendingId();
    this._applyRawPatch((next, info, vocabs) => {
      if (vocabs[priorVocabId]) {
        vocabs[priorVocabId].vocabLinks = (vocabs[priorVocabId].vocabLinks || []).filter(
          (l) => l.id !== prior.id,
        );
      }
      const tv = vocabs[vocabId];
      if (!tv) return;
      if (!Array.isArray(tv.vocabLinks)) tv.vocabLinks = [];
      tv.vocabLinks.push({
        id: newLinkId,
        tokens,
        vocabItem: itemSnapshot,
        ...(stamp ? { metadata: stamp } : {}),
      });
    });
    return this._queueWrite(label, async () => {
      const results = await this._client.batched(async (b) => {
        b.vocabLinks.delete(settledId(prior.id));
        b.vocabLinks.create(settledId(vocabItemId), tokens.map(settledId), stamp);
      });
      this._settle(new Map([[newLinkId, createdId(results[results.length - 1])]]));
    });
  },

  // Change which words an MWE covers, keeping its entry and provenance
  // (re-covering is not vouching for the link, so a verifier's change leaves
  // a proposal a proposal; a contributor's change marks it contributed, as
  // every contributor edit does). Fewer than two words left means the MWE
  // is gone.
  async setMweMembers(linkId, tokenIds) {
    const { link: prior, vocabId } = findLinkById(this._vocabularies, linkId);
    if (!prior) return false;
    const ids = [...new Set(tokenIds || [])];
    if (ids.length < 2) return this.unlinkMwe(prior.id);
    const tokens = this._mweMembers(ids);
    if (!tokens) return false;
    const label = 'Failed to change multi-word expression';
    if (!this._canWrite(label)) return false;
    const itemId = prior.vocabItem?.id;
    const merged = this.isContributor
      ? mergeMetadata(prior.metadata, this.editStamp(prior.metadata))
      : { ...(prior.metadata || {}) };
    const metadata = Object.keys(merged).length ? merged : null;
    const vocabItem = prior.vocabItem;
    const newLinkId = pendingId();
    this._applyRawPatch((next, info, vocabs) => {
      const tv = vocabs[vocabId];
      if (!tv) return;
      tv.vocabLinks = (tv.vocabLinks || []).filter((l) => l.id !== prior.id);
      tv.vocabLinks.push({
        id: newLinkId,
        tokens,
        vocabItem,
        ...(metadata ? { metadata } : {}),
      });
    });
    return this._queueWrite(label, async () => {
      const results = await this._client.batched(async (b) => {
        b.vocabLinks.delete(settledId(prior.id));
        b.vocabLinks.create(settledId(itemId), tokens.map(settledId), metadata || undefined);
      });
      this._settle(new Map([[newLinkId, createdId(results[results.length - 1])]]));
    });
  },

  async unlinkMwe(linkId) {
    const { link, vocabId } = findLinkById(this._vocabularies, linkId);
    if (!link) return false;
    const label = 'Failed to unlink multi-word expression';
    if (!this._canWrite(label)) return false;
    this._applyRawPatch((next, info, vocabs) => {
      if (vocabs[vocabId]) {
        vocabs[vocabId].vocabLinks = (vocabs[vocabId].vocabLinks || []).filter(
          (l) => l.id !== link.id,
        );
      }
    });
    return this._queueWrite(label, () => this._client.vocabLinks.delete(settledId(link.id)));
  },

  // Confirm-on-touch for a proposed MWE link (same contract as
  // confirmVocabLink). No-op when there is nothing for this writer to confirm.
  async confirmMweLink(linkId) {
    const { link, vocabId } = findLinkById(this._vocabularies, linkId);
    const confirm = link ? this.confirmStamp(link.metadata) : null;
    if (!confirm) return false;
    const label = 'Failed to confirm multi-word expression';
    if (!this._canWrite(label)) return false;
    this._applyRawPatch((next, info, vocabs) => {
      const l = (vocabs[vocabId]?.vocabLinks || []).find((x) => x.id === link.id);
      if (l) l.metadata = mergeMetadata(l.metadata, confirm);
    });
    return this._queueWrite(label, () =>
      this._client.vocabLinks.patchMetadata(settledId(link.id), metadataOps(confirm)),
    );
  },

  // Apply multi-word expression proposals from the built-in rule (or any
  // provider): `proposals` is [{ tokenIds, vocabItemId }]. Only new links are
  // written, each stamped { prov: 'inferred', provSource } for a person to
  // confirm; a run that already carries an MWE over exactly those words is
  // skipped. One bulk create, then one reload. Returns the number of links
  // written (false on failure).
  async bulkLinkMwes(proposals, provSource) {
    const existing = new Set();
    Object.values(this._vocabularies || {}).forEach((v) =>
      (v.vocabLinks || []).forEach((l) => {
        if (Array.isArray(l.tokens) && l.tokens.length >= 2) existing.add(l.tokens.join('\u0000'));
      }),
    );
    const words = new Set((this.layerInfo.primaryTokenLayer?.tokens || []).map((w) => w.id));
    const creates = [];
    for (const p of proposals || []) {
      const { item } = findVocabForItem(this._vocabularies, p.vocabItemId);
      if (!item) continue;
      const ids = [...new Set(p.tokenIds || [])];
      if (ids.length < 2 || !ids.every((id) => words.has(id))) continue;
      const key = ids.join('\u0000');
      if (existing.has(key)) continue;
      existing.add(key);
      creates.push({ vocabItem: item.id, tokens: ids });
    }
    if (!creates.length) return 0;
    const metadata = stampInferred(provSource);
    const ok = await this._queueWrite('Failed to auto-link multi-word expressions', async () => {
      await this._client.vocabLinks.bulkCreate(creates.map((c) => ({ ...c, metadata })));
      await this._reloadInSend();
    });
    return ok ? creates.length : false;
  },

  async createAndLinkVocabItem(tokenId, vocabId, form, metadata = {}, { alsoLink = [] } = {}) {
    if (!this._vocabularies[vocabId]) {
      this.setError(`Vocabulary ${vocabId} not found`);
      return false;
    }
    const label = 'Failed to create and link the entry';
    if (!this._canWrite(label)) return false;
    // Same as linkVocab: an unanalyzed word's morpheme is made too, before
    // anything points at it.
    const {
      ids: [targetTokenId],
      creates,
    } = this._planMorphemes([tokenId]);
    if (!targetTokenId) {
      this.setError(`Token ${tokenId} not found`);
      return false;
    }
    const { link: priorLink, vocabId: priorVocabId } = findPriorLink(
      this._vocabularies,
      targetTokenId,
    );
    const metadataArg = Object.keys(metadata || {}).length > 0 ? metadata : undefined;
    const stamp = this.createStamp || undefined;
    // A brand-new entry has no headword to inherit from, so its type is
    // whatever `metadata` carried. Today's caller carries none and this is a
    // no-op, but the cache rule holds on every link path, not just the ones
    // that exercise it now.
    const newType =
      typeof metadata?.morphType === 'string' && metadata.morphType !== ''
        ? metadata.morphType
        : null;
    const isMorpheme =
      creates.length > 0 ||
      (this.layerInfo.morphemeTokenLayer?.tokens || []).some((m) => m.id === targetTokenId);
    const cachedType = isMorpheme ? newType : null;
    if (cachedType) creates.forEach((c) => (c.metadata = { ...c.metadata, morphType: cachedType }));
    const patchType = cachedType && !creates.length;
    const newItem = { id: pendingId(), form, metadata: metadata || {} };
    const linkId = pendingId();
    // "Create and link every ‹roa› in this text": the others that read the
    // same and have no link, in the same operation as the create.
    const others = this._planLinkMany(
      alsoLink.filter((id) => id !== tokenId),
      { id: vocabId },
      newItem,
      { excluding: [targetTokenId] },
    );

    this._applyRawPatch((next, info, vocabs) => {
      this._showMorphemes(info, creates);
      if (priorLink && priorVocabId && vocabs[priorVocabId]) {
        vocabs[priorVocabId].vocabLinks = (vocabs[priorVocabId].vocabLinks || []).filter(
          (l) => l.id !== priorLink.id,
        );
      }
      const tv = vocabs[vocabId];
      if (tv) {
        if (!Array.isArray(tv.items)) tv.items = [];
        tv.items.push({ ...newItem });
        if (!Array.isArray(tv.vocabLinks)) tv.vocabLinks = [];
        tv.vocabLinks.push({
          id: linkId,
          tokens: [targetTokenId],
          vocabItem: { id: newItem.id, form: newItem.form, metadata: newItem.metadata },
          ...(stamp ? { metadata: stamp } : {}),
        });
      }
      if (patchType) {
        const m = (info.morphemeTokenLayer?.tokens || []).find((x) => x.id === targetTokenId);
        if (m) m.metadata = { ...(m.metadata || {}), morphType: cachedType };
      }
      this._showLinkMany(info, vocabs, others);
    });

    return this._queueWrite(label, async () => {
      const ids = new Map();
      const serverId = (id) => ids.get(id) || settledId(id);
      await this._sendMorphemes([...creates, ...others.creates], ids);
      const createResult = await this._client.vocabItems.create(vocabId, form, metadataArg);
      const newItemId = createdId(createResult);
      ids.set(newItem.id, newItemId);
      // An entry is made before anything can point at it, so a failure in the
      // writes below used to leave it behind: the person tried again and the
      // lexicon grew a homonym. Nothing else can have reached it yet, so it is
      // taken back out on the way past.
      try {
        const token = serverId(targetTokenId);
        if (priorLink || patchType) {
          const createAt = priorLink ? 1 : 0;
          const results = await this._client.batched(async (b) => {
            if (priorLink) b.vocabLinks.delete(settledId(priorLink.id));
            b.vocabLinks.create(newItemId, [token], stamp);
            if (patchType) {
              b.tokens.patchMetadata(token, [
                { op: 'set', path: ['morphType'], value: cachedType },
              ]);
            }
          });
          ids.set(linkId, createdId(results[createAt]));
        } else {
          const linkResult = await this._client.vocabLinks.create(newItemId, [token], stamp);
          ids.set(linkId, createdId(linkResult));
        }
        await this._sendLinkMany(others, ids);
      } catch (err) {
        try {
          await this._client.vocabItems.delete(newItemId);
        } catch (e) {
          console.error('Could not remove the entry a failed link left behind:', e);
        }
        throw err;
      }
      this._settle(ids);
    });
  },
};
