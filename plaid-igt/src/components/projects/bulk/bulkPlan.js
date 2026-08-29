// Pure planning for the project Bulk Edit tab. Everything here takes derived
// IgtDocuments (or plain vocab tables) and returns rows the UI can show as a
// checkbox-per-match preview and the runner can turn into writes. No client,
// no React.
//
// The four operations, and what their rows are:
//   respell    — word tokens whose surface form changes under a substitution
//                (plus the morpheme forms and lexicon entries that should
//                follow the respelling);
//   field      — annotation spans (or morpheme forms) whose value changes;
//   reanalyze  — every occurrence of one word form, with its current analysis,
//                so one analysis can be applied to all of them;
//   merge      — lexicon entries folded into one survivor.
//
// Match semantics mirror the Search tab (searchQueries.js): `contains` is a
// case-insensitive literal, `exact` is whole-value equality, `regex` is the
// pattern verbatim (JS regex here, with $1-style groups in the replacement;
// Search evaluates the same pattern server-side, and the two engines agree on
// everything a field linguist is likely to type).

import { cpSlice } from '@larc-iu/plaid-client';
import { extractAnalysis, analysisSignature } from '../../../domain/analysisMemory.js';
import { morphemeJoiner } from '../../../domain/affixMarkers.js';

export const OPERATIONS = [
  {
    id: 'respell',
    label: 'Respell words',
    blurb: 'Change the spelling of words across every document, keeping their analyses.',
  },
  {
    id: 'field',
    label: 'Replace in a field',
    blurb: 'Find and replace inside one annotation field, or inside morpheme forms.',
  },
  {
    id: 'reanalyze',
    label: 'Re-analyze a word',
    blurb: 'Give every occurrence of a word the same segmentation, glosses, and links.',
  },
  {
    id: 'merge',
    label: 'Merge lexicon entries',
    blurb: 'Fold duplicate entries into one; every linked word or morpheme follows.',
  },
];

const escapeRegex = (s) => s.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');

// A substitution function for one (find, matchType, replacement) triple.
// Returns { apply, error }: `apply(value)` gives the rewritten value, or null
// when the value is unchanged (no match, or the match rewrites to itself).
// A bad regex yields `error` and an `apply` that never matches.
export function buildReplacer(find, matchType, replacement) {
  const never = () => null;
  if (!find) return { apply: never, error: null };
  let re = null;
  if (matchType === 'regex') {
    try {
      re = new RegExp(find, 'g');
    } catch (err) {
      return { apply: never, error: err.message || 'Invalid regular expression.' };
    }
  } else if (matchType === 'contains') {
    re = new RegExp(escapeRegex(find), 'gi');
  }
  const apply = (value) => {
    const v = value ?? '';
    if (v === '') return null;
    let next;
    if (matchType === 'exact') {
      if (v !== find) return null;
      next = replacement;
    } else if (matchType === 'regex') {
      re.lastIndex = 0;
      if (!re.test(v)) return null;
      re.lastIndex = 0;
      next = v.replace(re, replacement);
    } else {
      re.lastIndex = 0;
      if (!re.test(v)) return null;
      re.lastIndex = 0;
      // A function replacer so `$` in a literal replacement stays literal.
      next = v.replace(re, () => replacement);
    }
    return next === v ? null : next;
  };
  return { apply, error: null };
}

const morphFormOf = (m) => {
  const meta = m?.metadata;
  if (meta && Object.prototype.hasOwnProperty.call(meta, 'form')) return meta.form ?? '';
  return m?.content ?? '';
};

// Does this morpheme carry its OWN form (set away from the word's surface), as
// opposed to deriving it from the baseline? Only own forms need rewriting
// when the baseline is respelled: a derived form follows the text for free.
const hasOwnForm = (m) =>
  !!m?.metadata && Object.prototype.hasOwnProperty.call(m.metadata, 'form') && m.metadata.form;

const sentenceContext = (doc, s, idx, marks) => ({
  docId: doc.id,
  docName: doc.document?.name || '(untitled)',
  sentenceId: s.id,
  sentenceIndex: idx,
  text: cpSlice(doc.body || '', s.begin, s.end),
  marks: marks.map((m) => ({ begin: m.begin - s.begin, end: m.end - s.begin })),
  hitBegin: marks.length ? marks[0].begin : null,
});

// ---- respell -----------------------------------------------------------------

// Word tokens in `doc` whose surface changes under `apply`. Each row carries
// the code-point extent (for the text replace op), the morpheme forms that
// should be rewritten alongside (`morphemes`: own forms only, and only where
// the same substitution changes them), and the full morpheme chain for
// display (`chain`, null when the word is a single derived morpheme, i.e. the
// chain IS the word): [{ joiner, own, old, new }], where a derived morpheme
// follows the baseline (its `new` is the word's) and an own form gets its own
// rewrite or stays put.
export function collectRespellRows(doc, apply) {
  const rows = [];
  const textId = doc.layerInfo.primaryTextLayer?.text?.id;
  if (!textId) return rows;
  (doc.sentences || []).forEach((s, idx) => {
    for (const t of s.tokens || []) {
      const next = apply(t.content);
      if (next == null) continue;
      const morphemes = [];
      const chain = [];
      const ms = t.morphemes || [];
      ms.forEach((m, i) => {
        const joiner = i > 0 ? morphemeJoiner(ms[i - 1]?.morphType, m.morphType) : '';
        if (hasOwnForm(m)) {
          const nf = apply(m.metadata.form);
          if (nf != null) morphemes.push({ id: m.id, old: m.metadata.form, new: nf });
          chain.push({ joiner, own: true, old: m.metadata.form, new: nf ?? m.metadata.form });
        } else {
          chain.push({ joiner, own: false, old: t.content, new: next });
        }
      });
      rows.push({
        id: t.id,
        kind: 'word',
        textId,
        begin: t.begin,
        end: t.end,
        old: t.content,
        new: next,
        morphemes,
        chain: chain.length > 1 || chain.some((c) => c.own) ? chain : null,
        ...sentenceContext(doc, s, idx, [{ begin: t.begin, end: t.end }]),
      });
    }
  });
  return rows;
}

// The morpheme chain of a respell row as before/after strings, honoring the
// "also respell morpheme forms" choice (with it off, own forms keep their
// spelling while derived ones still follow the word).
export function chainText(chain, includeMorphemes) {
  const join = (pick) => chain.map((c) => c.joiner + pick(c)).join('');
  return {
    old: join((c) => c.old),
    new: join((c) => (c.own && !includeMorphemes ? c.old : c.new)),
  };
}

// Lexicon entries whose form changes under `apply`. `vocabularies` is the
// { [vocabId]: { id, name, items } } table IgtDocument uses.
export function collectLexiconRows(vocabularies, apply) {
  const rows = [];
  for (const vocab of Object.values(vocabularies || {})) {
    for (const it of vocab.items || []) {
      const next = apply(it.form);
      if (next == null) continue;
      rows.push({
        id: it.id,
        kind: 'lexicon',
        vocabId: vocab.id,
        vocabName: vocab.name,
        old: it.form,
        new: next,
      });
    }
  }
  return rows;
}

// Text edit directives for one text's selected respell rows. Applied in
// order server-side, so later (higher-offset) replacements go first: each
// op's indices then refer to text no earlier op has shifted. Every op is a
// whole-token replace, which is what keeps the token (see plaid.algos.text).
export function respellOps(rows) {
  return [...rows]
    .sort((a, b) => b.begin - a.begin)
    .map((r) => ({ type: 'replace', index: r.begin, length: r.end - r.begin, value: r.new }));
}

// ---- field ------------------------------------------------------------------

// Spans (or morpheme forms) in `doc` whose value changes. `target` is a
// Search-tab domain: { kind: 'span', layerId, scope, field } or
// { kind: 'morpheme' } (morpheme forms live in token metadata).
export function collectFieldRows(doc, target, apply) {
  const rows = [];
  const push = (s, idx, entity, old, marks, extra = {}) => {
    const next = apply(old);
    if (next == null) return;
    rows.push({ id: entity.id, old, new: next, ...extra, ...sentenceContext(doc, s, idx, marks) });
  };
  (doc.sentences || []).forEach((s, idx) => {
    if (target.kind === 'span' && target.scope === 'sentence') {
      const span = s.annotations?.[target.field];
      if (span?.id) push(s, idx, span, span.value ?? '', [], { kind: 'span' });
      return;
    }
    for (const t of s.tokens || []) {
      const mark = [{ begin: t.begin, end: t.end }];
      if (target.kind === 'span' && target.scope === 'word') {
        const span = t.annotations?.[target.field];
        if (span?.id) push(s, idx, span, span.value ?? '', mark, { kind: 'span', word: t.content });
        continue;
      }
      for (const m of t.morphemes || []) {
        if (target.kind === 'morpheme') {
          // Only a morpheme's own form can be rewritten; a derived one is the
          // word's surface and belongs to the respell operation.
          if (!hasOwnForm(m)) continue;
          push(s, idx, m, m.metadata.form, mark, { kind: 'morphForm', word: t.content });
        } else if (target.kind === 'span' && target.scope === 'morpheme') {
          const span = m.annotations?.[target.field];
          if (span?.id) {
            push(s, idx, span, span.value ?? '', mark, {
              kind: 'span',
              word: t.content,
              morpheme: morphFormOf(m),
            });
          }
        }
      }
    }
  });
  return rows;
}

// ---- reanalyze ----------------------------------------------------------------

// Every occurrence of `form` (exact) in `doc`, with the analysis it currently
// carries (null when unanalyzed or pure-machine) and that analysis's
// signature so identical analyses can be tallied and compared.
export function collectOccurrenceRows(doc, form, ignoredCfg = null) {
  const rows = [];
  (doc.sentences || []).forEach((s, idx) => {
    for (const t of s.tokens || []) {
      if (t.content !== form) continue;
      const analysis = extractAnalysis(t);
      rows.push({
        id: t.id,
        kind: 'word',
        analysis,
        signature: analysis ? analysisSignature(analysis) : null,
        ...sentenceContext(doc, s, idx, [{ begin: t.begin, end: t.end }]),
      });
    }
  });
  // ignoredCfg is accepted for symmetry with the other collectors; punctuation
  // can't be a target form in practice, so no filtering is needed here.
  void ignoredCfg;
  return rows;
}

// The distinct analyses among occurrence rows, most common first:
// [{ signature, analysis, count }]. Unanalyzed occurrences aren't candidates.
export function tallyCandidates(rows) {
  const bySig = new Map();
  for (const r of rows) {
    if (!r.signature) continue;
    const e = bySig.get(r.signature);
    if (e) e.count += 1;
    else bySig.set(r.signature, { signature: r.signature, analysis: r.analysis, count: 1 });
  }
  return [...bySig.values()].sort((a, b) => b.count - a.count);
}

// A one-line rendering of an analysis for the candidate picker:
// forms, then each morpheme field aligned with them, then word fields.
//   ka-ra · go-PST · Word POS: V · links: ka, ra
export function analysisLabel(analysis, itemFormById = new Map()) {
  if (!analysis) return '(unanalyzed)';
  const ms = analysis.morphemes || [];
  const parts = [];
  parts.push(ms.map((m) => m.form ?? '').join('-') || '∅');
  const fieldNames = new Set();
  ms.forEach((m) => Object.keys(m.fields || {}).forEach((k) => fieldNames.add(k)));
  for (const name of fieldNames) {
    parts.push(`${name}: ${ms.map((m) => m.fields?.[name] ?? '').join('-')}`);
  }
  for (const [name, value] of Object.entries(analysis.word?.fields || {})) {
    parts.push(`${name}: ${value}`);
  }
  const links = [
    ...(analysis.word?.vocabItemId ? [analysis.word.vocabItemId] : []),
    ...ms.map((m) => m.vocabItemId).filter(Boolean),
  ].map((id) => itemFormById.get(id) ?? '?');
  if (links.length) parts.push(`links: ${links.join(', ')}`);
  return parts.join(' · ');
}

// ---- merge ----------------------------------------------------------------

// Vocab links (from documents' embedded link tables) that point at any of
// `loserIds`. Each is enough to recreate the link on the survivor.
export function collectLinksToMove(doc, loserIds) {
  const losers = new Set(loserIds);
  const out = [];
  for (const vocab of Object.values(doc.vocabularies || {})) {
    for (const l of vocab.vocabLinks || []) {
      if (l?.vocabItem?.id && losers.has(l.vocabItem.id)) {
        out.push({
          id: l.id,
          itemId: l.vocabItem.id,
          tokens: l.tokens || [],
          metadata: l.metadata || null,
          docId: doc.id,
        });
      }
    }
  }
  return out;
}

// ---- shared -----------------------------------------------------------------

// Group rows by document, preserving first-seen document order and sentence
// order within a document.
export function groupByDoc(rows) {
  const groups = new Map();
  for (const r of rows) {
    let g = groups.get(r.docId);
    if (!g) groups.set(r.docId, (g = { docId: r.docId, docName: r.docName, rows: [] }));
    g.rows.push(r);
  }
  for (const g of groups.values()) {
    g.rows.sort(
      (a, b) => a.sentenceIndex - b.sentenceIndex || (a.hitBegin ?? 0) - (b.hitBegin ?? 0),
    );
  }
  return [...groups.values()];
}

export function chunk(arr, size) {
  const out = [];
  for (let i = 0; i < arr.length; i += size) out.push(arr.slice(i, i + size));
  return out;
}

// The per-project row shape AnalysisCard needs, derived from IGT layer info
// once by the caller: which annotation rows exist at each scope, whether the
// morpheme chain shows, and whether forms carry a lexicon-link line.
export const cardRowsFor = (layerInfo, project) => ({
  wordFields: (layerInfo.spanLayers?.word || []).map((l) => l.name),
  morphFields: (layerInfo.spanLayers?.morpheme || []).map((l) => l.name),
  hasMorphemes: !!layerInfo.morphemeTokenLayer,
  hasVocabs: (project?.vocabs || []).length > 0,
});
