import { describe, it, expect, vi, beforeEach } from 'vitest';
import { MemoryRouter } from 'react-router-dom';
import { renderComponent } from '@ui/test/renderComponent.jsx';
import { parseUmrFile } from '../../../domain/format/umrFile.js';
import { planImport } from '../../../domain/umrImport.js';
import { UmrDocument } from '../../../domain/UmrDocument.js';
import { rawFromPlan } from '../../../../test/rawFromPlan.js';
import { recordingClient } from '../../../../test/recordingClient.js';
import { UmrCanvas } from './UmrCanvas.jsx';

// Every node drawn, counted by variable: a node is drawn once per render of
// its sentence's block. It draws what the block hands it, tags included, so
// a stale block shows here as a stale node.
const drawn = vi.hoisted(() => new Map());
vi.mock('./UmrNode.jsx', () => ({
  UmrNode: ({ node, nodeRef, docTags }) => {
    drawn.set(node.var, (drawn.get(node.var) || 0) + 1);
    return (
      <div ref={nodeRef} className="umr-node" data-node-var={node.var}>
        {[node.concept, ...(docTags || []).map((t) => t.text)].join(' | ')}
      </div>
    );
  },
}));

const block = (n, words, graph, alignment) => `${'#'.repeat(80)}
# :: snt${n}\t${words}
Index: ${words
  .split(' ')
  .map((_, i) => i + 1)
  .join(' ')}
Words: ${words}

# sentence level graph:
${graph}

# alignment:
${alignment}

# document level annotation:
(s${n}s0 / sentence)

`;

const FILE =
  block(1, 'Lindsay left', '(s1l / leave-02 :ARG0 (s1p / person))', 's1l: 2-2\ns1p: 1-1') +
  block(2, 'She ate', '(s2e / eat-01 :ARG0 (s2p / person))', 's2e: 2-2\ns2p: 1-1');

const load = () => {
  const raw = structuredClone(rawFromPlan(planImport(parseUmrFile(FILE).sentences, [])));
  const { client } = recordingClient();
  const doc = new UmrDocument({ raw, client });
  doc._reload = async () => {};
  return doc;
};

const canvas = (doc) => (
  <MemoryRouter>
    <UmrCanvas doc={doc} readOnly={false} />
  </MemoryRouter>
);
const nodeOf = (doc, v) => [...doc.graph.nodesById.values()].find((n) => n.var === v);
const shown = (container, v) => container.querySelector(`[data-node-var="${v}"]`).textContent;

// V8 F8: an edit re-rendered every sentence block on the page, 25 of them,
// because three of each block's props changed with every version.
describe('UmrCanvas, after an edit', () => {
  beforeEach(() => {
    drawn.clear();
    localStorage.clear();
  });

  it('draws again only the sentence the edit changed', async () => {
    const doc = load();
    const r = await renderComponent(canvas(doc));
    const before = { s1l: drawn.get('s1l'), s2e: drawn.get('s2e') };
    await r.step(() => doc.setConcept(nodeOf(doc, 's2e').id, 'devour-01'));
    await r.rerender(canvas(doc));
    expect(shown(r.container, 's2e')).toBe('devour-01');
    expect(drawn.get('s2e')).toBeGreaterThan(before.s2e);
    expect(drawn.get('s1l')).toBe(before.s1l);
    await r.unmount();
  });

  // A triple made in sentence 2's block reaches into sentence 1, whose block
  // the edit did not start in: that block has to draw the new tag.
  it('draws a document relation into a sentence from the other end', async () => {
    const doc = load();
    const r = await renderComponent(canvas(doc));
    await r.step(() =>
      doc.createTriple({
        source: nodeOf(doc, 's2p').id,
        target: nodeOf(doc, 's1p').id,
        rel: ':same-entity',
        group: 'coref',
        sentenceIndex: 2,
      }),
    );
    await r.rerender(canvas(doc));
    expect(shown(r.container, 's1p')).toBe('person | s2p :same-entity');
    expect(shown(r.container, 's2p')).toBe('person | :same-entity s1p');
    await r.unmount();
  });

  // And one renamed at the far end: the tag names the other node's variable.
  it('draws a far node renamed in its tag', async () => {
    const doc = load();
    const r = await renderComponent(canvas(doc));
    await r.step(() =>
      doc.createTriple({
        source: nodeOf(doc, 's2p').id,
        target: nodeOf(doc, 's1p').id,
        rel: ':same-entity',
        group: 'coref',
        sentenceIndex: 2,
      }),
    );
    await r.rerender(canvas(doc));
    await r.step(() => doc.setVariable(nodeOf(doc, 's2p').id, 's2x'));
    await r.rerender(canvas(doc));
    expect(shown(r.container, 's1p')).toBe('person | s2x :same-entity');
    await r.unmount();
  });
});
