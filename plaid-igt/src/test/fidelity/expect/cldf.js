// The CLDF round-trip expectation: what its loss list says an import gives back,
// as edits to the snapshots (see ./index.js).
//
// CLDF stores no character offsets, so most of what changes is a rebuild. The
// text is rebuilt from the sentences, the words are placed again against the
// whitespace of each sentence, every word comes back analyzed, the sense tree
// is flattened to one level, a vocabulary's config starts over from what
// project setup gives it, and the fields bound to CLDF terms come back under
// CLDF's names. Each step below takes one of those from the list's prose.
//
// The list names a sentence or morpheme field by the CLDF term it is bound to
// (Translated_Text, Comment, Gloss). Which field that is was decided by the
// preset the round trip exports with, which drivers.mjs builds the way the
// Export presets screen does. The preset is an input to the round trip, not
// behavior under test, so `bindings` asks the preset code for it.
//
// Three entries of the list turn on server order (span.duplicate,
// span.overlapSameField and the annotation span.reachesOrphanToken leaves
// behind): a cell holds the first annotation on a token in the order the server
// lists them. The snapshot records that order on each span (`order`), and so
// does every row split off one here.

import { defaultCldfOptions } from '../../../export/cldf.js';
import {
  baselineOf,
  byBegin,
  cps,
  docs,
  igt,
  layer,
  newKey,
  removeDocuments,
  removeLayers,
  removeSpans,
  removeTokens,
  renameSpanLayer,
  scopeOfLayer,
  spanLayers,
  surface,
  tokensIn,
  wordsWithMorphemes,
} from './snap.js';
import { DEFAULT_IGNORED_TOKENS, isTokenIgnored } from '../../../domain/igtConfig.js';
import { byOrder, coveredBy } from './strips.js';

// ---- reading ---------------------------------------------------------------------

const WHITESPACE = /\s/u;
// What a whitespace run's edges are trimmed of. The catalog's word-edge
// punctuation (token.wordEdgePunctuation) counts symbols as punctuation too.
const PUNCTUATION = /[\p{P}\p{S}]/u;
const CLITIC_TYPES = new Set(['clitic', 'enclitic', 'proclitic']);
// Item metadata a sense row does not carry: the tree itself and the examples.
const NOT_IN_A_ROW = new Set(['parent', 'senseOrder', 'homograph', 'examples']);

const hasValue = (v) => v != null && v !== '' && !(Array.isArray(v) && v.length === 0);
const vocabs = (s) => s.vocabularies || [];
const sourceDoc = (ctx, d) => docs(ctx.source).find((x) => x.key === d.key) ?? null;

/** The config project setup gives a new vocabulary, read off the bare project. */
function seededVocab(ctx) {
  const seed = ctx.bare?.vocabularies?.[0]?.config?.igt;
  if (!seed) throw new Error('the CLDF expectation needs the bare project’s vocabulary');
  return seed;
}

/** The fields the round trip's preset binds to CLDF terms, by their source names. */
function bindings(source) {
  const names = (role, scopes) =>
    (source.layers || [])
      .filter((l) => l.key.startsWith(`span:${role}/`) && scopes.includes(l.config?.igt?.scope))
      .sort((a, b) => a.position - b.position)
      .map((l) => l.name);
  const o = defaultCldfOptions({
    sentFields: names('sentence', ['Sentence']),
    wordFields: names('word', ['Word', 'Token']),
    morphFields: names('morpheme', ['Morpheme']),
    orthographies: [],
  });
  return {
    translation: o.translationField,
    comment: o.commentField,
    gloss: o.glossField,
    glossScope: o.glossScope,
  };
}

/**
 * A vocabulary's sense tree, as vocabDictionary.js defines one: an item with no
 * parent is a headword, and siblings go by senseOrder, then server order.
 */
function senseTree(items) {
  const byKey = new Map(items.map((it) => [it.key, it]));
  const position = new Map(items.map((it, i) => [it.key, i]));
  const parentOf = (it) => {
    const p = it.metadata?.parent;
    return p != null && p !== it.key && byKey.has(p) ? p : null;
  };
  const children = new Map(items.map((it) => [it.key, []]));
  for (const it of items) if (parentOf(it)) children.get(parentOf(it)).push(it);
  const order = (it) => (Number.isFinite(it.metadata?.senseOrder) ? it.metadata.senseOrder : null);
  const bySense = (a, b) => {
    const ao = order(a);
    const bo = order(b);
    if (ao != null && bo != null && ao !== bo) return ao - bo;
    if (ao != null && bo == null) return -1;
    if (ao == null && bo != null) return 1;
    return position.get(a.key) - position.get(b.key);
  };
  for (const list of children.values()) list.sort(bySense);
  return { roots: items.filter((it) => !parentOf(it)), children, position };
}

/** Every sense under an item, depth first in sense order. */
const descendants = (tree, it) =>
  tree.children.get(it.key).flatMap((c) => [c, ...descendants(tree, c)]);

/**
 * The label each item goes by when written as text: its form and its dotted
 * number ("perro 1", "banco 1.2"), or the bare form when it has none. The
 * first segment is a headword's place among the headwords spelled the same, by
 * entry number and then server order, or "1" for a lone headword with senses.
 * A sense adds its path under the headword.
 */
function entryLabels(items) {
  const tree = senseTree(items);
  const homograph = (it) => {
    const v = Number(it.metadata?.homograph);
    return Number.isFinite(v) && v > 0 ? v : null;
  };
  const byNumber = (a, b) => {
    const ha = homograph(a);
    const hb = homograph(b);
    if (ha != null && hb != null && ha !== hb) return ha - hb;
    if (ha != null && hb == null) return -1;
    if (ha == null && hb != null) return 1;
    return tree.position.get(a.key) - tree.position.get(b.key);
  };
  const groups = new Map();
  for (const r of tree.roots) groups.set(r.form, [...(groups.get(r.form) || []), r]);
  const labels = new Map();
  for (const group of groups.values()) {
    group.sort(byNumber).forEach((root, i) => {
      const seg = group.length > 1 ? String(i + 1) : tree.children.get(root.key).length ? '1' : '';
      const walk = (it, path) => {
        const n = seg && path ? `${seg}.${path}` : seg || path;
        labels.set(it.key, n ? `${it.form} ${n}` : it.form);
        tree.children
          .get(it.key)
          .forEach((c, k) => walk(c, path ? `${path}.${k + 1}` : `${k + 1}`));
      };
      walk(root, '');
    });
  }
  return labels;
}

const newMorpheme = (word, precedence, form) => ({
  key: newKey('morpheme'),
  layer: 'token:morpheme',
  begin: word.begin,
  end: word.end,
  precedence,
  metadata: { form },
});

// ---- one value per token per field -----------------------------------------------

/** Replace each multi-token annotation matching `pred` with one per token. */
function splitAnnotations(s, d, pred) {
  const split = d.spans.filter((sp) => sp.tokens.length > 1 && pred(sp));
  if (!split.length) return;
  const gone = new Set(split);
  removeSpans(s, d, (sp) => gone.has(sp));
  for (const sp of split) {
    for (const token of sp.tokens) {
      d.spans.push({
        key: newKey('span'),
        order: sp.order,
        layer: sp.layer,
        tokens: [token],
        value: sp.value,
        metadata: structuredClone(sp.metadata),
      });
    }
  }
}

/**
 * Keep one single-token annotation per field on each of `tokens`, the first in
 * server order (see the header).
 */
function oneValuePerToken(s, d, tokens) {
  const groups = new Map();
  for (const sp of d.spans) {
    if (sp.tokens.length !== 1 || !tokens.has(sp.tokens[0])) continue;
    const k = `${sp.layer}|${sp.tokens[0]}`;
    groups.set(k, [...(groups.get(k) || []), sp]);
  }
  const drop = new Set();
  for (const group of groups.values()) {
    for (const sp of [...group].sort(byOrder).slice(1)) drop.add(sp);
  }
  removeSpans(s, d, (sp) => drop.has(sp));
}

// ---- the text rebuild ------------------------------------------------------------

/**
 * Where each word of one sentence comes back, as [begin, end) in the source
 * text: over its whitespace run less the edge punctuation it did not cover
 * when it is alone in that run, over its own characters when it shares it.
 */
function placeWords(body, a, b, words) {
  const runs = [];
  for (let i = a; i < b; ) {
    if (WHITESPACE.test(body[i])) {
      i++;
      continue;
    }
    let j = i;
    while (j < b && !WHITESPACE.test(body[j])) j++;
    runs.push([i, j]);
    i = j;
  }
  const placed = new Map();
  for (const [r0, r1] of runs) {
    const inRun = words.filter((w) => r0 <= w.begin && w.begin < r1);
    if (inRun.length !== 1) {
      for (const w of inRun) placed.set(w, [w.begin, w.end]);
      continue;
    }
    const [w] = inRun;
    let begin = r0;
    while (begin < w.begin && PUNCTUATION.test(body[begin])) begin++;
    let end = r1;
    while (end > w.end && PUNCTUATION.test(body[end - 1])) end--;
    placed.set(w, [begin, end]);
  }
  for (const w of words) if (!placed.has(w)) placed.set(w, [w.begin, w.end]);
  return placed;
}

function rebuildText(s, d) {
  const text = baselineOf(d);
  if (!text) return;
  const body = cps(text.body);
  const trimmed = tokensIn(d, 'sentence')
    .sort(byBegin)
    .map((sn) => {
      let a = sn.begin;
      let b = sn.end;
      while (a < b && WHITESPACE.test(body[a])) a++;
      while (b > a && WHITESPACE.test(body[b - 1])) b--;
      return { sn, a, b };
    });
  const blank = new Set(trimmed.filter((t) => t.a === t.b).map((t) => t.sn));
  removeTokens(s, d, (t) => blank.has(t));
  const kept = trimmed.filter((t) => t.a < t.b);

  const words = tokensIn(d, 'word');
  const extentMoves = new Map(); // `${begin}-${end}` of a word -> its new extent
  const next = [];
  kept.forEach(({ sn, a, b }, i) => {
    const begin = next.length;
    next.push(...body.slice(a, b));
    if (i < kept.length - 1) next.push('\n');
    const delta = begin - a;
    const inside = words.filter((w) => sn.begin <= w.begin && w.end <= sn.end);
    for (const [w, [wb, we]] of placeWords(body, a, b, inside)) {
      extentMoves.set(`${w.begin}-${w.end}`, [wb + delta, we + delta]);
    }
    sn.begin = begin;
    sn.end = next.length;
  });
  for (const t of d.tokens) {
    if (t.layer !== 'token:word' && t.layer !== 'token:morpheme') continue;
    const moved = extentMoves.get(`${t.begin}-${t.end}`);
    if (moved) [t.begin, t.end] = moved;
  }
  text.body = next.join('');
}

// ---- the module --------------------------------------------------------------------

export default {
  id: 'cldf',
  strips: {
    // A project holding two vocabularies with one name is refused outright,
    // which roundTrip.mjs checks on a project of its own (REFUSALS). No project
    // that is compared holds it, so there is nothing to take out.
    'vocab.duplicateName': () => {},

    // An empty document and one whose sentences hold no text alike give the
    // import no example row to build a document from.
    'document.noText': (s) =>
      removeDocuments(s, (d) => {
        const body = cps(baselineOf(d)?.body);
        return !tokensIn(d, 'sentence').some((sn) =>
          body.slice(sn.begin, sn.end).some((c) => !WHITESPACE.test(c)),
        );
      }),

    // Nothing is dropped: the word gains the stored morpheme Analyzed_Word
    // implies, split at - and = when its text holds them. A word the imported
    // project skips, by the default rule it is given, stays unanalyzed
    // (token.ignoredWord). Precedence starts at 1, as the editor's.
    'token.unanalyzedWord': (s) => {
      for (const d of docs(s)) {
        for (const { word, morphemes } of wordsWithMorphemes(d)) {
          if (morphemes.length) continue;
          const text = surface(d, word);
          if (isTokenIgnored(text, DEFAULT_IGNORED_TOKENS)) continue;
          text.split(/[-=]/).forEach((form, i) => d.tokens.push(newMorpheme(word, i + 1, form)));
        }
      }
    },

    // The morpheme matching no word goes, and an annotation reaching it stays
    // on the tokens that do match a word. Where that leaves two annotations in
    // a field on one token, the cell holds the first.
    'token.orphanMorpheme': (s) => {
      for (const d of docs(s)) {
        const words = new Set(tokensIn(d, 'word').map((w) => `${w.begin}-${w.end}`));
        const orphans = new Set(
          tokensIn(d, 'morpheme')
            .filter((m) => !words.has(`${m.begin}-${m.end}`))
            .map((m) => m.key),
        );
        if (!orphans.size) continue;
        const trimmed = new Set();
        for (const sp of d.spans) {
          const kept = sp.tokens.filter((k) => !orphans.has(k));
          if (!kept.length || kept.length === sp.tokens.length) continue;
          sp.tokens = kept;
          trimmed.add(sp);
        }
        removeTokens(s, d, (t) => orphans.has(t.key));
        const reached = new Set([...trimmed].flatMap((sp) => sp.tokens));
        splitAnnotations(s, d, (sp) => trimmed.has(sp));
        oneValuePerToken(s, d, reached);
      }
    },
    'span.reachesOrphanToken': coveredBy(
      'token.orphanMorpheme',
      'the orphan goes from the annotation, which stays on the tokens that match a word',
    ),

    // Both annotations come apart into one per token, and a token they share
    // keeps the first.
    'span.overlapSameField': (s) => {
      for (const d of docs(s)) {
        const involved = new Set();
        d.spans.forEach((a, i) => {
          for (const b of d.spans.slice(i + 1)) {
            if (a.layer !== b.layer) continue;
            const shared = a.tokens.filter((k) => b.tokens.includes(k)).length;
            if (shared > 0 && (shared < a.tokens.length || shared < b.tokens.length)) {
              involved.add(a);
              involved.add(b);
            }
          }
        });
        if (!involved.size) continue;
        const tokens = new Set([...involved].flatMap((sp) => sp.tokens));
        splitAnnotations(s, d, (sp) => involved.has(sp));
        oneValuePerToken(s, d, tokens);
      }
    },

    // A field the import adds is inline only when named gloss or pos, and a
    // field setup seeds keeps the seed's setting.
    'vocab.fieldNotInline': (s, ctx) => {
      const seed = seededVocab(ctx).fields || {};
      for (const v of vocabs(s)) {
        for (const [name, f] of Object.entries(v.config?.igt?.fields || {})) {
          if (!f) continue;
          if (seed[name]) f.inline = seed[name].inline;
          else f.inline = name === 'gloss' || name === 'pos';
        }
      }
    },
    // Only the field setup seeds with a tagset keeps one.
    'vocab.fieldTagset': (s, ctx) => {
      const seed = seededVocab(ctx).fields || {};
      for (const v of vocabs(s)) {
        for (const [name, f] of Object.entries(v.config?.igt?.fields || {})) {
          if (!f) continue;
          if (seed[name]?.tagset) f.tagset = seed[name].tagset;
          else delete f.tagset;
        }
      }
    },
    // Every vocabulary has the tagsets setup seeds, and no others.
    'vocab.customTagset': (s, ctx) => {
      const seed = seededVocab(ctx).tagsets || {};
      for (const v of vocabs(s)) {
        v.config ??= {};
        v.config.igt ??= {};
        v.config.igt.tagsets = structuredClone(seed);
      }
    },
    // The field stays, as a text field. Its values are item.itemRefValue's.
    'vocab.fieldItemRef': (s) => {
      for (const v of vocabs(s)) {
        for (const f of Object.values(v.config?.igt?.fields || {})) {
          if (f?.type === 'item' && !f.many) delete f.type;
        }
      }
    },
    'vocab.fieldItemRefMany': (s) => {
      for (const v of vocabs(s)) {
        for (const f of Object.values(v.config?.igt?.fields || {})) {
          if (f?.type === 'item' && f.many) {
            delete f.type;
            delete f.many;
          }
        }
      }
    },
  },

  steps: [
    {
      keys: ['item.itemRefValue', 'item.itemRefManyValue'],
      // A reference becomes the label of the entry it pointed at, numbered as
      // the source vocabulary numbers it. The field's type is read off the
      // source, since vocab.fieldItemRef has already taken it away here. A
      // reference to nothing labels as nothing, which is no value.
      apply(expected, actual, ctx) {
        for (const v of vocabs(expected)) {
          const src = vocabs(ctx.source).find((x) => x.key === v.key);
          const refs = Object.entries(src?.config?.igt?.fields || {}).filter(
            ([, f]) => f?.type === 'item',
          );
          if (!refs.length) continue;
          const labels = entryLabels(src.items);
          for (const it of v.items) {
            for (const [name, f] of refs) {
              const value = it.metadata?.[name];
              if (value == null) continue;
              const text = f.many
                ? (Array.isArray(value) ? value : [value])
                    .map((k) => labels.get(k) ?? '')
                    .filter(Boolean)
                    .join('; ')
                : (labels.get(value) ?? '');
              if (text) it.metadata[name] = text;
              else delete it.metadata[name];
            }
          }
        }
      },
    },
    {
      keys: ['item.sense', 'item.subsense', 'item.senseOrder', 'item.containerHeadword'],
      // Each headword's sense rows are its own gloss and definition, when it
      // has either, then every sense below it with a gloss or definition,
      // depth first. Two or more rows become sense items right after the
      // headword, in row order, and the headword gives up its gloss and
      // definition. One row folds into the headword under its own values.
      // Senses with no row are gone either way.
      apply(expected) {
        for (const v of vocabs(expected)) {
          const tree = senseTree(v.items);
          const items = [];
          for (const head of tree.roots) {
            const md = (head.metadata ??= {});
            const rows = [];
            const own = Object.fromEntries(
              ['gloss', 'definition'].filter((k) => hasValue(md[k])).map((k) => [k, md[k]]),
            );
            if (Object.keys(own).length) rows.push(own);
            for (const sense of descendants(tree, head)) {
              const smd = sense.metadata || {};
              if (!hasValue(smd.gloss) && !hasValue(smd.definition)) continue;
              rows.push(
                Object.fromEntries(
                  Object.entries(smd).filter(([k, val]) => !NOT_IN_A_ROW.has(k) && hasValue(val)),
                ),
              );
            }
            items.push(head);
            if (rows.length >= 2) {
              delete md.gloss;
              delete md.definition;
              rows.forEach((row, i) => {
                items.push({
                  key: newKey('sense'),
                  form: head.form,
                  metadata: { ...row, parent: head.key, senseOrder: i + 1 },
                });
              });
            } else if (rows.length === 1) {
              for (const [k, val] of Object.entries(rows[0])) if (!hasValue(md[k])) md[k] = val;
            }
          }
          v.items = items;
        }
      },
    },
    {
      keys: [
        'vocab.linked',
        'vocab.second',
        'vocab.customField',
        'vocab.fieldMultilingual',
        'vocab.fieldAliasName',
      ],
      // A vocabulary with a headword comes back under its name, with setup's
      // fields and tagsets, and with each other field the source declared that
      // an item still holds a value in, declared { inline: false }. The items
      // here are already the flattened ones, so every item was exported.
      apply(expected, actual, ctx) {
        const seed = seededVocab(ctx);
        expected.vocabularies = vocabs(expected).filter((v) =>
          v.items.some((it) => it.metadata?.parent == null),
        );
        for (const v of vocabs(expected)) {
          const fields = structuredClone(seed.fields || {});
          for (const name of Object.keys(v.config?.igt?.fields || {})) {
            if (fields[name]) continue;
            if (v.items.some((it) => hasValue(it.metadata?.[name])))
              fields[name] = { inline: false };
          }
          v.config = { igt: { fields, tagsets: structuredClone(seed.tagsets || {}) } };
        }
      },
    },
    {
      keys: ['project.documentMetadataFields', 'document.metadataConfigured'],
      // Values come back as strings, and an empty one not at all. The fields
      // are then the names holding a value, met document by document in
      // snapshot order, each document's in the order Description, Contributor,
      // Citation and then the project's own field order, which is the order
      // the export writes the other ContributionTable columns in.
      apply(expected, actual, ctx) {
        const configured = (ctx.source.config?.igt?.documentMetadata || []).map((f) => f.name);
        const first = ['Description', 'Contributor', 'Citation'];
        const columns = [...first, ...configured.filter((n) => !first.includes(n))];
        const names = [];
        for (const d of docs(expected)) {
          for (const name of configured) {
            if (!(name in d.metadata)) continue;
            const v = d.metadata[name];
            if (v == null || v === '') delete d.metadata[name];
            else if (typeof v !== 'string') d.metadata[name] = String(v);
          }
          for (const name of columns) {
            if (hasValue(d.metadata[name]) && !names.includes(name)) names.push(name);
          }
        }
        igt(expected).documentMetadata = names.map((name) => ({ name }));
      },
    },
    {
      keys: ['project.languageObject', 'project.languageMeta'],
      // Each language comes back in the import's shape: name, Glottocode, ISO
      // 639-3 code and coordinates (carried), with no tag. An unnamed one is
      // that shape empty. A meta language that is the object language, by
      // Glottocode or else by ISO code, reads back from the object's row.
      apply(expected, actual, ctx) {
        const src = ctx.source.config?.igt?.languages || {};
        const shape = (l) => ({
          name: l?.name ?? '',
          glottocode: l?.glottocode ?? '',
          iso639P3: l?.iso639P3 ?? '',
          latitude: l?.latitude ?? null,
          longitude: l?.longitude ?? null,
        });
        const object = shape(src.object);
        const meta = src.meta;
        const named = !!(meta?.name || meta?.glottocode || meta?.iso639P3);
        const same =
          named &&
          (meta.glottocode
            ? meta.glottocode === src.object?.glottocode
            : !!meta.iso639P3 && meta.iso639P3 === src.object?.iso639P3);
        igt(expected).languages = {
          object,
          meta: !named ? shape(null) : same ? { ...object } : shape(meta),
        };
      },
    },
    {
      keys: ['layers.ignoredTokensPunctuation'],
      // Setup's default rule, whatever rule the source had.
      apply(expected) {
        const wl = layer(expected, 'token:word');
        if (!wl) return;
        wl.config ??= {};
        wl.config.igt = {
          ...wl.config.igt,
          ignoredTokens: { type: 'unicodePunctuation', whitelist: [] },
        };
      },
    },
    {
      keys: ['layers.orthography'],
      // The orthographies some word holds a value in, as bare { name } entries.
      apply(expected) {
        const cfg = layer(expected, 'token:word')?.config?.igt;
        if (!Array.isArray(cfg?.orthographies)) return;
        const filled = (name) =>
          docs(expected).some((d) =>
            tokensIn(d, 'word').some((w) => hasValue(w.metadata?.[`orthog:${name}`])),
          );
        cfg.orthographies = cfg.orthographies
          .filter((o) => filled(o.name))
          .map((o) => ({ name: o.name }));
      },
    },
    {
      keys: ['token.ignoredWord', 'token.morphemeFormEmpty', 'token.morphemeFormAbsent'],
      // A word with no morpheme was settled by the token.unanalyzedWord strip:
      // skipped under the imported project's rule it stays unanalyzed, and
      // otherwise it is analyzed. A morpheme with no form takes its word's
      // text. A word whose morphemes are all empty keeps only its first,
      // holding the word's text. The text is still the source's at this point.
      apply(expected) {
        for (const d of docs(expected)) {
          for (const { word, morphemes } of wordsWithMorphemes(d)) {
            const text = surface(d, word);
            if (!morphemes.length) continue;
            if (morphemes.every((m) => m.metadata.form === '')) {
              const [head, ...rest] = morphemes;
              head.metadata.form = text;
              const gone = new Set(rest);
              removeTokens(expected, d, (t) => gone.has(t));
              continue;
            }
            for (const m of morphemes) if (!('form' in m.metadata)) m.metadata.form = text;
          }
        }
      },
    },
    {
      keys: ['token.morphTypeOnMorpheme', 'token.procliticBeforeMorpheme'],
      // Only the joint survives: a morpheme after the first is "enclitic" when
      // it or the one before it had a clitic type, and nothing else keeps a
      // type. A type is read off the source, since the links are gone here: the
      // linked entry's (or its headword's, for a sense) when it has one, else
      // the token's own.
      apply(expected, actual, ctx) {
        const entries = new Map(
          vocabs(ctx.source).map((v) => [v.key, new Map(v.items.map((it) => [it.key, it]))]),
        );
        for (const d of docs(expected)) {
          const src = sourceDoc(ctx, d);
          const tokens = new Map((src?.tokens || []).map((t) => [t.key, t]));
          const typeOf = (m) => {
            for (const l of src?.links || []) {
              if (l.tokens.length !== 1 || l.tokens[0] !== m.key) continue;
              const items = entries.get(l.vocab);
              const entry = items?.get(l.item);
              const type =
                entry?.metadata?.morphType ||
                items?.get(entry?.metadata?.parent)?.metadata?.morphType;
              if (type) return type;
            }
            return tokens.get(m.key)?.metadata?.morphType ?? null;
          };
          for (const { morphemes } of wordsWithMorphemes(d)) {
            const clitic = morphemes.map((m) => CLITIC_TYPES.has(typeOf(m)));
            morphemes.forEach((m, i) => {
              if (i > 0 && (clitic[i] || clitic[i - 1])) m.metadata.morphType = 'enclitic';
              else delete m.metadata.morphType;
            });
          }
        }
      },
    },
    {
      keys: [
        'span.sentenceValue',
        'span.markupChars',
        'span.multilineValue',
        'span.valueWhitespace',
      ],
      // A sentence value in a custom column comes back trimmed, and one in the
      // Translated_Text or Comment column as it was. In a word or morpheme
      // value each run of tabs and line breaks becomes one space. A value left
      // empty by that reads as no value (span.emptyValue).
      apply(expected, actual, ctx) {
        const bound = bindings(ctx.source);
        for (const d of docs(expected)) {
          for (const sp of d.spans) {
            if (typeof sp.value !== 'string') continue;
            const scope = scopeOfLayer(expected, sp.layer);
            if (scope === 'Sentence') {
              const name = layer(expected, sp.layer).name;
              if (name !== bound.translation && name !== bound.comment) sp.value = sp.value.trim();
            } else if (scope === 'Word' || scope === 'Morpheme') {
              sp.value = sp.value.replace(/[\r\n\t]+/g, ' ');
            }
          }
          removeSpans(expected, d, (sp) => sp.value === '');
        }
      },
    },
    {
      keys: ['span.multiToken'],
      // One annotation per token, all with the value.
      apply(expected) {
        for (const d of docs(expected)) {
          const tokens = new Set(
            d.spans.filter((sp) => sp.tokens.length > 1).flatMap((sp) => sp.tokens),
          );
          splitAnnotations(expected, d, () => true);
          oneValuePerToken(expected, d, tokens);
        }
      },
    },
    {
      keys: ['text.multiline', 'token.sentence', 'token.word', 'token.untokenizedText'],
      // The baseline becomes the trimmed sentences joined by one newline, a
      // blank sentence dropped. Each sentence runs over its text and the
      // newline after it, the last to the end. Words are placed again by
      // placeWords, and a morpheme follows its word.
      apply(expected) {
        for (const d of docs(expected)) rebuildText(expected, d);
      },
    },
    {
      keys: [
        'layers.fieldSentence',
        'layers.fieldWord',
        'layers.fieldMorpheme',
        'layers.fieldSameNameTwoScopes',
      ],
      // A field with no non-empty value left does not come back, and the rest
      // keep their order with config { scope }. The Translated_Text field is
      // named Translation, the Comment field Note and the morpheme Gloss field
      // Gloss. A sentence field wanting a name one of those took keeps its
      // column name, and is renamed first so no two layers share a key.
      apply(expected, actual, ctx) {
        const used = new Set(
          docs(expected).flatMap((d) =>
            d.spans.filter((sp) => hasValue(sp.value)).map((sp) => sp.layer),
          ),
        );
        removeLayers(
          expected,
          (l) => l.key.startsWith('span:') && !!l.config?.igt?.scope && !used.has(l.key),
        );
        for (const l of spanLayers(expected)) {
          const scope = l.config?.igt?.scope;
          if (scope) l.config = { igt: { scope } };
        }
        const bound = bindings(ctx.source);
        const translation = layer(expected, `span:sentence/${bound.translation}`);
        const comment = layer(expected, `span:sentence/${bound.comment}`);
        const taken = new Set([translation && 'Translation', comment && 'Note'].filter(Boolean));
        for (const l of spanLayers(expected)) {
          if (!l.key.startsWith('span:sentence/') || l === translation || l === comment) continue;
          if (taken.has(l.name)) renameSpanLayer(expected, l.key, `Sentence_${l.name}`);
        }
        if (translation) renameSpanLayer(expected, translation.key, 'Translation');
        if (comment) renameSpanLayer(expected, comment.key, 'Note');
        const gloss =
          bound.glossScope === 'morpheme' && layer(expected, `span:morpheme/${bound.gloss}`);
        if (gloss) renameSpanLayer(expected, gloss.key, 'Gloss');
      },
    },
  ],
};
