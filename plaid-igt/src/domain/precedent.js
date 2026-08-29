// Precedent: what a form has been given before, project-wide. ONE tally feeds
// every mechanism that proposes from past decisions — the placeholder gloss
// guess (glossGuess.js), the lexicon popover's ranking (vocabRank.js) and the
// auto-linker (autoLink.js) — so they agree on what counts as precedent and
// each of them is only a policy over the same numbers. (Whole-word analysis
// copies keep their own signature tally in analysisMemory.js: their unit is
// the entire analysis, not one slot of it.)
//
// A tally is keyed by (kind, form, slot):
//   kind  — which kind of token carries the decision: a word or a morpheme
//           (the token layer's `config.plaid.role`);
//   form  — the token's form: a word's value with edge punctuation trimmed by
//           the project's ignore rule (so `derechos.` and `derechos` pool),
//           a morpheme's `metadata.form` verbatim;
//   slot  — an annotation field name (the value is the annotation) or
//           SLOT_LINK (the value is the linked vocab item's id).
// Under each key: value -> { n, machine }, where `machine` is how many of the
// n are machine-made and still unverified. ONE policy decides who counts it:
// a consumer that WRITES on its own (the analysis copy, the auto-linker)
// must not follow unverified machine decisions, or one machine pass would
// bootstrap the next; a consumer that only SUGGESTS and needs a human act to
// write (the placeholder guess, the popover ranking) counts everything,
// since the person adopting it is the check. Read with { excludeMachine }
// accordingly.
//
// Sources: grouped queries over the whole project (linkPrecedentQueries,
// valuePrecedentQueries) with the open document left out, plus the open
// document folded live from its derived sentences, so a decision made a
// moment ago already counts and nothing is counted twice.
//
// KNOWN ASYMMETRY: the query engine exposes no vocab-link metadata, so link
// rows from the project query carry no provenance and count as trusted;
// only the open document's links are state-exact. Value rows are exact.

import { PROV_STATES, ROLES, isMachine } from '@larc-iu/plaid-client';
import { trimIgnoredEdges } from './igtConfig.js';

/** The two kinds of token a decision can hang off (token-layer roles). */
export const KINDS = Object.freeze({ WORD: ROLES.WORD, MORPHEME: ROLES.MORPHEME });

/** The slot for vocab links; every other slot is an annotation field name. */
export const SLOT_LINK = 'link';

// Links also pool under this pseudo-kind: an entry may be linked from words
// and morphemes alike, and a kind with no precedent of its own follows what
// any kind did (autoLink's byKind fallback).
const ANY = 'any';

const keyOf = (kind, form, slot) => `${kind}\u0000${form}\u0000${slot}`;

const morphFormOf = (m) => {
  const meta = m?.metadata;
  if (meta && Object.prototype.hasOwnProperty.call(meta, 'form')) return meta.form ?? '';
  return m?.content ?? '';
};

/** The tally key form for a token of `kind` (see the header). */
export const precedentForm = (text, kind, ignoredCfg = null) =>
  kind === KINDS.WORD ? trimIgnoredEdges(text || '', ignoredCfg) : text || '';

export const createTally = () => new Map();

/** Count `n` decisions of `value` for (kind, form, slot). */
export function addPrecedent(tally, kind, form, slot, value, n = 1, { machine = false } = {}) {
  if (!form || value == null || value === '' || !(n > 0)) return;
  const k = keyOf(kind, form, slot);
  let byValue = tally.get(k);
  if (!byValue) tally.set(k, (byValue = new Map()));
  const v = String(value);
  const c = byValue.get(v) || { n: 0, machine: 0 };
  c.n += n;
  if (machine) c.machine += n;
  byValue.set(v, c);
}

const addLink = (tally, kind, form, itemId, n, machine) => {
  addPrecedent(tally, kind, form, SLOT_LINK, itemId, n, { machine });
  addPrecedent(tally, ANY, form, SLOT_LINK, itemId, n, { machine });
};

// ---- project queries ----

// One grouped query per vocab: how often each (form, item) pairing has been
// linked, split by the kind of token that carries the link. Row shape:
// [itemId, tokenValue, morphForm, role, count] — morphForm for morpheme
// tokens (their value is just the parent word's slice), tokenValue otherwise.
export function linkPrecedentQueries(vocabIds, { excludeDocId = null } = {}) {
  return vocabIds.map((vid) => ({
    where: [
      ['vocab', '?v', { layer: vid }],
      ['vocab-link', '?t', '?v'],
      ['token', '?t', { layer: '?tl' }],
      ['token-layer', '?tl', {}],
      ...(excludeDocId ? [['!=', '?t.doc', excludeDocId]] : []),
    ],
    return: {
      group: ['?v', '?t.value', '?t.metadata.form', '?tl.config.plaid.role'],
      aggregates: [['count']],
    },
  }));
}

// One grouped query per word- and morpheme-scope annotation layer: how often
// each (form, value) pairing was written, split by provenance state. Row
// shape: [form, value, prov, provConfirmed, count] (prov keys null when
// absent). Returns [{ kind, field, query }].
export function valuePrecedentQueries(layerInfo, { excludeDocId = null } = {}) {
  const out = [];
  const add = (kind, tokenLayerId, layers, formPath) => {
    if (!tokenLayerId) return;
    for (const l of layers || []) {
      out.push({
        kind,
        field: l.name,
        query: {
          where: [
            ['span', '?s', { layer: l.id }],
            ['token', '?t', { layer: tokenLayerId }],
            ['covers', '?s', '?t'],
            ...(excludeDocId ? [['!=', '?t.doc', excludeDocId]] : []),
          ],
          return: {
            group: [formPath, '?s.value', '?s.metadata.prov', '?s.metadata.provConfirmed'],
            aggregates: [['count']],
          },
        },
      });
    }
  };
  add(KINDS.WORD, layerInfo?.primaryTokenLayer?.id, layerInfo?.spanLayers?.word, '?t.value');
  add(
    KINDS.MORPHEME,
    layerInfo?.morphemeTokenLayer?.id,
    layerInfo?.spanLayers?.morpheme,
    '?t.metadata.form',
  );
  return out;
}

// ---- folding rows and documents into a tally ----

/** Fold linkPrecedentQueries results (one per vocab) into `tally`. */
export function foldLinkRows(tally, resultsPerVocab, ignoredCfg = null) {
  for (const res of resultsPerVocab || []) {
    for (const [itemId, value, morphForm, role, n] of res?.results || []) {
      const form =
        morphForm != null && morphForm !== ''
          ? String(morphForm)
          : trimIgnoredEdges((value ?? '').toString(), ignoredCfg);
      addLink(tally, role, form, itemId, n, false);
    }
  }
  return tally;
}

/** Fold one valuePrecedentQueries result (rows for one kind + field). */
export function foldValueRows(tally, kind, field, rows, ignoredCfg = null) {
  for (const [form, value, prov, confirmed, n] of rows || []) {
    addPrecedent(
      tally,
      kind,
      precedentForm(form == null ? '' : String(form), kind, ignoredCfg),
      field,
      value,
      n,
      {
        machine: prov != null && !confirmed,
      },
    );
  }
  return tally;
}

/**
 * Fold a whole project fetch: { links: [per-vocab results],
 * values: [{ kind, field, results }] }.
 */
export function foldProject(tally, { links, values } = {}, ignoredCfg = null) {
  foldLinkRows(tally, links, ignoredCfg);
  for (const { kind, field, results } of values || []) {
    foldValueRows(tally, kind, field, results?.results || results, ignoredCfg);
  }
  return tally;
}

/** Fold a derived document's own single-token links (derive.js sentences). */
export function foldDocumentLinks(tally, sentences, ignoredCfg = null) {
  for (const s of sentences || []) {
    for (const t of s.tokens || []) {
      if (t.vocabItem) {
        addLink(
          tally,
          KINDS.WORD,
          precedentForm(t.content, KINDS.WORD, ignoredCfg),
          t.vocabItem.id,
          1,
          t.vocabItem.prov === PROV_STATES.MACHINE,
        );
      }
      for (const m of t.morphemes || []) {
        if (m.vocabItem) {
          addLink(
            tally,
            KINDS.MORPHEME,
            morphFormOf(m),
            m.vocabItem.id,
            1,
            m.vocabItem.prov === PROV_STATES.MACHINE,
          );
        }
      }
    }
  }
  return tally;
}

/** Fold a derived document's own annotation values, per field. */
export function foldDocumentValues(
  tally,
  sentences,
  { wordFields = [], morphFields = [], ignoredCfg = null } = {},
) {
  const addSpans = (kind, form, annotations, fields) => {
    for (const f of fields) {
      const span = annotations?.[f];
      if (!span || (span.value ?? '') === '') continue;
      addPrecedent(tally, kind, form, f, span.value, 1, { machine: isMachine(span.metadata) });
    }
  };
  for (const s of sentences || []) {
    for (const t of s.tokens || []) {
      addSpans(
        KINDS.WORD,
        precedentForm(t.content, KINDS.WORD, ignoredCfg),
        t.annotations,
        wordFields,
      );
      for (const m of t.morphemes || []) {
        addSpans(KINDS.MORPHEME, morphFormOf(m), m.annotations, morphFields);
      }
    }
  }
  return tally;
}

/** Fold everything the open document decided: its links and its values. */
export function foldDocument(tally, sentences, opts = {}) {
  foldDocumentLinks(tally, sentences, opts.ignoredCfg);
  foldDocumentValues(tally, sentences, opts);
  return tally;
}

// ---- reading ----

/**
 * The decisions behind (kind, form, slot): value -> count, or null when
 * there are none. Links fall back to what ANY kind linked when this kind
 * never linked the form. `excludeMachine` leaves unverified machine-made
 * decisions out of the counts.
 */
export function precedentCounts(tally, kind, form, slot, { excludeMachine = false } = {}) {
  let byValue = tally?.get(keyOf(kind, form, slot));
  if (!byValue && slot === SLOT_LINK) byValue = tally?.get(keyOf(ANY, form, slot));
  if (!byValue) return null;
  const out = new Map();
  for (const [v, c] of byValue) {
    const n = excludeMachine ? c.n - c.machine : c.n;
    if (n > 0) out.set(v, n);
  }
  return out.size ? out : null;
}

/**
 * The winning value of a value -> count map. With tieBreak 'none' (the
 * default) a tie on the top count yields null — a strict majority is
 * required, ambiguous forms stay undecided rather than guessed wrong half
 * the time. With 'smallest' a tie breaks to the lexicographically smallest
 * value (deterministic, for cases where any answer beats none).
 */
export function pickMajority(counts, { tieBreak = 'none' } = {}) {
  if (!counts) return null;
  let best = null;
  let bestN = 0;
  let tie = false;
  for (const [v, n] of counts) {
    if (n > bestN) {
      best = v;
      bestN = n;
      tie = false;
    } else if (n === bestN) {
      if (tieBreak === 'smallest') {
        if (v < best) best = v;
      } else tie = true;
    }
  }
  return tie ? null : best;
}
