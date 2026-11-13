// What one History entry changed, as igt draws it: each sentence it changed,
// before and after, cell by cell, the lexicon entries it changed, and the
// document's name and metadata. Pure functions over the rows core's
// `audit.changes` read gives (AuditRowChange) and the documents igt already
// derives, so the view and its tests share one account.
//
// The rows say what each written row was just before the entry's first write
// to it and just after its last. The document AFTER the entry is the as-of
// read at the entry's end, and the document BEFORE it is that same read with
// the before of every row put back (`documentBefore`, `vocabulariesBefore`).
// So the two differ in the entry's rows and nothing else: what other people
// wrote between a job's batches stays the same on both sides. Both are derived
// as the Analyze grid derives a document (derive.js), cut into cells as the
// copy and export formats cut a sentence (igtExport.js wordCells: the joiners,
// a virtual morpheme, an ignored token), and compared cell by cell. A sentence
// whose cells all match on both sides is left out, which is what keeps a text
// edit's shifted offsets from listing every later sentence.
//
// The rows come a page at a time, and every function here takes the rows read
// so far: a row not read yet is the same before and after.

import { PROV_STATES, provState } from '@larc-iu/plaid-client';
import { deriveSentences } from './derive.js';
import { getIgtLayerInfo } from './layerInfo.js';
import { joinMorphemeTexts, wordCells } from './igtExport.js';
import { readOrthographies, readVocabFields } from './igtConfig.js';
import { entryName } from './vocabLookup.js';
import {
  FIELD_TYPES,
  RESERVED_ITEM_KEYS,
  fieldLabel,
  humanizeFieldName,
  normalizeVocabFields,
} from './vocabFields.js';

// ---------------------------------------------------------------------------
// Whose a value was

/** The legend's word for each provenance state. */
export const PROV_WORDS = Object.freeze({
  [PROV_STATES.HUMAN]: 'a person’s',
  [PROV_STATES.VERIFIED]: 'confirmed',
  [PROV_STATES.CONTRIBUTED]: 'contributed',
  [PROV_STATES.MACHINE]: 'machine-made',
});

// A person's value, confirmed or not: what a change "replaced a person's
// value" counts. A machine value a person confirmed is a person's too.
const PERSONS = new Set([PROV_STATES.HUMAN, PROV_STATES.VERIFIED, PROV_STATES.CONTRIBUTED]);
const isPersons = (prov) => PERSONS.has(prov);

// Where one cell holds several values (a gloss per morpheme), the one that
// says most about whose the cell is: a person's over a confirmed one over a
// contributor's over a machine's.
const RANK = {
  [PROV_STATES.HUMAN]: 4,
  [PROV_STATES.VERIFIED]: 3,
  [PROV_STATES.CONTRIBUTED]: 2,
  [PROV_STATES.MACHINE]: 1,
};
const strongest = (provs) =>
  provs.reduce((best, p) => (p && (!best || RANK[p] > RANK[best]) ? p : best), null);

// ---------------------------------------------------------------------------
// The document before the entry

const DOCUMENT_KINDS = new Set(['text', 'token', 'span', 'relation']);

const byKey = (rows, key) => {
  const out = new Map();
  for (const r of rows) {
    const k = key(r);
    if (k == null) continue;
    if (!out.has(k)) out.set(k, []);
    out.get(k).push(r);
  }
  return out;
};

// A list with the rows' befores in place of what the list holds under their
// ids: a row the entry made goes, one it deleted comes back.
const putBack = (list, rows, image = (r) => r.before) => {
  const ids = new Set(rows.map((r) => r.id));
  const out = (list || []).filter((x) => !ids.has(x.id));
  for (const r of rows) if (r.before) out.push(image(r));
  return out;
};

/**
 * `raw` (a document read, the one after the entry) with the before of every
 * one of `rows` that is the document's own put back: its name and metadata,
 * its text, tokens and spans. Returns a new object, `raw` untouched.
 */
function documentBefore(raw, rows) {
  const own = rows.filter((r) => DOCUMENT_KINDS.has(r.kind));
  const layers = byKey(own, (r) => r.layer);
  const doc = rows.find((r) => r.kind === 'document' && r.before);
  const token = (r) => ({ text: r.text, ...r.before });
  return {
    ...raw,
    ...(doc ? { name: doc.before.name, metadata: doc.before.metadata ?? {} } : {}),
    textLayers: (raw?.textLayers || []).map((tl) => ({
      ...tl,
      text: layers.has(tl.id) ? (layers.get(tl.id).find((r) => r.before)?.before ?? null) : tl.text,
      tokenLayers: (tl.tokenLayers || []).map((tkl) => ({
        ...tkl,
        tokens: layers.has(tkl.id) ? putBack(tkl.tokens, layers.get(tkl.id), token) : tkl.tokens,
        spanLayers: (tkl.spanLayers || []).map((sl) =>
          layers.has(sl.id) ? { ...sl, spans: putBack(sl.spans, layers.get(sl.id)) } : sl,
        ),
      })),
    })),
  };
}

/**
 * `vocabularies` (the document's, after the entry, links folded in) with the
 * before of every entry and link among `rows` put back.
 */
function vocabulariesBefore(vocabularies, rows) {
  const links = rows.filter((r) => r.kind === 'vocab-link');
  const linkIds = new Set(links.map((r) => r.id));
  const items = byKey(
    rows.filter((r) => r.kind === 'vocab-item'),
    (r) => r.vocabLayer,
  );
  const out = {};
  for (const [id, vocab] of Object.entries(vocabularies || {})) {
    out[id] = {
      ...vocab,
      items: items.has(id) ? putBack(vocab.items, items.get(id)) : vocab.items,
      // Every link the rows name leaves, wherever it is after, and comes back
      // in the vocabulary of the entry it named before.
      vocabLinks: links.length
        ? [
            ...(vocab.vocabLinks || []).filter((l) => !linkIds.has(l.id)),
            ...links.filter((r) => r.before?.vocabItem?.layer === id).map((r) => r.before),
          ]
        : vocab.vocabLinks,
    };
  }
  return out;
}

// ---------------------------------------------------------------------------
// A sentence as cells

/** The rows of the interlinear block, as the Analyze grid orders them. */
const fieldsOf = (info) => ({
  orthographies: (readOrthographies(info.primaryTokenLayer?.config) || []).map((o) => o.name),
  wordFields: info.spanLayers.word.map((l) => l.name),
  morphFields: info.morphemeTokenLayer ? info.spanLayers.morpheme.map((l) => l.name) : [],
  sentFields: info.spanLayers.sentence.map((l) => l.name),
  hasMorphemes: !!info.morphemeTokenLayer,
});

/** The rows a sentence block may have, in order: `{key, label, kind}`. */
const rowsOf = (fields) => [
  { key: 'surface', label: '', kind: 'surface' },
  ...fields.orthographies.map((n) => ({ key: `orth:${n}`, label: n, kind: 'orth' })),
  ...fields.wordFields.map((n) => ({ key: `word:${n}`, label: n, kind: 'word' })),
  ...(fields.hasMorphemes ? [{ key: 'morphemes', label: 'Morphemes', kind: 'morphemes' }] : []),
  ...fields.morphFields.map((n) => ({ key: `morph:${n}`, label: n, kind: 'morph' })),
  ...(fields.hasMorphemes ? [{ key: 'entry', label: 'Entry', kind: 'entry' }] : []),
  { key: 'wordEntry', label: 'Word entry', kind: 'entry' },
];

const filled = (v) => (v ?? '') !== '';
const spanProv = (span) => (span && filled(span.value) ? provState(span.metadata) : null);

// One cell: what it shows, whose it is, and `sig`, every piece's state, which
// tells a confirmed value from the same value unconfirmed.
const cell = (value, provs) => {
  const v = value ?? '';
  const states = v === '' ? [] : provs;
  return { value: v, prov: strongest(states), sig: states.map((p) => p ?? '').join(',') };
};

const linkLabel = (vocabularies, item) =>
  item ? entryName(vocabularies?.[item.vocabId]?.items || [], item) : '';

const wordModel = (t, fields, vocabularies) => {
  const c = wordCells(t, fields);
  const ms = t.morphemes || [];
  // A word nobody segmented has a virtual morpheme (virtualMorpheme.js): its
  // analysis is blank, whatever the word reads.
  const analyzed = ms.some((m) => !m.virtual);
  const cells = {
    surface: cell(c.surface, [provState(t.metadata)]),
    wordEntry: cell(linkLabel(vocabularies, t.vocabItem), [t.vocabItem?.prov]),
  };
  fields.orthographies.forEach((n, i) => {
    cells[`orth:${n}`] = cell(c.orthLines[i], [provState(t.metadata)]);
  });
  fields.wordFields.forEach((n, i) => {
    cells[`word:${n}`] = cell(c.wordLines[i], [spanProv(t.annotations?.[n])]);
  });
  if (fields.hasMorphemes) {
    cells.morphemes = cell(
      analyzed ? c.segmented : '',
      ms.map((m) => provState(m.metadata)),
    );
    fields.morphFields.forEach((n, i) => {
      cells[`morph:${n}`] = cell(
        c.morphLines[i],
        ms.map((m) => spanProv(m.annotations?.[n])),
      );
    });
    const links = ms.map((m) => linkLabel(vocabularies, m.vocabItem));
    cells.entry = cell(
      joinMorphemeTexts(ms, links),
      ms.map((m) => m.vocabItem?.prov ?? null),
    );
  }
  return { id: t.id, begin: t.begin, cells };
};

const sentenceModel = (s, fields, vocabularies) => ({
  id: s.id,
  text: (s.pieces || []).map((p) => p.content ?? '').join(''),
  words: (s.tokens || []).map((t) => wordModel(t, fields, vocabularies)),
  fields: Object.fromEntries(
    fields.sentFields.map((n) => [
      n,
      cell(s.annotations?.[n]?.value, [spanProv(s.annotations?.[n])]),
    ]),
  ),
  mwes: (s.mwes || []).map((e) => ({
    id: e.linkId,
    label: linkLabel(vocabularies, e.item ? { ...e.item, vocabId: e.vocabId } : null),
    words: e.memberIdx.map((i) => s.tokens[i]?.content ?? '').join(' '),
    prov: e.prov,
  })),
});

// ---------------------------------------------------------------------------
// Before against after

/**
 * Two lists of `{id}` in reading order as one: each id once, an item only one
 * side has placed where it stood on that side.
 */
export function mergeById(before, after) {
  const inAfter = new Set(after.map((x) => x.id));
  const beforeById = new Map(before.map((x) => [x.id, x]));
  const out = [];
  let i = 0;
  const gone = (x) => out.push({ id: x.id, before: x, after: null });
  for (const a of after) {
    if (beforeById.has(a.id)) {
      while (i < before.length && before[i].id !== a.id) {
        if (!inAfter.has(before[i].id)) gone(before[i]);
        i += 1;
      }
      if (i < before.length) i += 1;
      out.push({ id: a.id, before: beforeById.get(a.id), after: a });
    } else {
      out.push({ id: a.id, before: null, after: a });
    }
  }
  for (; i < before.length; i += 1) if (!inAfter.has(before[i].id)) gone(before[i]);
  return out;
}

const EMPTY = cell('', []);

/**
 * One cell before and after: `changed` when what it shows or whose it is
 * moved, `replaced` when a person's value went (changed, or cleared).
 */
const cellDiff = (b = EMPTY, a = EMPTY) => {
  const changed = b.value !== a.value || b.sig !== a.sig;
  return {
    before: b.value,
    after: a.value,
    beforeProv: b.prov,
    afterProv: a.prov,
    changed,
    replaced: changed && b.value !== '' && b.value !== a.value && isPersons(b.prov),
  };
};

const diffSentence = (b, a, rows, fields) => {
  const pairs = mergeById(b?.words || [], a?.words || []);
  const columns = pairs.map((p) => ({
    id: p.id,
    state: !p.before ? 'added' : !p.after ? 'deleted' : 'kept',
  }));
  const lines = rows
    .map((row) => ({
      ...row,
      cells: pairs.map((p) => cellDiff(p.before?.cells[row.key], p.after?.cells[row.key])),
    }))
    .filter((row) => row.kind === 'surface' || row.cells.some((c) => c.before || c.after));
  const sentFields = fields.sentFields
    .map((n) => ({ label: n, ...cellDiff(b?.fields[n], a?.fields[n]) }))
    .filter((f) => f.before || f.after);
  const mwes = mergeById(b?.mwes || [], a?.mwes || [])
    .map((p) => {
      const was = p.before?.label ?? '';
      const now = p.after?.label ?? '';
      const changed = !p.before || !p.after || was !== now || p.before.prov !== p.after.prov;
      return {
        id: p.id,
        words: (p.after ?? p.before).words,
        before: p.before ? was : '',
        after: p.after ? now : '',
        beforeProv: p.before?.prov ?? null,
        afterProv: p.after?.prov ?? null,
        changed,
        replaced: changed && !!p.before && was !== now && isPersons(p.before.prov),
      };
    })
    .filter((m) => m.changed);
  const text = {
    before: b?.text ?? '',
    after: a?.text ?? '',
    changed: (b?.text ?? '') !== (a?.text ?? ''),
  };
  text.replaced = text.changed && text.before !== '';
  const marks = [
    ...lines.flatMap((l) => l.cells),
    ...sentFields,
    ...mwes,
    ...(lines.some((l) => l.kind === 'surface' && l.cells.some((c) => c.changed)) ? [] : [text]),
  ];
  return {
    id: (a ?? b).id,
    state: !b ? 'added' : !a ? 'deleted' : 'kept',
    columns,
    lines,
    fields: sentFields,
    mwes,
    text,
    changes: marks.filter((m) => m.changed).length,
    replaced: marks.filter((m) => m.replaced).length,
  };
};

// Where every token of both documents is, for placing a span's or a link's.
const tokenPlaces = (raws) => {
  const out = new Map();
  for (const raw of raws) {
    for (const tl of raw?.textLayers || []) {
      for (const tkl of tl.tokenLayers || []) {
        for (const t of tkl.tokens || []) if (!out.has(t.id)) out.set(t.id, t);
      }
    }
  }
  return out;
};

// The ids of the sentences the rows touch, on either side, and the rows that
// touch none (a transcript segment, another app's layer).
const touched = (rows, sides, info) => {
  const ids = new Set();
  const unplaced = [];
  if (rows.some((r) => r.kind === 'text')) {
    for (const side of sides) for (const s of side.bundle.sentences) ids.add(s.id);
  }
  const places = tokenPlaces(sides.map((s) => s.raw));
  const sentenceIds = new Set(sides.flatMap((s) => s.bundle.sentences.map((x) => x.id)));
  const sentenceLayer = info.sentenceTokenLayer?.id;
  const place = (pos) => {
    let hit = false;
    for (const side of sides) {
      const s = pos && side.bundle.findSentenceForToken(pos);
      if (s) {
        ids.add(s.id);
        hit = true;
      }
    }
    return hit;
  };
  const placeToken = (id) => {
    if (sentenceIds.has(id)) {
      ids.add(id);
      return true;
    }
    return place(places.get(id));
  };
  for (const r of rows) {
    let hit = false;
    if (r.kind === 'token') {
      if (r.layer && r.layer === sentenceLayer) {
        ids.add(r.id);
        hit = true;
      } else if (
        r.layer === info.primaryTokenLayer?.id ||
        r.layer === info.morphemeTokenLayer?.id
      ) {
        hit = [place(r.before), place(r.after)].some(Boolean);
      }
    } else if (r.kind === 'span' || r.kind === 'vocab-link') {
      for (const img of [r.before, r.after]) {
        for (const t of img?.tokens || []) if (placeToken(t)) hit = true;
      }
    } else if (r.kind === 'text' || r.kind === 'document') {
      hit = true;
    }
    if (!hit && DOCUMENT_KINDS.has(r.kind)) unplaced.push(r);
    if (!hit && r.kind === 'vocab-link') unplaced.push(r);
  }
  return { ids, unplaced };
};

const derived = (raw, vocabularies) => {
  const info = getIgtLayerInfo(raw);
  return { raw, info, vocabularies, bundle: deriveSentences(raw, info, vocabularies) };
};

/**
 * The sentences `rows` (a document's rows of one entry) changed, in reading
 * order: `{id, number, state, columns, lines, fields, mwes, text, changes,
 * replaced}`, `number` counting from 1 in the document after the entry (in
 * the one before it, for a sentence the entry deleted), `changedSince` when
 * someone changed one of its rows after the entry. And `unplaced`, the
 * rows in no sentence. `after` is the document read at the entry's end
 * (`raw`, `vocabularies`, the shape IgtDocument holds).
 */
export function sentenceChanges({ raw, vocabularies }, rows) {
  const after = derived(raw, vocabularies);
  const before = derived(documentBefore(raw, rows), vocabulariesBefore(vocabularies, rows));
  const fields = fieldsOf(after.info);
  const rowsShown = rowsOf(fields);
  const { ids, unplaced } = touched(rows, [before, after], after.info);
  // The sentences a row of which someone changed after the entry. A text
  // edit since is no row of a sentence.
  const since = touched(
    rows.filter((r) => r.changedSince && r.kind !== 'text'),
    [before, after],
    after.info,
  ).ids;
  const pick = (side) => side.bundle.sentences.filter((s) => ids.has(s.id));
  const pairs = mergeById(pick(before), pick(after));
  const number = (side, id) => (side.bundle.sentenceIndexLookup.get(id) ?? 0) + 1;
  const sentences = [];
  for (const p of pairs) {
    const b = p.before && sentenceModel(p.before, fields, before.vocabularies);
    const a = p.after && sentenceModel(p.after, fields, after.vocabularies);
    const d = diffSentence(b, a, rowsShown, fields);
    if (d.changes === 0) continue;
    d.number = p.after ? number(after, p.id) : number(before, p.id);
    d.changedSince = since.has(p.id);
    sentences.push(d);
  }
  return { sentences, unplaced, fields };
}

// ---------------------------------------------------------------------------
// The document's own row

const asText = (v) =>
  v == null ? '' : typeof v === 'string' ? v : Array.isArray(v) ? v.join(', ') : JSON.stringify(v);

/** The document's name and each metadata key the entry changed. */
export function documentRowChanges(rows) {
  const r = rows.find((x) => x.kind === 'document' && x.before && x.after);
  if (!r) return [];
  const out = [];
  if ((r.before.name ?? '') !== (r.after.name ?? '')) {
    out.push({ label: 'Name', before: r.before.name ?? '', after: r.after.name ?? '' });
  }
  const b = r.before.metadata || {};
  const a = r.after.metadata || {};
  for (const key of [...new Set([...Object.keys(b), ...Object.keys(a)])].sort()) {
    const was = asText(b[key]);
    const now = asText(a[key]);
    if (was !== now) out.push({ label: key, before: was, after: now });
  }
  return out;
}

// ---------------------------------------------------------------------------
// Entries

const entryFieldValue = (field, value, nameOf) => {
  if (value == null || value === '') return '';
  if (field?.type === FIELD_TYPES.ITEM) {
    return (Array.isArray(value) ? value : [value]).map((id) => nameOf(id)).join(', ');
  }
  return asText(value);
};

/**
 * The entries `rows` created, changed, merged or deleted, each `{id,
 * vocabId, state ('added'|'changed'|'deleted'|'merged'), name, into, form,
 * fields, changedSince}`. `form` and each of `fields` (`{label, before,
 * after}`, by the vocabulary's own field names) are those that differ. A
 * deleted entry whose links the same rows moved to another entry was merged
 * into it (`into`, `{id, name}`). `vocabularies` are the entries as they are
 * after the entry (by id, with `items` and `config`), for names.
 */
export function entryChanges(rows, vocabularies) {
  const itemRows = rows.filter((r) => r.kind === 'vocab-item');
  const images = new Map();
  for (const r of itemRows) images.set(r.id, r.after ?? r.before);
  const nameOf = (vocabId) => (id) => {
    const items = vocabularies?.[vocabId]?.items || [];
    const item = items.find((i) => i.id === id) ?? images.get(id);
    return item ? entryName(items, item) : '';
  };
  const movedTo = new Map();
  for (const r of rows) {
    if (r.kind !== 'vocab-link' || !r.before?.vocabItem || !r.after?.vocabItem) continue;
    if (r.before.vocabItem.id !== r.after.vocabItem.id) {
      movedTo.set(r.before.vocabItem.id, r.after.vocabItem);
    }
  }
  return itemRows.map((r) => {
    const vocab = vocabularies?.[r.vocabLayer];
    const name = nameOf(r.vocabLayer);
    const fieldList = normalizeVocabFields(readVocabFields(vocab?.config));
    const byName = new Map(fieldList.map((f) => [f.name, f]));
    const b = r.before?.metadata || {};
    const a = r.after?.metadata || {};
    const keys = [
      ...fieldList.map((f) => f.name),
      ...[...new Set([...Object.keys(b), ...Object.keys(a)])].filter(
        (k) => !byName.has(k) && (!RESERVED_ITEM_KEYS.has(k) || k === 'parent'),
      ),
    ];
    const fields = [];
    if ((r.before?.form ?? '') !== (r.after?.form ?? '')) {
      fields.push({ label: 'Form', before: r.before?.form ?? '', after: r.after?.form ?? '' });
    }
    for (const k of keys) {
      const f = byName.get(k) ?? (k === 'parent' ? { type: FIELD_TYPES.ITEM } : null);
      const label = k === 'parent' ? 'Parent entry' : f ? fieldLabel(f) : humanizeFieldName(k);
      const was = entryFieldValue(f, b[k], name);
      const now = entryFieldValue(f, a[k], name);
      if (was !== now) fields.push({ label, before: was, after: now });
    }
    const into = !r.after && movedTo.get(r.id);
    return {
      id: r.id,
      vocabId: r.vocabLayer,
      state: !r.before ? 'added' : !r.after ? (into ? 'merged' : 'deleted') : 'changed',
      name: name(r.id),
      into: into ? { id: into.id, name: name(into.id) || into.form || '' } : null,
      fields,
      changedSince: !!r.changedSince,
    };
  });
}

/**
 * The links `rows` moved, removed or made for entries of vocabulary
 * `vocabId`, counted per document: `[{documentId, moved, removed, made}]`, in
 * the order the rows name the documents.
 */
export function linkCounts(rows, vocabId) {
  const out = new Map();
  for (const r of rows) {
    if (r.kind !== 'vocab-link') continue;
    const was = r.before?.vocabItem?.layer === vocabId ? r.before.vocabItem.id : null;
    const now = r.after?.vocabItem?.layer === vocabId ? r.after.vocabItem.id : null;
    if (!was && !now) continue;
    const key = r.document;
    if (!out.has(key)) out.set(key, { documentId: key, moved: 0, removed: 0, made: 0 });
    const c = out.get(key);
    if (was && r.after && was !== r.after.vocabItem?.id) c.moved += 1;
    else if (was && !r.after) c.removed += 1;
    else if (!was && now) c.made += 1;
  }
  return [...out.values()].filter((c) => c.moved || c.removed || c.made);
}
