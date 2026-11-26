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
//   merge      — lexicon entries folded into one survivor (no rows here: the
//                server moves the links).
//
// Match semantics are the Search tab's (searchQueries.js): `contains` is a
// case-insensitive literal, `exact` is whole-value equality (canonically
// equivalent text is equal), `regex` is a Java pattern with $1-style groups
// in the replacement. The documents come
// from the server's search and the rows from buildReplacer in the browser,
// and both read the pattern through translatePattern (plaid-ui domain/javaRegex.js),
// so they match the same values.

import { cpSlice, entryForm } from '@larc-iu/plaid-client';
import { extractAnalysis, analysisSignature } from '../../../domain/analysisMemory.js';
import { equalsBefore, morphemeJoiner } from '../../../domain/affixMarkers.js';
import { morphemeGlossReading } from '../../../domain/tagsets.js';
import { RESPELL_UNCHANGED, respellIgnoredRule, respellRefusal } from '../../../domain/respell.js';
import { msg, t } from '@ui/lib/i18n.js';

export const OPERATIONS = [
  {
    id: 'respell',
    label: msg('Respell words'),
    blurb: msg('Change the spelling of words across every document, keeping their analyses.'),
  },
  {
    id: 'field',
    label: msg('Replace in a field'),
    blurb: msg('Find and replace inside one annotation field, or inside morpheme forms.'),
  },
  {
    id: 'reanalyze',
    label: msg('Re-analyze a word'),
    blurb: msg('Give every occurrence of a word the same segmentation, glosses, and links.'),
  },
  {
    id: 'merge',
    label: msg('Merge lexicon entries'),
    blurb: msg('Fold duplicate entries into one. Every linked word or morpheme follows.'),
  },
];

export { buildReplacer } from '../../../domain/replacer.js';

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

// A form a replacement empties (nothing left, or only spaces). A word, a
// morpheme form and a lexicon entry cannot be spelled with nothing: a word
// replaced by nothing is deleted with its whole analysis, and an entry always
// has a form. A row that would write one is shown and never written, as the
// vocabulary's own Replace does (planVocabReplace).
export const blank = (s) => (s ?? '').trim() === '';

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
// rewrite or stays put. A row whose word the substitution empties is
// `invalid: 'empty'`, one whose new spelling the Analyze grid's Respell box
// refuses (a space, a leading combining mark, an ignored token:
// respellRefusal) is `invalid: 'refused'` with that `refusal`, and one that
// empties an own morpheme form carries `emptiesForm`, which bars it only while
// morpheme forms are respelled too (respellBarred).
export function collectRespellRows(doc, apply) {
  const rows = [];
  const textId = doc.layerInfo.primaryTextLayer?.text?.id;
  if (!textId) return rows;
  const ignored = respellIgnoredRule(doc.layerInfo);
  const barred = (old, next) => {
    if (blank(next)) return { invalid: 'empty' };
    const refusal = respellRefusal(old, next, ignored);
    return refusal && refusal !== RESPELL_UNCHANGED ? { invalid: 'refused', refusal } : {};
  };
  (doc.sentences || []).forEach((s, idx) => {
    for (const tok of s.tokens || []) {
      const next = apply(tok.content);
      if (next == null) continue;
      const morphemes = [];
      const chain = [];
      const ms = tok.morphemes || [];
      ms.forEach((m, i) => {
        const joiner =
          i > 0 ? morphemeJoiner(ms[i - 1]?.morphType, m.morphType, equalsBefore(m.metadata)) : '';
        if (hasOwnForm(m)) {
          const nf = apply(m.metadata.form);
          if (nf != null)
            morphemes.push({ id: m.id, old: m.metadata.form, new: nf, metadata: m.metadata });
          chain.push({ joiner, own: true, old: m.metadata.form, new: nf ?? m.metadata.form });
        } else {
          chain.push({ joiner, own: false, old: tok.content, new: next });
        }
      });
      rows.push({
        id: tok.id,
        kind: 'word',
        textId,
        begin: tok.begin,
        end: tok.end,
        old: tok.content,
        new: next,
        morphemes,
        chain: chain.length > 1 || chain.some((c) => c.own) ? chain : null,
        ...barred(tok.content, next),
        ...(morphemes.some((m) => blank(m.new)) ? { emptiesForm: true } : {}),
        ...sentenceContext(doc, s, idx, [{ begin: tok.begin, end: tok.end }]),
      });
    }
  });
  return rows;
}

// A respell row that is never written: its word would be emptied, or, with
// morpheme forms respelled too, one of its own forms would.
export const respellBarred = (row, includeMorphemes) =>
  !!row.invalid || (includeMorphemes && !!row.emptiesForm);

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
// { [vocabId]: { id, name, items } } table IgtDocument uses. The new form is
// the one an entry stores (entryForm), and a row of an untyped entry whose
// markers name a type carries it as `morphType`.
export function collectLexiconRows(vocabularies, apply, canRespellIn = () => true) {
  const rows = [];
  for (const vocab of Object.values(vocabularies || {})) {
    // Renaming an entry needs its vocabulary's maintainer. The entries of
    // another's vocabulary are still listed, as a match nobody here can apply.
    const locked = !canRespellIn(vocab);
    for (const it of vocab.items || []) {
      const respelled = apply(it.form);
      if (respelled == null) continue;
      // Stored without affix or clitic markers, which type an untyped entry.
      const own = it.metadata?.morphType ?? null;
      const read = blank(respelled)
        ? { form: respelled, morphType: own }
        : entryForm(own, respelled);
      const next = read.form;
      rows.push({
        id: it.id,
        kind: 'lexicon',
        vocabId: vocab.id,
        vocabName: vocab.name,
        old: it.form,
        new: next,
        ...(read.morphType !== own ? { morphType: read.morphType } : {}),
        ...(blank(next) ? { invalid: 'empty' } : {}),
        ...(locked ? { locked: true } : {}),
      });
    }
  }
  return rows;
}

// Text edit directives for one text's selected respell rows, shared with
// the Analyze grid's Respell (domain/respell.js).
export { respellOps } from '../../../domain/respell.js';

// ---- field ------------------------------------------------------------------

// How a morpheme's new gloss is read under a tagset (morphemeGlossReading),
// with the word's other glosses as this replace leaves them.
const glossReadingAfter = (morphemes, m, field, apply) =>
  morphemeGlossReading(
    morphemes.map((x) => {
      const old = x.annotations?.[field]?.value ?? '';
      return {
        morphType: x.morphType,
        form: morphFormOf(x),
        gloss: x.annotations?.[field]?.id ? (apply(old) ?? old) : old,
      };
    }),
    morphemes.indexOf(m),
  );

// Spans (or morpheme forms) in `doc` whose value changes. A morpheme span's
// row carries the `reading` its new value is checked by (readingTagset). A
// span the replacement empties is cleared (the runner deletes it, since an
// annotation is never stored as ''), and a morpheme form it empties is
// `invalid: 'empty'`. `target` is a
// Search-tab domain: { kind: 'span', layerId, scope, field } or
// { kind: 'morpheme' } (morpheme forms live in token metadata).
export function collectFieldRows(doc, target, apply) {
  const rows = [];
  const push = (s, idx, entity, old, marks, extra = {}, isForm = false) => {
    const next = apply(old);
    if (next == null) return;
    rows.push({
      id: entity.id,
      old,
      new: next,
      // What the write's provenance stamp is read from (applyField).
      metadata: entity.metadata ?? null,
      ...extra,
      ...(isForm && blank(next) ? { invalid: 'empty' } : {}),
      ...sentenceContext(doc, s, idx, marks),
    });
  };
  (doc.sentences || []).forEach((s, idx) => {
    if (target.kind === 'span' && target.scope === 'sentence') {
      const span = s.annotations?.[target.field];
      if (span?.id) push(s, idx, span, span.value ?? '', [], { kind: 'span' });
      return;
    }
    for (const tok of s.tokens || []) {
      const mark = [{ begin: tok.begin, end: tok.end }];
      if (target.kind === 'span' && target.scope === 'word') {
        const span = tok.annotations?.[target.field];
        if (span?.id)
          push(s, idx, span, span.value ?? '', mark, { kind: 'span', word: tok.content });
        continue;
      }
      for (const m of tok.morphemes || []) {
        if (target.kind === 'morpheme') {
          // Only a morpheme's own form can be rewritten; a derived one is the
          // word's surface and belongs to the respell operation. A stored one
          // alone in its word shows that surface, and Search finds it by it,
          // so it is listed and barred (`invalid: 'formless'`). A virtual one
          // is not stored, and Search does not find it.
          if (hasOwnForm(m)) {
            push(s, idx, m, m.metadata.form, mark, { kind: 'morphForm', word: tok.content }, true);
          } else if (!m.virtual && tok.morphemes.length === 1) {
            push(s, idx, m, morphFormOf(m), mark, {
              kind: 'morphForm',
              word: tok.content,
              invalid: 'formless',
            });
          }
        } else if (target.kind === 'span' && target.scope === 'morpheme') {
          const span = m.annotations?.[target.field];
          if (span?.id) {
            push(s, idx, span, span.value ?? '', mark, {
              kind: 'span',
              word: tok.content,
              morpheme: morphFormOf(m),
              reading: glossReadingAfter(tok.morphemes, m, target.field, apply),
            });
          }
        }
      }
    }
  });
  return rows;
}

// ---- reanalyze ----------------------------------------------------------------

// Every occurrence of `form` (exact, with canonically equivalent text the
// same text, as the server's search reads it) in `doc`, with the analysis it
// currently carries (null when unanalyzed or pure-machine) and that
// analysis's signature so identical analyses can be tallied and compared.
export function collectOccurrenceRows(doc, form, ignoredCfg = null) {
  const rows = [];
  const wanted = form.normalize('NFC');
  (doc.sentences || []).forEach((s, idx) => {
    for (const tok of s.tokens || []) {
      if ((tok.content ?? '').normalize('NFC') !== wanted) continue;
      const analysis = extractAnalysis(tok);
      rows.push({
        id: tok.id,
        kind: 'word',
        analysis,
        signature: analysis ? analysisSignature(analysis) : null,
        ...sentenceContext(doc, s, idx, [{ begin: tok.begin, end: tok.end }]),
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
//
// `shown` words it for the screen. Without it the label is the audit label's
// English, which is stored.
export function analysisLabel(analysis, itemFormById = new Map(), shown = false) {
  if (!analysis) return shown ? t('(unanalyzed)') : '(unanalyzed)'; // i18n-ignore: the audit label's form, stored
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
  if (links.length)
    parts.push(
      shown ? t('links: {forms}', { forms: links.join(', ') }) : `links: ${links.join(', ')}`, // i18n-ignore: the audit label's form, stored
    );
  return parts.join(' · ');
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

// The per-project row shape AnalysisCard needs, derived from IGT layer info
// once by the caller: which annotation rows exist at each scope, whether the
// morpheme chain shows, and whether forms carry a lexicon-link line.
export const cardRowsFor = (layerInfo, project) => ({
  wordFields: (layerInfo.spanLayers?.word || []).map((l) => l.name),
  morphFields: (layerInfo.spanLayers?.morpheme || []).map((l) => l.name),
  hasMorphemes: !!layerInfo.morphemeTokenLayer,
  hasVocabs: (project?.vocabs || []).length > 0,
});
