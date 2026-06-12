// FLEx IR → importable document models.
//
// FLEx stores no per-word character offsets: each Segment carries an ORDERED
// list of word/punctuation analyses that lines up with the surface text. This
// module re-derives word token offsets by walking the baseline and matching
// each form case-folded (the surface says "За", the wordform stores "за").
// Mismatches fall back to a bounded forward search and are reported as
// warnings rather than failing the document.
//
// Output offsets are Unicode CODE POINTS in document-body space, ready for
// the plaid API. Sentence spans tile the body exactly (the sentence layer is
// partitioning): each paragraph's last sentence absorbs the trailing newline.

import { utf16ToCp } from '@larc-iu/plaid-client';
import { pickEn } from './fwdataParser.js';

/** Case-fold one code point; tolerates Turkish/Azeri dotted İ → i. */
const foldChar = (c) => {
  const l = c.toLowerCase();
  return l === 'i̇' ? 'i' : l;
};

/** Does body (UTF-16 index `at`) case-foldedly start with `form`? */
function matchesAt(body, at, form) {
  let i = at;
  for (const fc of form) {
    if (i >= body.length) return false;
    const bc = String.fromCodePoint(body.codePointAt(i));
    if (foldChar(bc) !== foldChar(fc)) return false;
    i += bc.length;
  }
  return i;
}

/**
 * Align one segment's ordered analyses against body[begin, end).
 * Returns {words, warnings}; each word gets UTF-16 begin/end in body space.
 */
function alignSegment(body, begin, end, analyses, baselineWs) {
  const words = [];
  const puncts = [];
  const warnings = [];
  let cursor = begin;
  for (const a of analyses) {
    const form = a.kind === 'punct'
      ? a.form
      : (a.forms?.[baselineWs] ?? pickEn(a.forms));
    if (!form) {
      warnings.push(`word with no form at offset ${cursor}`);
      continue;
    }
    while (cursor < end && /\s/.test(body[cursor])) cursor += 1;
    let at = cursor;
    let matchEnd = matchesAt(body, at, form);
    if (matchEnd === false) {
      // Bounded forward search inside the segment (stale analyses, surface
      // edits FLEx never re-parsed, forms that differ from the text).
      for (at = cursor + 1; at <= end - form.length; at += 1) {
        matchEnd = matchesAt(body, at, form);
        if (matchEnd !== false) break;
      }
      if (matchEnd === false) {
        warnings.push(`could not align ${a.kind} "${form}" after offset ${cursor}`);
        continue;
      }
      const skipped = body.slice(cursor, at);
      if (/\S/.test(skipped)) {
        warnings.push(`skipped "${skipped.trim()}" before "${form}"`);
      }
    }
    if (a.kind === 'word') words.push({ ...a, beginU16: at, endU16: matchEnd });
    else if (a.kind === 'punct') puncts.push({ form, beginU16: at, endU16: matchEnd });
    cursor = matchEnd;
  }
  return { words, puncts, warnings };
}

/**
 * Build importable documents from a parsed IR.
 *
 * @param {object} ir — parseFwdata output
 * @param {object} [opts] — {baselineWs} override (default: first vernacular)
 * @returns {{documents, baselineWs, orthographyWss, stats}}
 *   Each document: {guid, name, names, source, description, genres, body,
 *   sentences: [{begin, end, freeTranslation, literalTranslation, notes}],
 *   words: [{begin, end, forms, gloss, pos, morphemes}], warnings}
 *   All begin/end are code points in body space.
 */
export function buildDocuments(ir, opts = {}) {
  const baselineWs = opts.baselineWs ?? ir.writingSystems.vernacular[0];
  const orthographyWss = ir.writingSystems.vernacular
    .filter((ws) => ws !== baselineWs && ir.wsUsage.wordForms.includes(ws));

  const documents = [];
  for (const text of ir.texts) {
    const warnings = [];
    const parts = [];
    const sentences = []; // {beginU16, endU16, seg|null}
    let offset = 0;
    for (const para of text.paragraphs) {
      const paraEnd = offset + para.content.length;
      if (para.segments.length === 0) {
        // Paragraph FLEx never segmented: absorb into the previous sentence,
        // or open a fresh sentence if it's the first content.
        if (sentences.length) sentences[sentences.length - 1].endU16 = paraEnd;
        else if (para.content.length) sentences.push({ beginU16: offset, endU16: paraEnd, seg: null });
      } else {
        para.segments.forEach((seg, i) => {
          const next = para.segments[i + 1];
          sentences.push({
            beginU16: offset + (i === 0 ? 0 : seg.beginOffset),
            endU16: next ? offset + next.beginOffset : paraEnd,
            seg,
          });
        });
      }
      parts.push(para.content);
      offset = paraEnd + 1; // the joining '\n'
      // The newline belongs to the paragraph's last sentence.
      if (sentences.length) sentences[sentences.length - 1].endU16 = offset;
    }
    const body = parts.join('\n');
    if (sentences.length) {
      // Partitioning invariants: tile [0, len) exactly, no gaps at the edges
      // (leading empty paragraphs would otherwise leave the first sentence
      // starting past 0).
      sentences[0].beginU16 = 0;
      sentences[sentences.length - 1].endU16 = body.length;
    }

    const words = [];
    const puncts = [];
    for (const s of sentences) {
      if (!s.seg) continue;
      const r = alignSegment(body, s.beginU16, s.endU16, s.seg.analyses, baselineWs);
      words.push(...r.words);
      puncts.push(...r.puncts);
      warnings.push(...r.warnings);
    }

    documents.push({
      guid: text.guid,
      name: text.names?.[baselineWs] ?? pickEn(text.names) ?? 'Untitled',
      names: text.names ?? {},
      source: text.source,
      description: text.description,
      genres: text.genres,
      body,
      sentences: sentences.map((s) => ({
        begin: utf16ToCp(body, s.beginU16),
        end: utf16ToCp(body, s.endU16),
        freeTranslation: s.seg?.freeTranslation ?? null,
        literalTranslation: s.seg?.literalTranslation ?? null,
        notes: s.seg?.notes ?? [],
      })),
      words: words.map(({ beginU16, endU16, kind: _kind, ...w }) => ({
        ...w,
        begin: utf16ToCp(body, beginU16),
        end: utf16ToCp(body, endU16),
      })),
      // FLEx's own punctuation analyses, aligned to the body. Imported as word
      // tokens only when the user opts into tokenizing punctuation; otherwise
      // they stay as baseline gaps. Kept separate from `words` so word counts
      // and gloss/morpheme logic never see them.
      puncts: puncts.map(({ form, beginU16, endU16 }) => ({
        form,
        begin: utf16ToCp(body, beginU16),
        end: utf16ToCp(body, endU16),
      })),
      warnings,
    });
  }

  documents.sort((a, b) => a.name.localeCompare(b.name, undefined, { numeric: true }));

  const totalAnalyses = ir.texts.flatMap((t) =>
    t.paragraphs.flatMap((p) => p.segments.flatMap((s) => s.analyses)))
    .filter((a) => a.kind === 'word').length;
  const stats = {
    documents: documents.length,
    sentences: documents.reduce((n, d) => n + d.sentences.length, 0),
    words: documents.reduce((n, d) => n + d.words.length, 0),
    puncts: documents.reduce((n, d) => n + d.puncts.length, 0),
    unalignedWords: totalAnalyses - documents.reduce((n, d) => n + d.words.length, 0),
    morphemes: documents.reduce(
      (n, d) => n + d.words.reduce((m, w) => m + (w.morphemes?.length ?? 0), 0), 0),
    lexiconEntries: ir.lexicon.length,
    lexiconSenses: ir.lexicon.reduce((n, e) => n + e.senses.length, 0),
    warnings: documents.reduce((n, d) => n + d.warnings.length, 0),
  };

  return { documents, baselineWs, orthographyWss, stats };
}
