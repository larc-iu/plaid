// Whether an edit to the lexicon links, refused because the document changed
// elsewhere (409), can go again by itself on the document as read after the
// refusal (DocumentModel `_besideUntouched`). A link is kept beside the
// document (IgtDocument `_vocabularies`), so the rule by layer or entity
// (plaid-ui rebase.js) does not read it. This is the same rule for links:
// the edit goes again when what it changes is as it was when the edit was
// made, and a real conflict is refused with what changed.
//
// What an edit to the links changes (`linkFootprint`), from the
// vocabularies before its patch and after it:
// - the links it changes or removes, which must be there still, unchanged,
// - the place each link it makes, changes or removes sits in (one token, or
//   the words of a multi-word expression), where no other link may have been
//   made, changed or removed since,
// - the tokens a link it makes names, which must still be in the document,
// - the entries a link it makes names, which must still be in the lexicon,
// - the entries it changes (an entry's type), which must be unchanged.
// An edit that removes an entry or changes a vocabulary's own settings is
// never judged (null): it goes again only by hand.
//
// Ids are compared as the server's (`settledId`), and a link or entry still
// under a pending id is this page's own, not a change made elsewhere.

import { isPendingId, settledId } from '@ui/domain/pendingIds.js';

// A value as text that does not depend on key order, a null field the same
// as none.
const canonical = (value) =>
  JSON.stringify(value, (key, v) => {
    if (v === null || typeof v !== 'object' || Array.isArray(v)) return v;
    const out = {};
    for (const k of Object.keys(v).sort()) if (v[k] != null) out[k] = v[k];
    return out;
  });

const tokensOf = (link) => (Array.isArray(link?.tokens) ? link.tokens.map(settledId) : []);
const itemOf = (link) => {
  const item = link?.vocabItem;
  return settledId(typeof item === 'string' ? item : (item?.id ?? null));
};

// What a link is, for telling whether someone changed it: its tokens, its
// entry and its metadata. The entry's own fields (form, gloss) are the
// entry's, which a link read and a link shown carry differently.
const linkContent = (link) =>
  canonical({ tokens: tokensOf(link), item: itemOf(link), metadata: link?.metadata ?? {} });

// The place a link sits in: one token, or the words of a multi-word
// expression (another link over the same words clashes, one over other
// words that share one does not: a word sits in any number of them).
const placeOf = (link) => {
  const tokens = tokensOf(link);
  return tokens.length === 1 ? `1:${tokens[0]}` : `n:${[...tokens].sort().join(',')}`;
};

// Every link by its server id: `{ link, vocabId }`.
const linksOf = (vocabularies) => {
  const out = new Map();
  for (const vocab of Object.values(vocabularies || {})) {
    for (const link of vocab?.vocabLinks || []) {
      if (link?.id != null) out.set(settledId(link.id), { link, vocabId: vocab.id });
    }
  }
  return out;
};

// Every entry by its server id.
const itemsOf = (vocabularies) => {
  const out = new Map();
  for (const vocab of Object.values(vocabularies || {})) {
    for (const item of Array.isArray(vocab?.items) ? vocab.items : []) {
      if (item?.id != null) out.set(settledId(item.id), item);
    }
  }
  return out;
};

const settingsOf = (vocab) => {
  const { items, vocabLinks, ...rest } = vocab || {};
  void items;
  void vocabLinks;
  return canonical(rest);
};

/**
 * What an edit changed in the vocabularies, from `before` its patch and
 * `after` it: `{ links, places, tokens, items, entries }` (see above), or
 * null when it cannot be judged.
 */
export function linkFootprint(before, after) {
  const ids = new Set([...Object.keys(before || {}), ...Object.keys(after || {})]);
  for (const id of ids) {
    if (!before?.[id] || !after?.[id]) return null;
    if (settingsOf(before[id]) !== settingsOf(after[id])) return null;
  }
  const was = itemsOf(before);
  const is = itemsOf(after);
  const entries = new Set();
  for (const [id, item] of was) {
    const now = is.get(id);
    if (!now) return null;
    if (now !== item && canonical(now) !== canonical(item)) entries.add(id);
  }
  const a = linksOf(before);
  const b = linksOf(after);
  const links = new Set();
  const places = new Set();
  const tokens = new Set();
  const items = new Set();
  for (const id of new Set([...a.keys(), ...b.keys()])) {
    const old = a.get(id)?.link;
    const now = b.get(id)?.link;
    if (old && now && linkContent(old) === linkContent(now)) continue;
    if (old && !isPendingId(id)) links.add(id);
    for (const link of [old, now]) if (link) places.add(placeOf(link));
    if (now) {
      for (const t of tokensOf(now)) if (!isPendingId(t)) tokens.add(t);
      const item = itemOf(now);
      if (item && !isPendingId(item)) items.add(item);
    }
  }
  return { links, places, tokens, items, entries };
}

/**
 * Whether nothing that changed between `checked` (the vocabularies the edit
 * was last checked against) and `current` (as read now, with the edits ahead
 * of it shown) touches `footprint`, in a document whose tokens are
 * `tokenIds` (server ids). Answers `{ ok: true }`, or `{ ok: false,
 * conflict }` with what changed: `{ kind, ids, form?, unit? }`, the kinds
 * plaid-ui `linkChangedTo` words.
 */
export function linksUntouched(footprint, checked, current, tokenIds, unitOf = () => 'word') {
  if (!footprint) return { ok: false, conflict: null };
  const a = linksOf(checked);
  const b = linksOf(current);
  for (const id of footprint.links) {
    const old = a.get(id)?.link;
    const now = b.get(id)?.link;
    if (!now) {
      // Put back as another link in the same place: say what it is now.
      const instead = old
        ? [...b].find(([other, x]) => !isPendingId(other) && placeOf(x.link) === placeOf(old))
        : null;
      if (instead) {
        const [other, { link }] = instead;
        const form = typeof link.vocabItem === 'object' ? (link.vocabItem?.form ?? null) : null;
        return {
          ok: false,
          conflict: { kind: 'linked', form, ids: [id, other, ...tokensOf(link)] },
        };
      }
      return { ok: false, conflict: { kind: 'removed', ids: [id, ...tokensOf(old)] } };
    }
    if (!old || linkContent(old) !== linkContent(now)) {
      return { ok: false, conflict: { kind: 'changed', ids: [id, ...tokensOf(now)] } };
    }
  }
  // Another link in a place the edit writes, made, changed or removed since.
  const byPlace = (links) => {
    const out = new Map();
    for (const [id, { link }] of links) {
      if (isPendingId(id) || !footprint.places.has(placeOf(link))) continue;
      out.set(id, link);
    }
    return out;
  };
  const was = byPlace(a);
  const is = byPlace(b);
  for (const [id, link] of is) {
    const old = was.get(id);
    if (old && linkContent(old) === linkContent(link)) continue;
    const form = typeof link.vocabItem === 'object' ? (link.vocabItem?.form ?? null) : null;
    const kind = old ? 'changed' : 'linked';
    return { ok: false, conflict: { kind, form, ids: [id, ...tokensOf(link)] } };
  }
  for (const [id, link] of was) {
    if (!is.has(id))
      return { ok: false, conflict: { kind: 'removed', ids: [id, ...tokensOf(link)] } };
  }
  for (const t of footprint.tokens) {
    if (!tokenIds.has(t))
      return { ok: false, conflict: { kind: 'token', unit: unitOf(t), ids: [t] } };
  }
  const before = itemsOf(checked);
  const now = itemsOf(current);
  for (const id of footprint.items) {
    if (!now.has(id)) return { ok: false, conflict: { kind: 'entryGone', ids: [id] } };
  }
  for (const id of footprint.entries) {
    const item = now.get(id);
    if (!item) return { ok: false, conflict: { kind: 'entryGone', ids: [id] } };
    const old = before.get(id);
    if (!old || canonical(old) !== canonical(item)) {
      return { ok: false, conflict: { kind: 'entry', ids: [id] } };
    }
  }
  return { ok: true };
}

// Every token id in a document read (server ids), in every token layer.
export function tokenIdsOf(raw) {
  const ids = new Set();
  for (const textLayer of raw?.textLayers || []) {
    for (const tokenLayer of textLayer?.tokenLayers || []) {
      for (const token of tokenLayer?.tokens || []) if (token?.id) ids.add(settledId(token.id));
    }
  }
  return ids;
}
