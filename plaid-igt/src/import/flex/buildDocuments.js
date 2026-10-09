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

import { pickEn } from './fwdataParser.js';
import { keepTimeRule } from '../elan/buildDocuments.js';
import { matchesAt, makeCpIndexer, composeOnEdges, cutsAWord } from '../align.js';

/**
 * Align one segment's ordered analyses against body[begin, end), each form
 * spelled by `spell` as the body is.
 * Returns {words, warnings}; each word gets UTF-16 begin/end in body space.
 */
function alignSegment(body, begin, end, analyses, baselineWs, spell = (s) => s) {
  const words = [];
  const warnings = [];
  let cursor = begin;
  for (const a of analyses) {
    // `surface` is the form a word is written with in the text, where the IR
    // knows it: a .flextext's text is rebuilt from exactly those forms.
    const form = spell(
      a.kind === 'punct' ? a.form : (a.surface ?? a.forms?.[baselineWs] ?? pickEn(a.forms)),
    );
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
    // Punctuation analyses are matched for the cursor's sake only, never
    // collected: punctuation stays untokenized baseline text, the same
    // convention the built-in tokenizer follows (utils/tokenizationUtils).
    if (a.kind === 'word') words.push({ ...a, beginU16: at, endU16: matchEnd });
    cursor = matchEnd;
  }
  return { words, warnings };
}

const nfd = (s) => (s == null ? s : String(s).normalize('NFD'));

// A paragraph as its words are found in it. Every string the parsers read is
// composed (NFC), so a word that begins or ends inside a character (a tone
// mark that is a word of its own, after the letter it would compose with) is
// in the paragraph only decomposed. When its segments do not all align as
// read and do decomposed, with no letter left outside a word, the paragraph
// is read decomposed: `{ content, segments, spell }`, the segments' offsets
// moved onto it. The body is composed with the words' edges at the end
// (composeOnEdges), which keeps only that character decomposed, as the
// server stores it (Luke, 2026-10-09).
function spelledParagraph(para, baselineWs) {
  const given = { content: para.content, segments: para.segments, spell: (s) => s };
  const aligns = ({ content, segments, spell }) => {
    const spans = [];
    for (let i = 0; i < segments.length; i += 1) {
      const begin = i === 0 ? 0 : segments[i].beginOffset;
      const end = segments[i + 1] ? segments[i + 1].beginOffset : content.length;
      const r = alignSegment(content, begin, end, segments[i].analyses, baselineWs, spell);
      if (r.warnings.length) return null;
      spans.push(...r.words);
    }
    return spans;
  };
  if (!para.segments.length || aligns(given)) return given;
  const content = nfd(para.content);
  if (content === para.content) return given;
  const decomposed = {
    content,
    segments: para.segments.map((seg) => ({
      ...seg,
      beginOffset: nfd(para.content.slice(0, seg.beginOffset)).length,
    })),
    spell: nfd,
  };
  const spans = aligns(decomposed);
  return spans && !cutsAWord(content, spans) ? decomposed : given;
}

/**
 * Build importable documents from a parsed IR.
 *
 * @param {object} ir — parseFwdata output
 * @param {object} [opts] — {baselineWs} override (default: first vernacular)
 * @returns {{documents, baselineWs, orthographyWss, stats}}
 *   Each document: {guid, name, names, abbreviation, abbreviations, source,
 *   description, genres, notebook, body, tokenEdges (what the text is created
 *   with, see composeOnEdges, null for a body all composed),
 *   sentences: [{begin, end, freeTranslation, literalTranslation, notes}],
 *   words: [{begin, end, forms, gloss, pos, morphemes}], warnings}
 *   All begin/end are code points in body space.
 */
export function buildDocuments(ir, opts = {}) {
  const baselineWs = opts.baselineWs ?? ir.writingSystems.vernacular[0];
  const orthographyWss = ir.writingSystems.vernacular.filter(
    (ws) => ws !== baselineWs && ir.wsUsage.wordForms.includes(ws),
  );

  const documents = [];
  for (const text of ir.texts) {
    const warnings = [];
    const parts = [];
    const sentences = []; // {beginU16, endU16, seg|null}
    let offset = 0;
    // The spelling each sentence's words are found in (see spelledParagraph).
    const spellOf = new Map();
    for (const read of text.paragraphs) {
      const { spell, ...para } = { ...read, ...spelledParagraph(read, baselineWs) };
      for (const seg of para.segments) spellOf.set(seg, spell);
      const paraEnd = offset + para.content.length;
      if (para.segments.length === 0) {
        // Paragraph FLEx never segmented: absorb into the previous sentence,
        // or open a fresh sentence if it's the first content.
        if (sentences.length) sentences[sentences.length - 1].endU16 = paraEnd;
        else if (para.content.length)
          sentences.push({ beginU16: offset, endU16: paraEnd, seg: null });
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

    // One prebuilt converter for the whole document: the client's per-call
    // conversion spreads the entire prefix, which is quadratic across
    // thousands of tokens (see makeCpIndexer).
    const toCp = makeCpIndexer(body);

    const words = [];
    for (const s of sentences) {
      if (!s.seg) continue;
      const r = alignSegment(
        body,
        s.beginU16,
        s.endU16,
        s.seg.analyses,
        baselineWs,
        spellOf.get(s.seg),
      );
      words.push(...r.words);
      warnings.push(...r.warnings);
    }

    // The recording the text's sentences point to (FLEx can list a video and
    // its audio, and the sentences say which one they were timed against),
    // and each timed sentence's place in it, in seconds as the editor reads
    // them. A document has one recording, so a sentence timed against another
    // is left untimed, and listed (`otherRecording`) for the review screen.
    const named = new Map();
    for (const s of sentences) {
      const name = s.seg?.mediaName;
      if (name) named.set(name, (named.get(name) ?? 0) + 1);
    }
    const mediaName = [...named].sort((a, b) => b[1] - a[1])[0]?.[0] ?? null;
    const timed = sentences
      .map((s, i) => ({ s, n: i + 1 }))
      .filter(
        ({ s }) =>
          s.seg?.timeBeginMs != null && (!s.seg.mediaName || s.seg.mediaName === mediaName),
      );
    const otherRecording = sentences
      .map((s, i) => ({ n: i + 1, mediaName: s.seg?.mediaName }))
      .filter(
        ({ n, mediaName: name }) =>
          name && name !== mediaName && sentences[n - 1].seg.timeBeginMs != null,
      );
    // Two sentences FLEx timed over the same stretch keep only the first's
    // time, as the ELAN importer does: with no speakers to tell them apart
    // the editor cannot hold both.
    const timeWarnings = [];
    const alignments = keepTimeRule(
      timed.map(({ s }) => ({
        begin: toCp(s.beginU16),
        end: toCp(s.endU16),
        timeBegin: s.seg.timeBeginMs / 1000,
        timeEnd: s.seg.timeEndMs / 1000,
      })),
      timed.map(({ n }) => n),
      timeWarnings,
    );

    const cpSentences = sentences.map((s) => ({
      begin: toCp(s.beginU16),
      end: toCp(s.endU16),
      freeTranslation: s.seg?.freeTranslation ?? null,
      literalTranslation: s.seg?.literalTranslation ?? null,
      notes: s.seg?.notes ?? [],
    }));
    const cpWords = words.map(({ beginU16, endU16, kind: _kind, surface: _surface, ...w }) => ({
      ...w,
      begin: toCp(beginU16),
      end: toCp(endU16),
    }));
    // Composed as the server stores it with these tokens on it: a paragraph
    // read decomposed keeps only the character a word edge falls inside so.
    const composed = composeOnEdges(
      body,
      [...cpSentences, ...cpWords, ...alignments].flatMap((t) => [t.begin, t.end]),
    );
    const moved = (t) => ({ ...t, begin: composed.at(t.begin), end: composed.at(t.end) });

    documents.push({
      guid: text.guid,
      mediaName,
      alignments: alignments.map(moved),
      timeWarnings,
      otherRecording,
      name: text.names?.[baselineWs] ?? pickEn(text.names) ?? text.fallbackName ?? 'Untitled',
      names: text.names ?? {},
      // Every writing system's abbreviation, each distinct one kept under its
      // own tag (documentMetadataOf in importEngine.js), since the name is the only
      // record of the language a document field is in and the writing system
      // it goes back to FLEx in.
      abbreviations: text.abbreviations ?? {},
      source: text.source,
      description: text.description,
      genres: text.genres,
      notebook: text.notebook ?? null,
      body: composed.body,
      tokenEdges: composed.tokenEdges,
      sentences: cpSentences.map(moved),
      words: cpWords.map(moved),
      warnings,
    });
  }

  documents.sort((a, b) => a.name.localeCompare(b.name, undefined, { numeric: true }));

  const totalAnalyses = ir.texts
    .flatMap((t) => t.paragraphs.flatMap((p) => p.segments.flatMap((s) => s.analyses)))
    .filter((a) => a.kind === 'word').length;
  const stats = {
    documents: documents.length,
    sentences: documents.reduce((n, d) => n + d.sentences.length, 0),
    words: documents.reduce((n, d) => n + d.words.length, 0),
    unalignedWords: totalAnalyses - documents.reduce((n, d) => n + d.words.length, 0),
    morphemes: documents.reduce(
      (n, d) => n + d.words.reduce((m, w) => m + (w.morphemes?.length ?? 0), 0),
      0,
    ),
    lexiconEntries: ir.lexicon.length,
    lexiconSenses: ir.lexicon.reduce((n, e) => n + e.senses.length, 0),
    warnings: documents.reduce((n, d) => n + d.warnings.length, 0),
  };

  return { documents, baselineWs, orthographyWss, stats };
}
