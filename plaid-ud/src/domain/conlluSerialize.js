import { isProvKey } from '../utils/provenanceUi.js';
import { enhancedEdges, isSuppressor, serializeDeps } from './enhancedGraph.js';

// CoNLL-U export: the sentence rows and the layer info in, the file out.
//
// Pure, like the row builder beside it, which is why neither lives on
// ConlluDocument. The document caches the result against `_dataVersion` (see
// `toConllu`).

const UNDERSCORE = '_';

/**
 * The document as CoNLL-U text. `sentences` are the rows from
 * buildSentenceRows, `layerInfo` the document's, `name` the document's name.
 * A document whose project is not configured for UD gets a `#`-prefixed
 * sentinel line rather than a throw, which is what the export screens render.
 */
/**
 * What a CoNLL-U file cannot say about these sentences, one line each, or an
 * empty list when it can say everything.
 *
 * A word with no enhanced head writes `_` in its DEPS column, and a sentence
 * where every word writes `_` is exactly what a sentence nobody annotated for
 * the enhanced graph writes. So a sentence whose enhanced graph leaves out
 * every one of its relations, and adds none, comes back from its own file
 * with every relation in place again. The notation has no way to tell the two
 * apart, so the export says so rather than losing the decision quietly.
 */
export function conlluLosses({ sentences } = {}) {
  const out = [];
  (sentences || []).forEach((sentence, i) => {
    const rows = sentence.enhancedRelations || [];
    if (!rows.some(isSuppressor)) return;
    const edges = enhancedEdges(sentence.relations, rows);
    if (edges.some((e) => e.value)) return;
    out.push(
      `Sentence ${i + 1} leaves every relation out of the enhanced graph. ` +
        'CoNLL-U writes that the same way as a sentence with no enhanced ' +
        'annotation at all, so reading this file back gives every word its ' +
        'tree relation again.',
    );
  });
  return out;
}

// What `buildConllu` returns, in place of a file, for a document it cannot
// write. The export screen lists a document skipped for one of these, with the
// text after the `#` as the reason.
export const NOT_SET_UP_FILE = '# This project is not fully set up for UD.';
export const NOT_TOKENIZED_FILE = '# No tokens.';

export function buildConllu({ name, layerInfo: info, sentences: sentenceData }) {
  if (!info.isConfigured) return NOT_SET_UP_FILE;
  if (!sentenceData || sentenceData.length === 0) return NOT_TOKENIZED_FILE;

  // CoNLL-U is line- and tab-delimited with no escape of its own, so a tab
  // inside a value would make an eleven-column row and a newline would make a
  // bare line the parser cannot place. The UI's inputs are single-line, but
  // the API, the assistant and a word carved over a tab in the Text Editor
  // all reach here. One space each, so the file always re-parses. Every
  // column and every comment line goes through these two, nothing else.
  const flat = (v) => String(v).replace(/[\t\r\n]+/g, ' ');
  const esc = (v) => (v == null || v === '' ? UNDERSCORE : flat(v));
  const serializeFeats = (feats) => {
    if (!feats || feats.length === 0) return UNDERSCORE;
    const values = feats
      .map((f) => f.value)
      .filter(Boolean)
      .map(flat)
      // UD orders features by name, case aside (`Number` before `NumType`).
      .map((v) => [v.split('=')[0].toLowerCase(), v])
      .sort(([a, x], [b, y]) => (a < b ? -1 : a > b ? 1 : x < y ? -1 : x > y ? 1 : 0))
      .map(([, v]) => v);
    return values.length > 0 ? values.join('|') : UNDERSCORE;
  };

  // MISC is not stored (see scope decisions), but `SpaceAfter=No` is a fact
  // of the text: a token that is not its sentence's last and is followed by
  // no space gets it, as UD's validators expect of `# text`. So does one the
  // next token starts right at, which a token of no width (a mark that
  // composed with the letter before it) does.
  let chars = null;
  const miscOf = (extent, isLast, nextExtent) => {
    if (isLast || !extent) return UNDERSCORE;
    if (nextExtent && nextExtent.begin <= extent.end) return 'SpaceAfter=No';
    chars ??= [...(info.textLayer?.text?.body ?? '')];
    const next = chars[extent.end];
    return next !== undefined && !/\s/u.test(next) ? 'SpaceAfter=No' : UNDERSCORE;
  };

  const output = [];
  const docName = flat(name || 'unknown');
  output.push(`# newdoc id = ${docName}`);

  sentenceData.forEach((sentence, sentIdx) => {
    const morphemes = sentence.tokens;
    const idByLemmaSpanId = new Map();
    morphemes.forEach((m, i) => {
      if (m.spanIds?.lemma) idByLemmaSpanId.set(m.spanIds.lemma, i + 1);
    });
    const incomingByTarget = new Map();
    (sentence.relations || []).forEach((rel) => incomingByTarget.set(rel.target, rel));
    // DEPS states the whole enhanced graph: the tree, less what the enhanced
    // layer suppresses, plus its extra edges. With no enhanced rows that is
    // the tree again, which is what this column has always said.
    const enhancedByTarget = new Map();
    enhancedEdges(sentence.relations, sentence.enhancedRelations).forEach((edge) => {
      if (!edge.value) return;
      const head = edge.source === edge.target ? 0 : idByLemmaSpanId.get(edge.source);
      if (head == null) return;
      if (!enhancedByTarget.has(edge.target)) enhancedByTarget.set(edge.target, []);
      enhancedByTarget.get(edge.target).push({ head, deprel: flat(edge.value) });
    });

    // Prefer a `sent_id` carried on the sentence token's metadata (round-
    // tripped from import); otherwise synthesize one from doc name + index.
    const sentMeta = sentence.sentenceToken?.metadata || {};
    const sentIdFromMeta = sentMeta.sent_id;
    output.push(
      sentIdFromMeta
        ? `# sent_id = ${flat(sentIdFromMeta)}`
        : `# sent_id = ${docName}-${sentIdx + 1}`,
    );

    // Emit arbitrary `# k = v` metadata sorted alphabetically. If metadata
    // carries `text`, the loop emits it; otherwise we fall back to the
    // sentence's substring of the document body. Skip `sent_id` (emitted
    // above) so it doesn't double-emit, and the reserved provenance keys
    // (the parser stamps sentence tokens too; `# prov = inferred` /
    // `# provDetail = [object Object]` are not CoNLL-U content).
    // A `# text` stored on the sentence (from an import or a parser) is kept
    // only while it is the sentence's text exactly, spaces included. The
    // import builds the body from `# text`, so the two agree until someone
    // edits the sentence. After an edit, even one that only adds or removes a
    // space, the stored line says something else, and writing it put a line
    // in the file that the screen and its own token rows contradicted.
    const own = (sentence.text || '').trim();
    const staleText =
      sentMeta.text !== undefined && flat(sentMeta.text).trim() !== flat(own) ? 'text' : null;
    let hasTextMetadata = false;
    Object.keys(sentMeta)
      .sort()
      .forEach((key) => {
        if (key === 'sent_id' || key === staleText || isProvKey(key)) return;
        const value = sentMeta[key];
        if (key === 'text') hasTextMetadata = true;
        if (value === true) output.push(`# ${flat(key)}`);
        else output.push(`# ${flat(key)} = ${flat(value)}`);
      });
    if (!hasTextMetadata) {
      output.push(`# text = ${flat(own)}`);
    }

    let i = 0;
    while (i < morphemes.length) {
      const word = morphemes[i].word;
      let groupLen = 1;
      if (word) {
        while (i + groupLen < morphemes.length && morphemes[i + groupLen].word?.id === word.id) {
          groupLen += 1;
        }
      }

      // MWT bracket line. A token imported with FORM `_` has no stored
      // `metadata.form` and is written `_` again. Any other is written as its
      // text in the document: the stored form is that text when it was set,
      // and a text edit since (`del` to `dul`) leaves it behind, which put a
      // form in the file that its own `# text` did not hold.
      const next = morphemes[i + groupLen];
      const misc = miscOf(
        morphemes[i].word || morphemes[i].token,
        i + groupLen >= morphemes.length,
        next && (next.word || next.token),
      );
      if (groupLen > 1) {
        const wordMeta = morphemes[i].word?.metadata || {};
        const surfaceForm = wordMeta.form ? esc(morphemes[i].wordForm) : UNDERSCORE;
        // A multi-word token's `SpaceAfter=No` goes on its bracket row.
        output.push(
          [
            `${i + 1}-${i + groupLen}`,
            surfaceForm,
            UNDERSCORE,
            UNDERSCORE,
            UNDERSCORE,
            UNDERSCORE,
            UNDERSCORE,
            UNDERSCORE,
            UNDERSCORE,
            misc,
          ].join('\t'),
        );
      }

      for (let k = 0; k < groupLen; k++) {
        const m = morphemes[i + k];
        const id = i + k + 1;
        const form = esc(m.tokenForm);
        const lemma = esc(m.lemma?.value);
        const upos = esc(m.upos?.value);
        const xpos = esc(m.xpos?.value);
        const feats = serializeFeats(m.feats);

        let head = UNDERSCORE;
        let deprel = UNDERSCORE;
        const rel = m.spanIds?.lemma ? incomingByTarget.get(m.spanIds.lemma) : null;
        if (rel) {
          if (rel.source === rel.target) {
            head = 0;
            deprel = esc(rel.value);
          } else {
            const h = idByLemmaSpanId.get(rel.source);
            if (h != null) {
              head = h;
              deprel = esc(rel.value);
            }
          }
        }
        const deps = serializeDeps(m.spanIds?.lemma ? enhancedByTarget.get(m.spanIds.lemma) : null);
        output.push(
          [
            id,
            form,
            lemma,
            upos,
            xpos,
            feats,
            head,
            deprel,
            deps,
            groupLen > 1 ? UNDERSCORE : misc,
          ].join('\t'),
        );
      }

      i += groupLen;
    }
    // CoNLL-U ends every sentence with a blank line, the last one too, and
    // the file with a newline, so two files joined end to end stay apart.
    output.push('');
  });

  return `${output.join('\n')}\n`;
}
