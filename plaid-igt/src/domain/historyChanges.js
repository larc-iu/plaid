// What one History entry changed, as igt draws it: each sentence it changed,
// before and after, cell by cell, the lexicon entries it changed, and the
// document's name and metadata. Pure functions over the rows core's
// `audit.changes` read gives (AuditRowChange) and the documents igt already
// derives, so the view and its tests share one account.
//
// The rows say what each written row was just before the entry's first write
// to it and just after its last. The document AFTER the entry is the as-of
// read at the entry's end with each span and link the entry wrote as the
// entry left it (`documentAfter`, `vocabulariesAt`), and the document BEFORE
// it is that same read with the before of every row put back
// (`documentBefore`). So the two differ in the entry's rows and nothing else:
// what other people wrote between a job's batches stays the same on both
// sides, and a value someone changed after the entry wrote it, before the
// entry ended (a person editing a gloss while a job runs, a later action of
// the same batch), shows as the entry left it. Both are derived
// as the Analyze grid derives a document (derive.js), cut into cells as the
// copy and export formats cut a sentence (igtExport.js wordCells: the joiners,
// a virtual morpheme, an ignored token), and compared cell by cell. A sentence
// whose cells all match on both sides is left out, which is what keeps a text
// edit's shifted offsets from listing every later sentence.
//
// Every function here takes ALL the rows of the entry (narrowed to a document
// or a vocabulary): rows depend on each other (a text and the tokens it
// shifted, a token and the spans on it), so a part of them puts back a
// before beside an after it does not belong with.

import { PROV_STATES, provState } from '@larc-iu/plaid-client';
import { deriveSentences } from './derive.js';
import { getIgtLayerInfo } from './layerInfo.js';
import { morphFormOf, wordCells } from './igtExport.js';
import { equalsBefore, joinerBetween } from './affixMarkers.js';
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

const BEFORE = (r) => r.before;
const AFTER = (r) => r.after;

// A list with each row's `image` (its before, or its after) in place of what
// the list holds under its id, and no item for a row with no such image.
const putBack = (list, rows, image = BEFORE) => {
  const ids = new Set(rows.map((r) => r.id));
  const out = (list || []).filter((x) => !ids.has(x.id));
  for (const r of rows) {
    const img = image(r);
    if (img) out.push(img);
  }
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
  const token = (r) => r.before && { text: r.text, ...r.before };
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
 * `raw` (the as-of read at the entry's end) with each span among `rows` as
 * the entry left it. Tokens and the text stay as read: their offsets belong
 * with the text as it is at the entry's end.
 */
function documentAfter(raw, rows) {
  const spans = byKey(
    rows.filter((r) => r.kind === 'span'),
    (r) => r.layer,
  );
  if (!spans.size) return raw;
  return {
    ...raw,
    textLayers: (raw?.textLayers || []).map((tl) => ({
      ...tl,
      tokenLayers: (tl.tokenLayers || []).map((tkl) => ({
        ...tkl,
        spanLayers: (tkl.spanLayers || []).map((sl) =>
          spans.has(sl.id) ? { ...sl, spans: putBack(sl.spans, spans.get(sl.id), AFTER) } : sl,
        ),
      })),
    })),
  };
}

/**
 * `vocabularies` (the document's, as read at the entry's end, links folded
 * in) with every entry and link among `rows` as `image` gives it (BEFORE, the
 * vocabularies before the entry, or AFTER, as the entry left them).
 */
function vocabulariesAt(vocabularies, rows, image) {
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
      items: items.has(id) ? putBack(vocab.items, items.get(id), image) : vocab.items,
      // Every link the rows name leaves, wherever it is, and comes back in
      // the vocabulary of the entry its image names.
      vocabLinks: links.length
        ? [
            ...(vocab.vocabLinks || []).filter((l) => !linkIds.has(l.id)),
            ...links.filter((r) => image(r)?.vocabItem?.layer === id).map(image),
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

/**
 * The rows a sentence block may have, in order: `{key, label, kind}`. A row
 * of kind `morphemes`, `morph` or `entry` holds a value per morpheme (a
 * cell's `pieces`), every other row one value per word.
 */
const rowsOf = (fields) => [
  { key: 'surface', label: '', kind: 'surface' },
  ...fields.orthographies.map((n) => ({ key: `orth:${n}`, label: n, kind: 'orth' })),
  ...fields.wordFields.map((n) => ({ key: `word:${n}`, label: n, kind: 'word' })),
  ...(fields.hasMorphemes ? [{ key: 'morphemes', label: 'Morphemes', kind: 'morphemes' }] : []),
  ...fields.morphFields.map((n) => ({ key: `morph:${n}`, label: n, kind: 'morph' })),
  ...(fields.hasMorphemes ? [{ key: 'entry', label: 'Entry', kind: 'entry' }] : []),
  { key: 'wordEntry', label: 'Word entry', kind: 'wordEntry' },
];

const filled = (v) => (v ?? '') !== '';
const spanProv = (span) => (span && filled(span.value) ? provState(span.metadata) : null);

// One value: what it shows, whose it is, and `src`, the id of the row it is
// stored in (a span, a link, a token's metadata), or null for a value read
// off the text (a word as written, a morpheme with no form of its own), which
// a text edit changes and which no one's value is replaced by.
const cellValue = (v, prov, src) => {
  const shown = v ?? '';
  const from = src ?? null;
  return { value: shown, prov: shown === '' ? null : prov, src: from, stored: from !== null };
};

const linkLabel = (vocabularies, item) =>
  item ? entryName(vocabularies?.[item.vocabId]?.items || [], item) : '';

// The values of one morpheme, by row key, for the rows that hold one per
// morpheme. A word nobody segmented has a virtual morpheme
// (virtualMorpheme.js), whose analysis is blank whatever the word reads: it
// has no values here.
const morphemeValues = (m, fields, vocabularies) => {
  const own = Object.prototype.hasOwnProperty.call(m.metadata || {}, 'form');
  const out = {
    morphemes: cellValue(morphFormOf(m), provState(m.metadata), own ? m.id : null),
    entry: cellValue(
      linkLabel(vocabularies, m.vocabItem),
      m.vocabItem?.prov ?? null,
      m.vocabItem?.linkId,
    ),
  };
  for (const n of fields.morphFields) {
    const sp = m.annotations?.[n];
    out[`morph:${n}`] = cellValue(sp?.value, spanProv(sp), sp?.id);
  }
  return out;
};

const wordModel = (t, fields, vocabularies) => {
  const c = wordCells(t, fields);
  const values = {
    surface: cellValue(c.surface, provState(t.metadata)),
    wordEntry: cellValue(
      linkLabel(vocabularies, t.vocabItem),
      t.vocabItem?.prov ?? null,
      t.vocabItem?.linkId,
    ),
  };
  fields.orthographies.forEach((n, i) => {
    values[`orth:${n}`] = cellValue(c.orthLines[i], provState(t.metadata), t.id);
  });
  fields.wordFields.forEach((n, i) => {
    values[`word:${n}`] = cellValue(
      c.wordLines[i],
      spanProv(t.annotations?.[n]),
      t.annotations?.[n]?.id,
    );
  });
  const morphemes = (t.morphemes || [])
    .filter((m) => !m.virtual)
    .map((m) => ({
      id: m.id,
      morphType: m.morphType,
      equalsBefore: equalsBefore(m.metadata),
      values: morphemeValues(m, fields, vocabularies),
    }));
  return { id: t.id, begin: t.begin, values, morphemes };
};

const sentenceModel = (s, fields, vocabularies) => ({
  id: s.id,
  text: (s.pieces || []).map((p) => p.content ?? '').join(''),
  words: (s.tokens || []).map((t) => wordModel(t, fields, vocabularies)),
  fields: Object.fromEntries(
    fields.sentFields.map((n) => [
      n,
      cellValue(s.annotations?.[n]?.value, spanProv(s.annotations?.[n]), s.annotations?.[n]?.id),
    ]),
  ),
  mwes: (s.mwes || []).map((e) => ({
    id: e.linkId,
    words: e.memberIdx.map((i) => s.tokens[i]?.content ?? '').join(' '),
    value: cellValue(
      linkLabel(vocabularies, e.item ? { ...e.item, vocabId: e.vocabId } : null),
      e.prov ?? null,
      e.linkId,
    ),
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

const BLANK = cellValue('', null);

/**
 * Whether the entry replaced a person's value: the value before was a
 * person's (theirs, contributed or confirmed), and after the entry it is
 * machine-made, gone, or reads differently. The one rule for the mark, the
 * count and the filter. A value read off the text is no one's value, so a
 * text edit replaces nothing.
 */
const replacedPersons = (b, a) =>
  b.stored &&
  b.value !== '' &&
  isPersons(b.prov) &&
  (a.value === '' || a.value !== b.value || a.prov === PROV_STATES.MACHINE);

/**
 * One value before and after: `changed` when what it shows or whose it is
 * moved, `replaced` when a person's value went (`replacedPersons`). A stored
 * value whose row is not among the entry's own (`own`, a set of row ids) is
 * none of the entry's change, whatever the two sides read: a gloss a later
 * action put on a morpheme this one made. It reads as it is after, unchanged.
 */
const valueDiff = (b = BLANK, a = BLANK, own = null) => {
  const stored = b.src ?? a.src;
  if (own && stored && !own.has(b.src) && !own.has(a.src)) {
    return {
      before: a.value,
      after: a.value,
      beforeProv: a.prov,
      afterProv: a.prov,
      changed: false,
      replaced: false,
    };
  }
  return {
    before: b.value,
    after: a.value,
    beforeProv: b.prov,
    afterProv: a.prov,
    changed: b.value !== a.value || b.prov !== a.prov,
    replaced: replacedPersons(b, a),
  };
};

// The morphemes of a word before and after, each value diffed on its own,
// with the joiner the grid writes in front of it (from what it shows now, or
// showed, when it is gone). A morpheme the entry deleted took its form with
// it, a person's segmentation however it was spelled: only a morpheme kept
// has a form a text edit moved.
const piecesDiff = (key, bMorphs, aMorphs, own) => {
  const pairs = mergeById(bMorphs || [], aMorphs || []);
  let prev = null;
  const pieces = pairs.map((p) => {
    const m = p.after ?? p.before;
    const was = p.before?.values[key];
    const d = valueDiff(
      p.after || !was ? was : { ...was, stored: true, src: was.src ?? p.id },
      p.after?.values[key],
      own,
    );
    const piece = {
      text: d.after !== '' ? d.after : d.before,
      morphType: m.morphType,
      equalsBefore: m.equalsBefore,
    };
    const joiner = prev ? joinerBetween(prev, piece) : '';
    prev = piece;
    return { id: p.id, joiner, ...d };
  });
  // A word whose morphemes are all blank shows nothing, as the grid's joined
  // line does, not a run of joiners.
  return pieces.some((x) => x.before || x.after)
    ? pieces
    : pieces.map((x) => ({ ...x, joiner: '' }));
};

const PIECE_KINDS = new Set(['morphemes', 'morph', 'entry']);

// One cell of a word column: a value diff, or for a row of morpheme values
// `{pieces}`, each piece a value diff of its own.
const cellDiff = (row, b, a, own) => {
  if (!PIECE_KINDS.has(row.kind)) return valueDiff(b?.values[row.key], a?.values[row.key], own);
  const pieces = piecesDiff(row.key, b?.morphemes, a?.morphemes, own);
  return { pieces, changed: pieces.some((x) => x.changed) };
};

const hasValue = (c) =>
  c.pieces ? c.pieces.some((x) => x.before || x.after) : !!(c.before || c.after);
// Every value a cell holds that the entry could have changed.
const valuesOf = (c) => c.pieces ?? [c];

const diffSentence = (b, a, rows, fields, own) => {
  const pairs = mergeById(b?.words || [], a?.words || []);
  const columns = pairs.map((p) => ({
    id: p.id,
    state: !p.before ? 'added' : !p.after ? 'deleted' : 'kept',
  }));
  const lines = rows
    .map((row) => ({ ...row, cells: pairs.map((p) => cellDiff(row, p.before, p.after, own)) }))
    .filter((row) => row.kind === 'surface' || row.cells.some(hasValue));
  const sentFields = fields.sentFields
    .map((n) => ({ label: n, ...valueDiff(b?.fields[n], a?.fields[n], own) }))
    .filter((f) => f.before || f.after);
  const mwes = mergeById(b?.mwes || [], a?.mwes || [])
    .map((p) => ({
      id: p.id,
      words: (p.after ?? p.before).words,
      ...valueDiff(p.before?.value, p.after?.value, own),
      // An expression made or taken away is a change even with no entry named.
      ...((!p.before || !p.after) && own.has(p.id) ? { changed: true } : {}),
    }))
    .filter((m) => m.changed);
  const textChanged = (b?.text ?? '') !== (a?.text ?? '');
  // A text has no one's value: a text edit is a change, never a value replaced.
  const text = {
    before: b?.text ?? '',
    after: a?.text ?? '',
    changed: textChanged,
    replaced: false,
  };
  const marks = [
    ...lines.flatMap((l) => l.cells.flatMap(valuesOf)),
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

// Each token of both documents by id, with its layer, for placing a span's or
// a link's.
const tokenPlaces = (raws) => {
  const out = new Map();
  for (const raw of raws) {
    for (const tl of raw?.textLayers || []) {
      for (const tkl of tl.tokenLayers || []) {
        for (const t of tkl.tokens || [])
          if (!out.has(t.id)) out.set(t.id, { ...t, layer: tkl.id });
      }
    }
  }
  return out;
};

// A token row whose image moved and nothing else: what a text edit does to
// every token after it.
const onlyMoved = (r) => {
  if (!r.before || !r.after) return false;
  const rest = (img) => JSON.stringify({ ...img, begin: null, end: null });
  return rest(r.before) === rest(r.after);
};

/**
 * Where each row is drawn. `{ids, placed, elsewhere}`: the ids of the
 * sentences the rows touch on either side; `placed`, each row of an igt layer
 * in a sentence with the ids of its sentences; and `elsewhere`, the rows igt
 * draws in no sentence, by where they are: a transcript segment or a span on
 * one (`transcript`), a layer igt does not draw, whatever tokens it sits on,
 * or a relation (`other`), and a span or link whose tokens neither document
 * has, deleted before the entry ended (`deleted`).
 */
const placeRows = (rows, sides, info) => {
  const ids = new Set();
  const placed = [];
  const elsewhere = { transcript: [], other: [], deleted: [] };
  const all = sides.flatMap((s) => s.bundle.sentences.map((x) => x.id));
  if (rows.some((r) => r.kind === 'text')) for (const id of all) ids.add(id);
  const places = tokenPlaces(sides.map((s) => s.raw));
  const sentenceIds = new Set(all);
  const sentenceLayer = info.sentenceTokenLayer?.id;
  const wordLayers = new Set(
    [info.primaryTokenLayer?.id, info.morphemeTokenLayer?.id].filter(Boolean),
  );
  const igtSpanLayers = new Set(
    [...info.spanLayers.word, ...info.spanLayers.morpheme, ...info.spanLayers.sentence].map(
      (l) => l.id,
    ),
  );
  const transcriptLayer = info.alignmentTokenLayer;
  const transcriptSpanLayers = new Set((transcriptLayer?.spanLayers || []).map((l) => l.id));
  const at = (pos, out) => {
    for (const side of sides) {
      const s = pos && side.bundle.findSentenceForToken(pos);
      if (s) out.add(s.id);
    }
  };
  // The sentences the tokens `tokens` (ids) are in, or null when a token is
  // in neither document, or `false` when one is not igt's.
  const onTokens = (tokens) => {
    const out = new Set();
    for (const id of tokens) {
      if (sentenceIds.has(id)) {
        out.add(id);
        continue;
      }
      const t = places.get(id);
      if (!t) return null;
      if (!wordLayers.has(t.layer)) return false;
      at(t, out);
    }
    return out;
  };
  for (const r of rows) {
    let where = 'other';
    let mine = null;
    if (r.kind === 'text') {
      where = 'text';
    } else if (r.kind === 'document') {
      where = 'document';
    } else if (r.kind === 'token') {
      if (r.layer && r.layer === sentenceLayer) {
        mine = new Set([r.id]);
      } else if (wordLayers.has(r.layer)) {
        mine = new Set();
        at(r.before, mine);
        at(r.after, mine);
      } else if (transcriptLayer && r.layer === transcriptLayer.id) {
        where = 'transcript';
      }
    } else if (r.kind === 'span' || r.kind === 'vocab-link') {
      const igt = r.kind === 'vocab-link' || igtSpanLayers.has(r.layer);
      if (r.kind === 'span' && transcriptSpanLayers.has(r.layer)) {
        where = 'transcript';
      } else if (igt) {
        const tokens = [...(r.before?.tokens || []), ...(r.after?.tokens || [])];
        const found = onTokens(tokens);
        if (found === null) where = 'deleted';
        else if (found) mine = found;
      }
    }
    if (mine && mine.size) {
      for (const id of mine) ids.add(id);
      placed.push({ row: r, ids: mine });
    } else if (where === 'transcript' || where === 'other' || where === 'deleted') {
      elsewhere[where].push(r);
    }
  }
  return { ids, placed, elsewhere };
};

const derived = (raw, vocabularies) => {
  const info = getIgtLayerInfo(raw);
  return { raw, info, vocabularies, bundle: deriveSentences(raw, info, vocabularies) };
};

/**
 * The sentences `rows` (a document's rows of one entry, all of them) changed,
 * in reading order: `{id, number, state, columns, lines, fields, mwes, text,
 * changes, replaced}`, `number` counting from 1 in the document after the
 * entry (in the one before it, for a sentence the entry deleted),
 * `changedSince` when someone changed one of its rows after the entry. And
 * `elsewhere`, the rows igt draws in no sentence, counted where they are
 * (`{transcript, other, deleted}`, see placeRows): a row placed only in
 * sentences that show no change is one of `other`, since igt draws nothing
 * of it, unless it is a token a text edit only moved. `after` is the
 * document read at the entry's end (`raw`, `vocabularies`, the shape
 * IgtDocument holds).
 */
export function sentenceChanges({ raw, vocabularies }, rows) {
  const after = derived(documentAfter(raw, rows), vocabulariesAt(vocabularies, rows, AFTER));
  const before = derived(documentBefore(raw, rows), vocabulariesAt(vocabularies, rows, BEFORE));
  const fields = fieldsOf(after.info);
  const rowsShown = rowsOf(fields);
  const sides = [before, after];
  // The rows that are this entry's: a value stored in any other is not its change.
  const own = new Set(rows.map((r) => r.id));
  const { ids, placed, elsewhere } = placeRows(rows, sides, after.info);
  // The sentences a row of which someone changed after the entry. A text
  // edit since is no row of a sentence.
  const since = placeRows(
    rows.filter((r) => r.changedSince && r.kind !== 'text'),
    sides,
    after.info,
  ).ids;
  const pick = (side) => side.bundle.sentences.filter((s) => ids.has(s.id));
  const pairs = mergeById(pick(before), pick(after));
  const number = (side, id) => (side.bundle.sentenceIndexLookup.get(id) ?? 0) + 1;
  const sentences = [];
  for (const p of pairs) {
    const b = p.before && sentenceModel(p.before, fields, before.vocabularies);
    const a = p.after && sentenceModel(p.after, fields, after.vocabularies);
    const d = diffSentence(b, a, rowsShown, fields, own);
    if (d.changes === 0) continue;
    d.number = p.after ? number(after, p.id) : number(before, p.id);
    d.changedSince = since.has(p.id);
    sentences.push(d);
  }
  const drawn = new Set(sentences.map((s) => s.id));
  const undrawn = placed
    .filter((p) => ![...p.ids].some((id) => drawn.has(id)))
    .filter(({ row }) => !(row.kind === 'token' && onlyMoved(row)))
    .map(({ row }) => row);
  return {
    sentences,
    elsewhere: {
      transcript: elsewhere.transcript.length,
      other: elsewhere.other.length + undrawn.length,
      deleted: elsewhere.deleted.length,
    },
    fields,
  };
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
