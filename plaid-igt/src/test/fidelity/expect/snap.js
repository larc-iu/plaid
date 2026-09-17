// Editing a project snapshot (e2e/fidelity/snapshot.mjs) into the shape an
// import is expected to give back.
//
// A snapshot names everything by id-free keys built from content: a token is
// `word:4-9`, a span `span:word/Gloss|word:4-9`, a document `Notes#2`. An
// expectation that moves a word or renames a document would have to rewrite
// every reference to it, so it does not. While a snapshot is being edited, a
// key is only an identity: change a token's `begin`, a document's `name` or an
// entry's `form` and leave the key alone. `finalize` then recomputes every key
// the way snapshot.mjs does and rewrites every reference with it. Anything new
// an expectation adds needs a key no other row has (`newKey`).

import { stableStringify } from '../stable.js';

const byString = (a, b) => (a < b ? -1 : a > b ? 1 : 0);
const sortByKey = (rows, keyOf) =>
  rows
    .map((r) => [keyOf(r), r])
    .sort((a, b) => byString(a[0], b[0]))
    .map(([, r]) => r);

let fresh = 0;
/** A key no snapshot key can equal, for a row an expectation adds. */
export const newKey = (label) => `new:${label}:${++fresh}`;

// ---- reading ---------------------------------------------------------------------

export const igt = (s) => {
  s.config ??= {};
  s.config.igt ??= {};
  return s.config.igt;
};
export const docs = (s) => s.documents || [];
export const layer = (s, key) => (s.layers || []).find((l) => l.key === key);
export const tokensIn = (d, role) => d.tokens.filter((t) => t.layer === `token:${role}`);
export const baselineOf = (d) => d.texts.find((t) => t.layer === 'text:baseline') ?? null;
export const byBegin = (a, b) => a.begin - b.begin || a.end - b.end;
export const cps = (str) => [...(str ?? '')];
export const surface = (d, t) => cps(baselineOf(d)?.body).slice(t.begin, t.end).join('');
export const spanLayers = (s) => (s.layers || []).filter((l) => l.key.startsWith('span:'));
export const scopeOfLayer = (s, key) => layer(s, key)?.config?.igt?.scope ?? null;
export const isProvKey = (k) => k.startsWith('prov');

/** Words in text order, each with its morphemes in precedence order. */
export function wordsWithMorphemes(d) {
  const morphs = new Map();
  for (const m of tokensIn(d, 'morpheme')) {
    const k = `${m.begin}-${m.end}`;
    if (!morphs.has(k)) morphs.set(k, []);
    morphs.get(k).push(m);
  }
  return tokensIn(d, 'word')
    .sort(byBegin)
    .map((w) => ({
      word: w,
      morphemes: (morphs.get(`${w.begin}-${w.end}`) || []).sort(
        (a, b) => (a.precedence ?? 0) - (b.precedence ?? 0),
      ),
    }));
}

/** Delete keys from an object in place, and return it. */
export function omitKeys(obj, pred) {
  for (const k of Object.keys(obj || {})) if (pred(k, obj[k])) delete obj[k];
  return obj;
}

// ---- removing, with everything that hangs off what is removed ---------------------

/**
 * Remove comments matching `pred`, from documents and vocabularies alike.
 * `pred(comment, where)` where `where` is the document or vocabulary holding it.
 */
export function removeComments(s, pred) {
  for (const d of docs(s)) d.comments = d.comments.filter((c) => !pred(c, d));
  for (const v of s.vocabularies || []) v.comments = (v.comments || []).filter((c) => !pred(c, v));
  s.unplacedComments = (s.unplacedComments || []).filter((c) => !pred(c, null));
}

/** Remove relations matching `pred` in one document, and the comments on them. */
export function removeRelations(s, d, pred) {
  const gone = new Set();
  d.relations = d.relations.filter((r) => {
    if (!pred(r)) return true;
    gone.add(relationRef(r));
    return false;
  });
  if (gone.size) {
    removeComments(s, (c) => c.anchor.type === 'relation' && gone.has(c.anchor.ref));
  }
}

/** Remove spans matching `pred` in one document, with their relations and comments. */
export function removeSpans(s, d, pred) {
  const gone = new Set();
  d.spans = d.spans.filter((sp) => {
    if (!pred(sp)) return true;
    gone.add(sp.key);
    return false;
  });
  if (!gone.size) return;
  removeRelations(s, d, (r) => gone.has(r.source) || gone.has(r.target));
  removeComments(s, (c) => c.anchor.type === 'span' && gone.has(c.anchor.ref));
}

/**
 * Remove tokens matching `pred` in one document, with every span and link on
 * any of them, the comments on all of those, and the promoted examples
 * pointing at them.
 */
export function removeTokens(s, d, pred) {
  const gone = new Set();
  d.tokens = d.tokens.filter((t) => {
    if (!pred(t)) return true;
    gone.add(t.key);
    return false;
  });
  if (!gone.size) return;
  removeSpans(s, d, (sp) => sp.tokens.some((k) => gone.has(k)));
  d.links = d.links.filter((l) => !l.tokens.some((k) => gone.has(k)));
  removeComments(
    s,
    (c, where) => where === d && c.anchor.type === 'token' && gone.has(c.anchor.ref),
  );
  for (const it of (s.vocabularies || []).flatMap((v) => v.items)) {
    const ex = it.metadata?.examples;
    if (!Array.isArray(ex)) continue;
    it.metadata.examples = ex.filter((e) => !(e?.document === d.key && gone.has(e?.token)));
  }
}

/** Remove documents matching `pred`, with everything pointing into them. */
export function removeDocuments(s, pred) {
  const gone = new Set(
    docs(s)
      .filter(pred)
      .map((d) => d.key),
  );
  if (!gone.size) return;
  s.documents = docs(s).filter((d) => !gone.has(d.key));
  for (const it of (s.vocabularies || []).flatMap((v) => v.items)) {
    const ex = it.metadata?.examples;
    if (Array.isArray(ex)) it.metadata.examples = ex.filter((e) => !gone.has(e?.document));
  }
}

/**
 * Remove layers matching `pred` and every layer beneath them, with their
 * tokens, spans and relations, and renumber the positions of the layers left
 * beside them.
 */
export function removeLayers(s, pred) {
  const gone = new Set(s.layers.filter(pred).map((l) => l.key));
  // A token layer takes its span and relation layers with it.
  for (const l of s.layers) {
    if (!l.key.startsWith('token:') || !gone.has(l.key)) continue;
    const role = l.key.slice('token:'.length);
    for (const c of s.layers) {
      if (c.key.startsWith(`span:${role}/`) || c.key.startsWith(`relation:${role}/`))
        gone.add(c.key);
    }
  }
  for (const l of s.layers) {
    if (!l.key.startsWith('span:') || !gone.has(l.key)) continue;
    const rest = l.key.slice('span:'.length);
    for (const c of s.layers) if (c.key.startsWith(`relation:${rest}/`)) gone.add(c.key);
  }
  if (!gone.size) return;
  for (const d of docs(s)) {
    removeRelations(s, d, (r) => gone.has(r.layer));
    removeSpans(s, d, (sp) => gone.has(sp.layer));
    removeTokens(s, d, (t) => gone.has(t.layer));
  }
  const removed = s.layers.filter((l) => gone.has(l.key));
  s.layers = s.layers.filter((l) => !gone.has(l.key));
  for (const l of removed) renumberSiblings(s, l.key);
}

// The parent part of a layer key: `span:word/Gloss` -> `span:word/`.
const siblingPrefix = (key) => {
  if (key.startsWith('span:') || key.startsWith('relation:')) {
    return key.slice(0, key.lastIndexOf('/') + 1);
  }
  return key.slice(0, key.indexOf(':') + 1);
};

/** Close the gap in `position` among the siblings of a layer key. */
function renumberSiblings(s, key) {
  const prefix = siblingPrefix(key);
  const depth = key.split('/').length;
  s.layers
    .filter((l) => siblingPrefix(l.key) === prefix && l.key.split('/').length === depth)
    .sort((a, b) => a.position - b.position)
    .forEach((l, i) => {
      l.position = i;
    });
}

/** Rename a span layer, rewriting its key and every span in it. */
export function renameSpanLayer(s, key, name) {
  const l = layer(s, key);
  if (!l || l.name === name) return key;
  const next = `${siblingPrefix(key)}${name}`;
  l.name = name;
  l.key = next;
  // Relation layers beneath it are keyed `relation:<role>/<span name>/<name>`.
  const oldPrefix = `relation:${key.slice('span:'.length)}/`;
  const newPrefix = `relation:${next.slice('span:'.length)}/`;
  const move = (k) => (k.startsWith(oldPrefix) ? newPrefix + k.slice(oldPrefix.length) : k);
  for (const d of docs(s)) {
    for (const sp of d.spans) if (sp.layer === key) sp.layer = next;
    for (const r of d.relations) r.layer = move(r.layer);
  }
  for (const rl of s.layers) rl.key = move(rl.key);
  return next;
}

// ---- recomputing keys --------------------------------------------------------------

const relationRef = (r) => `${r.layer}|${r.source}>${r.target}`;

/**
 * Recompute every key in a snapshot the way snapshot.mjs builds them, rewrite
 * every reference to match, and put every list back in snapshot order. Run it
 * on both sides of a comparison.
 */
export function finalize(s) {
  // Vocabularies: `name#n` in the order the project lists them, which the
  // snapshot keeps within a name.
  const vocabMap = new Map();
  const itemMap = new Map(); // `${oldVocabKey}|${oldItemKey}` -> new item key
  const itemMapAnyVocab = new Map(); // old item key -> new, for item refs inside one vocab
  const vocabCounts = new Map();
  for (const v of s.vocabularies || []) {
    const n = (vocabCounts.get(v.name) ?? 0) + 1;
    vocabCounts.set(v.name, n);
    const key = `${v.name}#${n}`;
    vocabMap.set(v.key, key);
    const seen = new Map();
    const local = new Map();
    for (const it of v.items) {
      const m = (seen.get(it.form) ?? 0) + 1;
      seen.set(it.form, m);
      const next = `${it.form}#${m}`;
      local.set(it.key, next);
      itemMap.set(`${v.key}|${it.key}`, next);
    }
    itemMapAnyVocab.set(v.key, local);
  }

  // Documents: `name#n` in the order the server lists them. The snapshot sorts
  // by key, which keeps that order within a name.
  const docMap = new Map();
  const docCounts = new Map();
  for (const d of docs(s)) {
    const n = (docCounts.get(d.name) ?? 0) + 1;
    docCounts.set(d.name, n);
    docMap.set(d.key, `${d.name}#${n}`);
  }

  const tokenMapByDoc = new Map();
  for (const d of docs(s)) {
    // Tokens: `${role}:${begin}-${end}[@precedence][#n]`.
    const tokenMap = new Map();
    const sorted = [...d.tokens].sort(
      (a, b) =>
        byString(a.layer, b.layer) ||
        a.begin - b.begin ||
        a.end - b.end ||
        (a.precedence ?? 0) - (b.precedence ?? 0) ||
        byString(stableStringify(a.metadata || {}), stableStringify(b.metadata || {})),
    );
    const dup = new Map();
    for (const t of sorted) {
      const label = t.layer.slice('token:'.length);
      const base = `${label}:${t.begin}-${t.end}${t.precedence != null ? `@${t.precedence}` : ''}`;
      const n = (dup.get(base) ?? 0) + 1;
      dup.set(base, n);
      tokenMap.set(t.key, n === 1 ? base : `${base}#${n}`);
    }
    for (const t of d.tokens) t.key = tokenMap.get(t.key);
    tokenMapByDoc.set(d.key, tokenMap);
    const tok = (k) => tokenMap.get(k) ?? k;

    // Spans: `${layer}|${tokens}` plus `#n` ordered by value and metadata.
    const spanMap = new Map();
    const groups = new Map();
    for (const sp of d.spans) {
      sp.tokens = sp.tokens.map(tok).sort(byString);
      const base = `${sp.layer}|${sp.tokens.join(',')}`;
      if (!groups.has(base)) groups.set(base, []);
      groups.get(base).push(sp);
    }
    for (const [base, group] of groups) {
      sortByKey(group, (sp) => stableStringify([sp.value, sp.metadata])).forEach((sp, i) => {
        const key = i === 0 ? base : `${base}#${i + 1}`;
        spanMap.set(sp.key, key);
        sp.key = key;
      });
    }
    const relationMap = new Map();
    for (const r of d.relations) {
      const old = relationRef(r);
      r.source = spanMap.get(r.source) ?? r.source;
      r.target = spanMap.get(r.target) ?? r.target;
      relationMap.set(old, relationRef(r));
    }
    for (const l of d.links) {
      l.tokens = l.tokens.map(tok).sort(byString);
      l.item = itemMap.get(`${l.vocab}|${l.item}`) ?? l.item;
      l.vocab = vocabMap.get(l.vocab) ?? l.vocab;
    }
    const newDocKey = docMap.get(d.key);
    for (const c of d.comments) {
      const a = c.anchor;
      if (a.ref == null) continue;
      if (a.type === 'document') a.ref = docMap.get(a.ref) ?? a.ref;
      else if (a.type === 'text') a.ref = `${newDocKey}${a.ref.slice(a.ref.indexOf('|'))}`;
      else if (a.type === 'token') a.ref = tok(a.ref);
      else if (a.type === 'span') a.ref = spanMap.get(a.ref) ?? a.ref;
      else if (a.type === 'relation') a.ref = relationMap.get(a.ref) ?? a.ref;
    }
    d.tokens = sortByKey(d.tokens, (t) => t.key);
    d.spans = sortByKey(d.spans, (sp) => sp.key);
    d.relations = sortByKey(d.relations, stableStringify);
    d.links = sortByKey(d.links, stableStringify);
    d.comments = sortByKey(d.comments, stableStringify);
  }

  // Entry metadata: parent, item-reference fields and examples.
  for (const v of s.vocabularies || []) {
    const local = itemMapAnyVocab.get(v.key);
    const ref = (k) => (typeof k === 'string' ? (local.get(k) ?? k) : k);
    const itemFields = Object.entries(v.config?.igt?.fields || {})
      .filter(([, f]) => f?.type === 'item')
      .map(([name]) => name);
    for (const it of v.items) {
      const md = it.metadata || {};
      if (md.parent != null) md.parent = ref(md.parent);
      for (const name of itemFields) {
        if (md[name] == null) continue;
        md[name] = Array.isArray(md[name]) ? md[name].map(ref) : ref(md[name]);
      }
      if (Array.isArray(md.examples)) {
        md.examples = md.examples.map((ex) =>
          ex && typeof ex === 'object' && 'document' in ex
            ? {
                ...ex,
                token: tokenMapByDoc.get(ex.document)?.get(ex.token) ?? ex.token,
                document: docMap.get(ex.document) ?? ex.document,
              }
            : ex,
        );
      }
    }
    for (const c of v.comments || []) {
      if (c.anchor.type === 'vocab-item' && c.anchor.ref != null) c.anchor.ref = ref(c.anchor.ref);
    }
    v.comments = sortByKey(v.comments || [], stableStringify);
  }
  for (const v of s.vocabularies || []) {
    for (const it of v.items) it.key = itemMap.get(`${v.key}|${it.key}`);
    v.key = vocabMap.get(v.key);
  }
  for (const d of docs(s)) d.key = docMap.get(d.key);

  s.layers = sortByKey(s.layers || [], (l) => l.key);
  s.vocabularies = sortByKey(s.vocabularies || [], (v) => v.key);
  s.documents = sortByKey(docs(s), (d) => d.key);
  s.unplacedComments = sortByKey(s.unplacedComments || [], stableStringify);
  return s;
}
