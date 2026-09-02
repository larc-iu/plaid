// Mutation mixin: vocabulary-link operations. See IgtDocument.js for the
// `this` API (_withSaving, _applyRawPatch, _reload, layerInfo, etc.).
//
// Vocab links live on the vocab layer (not the document), so optimistic
// patches mutate the third arg of `_applyRawPatch` (a shallow clone of
// `_vocabularies`). A token id here may be a word OR morpheme token; the
// link/create operation is identical either way.

import { stampInferred, isMachine, PROV_CONFIRMED } from '@larc-iu/plaid-client';
import { isValidMorphType } from '../affixMarkers.js';

// Link replacements emit 2 ops apiece (delete + create); 400 per batch keeps
// each atomic batch comfortably under plaid-core's 1000-op cap.
const REPLACE_CHUNK = 400;

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
    const creates = []; // { tokenId, item }
    const replaces = []; // { tokenId, item, priorLinkId }
    for (const p of proposals || []) {
      const { item } = findVocabForItem(this._vocabularies, p.vocabItemId);
      if (!item) continue;
      const { link } = findPriorLink(this._vocabularies, p.tokenId);
      if (!link) {
        creates.push({ tokenId: p.tokenId, item });
        continue;
      }
      // Replace only machine-unverified links, and only when the item changes.
      if (!isMachine(link.metadata)) continue;
      if (link.vocabItem?.id === item.id) continue;
      replaces.push({ tokenId: p.tokenId, item, priorLinkId: link.id });
    }
    if (!creates.length && !replaces.length) return 0;
    const metadata = stampInferred(provSource);

    const ok = await this._withSaving('Failed to auto-link', async () => {
      if (creates.length) {
        // The dedicated endpoint has no per-batch op cap, so even a document
        // with thousands of unlinked tokens links in a single tx.
        await this._client.vocabLinks.bulkCreate(
          creates.map((c) => ({ vocabItem: c.item.id, tokens: [c.tokenId], metadata })),
        );
      }
      // Replacements (2 ops each: delete stale link + create new) packed into
      // atomic batches under the server's 1000-op cap.
      for (let i = 0; i < replaces.length; i += REPLACE_CHUNK) {
        const chunk = replaces.slice(i, i + REPLACE_CHUNK);
        await this._client.batched(async () => {
          for (const r of chunk) {
            this._client.vocabLinks.delete(r.priorLinkId);
            this._client.vocabLinks.create(r.item.id, [r.tokenId], metadata);
          }
        });
      }
      await this._reload();
    });
    return ok ? creates.length + replaces.length : false;
  },

  // Confirm-on-touch for an inferred link: flip provConfirmed so it renders
  // (and queries) as human-approved. No-op for human or already-confirmed links.
  async confirmVocabLink(tokenId) {
    const { link, vocabId } = findPriorLink(this._vocabularies, tokenId);
    if (!link || !vocabId) return false;
    if (!isMachine(link.metadata)) return false;

    return this._withSaving('Failed to confirm link', async () => {
      await this._client.vocabLinks.patchMetadata(link.id, PROV_CONFIRMED);
      this._applyRawPatch((next, info, vocabs) => {
        const l = (vocabs[vocabId]?.vocabLinks || []).find((x) => x.id === link.id);
        if (l) l.metadata = { ...(l.metadata || {}), ...PROV_CONFIRMED };
      });
    });
  },

  // Link a vocab item to a token (word or morpheme). If a prior single-token
  // link exists for this token, delete it and create the new link atomically.
  // `metadata` (optional) carries provenance for machine-produced links (see
  // the shared provenance helpers); human links from the popover pass none.
  async linkVocab(tokenId, vocabItemId, metadata = null) {
    const { vocab: targetVocab, item: vocabItem } = findVocabForItem(
      this._vocabularies,
      vocabItemId,
    );
    if (!targetVocab || !vocabItem) {
      this.setError(`Vocab item ${vocabItemId} not found`);
      return false;
    }
    const targetVocabId = targetVocab.id;
    const { link: priorLink, vocabId: priorVocabId } = findPriorLink(this._vocabularies, tokenId);

    return this._withSaving('Failed to link vocab item', async () => {
      let newLinkId;
      if (priorLink) {
        const results = await this._client.batched(async () => {
          this._client.vocabLinks.delete(priorLink.id);
          this._client.vocabLinks.create(vocabItemId, [tokenId], metadata || undefined);
        });
        newLinkId = results[results.length - 1]?.body?.id;
      } else {
        const result = await this._client.vocabLinks.create(
          vocabItemId,
          [tokenId],
          metadata || undefined,
        );
        newLinkId = result?.id || result;
      }

      const itemSnapshot = {
        id: vocabItem.id,
        form: vocabItem.form,
        metadata: vocabItem.metadata || {},
      };

      this._applyRawPatch((next, info, vocabs) => {
        if (priorLink && priorVocabId && vocabs[priorVocabId]) {
          vocabs[priorVocabId].vocabLinks = (vocabs[priorVocabId].vocabLinks || []).filter(
            (l) => l.id !== priorLink.id,
          );
        }
        const tv = vocabs[targetVocabId];
        if (tv) {
          if (!Array.isArray(tv.vocabLinks)) tv.vocabLinks = [];
          tv.vocabLinks.push({
            id: newLinkId,
            tokens: [tokenId],
            vocabItem: itemSnapshot,
            ...(metadata ? { metadata } : {}),
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
          vocabs[priorVocabId].vocabLinks = (vocabs[priorVocabId].vocabLinks || []).filter(
            (l) => l.id !== priorLink.id,
          );
        }
      });
    });
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
    const morphemeIds = new Set((this.layerInfo.morphemeTokenLayer?.tokens || []).map((m) => m.id));
    const linkedMorphemes = (vocab.vocabLinks || [])
      .filter((l) => l.vocabItem?.id === itemId && Array.isArray(l.tokens) && l.tokens.length === 1)
      .map((l) => l.tokens[0])
      .filter((id) => morphemeIds.has(id));

    return this._withSaving('Failed to set entry type', async () => {
      await this._client.batched(async () => {
        this._client.vocabItems.patchMetadata(itemId, { morphType: morphType ?? null });
        // A cleared entry type stops overriding; the cache keeps its last value.
        if (morphType != null) {
          linkedMorphemes.forEach((id) => this._client.tokens.patchMetadata(id, { morphType }));
        }
      });
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
        (v.vocabLinks || []).forEach((l) => {
          if (l.vocabItem?.id === itemId) l.vocabItem.metadata = setType(l.vocabItem.metadata);
        });
        if (morphType != null) {
          const linked = new Set(linkedMorphemes);
          (info.morphemeTokenLayer?.tokens || []).forEach((m) => {
            if (linked.has(m.id)) m.metadata = { ...(m.metadata || {}), morphType };
          });
        }
      });
    });
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
  // machine-made links; a human link from the popover passes none.
  async linkMwe(tokenIds, vocabItemId, metadata = null) {
    const { vocab, item } = findVocabForItem(this._vocabularies, vocabItemId);
    if (!vocab || !item) {
      this.setError(`Vocab item ${vocabItemId} not found`);
      return false;
    }
    const tokens = this._mweMembers(tokenIds);
    if (!tokens) return false;
    const vocabId = vocab.id;
    const itemSnapshot = { id: item.id, form: item.form, metadata: item.metadata || {} };
    return this._withSaving('Failed to link multi-word expression', async () => {
      const result = await this._client.vocabLinks.create(
        vocabItemId,
        tokens,
        metadata || undefined,
      );
      const newLinkId = result?.id || result;
      this._applyRawPatch((next, info, vocabs) => {
        const tv = vocabs[vocabId];
        if (!tv) return;
        if (!Array.isArray(tv.vocabLinks)) tv.vocabLinks = [];
        tv.vocabLinks.push({
          id: newLinkId,
          tokens,
          vocabItem: itemSnapshot,
          ...(metadata ? { metadata } : {}),
        });
      });
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
    const metadataArg = Object.keys(metadata || {}).length > 0 ? metadata : undefined;
    return this._withSaving('Failed to create and link multi-word expression', async () => {
      const createResult = await this._client.vocabItems.create(vocabId, form, metadataArg);
      const newItemId = createResult?.id || createResult;
      let newLinkId;
      if (replaceLinkId) {
        const results = await this._client.batched(async () => {
          this._client.vocabLinks.delete(replaceLinkId);
          this._client.vocabLinks.create(newItemId, tokens);
        });
        newLinkId = results[results.length - 1]?.body?.id;
      } else {
        const linkResult = await this._client.vocabLinks.create(newItemId, tokens);
        newLinkId = linkResult?.id || linkResult;
      }
      const newItem = { id: newItemId, form, metadata: metadata || {} };
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
        tv.items.push(newItem);
        if (!Array.isArray(tv.vocabLinks)) tv.vocabLinks = [];
        tv.vocabLinks.push({ id: newLinkId, tokens, vocabItem: { ...newItem } });
      });
    });
  },

  // Point an existing MWE at a different entry: the same words, a new
  // link (delete + create in one atomic batch). A human choice, so the
  // machine provenance of the old link does not carry over.
  async relinkMwe(linkId, vocabItemId) {
    const { link: prior, vocabId: priorVocabId } = findLinkById(this._vocabularies, linkId);
    if (!prior) return false;
    const { vocab, item } = findVocabForItem(this._vocabularies, vocabItemId);
    if (!vocab || !item) {
      this.setError(`Vocab item ${vocabItemId} not found`);
      return false;
    }
    const tokens = [...prior.tokens];
    const vocabId = vocab.id;
    const itemSnapshot = { id: item.id, form: item.form, metadata: item.metadata || {} };
    return this._withSaving('Failed to change multi-word expression', async () => {
      const results = await this._client.batched(async () => {
        this._client.vocabLinks.delete(linkId);
        this._client.vocabLinks.create(vocabItemId, tokens);
      });
      const newLinkId = results[results.length - 1]?.body?.id;
      this._applyRawPatch((next, info, vocabs) => {
        if (vocabs[priorVocabId]) {
          vocabs[priorVocabId].vocabLinks = (vocabs[priorVocabId].vocabLinks || []).filter(
            (l) => l.id !== linkId,
          );
        }
        const tv = vocabs[vocabId];
        if (!tv) return;
        if (!Array.isArray(tv.vocabLinks)) tv.vocabLinks = [];
        tv.vocabLinks.push({ id: newLinkId, tokens, vocabItem: itemSnapshot });
      });
    });
  },

  // Change which words an MWE covers, keeping its entry and
  // provenance. Fewer than two words left means the MWE is gone.
  async setMweMembers(linkId, tokenIds) {
    const { link: prior, vocabId } = findLinkById(this._vocabularies, linkId);
    if (!prior) return false;
    const ids = [...new Set(tokenIds || [])];
    if (ids.length < 2) return this.unlinkMwe(linkId);
    const tokens = this._mweMembers(ids);
    if (!tokens) return false;
    const itemId = prior.vocabItem?.id;
    const metadata = prior.metadata && Object.keys(prior.metadata).length ? prior.metadata : null;
    const vocabItem = prior.vocabItem;
    return this._withSaving('Failed to change multi-word expression', async () => {
      const results = await this._client.batched(async () => {
        this._client.vocabLinks.delete(linkId);
        this._client.vocabLinks.create(itemId, tokens, metadata || undefined);
      });
      const newLinkId = results[results.length - 1]?.body?.id;
      this._applyRawPatch((next, info, vocabs) => {
        const tv = vocabs[vocabId];
        if (!tv) return;
        tv.vocabLinks = (tv.vocabLinks || []).filter((l) => l.id !== linkId);
        tv.vocabLinks.push({
          id: newLinkId,
          tokens,
          vocabItem,
          ...(metadata ? { metadata } : {}),
        });
      });
    });
  },

  async unlinkMwe(linkId) {
    const { link, vocabId } = findLinkById(this._vocabularies, linkId);
    if (!link) return false;
    return this._withSaving('Failed to unlink multi-word expression', async () => {
      await this._client.vocabLinks.delete(linkId);
      this._applyRawPatch((next, info, vocabs) => {
        if (vocabs[vocabId]) {
          vocabs[vocabId].vocabLinks = (vocabs[vocabId].vocabLinks || []).filter(
            (l) => l.id !== linkId,
          );
        }
      });
    });
  },

  // Confirm-on-touch for a machine-made MWE link (same contract as
  // confirmVocabLink). No-op for human or already-confirmed links.
  async confirmMweLink(linkId) {
    const { link, vocabId } = findLinkById(this._vocabularies, linkId);
    if (!link || !isMachine(link.metadata)) return false;
    return this._withSaving('Failed to confirm multi-word expression', async () => {
      await this._client.vocabLinks.patchMetadata(linkId, PROV_CONFIRMED);
      this._applyRawPatch((next, info, vocabs) => {
        const l = (vocabs[vocabId]?.vocabLinks || []).find((x) => x.id === linkId);
        if (l) l.metadata = { ...(l.metadata || {}), ...PROV_CONFIRMED };
      });
    });
  },

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
        const results = await this._client.batched(async () => {
          this._client.vocabLinks.delete(priorLink.id);
          this._client.vocabLinks.create(newItemId, [tokenId]);
        });
        newLinkId = results[results.length - 1]?.body?.id;
      } else {
        const linkResult = await this._client.vocabLinks.create(newItemId, [tokenId]);
        newLinkId = linkResult?.id || linkResult;
      }

      const newItem = {
        id: newItemId,
        form,
        metadata: metadata || {},
      };

      this._applyRawPatch((next, info, vocabs) => {
        if (priorLink && priorVocabId && vocabs[priorVocabId]) {
          vocabs[priorVocabId].vocabLinks = (vocabs[priorVocabId].vocabLinks || []).filter(
            (l) => l.id !== priorLink.id,
          );
        }
        const tv = vocabs[vocabId];
        if (tv) {
          if (!Array.isArray(tv.items)) tv.items = [];
          tv.items.push(newItem);
          if (!Array.isArray(tv.vocabLinks)) tv.vocabLinks = [];
          tv.vocabLinks.push({
            id: newLinkId,
            tokens: [tokenId],
            vocabItem: { id: newItem.id, form: newItem.form, metadata: newItem.metadata },
          });
        }
      });
    });
  },
};
