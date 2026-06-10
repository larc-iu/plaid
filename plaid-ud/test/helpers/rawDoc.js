// Build the raw document object that `client.documents.get(id, true)` would
// return for a CoNLL-U import — the same shape ConlluDocument wraps. This
// mirrors importFromConllu's writes step for step (sentence/word/morpheme
// tokens with their metadata, Form/Lemma/UPOS/XPOS/Features spans, dependency
// relations on Lemma spans), so tests can exercise the domain layer offline.
// It doubles as documentation of the UD project layout: substrate layers are
// bound by config.plaid.role, annotation layers by config.ud.* flags.
import { cpSlice } from '@larc-iu/plaid-client';
import { parseCoNLLU, buildConlluHierarchy } from '../../src/utils/conlluParser.js';

export function rawDocFromConllu(conlluText, name = 'doc') {
  const hierarchy = buildConlluHierarchy(parseCoNLLU(conlluText));

  const sentenceTokens = [];
  const wordTokens = [];
  const morphemeTokens = [];
  const formSpans = [];
  const lemmaSpans = [];
  const uposSpans = [];
  const xposSpans = [];
  const featSpans = [];
  const relations = [];

  let nextId = 0;
  const id = (prefix) => `${prefix}-${nextId++}`;

  hierarchy.sentences.forEach((s) => {
    const sentenceToken = { id: id('sent'), begin: s.begin, end: s.end };
    if (s.metadata && Object.keys(s.metadata).length > 0) sentenceToken.metadata = s.metadata;
    sentenceTokens.push(sentenceToken);

    // Lemma span id per CoNLL-U row id, for wiring this sentence's relations.
    const lemmaSpanIdByRow = new Map();

    s.words.forEach((w) => {
      const wordToken = { id: id('word'), begin: w.begin, end: w.end };
      const meta = {};
      if (w.isMwt && w.hasExplicitForm && w.surfaceForm) meta.form = w.surfaceForm;
      if (w.misc) meta.misc = w.misc;
      if (Object.keys(meta).length > 0) wordToken.metadata = meta;
      wordTokens.push(wordToken);

      const wordSubstring = cpSlice(hierarchy.text, w.begin, w.end);
      w.morphemes.forEach((m) => {
        const morphemeId = id('morph');
        morphemeTokens.push({ id: morphemeId, begin: m.begin, end: m.end, precedence: m.precedence });
        const row = m.row;
        // Form spans only when the surface form differs from the substring
        // (the form-else-substring rule).
        if (row.form && row.form !== wordSubstring) {
          formSpans.push({ id: id('form'), tokens: [morphemeId], value: row.form });
        }
        if (row.lemma) {
          const lemmaId = id('lemma');
          lemmaSpans.push({ id: lemmaId, tokens: [morphemeId], value: row.lemma });
          lemmaSpanIdByRow.set(row.id, lemmaId);
        }
        if (row.upos) uposSpans.push({ id: id('upos'), tokens: [morphemeId], value: row.upos });
        if (row.xpos) xposSpans.push({ id: id('xpos'), tokens: [morphemeId], value: row.xpos });
        (row.feats || []).forEach((f) => featSpans.push({ id: id('feat'), tokens: [morphemeId], value: f }));
      });
    });

    // Dependency relations live on Lemma spans; the root is a self-loop.
    s.words.forEach((w) => w.morphemes.forEach((m) => {
      const row = m.row;
      const targetId = lemmaSpanIdByRow.get(row.id);
      if (!row.deprel || !targetId) return;
      if (row.head === 0) {
        relations.push({ id: id('rel'), source: targetId, target: targetId, value: row.deprel });
      } else if (row.head > 0) {
        const sourceId = lemmaSpanIdByRow.get(row.head);
        if (sourceId) relations.push({ id: id('rel'), source: sourceId, target: targetId, value: row.deprel });
      }
    }));
  });

  return {
    id: `${name}-id`,
    name,
    textLayers: [{
      id: 'text-layer',
      config: { plaid: { role: 'baseline' } },
      text: { id: 'text-1', body: hierarchy.text },
      tokenLayers: [
        { id: 'sentence-layer', config: { plaid: { role: 'sentence' } }, tokens: sentenceTokens },
        { id: 'word-layer', config: { plaid: { role: 'word' } }, tokens: wordTokens },
        {
          id: 'morpheme-layer',
          config: { plaid: { role: 'syntactic-word' } },
          tokens: morphemeTokens,
          spanLayers: [
            { id: 'form-layer', config: { ud: { form: true } }, spans: formSpans },
            {
              id: 'lemma-layer',
              config: { ud: { lemma: true } },
              spans: lemmaSpans,
              relationLayers: [
                { id: 'relation-layer', config: { ud: { dependency: true } }, relations },
              ],
            },
            { id: 'upos-layer', config: { ud: { upos: true } }, spans: uposSpans },
            { id: 'xpos-layer', config: { ud: { xpos: true } }, spans: xposSpans },
            { id: 'features-layer', config: { ud: { features: true } }, spans: featSpans },
          ],
        },
      ],
    }],
  };
}
