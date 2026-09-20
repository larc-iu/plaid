import { describe, it, expect } from 'vitest';
import { renderComponent, all, texts } from '@ui/test/renderComponent.jsx';
import { SentenceBlock } from './SentenceBlock.jsx';

// A sentence as buildDocumentGraph hands it over: three nodes, one of them
// unaligned, one re-entrant edge, two gloss lines.
const fixture = () => {
  const words = [
    { id: 'w1', index: 1, begin: 0, end: 7, text: 'Lindsay' },
    { id: 'w2', index: 2, begin: 8, end: 12, text: 'left' },
    { id: 'w3', index: 3, begin: 13, end: 16, text: 'eat' },
  ];
  const mk = (id, v, concept, wordIds, attrs = []) => ({
    id,
    var: v,
    concept,
    wordIds,
    pieces: wordIds.length ? [{ begin: 0, end: 1 }] : [{ begin: 0, end: 0 }],
    aligned: wordIds.length > 0,
    constant: false,
    sentence: 1,
    attrs,
    out: [],
    in: [],
  });
  const leave = mk('n1', 's1l', 'leave-02', ['w2'], [{ rel: ':aspect', value: 'performance' }]);
  const person = mk('n2', 's1p', 'person', []);
  const eat = mk('n3', 's1e', 'eat-01', ['w3']);
  const e1 = { id: 'e1', source: 'n1', target: 'n2', role: ':ARG0', order: 0 };
  const e2 = { id: 'e2', source: 'n1', target: 'n3', role: ':purpose', order: 1 };
  const e3 = { id: 'e3', source: 'n3', target: 'n2', role: ':ARG0', order: 0 };
  leave.out.push(e1, e2);
  person.in.push(e1, e3);
  eat.in.push(e2);
  eat.out.push(e3);
  const nodesById = new Map([
    ['n1', leave],
    ['n2', person],
    ['n3', eat],
  ]);
  const sentence = {
    index: 1,
    tokenId: 't1',
    text: 'Lindsay left eat',
    words,
    morphemes: [],
    ilg: [
      {
        header: 'Word Gloss (en)',
        key: 'word-gloss',
        lang: 'en',
        items: ['L.', 'go', 'eat'],
        perWord: [['L.'], ['go'], ['eat']],
      },
      {
        header: 'Sentence Gloss (en)',
        key: 'sentence-gloss',
        lang: 'en',
        items: ['Lindsay', 'went'],
        perWord: null,
      },
    ],
    nodes: [leave, person, eat],
    edges: [e1, e2, e3],
    triples: [],
    roots: [leave],
  };
  return { sentence, nodesById };
};

describe('SentenceBlock', () => {
  it('draws every node, edge label and word with its gloss', async () => {
    const { sentence, nodesById } = fixture();
    const r = await renderComponent(
      <SentenceBlock sentence={sentence} nodesById={nodesById} dataVersion={1} />,
    );
    expect(texts(r.container, '.umr-node-concept')).toEqual(['leave-02', 'person', 'eat-01']);
    expect(texts(r.container, '.umr-node-var')).toEqual(['s1l', 's1p', 's1e']);
    expect(all(r.container, '.umr-node--unaligned')).toHaveLength(1);
    expect(texts(r.container, '.umr-chip-rel')).toEqual(['aspect']);
    expect(texts(r.container, '.umr-chip-value')).toEqual(['performance']);
    expect(texts(r.container, '.umr-word-text')).toEqual(['Lindsay', 'left', 'eat']);
    expect(texts(r.container, '.umr-word-gloss')).toEqual(['L.', 'go', 'eat']);
    // The sentence gloss has fewer items than words, so it runs as its own row.
    expect(texts(r.container, '.umr-ilg-items')).toEqual(['Lindsay went']);
    // happy-dom measures nothing, so the block stays in its measuring pass:
    // edges and labels wait for real positions. Nodes are in the DOM for it.
    expect(all(r.container, '.umr-node')).toHaveLength(3);
    await r.unmount();
  });

  it('says nothing about a sentence with no graph, which says so by being empty', async () => {
    const { sentence, nodesById } = fixture();
    const r = await renderComponent(
      <SentenceBlock
        sentence={{ ...sentence, nodes: [], edges: [], roots: [] }}
        nodesById={nodesById}
        dataVersion={1}
      />,
    );
    expect(texts(r.container, '.umr-block-note')).toEqual([]);
    await r.unmount();
  });

  // The opposite case, and the reason the one above is safe to drop: this
  // sentence looks just as empty and is not.
  it('says when a graph is there but could not be read', async () => {
    const { sentence, nodesById } = fixture();
    const r = await renderComponent(
      <SentenceBlock
        sentence={{ ...sentence, nodes: [], edges: [], roots: [], rawGraph: '(s1x / broken' }}
        nodesById={nodesById}
        dataVersion={1}
      />,
    );
    expect(texts(r.container, '.umr-block-note')).toEqual([
      'Graph kept as text, could not be read',
    ]);
    await r.unmount();
  });
});
