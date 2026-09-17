import { isProvKey } from '../utils/provenanceUi.js';
import { missingUdLayerLabels } from '../utils/udLayerUtils.js';
import { enhancedEdges, serializeDeps } from './enhancedGraph.js';

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
export function buildConllu({ name, layerInfo: info, sentences: sentenceData }) {
  if (!info.isConfigured) {
    const missing = missingUdLayerLabels(info.missingLayers);
    const missingList = missing.length > 0 ? missing.join(', ') : 'required UD layers';
    return `# Project configuration incomplete: ${missingList}`;
  }
  if (!sentenceData || sentenceData.length === 0) {
    return '# No tokenized content available';
  }

  // CoNLL-U is line- and tab-delimited with no escape of its own, so a tab
  // inside a value would make an eleven-column row and a newline would make a
  // bare line the parser cannot place. The UI's inputs are single-line, but
  // the API, the assistant and a word carved over a tab in the Text Editor
  // all reach here. One space each, so the file always re-parses.
  const flat = (v) => String(v).replace(/[\t\r\n]+/g, ' ');
  const esc = (v) => (v == null || v === '' ? UNDERSCORE : flat(v));
  const serializeFeats = (feats) => {
    if (!feats || feats.length === 0) return UNDERSCORE;
    const values = feats
      .map((f) => f.value)
      .filter(Boolean)
      .sort();
    return values.length > 0 ? values.join('|') : UNDERSCORE;
  };

  const output = [];
  const docName = flat(name || 'unknown');
  output.push(`# newdoc id = ${docName}`);

  sentenceData.forEach((sentence, sentIdx) => {
    if (sentIdx > 0) output.push('');

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
      sentIdFromMeta ? `# sent_id = ${sentIdFromMeta}` : `# sent_id = ${docName}-${sentIdx + 1}`,
    );

    // Emit arbitrary `# k = v` metadata sorted alphabetically. If metadata
    // carries `text`, the loop emits it; otherwise we fall back to the
    // sentence's substring of the document body. Skip `sent_id` (emitted
    // above) so it doesn't double-emit, and the reserved provenance keys
    // (the parser stamps sentence tokens too; `# prov = inferred` /
    // `# provDetail = [object Object]` are not CoNLL-U content).
    let hasTextMetadata = false;
    Object.keys(sentMeta)
      .sort()
      .forEach((key) => {
        if (key === 'sent_id' || isProvKey(key)) return;
        const value = sentMeta[key];
        if (key === 'text') hasTextMetadata = true;
        if (value === true) output.push(`# ${flat(key)}`);
        else output.push(`# ${flat(key)} = ${flat(value)}`);
      });
    if (!hasTextMetadata) {
      output.push(`# text = ${flat((sentence.text || '').trim())}`);
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

      // MWT bracket line. Surface form comes from the word token's
      // persisted `metadata.form`. When that's absent (MWT imported with
      // FORM=`_`), emit `_` to round-trip the original "unspecified"
      // semantics — don't fabricate a value from the body substring.
      // Editor-created MWTs get `metadata.form` set in `setWordMorphemes`
      // so they round-trip correctly without going through this branch.
      if (groupLen > 1) {
        const wordMeta = morphemes[i].word?.metadata || {};
        const surfaceForm = wordMeta.form || UNDERSCORE;
        // MISC is not stored (see scope decisions), so the bracket row's MISC
        // column is always `_`.
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
            UNDERSCORE,
          ].join('\t'),
        );
      }

      for (let k = 0; k < groupLen; k++) {
        const m = morphemes[i + k];
        const id = i + k + 1;
        const form = m.tokenForm || UNDERSCORE;
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
            deprel = rel.value || UNDERSCORE;
          } else {
            const h = idByLemmaSpanId.get(rel.source);
            if (h != null) {
              head = h;
              deprel = rel.value || UNDERSCORE;
            }
          }
        }
        const deps = serializeDeps(m.spanIds?.lemma ? enhancedByTarget.get(m.spanIds.lemma) : null);
        output.push(
          [id, form, lemma, upos, xpos, feats, head, deprel, deps, UNDERSCORE].join('\t'),
        );
      }

      i += groupLen;
    }
  });

  return output.join('\n');
}
