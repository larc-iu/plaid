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
export const EMPTY_LEXICON = Object.freeze({ entries: Object.freeze([]), byId: new Map() });

// Every vocabulary linked to the project, with its items. One that cannot
// be read is left out, and the rest still load.
export async function loadVocabularies(client, project) {
  const ids = (project?.vocabs || []).map((v) => v.id);
  if (!ids.length) return EMPTY_LEXICON;
  const got = await Promise.all(
    ids.map((id) =>
      client.vocabLayers.get(id, true).catch((err) => {
        console.warn(`Could not read vocabulary ${id}:`, err);
        return null;
      }),
    ),
  );
  return buildLexicon(got.filter(Boolean));
}

// The headword an item belongs to: its own form for an entry, the form at
// the top of its parent chain for a sense. A chain that loops or dangles
// stops at the item itself.
const headwordOf = (item, byId) => {
  let cur = item;
  const seen = new Set();
  while (cur && !seen.has(cur.id)) {
    seen.add(cur.id);
    const parent = cur.metadata?.parent;
    const up = parent ? byId.get(parent) : null;
    if (!up) return cur.form ?? '';
    cur = up;
  }
  return item.form ?? '';
};

/**
 * The lexicon over vocabularies as `vocabLayers.get(id, true)` returns them.
 * @returns {{ entries: Array<object>, byId: Map<string, object> }}
 */
export function buildLexicon(vocabularies) {
  const entries = [];
  const byId = new Map();
  (vocabularies || []).forEach((vocab) => {
    const items = vocab?.items || [];
    const itemsById = new Map(items.map((it) => [it.id, it]));
    items.forEach((it) => {
      const umr = it.metadata?.umr || {};
      const gloss = it.metadata?.gloss;
      const entry = {
        id: it.id,
        vocabulary: vocab.name || '',
        form: it.form ?? '',
        headword: headwordOf(it, itemsById),
        sense: Boolean(it.metadata?.parent && itemsById.has(it.metadata.parent)),
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
  return { entries, byId };
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
 */
export function argsOfEntry(lexicon, concept) {
  if (!concept) return [];
  const entry = (lexicon?.entries || []).find((e) => e.args && e.concept === concept);
  return entry ? argsOf({ [concept]: entry.args }, concept) : [];
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
