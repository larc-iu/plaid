// The project's vocabularies as a lexicon for the concept picker, beside the
// bundled frame files (lexicon.js). A vocabulary is IGT's: entries with a
// form, senses under a headword, a gloss, and links from the word and
// morpheme tokens of a document to the entries they are analyzed as.
//
// What an entry offers as a concept is its headword's form, as the
// guidelines' stage 0 has it ("use the lemma as is"), unless the entry says
// otherwise: `metadata.umr.roleset` names the roleset it stands for and
// `metadata.umr.args` describes the roleset's arguments the way a frame file
// does (`{ARG0: 'leaver'}`), so a project can keep its own rolesets in the
// vocabulary it already maintains.
//
// A word's link says which entry the annotator chose for it, so that entry
// is offered first. The rest of the lexicon is reachable by typing.

import { argsOf, argSummary } from './lexicon.js';
import { entryMorphType } from '../../../plaid-ui/src/domain/morphemes.js';

const uniqBy = (list, key) => {
  const seen = new Set();
  return list.filter((x) => {
    if (!x) return false;
    const k = key(x);
    if (seen.has(k)) return false;
    seen.add(k);
    return true;
  });
};

/** The empty lexicon, for a project with no vocabulary. */
export const EMPTY_LEXICON = Object.freeze({
  entries: Object.freeze([]),
  byId: new Map(),
  entryTypes: new Map(),
});

// The entry each item is a sense of, or null, as plaid-igt's vocabulary
// reads it (vocabDictionary.js validateVocabRefs): its parent while that is
// another item of the vocabulary and the chain above it reaches an entry. An
// item whose parent is gone, or whose chain loops, is an entry of its own.
const liveParents = (items, byId) => {
  const parentIn = (item) => {
    const p = item?.metadata?.parent;
    return typeof p === 'string' && byId.has(p) ? p : null;
  };
  const out = new Map();
  items.forEach((item) => {
    const p = parentIn(item);
    const seen = new Set([item.id]);
    let cur = p;
    while (cur && !seen.has(cur)) {
      seen.add(cur);
      cur = parentIn(byId.get(cur));
    }
    out.set(item.id, p && !cur ? p : null);
  });
  return out;
};

// The headword an item belongs to: its own form for an entry, the form at
// the top of its parent chain for a sense.
const headwordOf = (item, byId, parents) => {
  let cur = item;
  while (parents.get(cur.id)) cur = byId.get(parents.get(cur.id));
  return cur.form ?? '';
};

/**
 * The lexicon over vocabularies as `vocabLayers.get(id, true)` returns them.
 * `entryTypes` is the morph type each entry goes by, its own or its
 * headword's, for the entries that go by one: the type a morpheme linked to
 * the entry is drawn with (sentenceGraph.js).
 * @returns {{ entries: Array<object>, byId: Map<string, object>, entryTypes: Map<string, string> }}
 */
export function buildLexicon(vocabularies) {
  const entries = [];
  const byId = new Map();
  const entryTypes = new Map();
  (vocabularies || []).forEach((vocab) => {
    const items = vocab?.items || [];
    const itemsById = new Map(items.map((it) => [it.id, it]));
    const parents = liveParents(items, itemsById);
    items.forEach((it) => {
      const type = entryMorphType(
        it.id,
        (id) => itemsById.get(id)?.metadata?.morphType,
        (id) => parents.get(id) ?? null,
      );
      if (type) entryTypes.set(it.id, type);
      const umr = it.metadata?.umr || {};
      const gloss = it.metadata?.gloss;
      const entry = {
        id: it.id,
        vocabulary: vocab.name || '',
        form: it.form ?? '',
        headword: headwordOf(it, itemsById, parents),
        sense: Boolean(parents.get(it.id)),
        gloss: typeof gloss === 'string' ? gloss.trim() : '',
        concept: typeof umr.roleset === 'string' && umr.roleset.trim() ? umr.roleset.trim() : null,
        args: umr.args && typeof umr.args === 'object' ? umr.args : null,
      };
      entry.concept = entry.concept || entry.headword;
      entries.push(entry);
      byId.set(entry.id, entry);
    });
  });
  entries.sort((a, b) => a.form.localeCompare(b.form) || a.id.localeCompare(b.id));
  return { entries, byId, entryTypes };
}

// The entries linked from the document's word and morpheme tokens, by
// token id. Links hang off the token layer their tokens live in, and one
// link can cover several tokens.
export function vocabLinksByToken(layerInfo) {
  const out = new Map();
  [layerInfo?.wordTokenLayer, layerInfo?.morphemeTokenLayer].forEach((layer) => {
    (layer?.vocabs || []).forEach((vocab) => {
      (vocab.vocabLinks || []).forEach((link) => {
        const item = link?.vocabItem?.id;
        if (!item) return;
        (link.tokens || []).forEach((t) => {
          if (!out.has(t)) out.set(t, []);
          out.get(t).push(item);
        });
      });
    });
  });
  return out;
}

/** The entries linked from any of `tokenIds`, each once, in link order. */
export const linkedEntries = (lexicon, links, tokenIds) =>
  uniqBy(
    (tokenIds || []).flatMap((t) => links?.get(t) || []).map((id) => lexicon.byId.get(id)),
    (e) => e.id,
  );

// The entries whose form starts with what was typed, capped: a picker asks
// on every keystroke.
export function entriesStartingWith(lexicon, prefix, limit = 40) {
  const p = String(prefix || '')
    .trim()
    .toLowerCase();
  if (!p) return [];
  const out = [];
  for (const e of lexicon.entries) {
    if (e.form.toLowerCase().startsWith(p) || e.concept.toLowerCase().startsWith(p)) {
      out.push(e);
      if (out.length >= limit) break;
    }
  }
  return out;
}

/**
 * The arguments of a concept the vocabulary describes, in the shape
 * `lexicon.js`'s `argsOf` returns for a bundled frame file, so the role
 * picker offers a project's own rolesets the way it offers the bundled ones.
 * A language being documented has no bundled frame file, and the vocabulary
 * is where its rolesets live.
 *
 * `entryId` is the entry the node was made from (`umr.entry` on the node),
 * which is the answer whenever it still stands for the node's concept: two
 * senses of one headword offer the same concept with different arguments.
 * Without one, the concept is enough only when every entry that describes it
 * agrees, and a node that could be either sense is offered neither.
 */
export function argsOfEntry(lexicon, concept, entryId = null) {
  if (!concept) return [];
  const chosen = entryId ? lexicon?.byId?.get(entryId) : null;
  if (chosen && chosen.concept === concept) {
    return chosen.args ? argsOf({ [concept]: chosen.args }, concept) : [];
  }
  const described = (lexicon?.entries || []).filter((e) => e.args && e.concept === concept);
  if (!described.length) return [];
  const key = (args) => JSON.stringify(Object.entries(args).sort(([a], [b]) => a.localeCompare(b)));
  const first = key(described[0].args);
  if (described.some((e) => key(e.args) !== first)) return [];
  return argsOf({ [concept]: described[0].args }, concept);
}

// One line for a list: the concept, the gloss, and the arguments when the
// entry describes a roleset. A sense shows its own form when it differs
// from the headword offered.
export const entryLabel = (entry) => {
  const parts = [entry.concept];
  if (entry.sense && entry.form !== entry.headword) parts.push(`(${entry.form})`);
  if (entry.gloss) parts.push(entry.gloss);
  const args = argSummary(entry.args);
  if (args) parts.push(args);
  return parts.join('  ');
};
