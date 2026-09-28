import { describe, it, expect, afterEach, vi } from 'vitest';
import { CommentStore } from '@ui/domain/CommentStore.js';
import { renderComponent, all, texts } from '@ui/test/renderComponent.jsx';
import { ConfirmProvider } from '@ui/components/shared/ConfirmProvider.jsx';
import { useMemo } from 'react';
import { SentenceBlock as Block } from './SentenceBlock.jsx';
import { keys } from '../../../lib/keymap.js';

// The canvas hands a block the live document, and the block reads the whole
// document's nodes from `doc.graph` when it needs them. A test builds the map
// itself and hands it in here, where it is set on the stub in place: a
// rerender with a new map and a new sentence is what a new version of the
// document is, and a rerender with neither is a version that left this
// sentence alone.
const SentenceBlock = ({ doc, nodesById = new Map(), dataVersion: _version, ...props }) => {
  const stub = useMemo(
    () => doc ?? { canConfirmSentence: () => false, canDiscardSentence: () => false },
    [doc],
  );
  if (!stub.graph) stub.graph = {};
  stub.graph.nodesById = nodesById;
  return <Block doc={stub} {...props} />;
};

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
    expect(texts(r.container, '.umr-block-note')).toEqual(['Unreadable graph, stored as text']);
    await r.unmount();
  });
});

// RTL. The words run right to left and the graph follows, because the nodes
// are placed over measured word positions; what the block has to get right
// is which box carries the direction and which keeps counting from the left.
describe('SentenceBlock in a right-to-left document', () => {
  it('gives the scroller and the word row the direction, and keeps the stage physical', async () => {
    const { sentence, nodesById } = fixture();
    const r = await renderComponent(
      <SentenceBlock sentence={sentence} nodesById={nodesById} dataVersion={1} direction="rtl" />,
    );
    // The scroller, so a long sentence opens at its start edge.
    expect(r.container.querySelector('.umr-canvas').getAttribute('dir')).toBe('rtl');
    expect(r.container.querySelector('.umr-tokens').getAttribute('dir')).toBe('rtl');
    // The stage says nothing: its axis is the stylesheet's `direction: ltr`,
    // because every node sits at a measured pixel offset from its left.
    expect(r.container.querySelector('.umr-stage').hasAttribute('dir')).toBe(false);
    await r.unmount();
  });

  it('leaves a left-to-right document alone', async () => {
    const { sentence, nodesById } = fixture();
    const r = await renderComponent(
      <SentenceBlock sentence={sentence} nodesById={nodesById} dataVersion={1} />,
    );
    expect(r.container.querySelector('.umr-canvas').getAttribute('dir')).toBe('ltr');
    await r.unmount();
  });

  // A line from a node to a document constant ends at the sticky margin,
  // which rides the canvas's visible left edge. An RTL scroller counts
  // `scrollLeft` from its RIGHT edge and opens there, so reading it as a
  // distance from the left drew the line a whole overflow width away from
  // the chip it points at, off screen, before anyone had scrolled anything.
  const withDocTriple = () => {
    const { sentence, nodesById } = fixture();
    const author = {
      id: 'c1',
      var: 'author',
      concept: 'author',
      wordIds: [],
      pieces: [],
      aligned: false,
      constant: true,
      sentence: 1,
      attrs: [],
      out: [],
      in: [],
    };
    nodesById.set('c1', author);
    return {
      nodesById,
      sentence: {
        ...sentence,
        triples: [
          { id: 'tr1', source: 'c1', target: 'n1', rel: ':full-affirmative', group: 'modal' },
        ],
      },
    };
  };

  // A canvas 400 wide holding 1000 of stage: 600 of it is off to one side.
  const overflowing = (canvas) => {
    Object.defineProperty(canvas, 'scrollWidth', { value: 1000, configurable: true });
    Object.defineProperty(canvas, 'clientWidth', { value: 400, configurable: true });
  };

  const docEdgeX = async (direction) => {
    const { sentence, nodesById } = withDocTriple();
    const r = await renderComponent(
      <SentenceBlock
        sentence={sentence}
        nodesById={nodesById}
        dataVersion={1}
        direction={direction}
      />,
    );
    const canvas = r.container.querySelector('.umr-canvas');
    overflowing(canvas);
    // Nothing has been scrolled: the canvas is at its own start edge.
    await r.step(() => canvas.dispatchEvent(new Event('scroll')));
    await r.step(() =>
      r.container
        .querySelector('[data-node-id]')
        .dispatchEvent(new MouseEvent('mouseover', { bubbles: true })),
    );
    const d = r.container.querySelector('.umr-doc-edge')?.getAttribute('d');
    await r.unmount();
    return Number(d?.match(/^M (-?[\d.]+) /)?.[1]);
  };

  it('draws the line to a document constant where the chip is, in either script', async () => {
    // Left to right, at rest: the margin is the stage's own left edge.
    expect(await docEdgeX('ltr')).toBe(180);
    // Right to left, at rest: the canvas opens showing the far end of the
    // stage, and the margin rides the left edge of that view.
    expect(await docEdgeX('rtl')).toBe(780);
  });
});

describe('SentenceBlock text mode', () => {
  const type = (el, value) => {
    const setter = Object.getOwnPropertyDescriptor(HTMLTextAreaElement.prototype, 'value').set;
    setter.call(el, value);
    el.dispatchEvent(new Event('input', { bubbles: true }));
  };
  const button = (root, name) => all(root, 'button').find((b) => b.textContent.trim() === name);

  // Apply shows the plan at once and closes text mode. A write that does not
  // land (refused, or skipped behind an earlier refused edit) takes the plan
  // off the canvas again, so the typed text is all that is left of it.
  it.each([
    ['refused', false, 'reopens with the typed text'],
    ['landed', 1, 'stays closed'],
  ])('an apply that is %s %s', async (_what, outcome) => {
    const { sentence, nodesById } = fixture();
    let settle;
    const doc = {
      graph: {},
      canConfirmSentence: () => false,
      canDiscardSentence: () => false,
      penmanOf: () => '(s1l / leave-02)',
      planPenman: () => ({ changes: 1 }),
      applyPenman: () =>
        new Promise((resolve) => {
          settle = resolve;
        }),
    };
    const r = await renderComponent(
      <SentenceBlock
        doc={doc}
        sentence={sentence}
        nodesById={nodesById}
        dataVersion={1}
        readOnly={false}
      />,
    );
    await r.step(() => button(r.container, 'Text').click());
    const typed = '(s1l / leave-02\n    :ARG0 (s1z / zebra))';
    await r.step(() => type(r.container.querySelector('textarea'), typed));
    await r.step(() => button(r.container, 'Apply').click());
    expect(r.container.querySelector('textarea')).toBeNull();
    await r.step(() => settle(outcome));
    const box = r.container.querySelector('textarea');
    if (outcome === false) {
      expect(box.value).toBe(typed);
      // Still typed and not applied, so Apply is offered again.
      expect(button(r.container, 'Apply').disabled).toBe(false);
    } else {
      expect(box).toBeNull();
    }
    await r.unmount();
  });
});

describe('SentenceBlock review', () => {
  const button = (root, name) => all(root, 'button').find((b) => b.textContent.trim() === name);

  it("offers Accept graph, in the review pair's violet, while the sentence has something to accept", async () => {
    const { sentence, nodesById } = fixture();
    const confirmed = [];
    const doc = (open) => ({
      graph: {},
      canConfirmSentence: () => open,
      canDiscardSentence: () => false,
      confirmSentence: async (i) => confirmed.push(i),
    });
    const r = await renderComponent(
      <SentenceBlock
        doc={doc(true)}
        sentence={sentence}
        nodesById={nodesById}
        dataVersion={1}
        readOnly={false}
      />,
    );
    expect(button(r.container, 'Accept graph').classList).toContain('plaid-review--accept');
    await r.step(() => button(r.container, 'Accept graph').click());
    expect(confirmed).toEqual([1]);
    await r.rerender(
      <SentenceBlock
        doc={doc(false)}
        sentence={sentence}
        nodesById={nodesById}
        dataVersion={2}
        readOnly={false}
      />,
    );
    expect(button(r.container, 'Accept graph')).toBeUndefined();
    await r.unmount();
  });
});

describe('SentenceBlock discard', () => {
  const button = (root, name) => all(root, 'button').find((b) => b.textContent.trim() === name);
  const wait = (ms) => new Promise((resolve) => setTimeout(resolve, ms));
  const dialog = () => document.querySelector('[role="alertdialog"]');

  const setup = async ({ readOnly = false, open = true, otherRelations = 0 } = {}) => {
    const { sentence, nodesById } = fixture();
    const discarded = [];
    const doc = {
      graph: {},
      canConfirmSentence: () => open,
      confirmSentence: async () => true,
      canDiscardSentence: () => open,
      discardPlan: () => ({
        nodes: sentence.nodes.slice(0, 2),
        relations: sentence.edges,
        otherRelations,
      }),
      discardSentence: async (i) => discarded.push(i),
    };
    const r = await renderComponent(
      <ConfirmProvider>
        <SentenceBlock
          doc={doc}
          sentence={sentence}
          nodesById={nodesById}
          dataVersion={1}
          readOnly={readOnly}
        />
      </ConfirmProvider>,
    );
    return { r, discarded };
  };

  it('offers Discard graph beside Accept graph, in the red outline, and asks first', async () => {
    const { r, discarded } = await setup();
    const discard = button(r.container, 'Discard graph');
    expect(discard.classList).toContain('plaid-review--discard');
    expect(discard.previousElementSibling.textContent.trim()).toBe('Accept graph');
    await r.step(() => discard.click());
    await r.step(() => wait(50));
    expect(dialog()).not.toBeNull();
    expect(dialog().querySelector('h2').textContent.trim()).toBe('Discard the drafted graph?');
    expect(dialog().textContent).toContain('2 nodes and 3 relations. Restorable from History.');
    expect(discarded).toEqual([]);
    await r.step(() => button(dialog(), 'Discard').click());
    await r.step(() => wait(50));
    expect(discarded).toEqual([1]);
    await r.unmount();
  });

  it('says how many drafted relations other sentences lose, only when some do', async () => {
    for (const [other, line] of [
      [
        2,
        '2 nodes and 1 relation. Also removes 2 drafted relations from other sentences. Restorable from History.',
      ],
      [
        1,
        '2 nodes and 2 relations. Also removes 1 drafted relation from another sentence. Restorable from History.',
      ],
      [
        3,
        '2 nodes. Also removes 3 drafted relations from other sentences. Restorable from History.',
      ],
    ]) {
      const { r } = await setup({ otherRelations: other });
      await r.step(() => button(r.container, 'Discard graph').click());
      await r.step(() => wait(50));
      expect(dialog().textContent).toContain(line);
      await r.step(() => button(dialog(), 'Cancel').click());
      await r.step(() => wait(50));
      await r.unmount();
    }
    const { r } = await setup();
    await r.step(() => button(r.container, 'Discard graph').click());
    await r.step(() => wait(50));
    expect(dialog().textContent).not.toContain('Also removes');
    await r.step(() => button(dialog(), 'Cancel').click());
    await r.step(() => wait(50));
    await r.unmount();
  });

  it('discards nothing when the question is cancelled', async () => {
    const { r, discarded } = await setup();
    await r.step(() => button(r.container, 'Discard graph').click());
    await r.step(() => wait(50));
    await r.step(() => button(dialog(), 'Cancel').click());
    await r.step(() => wait(50));
    expect(discarded).toEqual([]);
    await r.unmount();
  });

  it('is not offered to a reader, at a past state, or with nothing drafted', async () => {
    for (const opts of [{ readOnly: true }, { open: false }]) {
      const { r } = await setup(opts);
      expect(button(r.container, 'Discard graph')).toBeUndefined();
      await r.unmount();
    }
  });
});

describe('SentenceBlock node menu', () => {
  const wait = (ms) => new Promise((resolve) => setTimeout(resolve, ms));
  const nodeEl = (root, concept) =>
    all(root, '.umr-node').find(
      (n) => n.querySelector('.umr-node-concept')?.textContent === concept,
    );

  // The menu hands focus back only once it has really gone, after its exit
  // animation. The action it ran may have moved focus by then: a delete
  // hands it to the parent. Handing it to the node the menu was opened on
  // named a node that no longer exists, so nothing was focused and every key
  // went to the page.
  it('leaves focus on the parent after deleting a node from its menu', async () => {
    const { sentence, nodesById } = fixture();
    const deleted = [];
    const doc = {
      graph: {},
      canConfirmSentence: () => false,
      canDiscardSentence: () => false,
      canConfirm: () => false,
      orphanedBy: () => [],
      deleteNode: (id) => deleted.push(id),
    };
    const props = { doc, dataVersion: 1, readOnly: false };
    const r = await renderComponent(
      <SentenceBlock {...props} sentence={sentence} nodesById={nodesById} />,
    );
    await r.step(() =>
      nodeEl(r.container, 'eat-01').dispatchEvent(
        new MouseEvent('contextmenu', { bubbles: true, cancelable: true }),
      ),
    );
    const item = all(document, '[role="menuitem"]').find((m) =>
      m.textContent.includes('Delete node and all below it'),
    );
    await r.step(() => item.click());
    expect(deleted).toEqual(['n3']);
    // The document without the node, as the next render has it.
    const eat = nodesById.get('n3');
    const leave = nodesById.get('n1');
    const after = new Map([...nodesById].filter(([id]) => id !== 'n3'));
    after.set('n1', { ...leave, out: leave.out.filter((e) => e.target !== 'n3') });
    await r.rerender(
      <SentenceBlock
        {...props}
        dataVersion={2}
        nodesById={after}
        sentence={{
          ...sentence,
          nodes: sentence.nodes.filter((n) => n !== eat),
          edges: sentence.edges.filter((e) => e.source !== 'n3' && e.target !== 'n3'),
          roots: [after.get('n1')],
        }}
      />,
    );
    // The menu's close, then the frame it waits for.
    await r.step(() => wait(100));
    expect(document.querySelector('[role="menu"]')).toBeNull();
    expect(document.activeElement).toBe(nodeEl(r.container, 'leave-02'));
    expect(texts(r.container, '.umr-node--focused .umr-node-concept')).toEqual(['leave-02']);
    await r.unmount();
  });
});

describe('SentenceBlock node menu, the last node', () => {
  const wait = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

  // Deleting a sentence's only node leaves nothing to hand focus to, so the
  // block itself takes it. The menu's late hand-back must not then take it
  // away to the page, where every key is dead.
  it('leaves focus on the block after deleting its only node from the menu', async () => {
    const { sentence, nodesById } = fixture();
    const lone = { ...nodesById.get('n1'), out: [], in: [] };
    const only = new Map([['n1', lone]]);
    const deleted = [];
    const doc = {
      graph: {},
      canConfirmSentence: () => false,
      canDiscardSentence: () => false,
      canConfirm: () => false,
      orphanedBy: () => [],
      deleteNode: (id) => deleted.push(id),
    };
    const props = { doc, dataVersion: 1, readOnly: false };
    const one = { ...sentence, nodes: [lone], edges: [], roots: [lone] };
    const r = await renderComponent(<SentenceBlock {...props} sentence={one} nodesById={only} />);
    const node = all(r.container, '.umr-node')[0];
    await r.step(() =>
      node.dispatchEvent(new MouseEvent('contextmenu', { bubbles: true, cancelable: true })),
    );
    const item = all(document, '[role="menuitem"]').find((m) =>
      m.textContent.includes('Delete node and all below it'),
    );
    await r.step(() => item.click());
    expect(deleted).toEqual(['n1']);
    await r.rerender(
      <SentenceBlock
        {...props}
        dataVersion={2}
        nodesById={new Map()}
        sentence={{ ...one, nodes: [], roots: [] }}
      />,
    );
    await r.step(() => wait(100));
    expect(document.querySelector('[role="menu"]')).toBeNull();
    expect(document.activeElement).toBe(r.container.querySelector('section'));
    await r.unmount();
  });
});

// Move earlier and later are reading order, and in an RTL sentence siblings
// read right to left: Alt+ArrowLeft moves a node on to the LEFT, which there
// is later. Unmirrored, the key moved the node against the way it points.
describe('SentenceBlock moving a node among its siblings', () => {
  const press = async (direction, key) => {
    const { sentence, nodesById } = fixture();
    const shifted = [];
    const doc = {
      graph: {},
      canConfirmSentence: () => false,
      canDiscardSentence: () => false,
      canConfirm: () => false,
      shiftEdge: (edgeId, step) => shifted.push([edgeId, step]),
    };
    const r = await renderComponent(
      <SentenceBlock
        doc={doc}
        dataVersion={1}
        readOnly={false}
        direction={direction}
        sentence={sentence}
        nodesById={nodesById}
      />,
    );
    const node = all(r.container, '.umr-node').find(
      (n) => n.querySelector('.umr-node-concept')?.textContent === 'person',
    );
    await r.step(() => node.focus());
    await r.step(() =>
      node.dispatchEvent(
        new KeyboardEvent('keydown', { key, altKey: true, bubbles: true, cancelable: true }),
      ),
    );
    await r.unmount();
    return shifted;
  };

  it.each([
    ['ltr', 'ArrowLeft', -1],
    ['ltr', 'ArrowRight', 1],
    ['rtl', 'ArrowLeft', 1],
    ['rtl', 'ArrowRight', -1],
  ])('in %s, Alt+%s moves the node %i in the file', async (direction, key, step) => {
    expect(await press(direction, key)).toEqual([['e1', step]]);
  });
});

// Left and Right trade places in an RTL sentence, in the CHORD, so a person
// who moved one of the pair onto another key still has a key for each: with
// Move earlier on Alt+J, swapping the ACTION made Alt+ArrowRight a second key
// for earlier and left nothing that moved a node later.
describe('SentenceBlock moving a node among its siblings, rebound', () => {
  const press = async (direction, key, mods = { altKey: true }) => {
    const { sentence, nodesById } = fixture();
    const shifted = [];
    const doc = {
      graph: {},
      canConfirmSentence: () => false,
      canDiscardSentence: () => false,
      canConfirm: () => false,
      shiftEdge: (edgeId, step) => shifted.push([edgeId, step]),
    };
    const r = await renderComponent(
      <SentenceBlock
        doc={doc}
        dataVersion={1}
        readOnly={false}
        direction={direction}
        sentence={sentence}
        nodesById={nodesById}
      />,
    );
    const node = all(r.container, '.umr-node').find(
      (n) => n.querySelector('.umr-node-concept')?.textContent === 'person',
    );
    await r.step(() => node.focus());
    await r.step(() =>
      node.dispatchEvent(
        new KeyboardEvent('keydown', {
          key,
          code: key.length === 1 ? `Key${key.toUpperCase()}` : key,
          ...mods,
          bubbles: true,
          cancelable: true,
        }),
      ),
    );
    await r.unmount();
    return shifted;
  };

  afterEach(() => keys.setOverrides({}));

  it.each([
    ['ltr', 'ArrowLeft', []],
    ['ltr', 'ArrowRight', [['e1', 1]]],
    ['ltr', 'j', [['e1', -1]]],
    ['rtl', 'ArrowLeft', [['e1', 1]]],
    ['rtl', 'ArrowRight', []],
    ['rtl', 'j', [['e1', -1]]],
  ])('with Move earlier on Alt+J, in %s Alt+%s moves %j', async (direction, key, moved) => {
    keys.setOverrides({ 'node.earlier': ['Alt+J'] });
    expect(await press(direction, key)).toEqual(moved);
  });

  // Another action on a sideways arrow means what it says in either script.
  it('leaves an action that is not a move alone', async () => {
    keys.setOverrides({ 'node.root': ['Alt+Shift+ArrowLeft'] });
    const { sentence, nodesById } = fixture();
    const roots = [];
    const doc = {
      graph: {},
      canConfirmSentence: () => false,
      canDiscardSentence: () => false,
      canConfirm: () => false,
      setRoot: (id) => roots.push(id),
    };
    const r = await renderComponent(
      <SentenceBlock
        doc={doc}
        dataVersion={1}
        readOnly={false}
        direction="rtl"
        sentence={sentence}
        nodesById={nodesById}
      />,
    );
    const node = all(r.container, '.umr-node').find(
      (n) => n.querySelector('.umr-node-concept')?.textContent === 'eat-01',
    );
    await r.step(() => node.focus());
    const ev = new KeyboardEvent('keydown', {
      key: 'ArrowLeft',
      code: 'ArrowLeft',
      altKey: true,
      shiftKey: true,
      bubbles: true,
      cancelable: true,
    });
    await r.step(() => node.dispatchEvent(ev));
    expect(roots).toEqual(['n3']);
    await r.unmount();
  });
});

// The menu names the key that does the move in THIS sentence: in an RTL one
// the earlier sibling is to the right, so Move earlier is Alt+Right there.
describe('SentenceBlock node menu, the move keys', () => {
  const rows = async (direction) => {
    const { sentence, nodesById } = fixture();
    const doc = {
      graph: {},
      canConfirmSentence: () => false,
      canDiscardSentence: () => false,
      canConfirm: () => false,
    };
    const r = await renderComponent(
      <SentenceBlock
        doc={doc}
        dataVersion={1}
        readOnly={false}
        direction={direction}
        sentence={sentence}
        nodesById={nodesById}
      />,
    );
    const node = all(r.container, '.umr-node').find(
      (n) => n.querySelector('.umr-node-concept')?.textContent === 'person',
    );
    await r.step(() =>
      node.dispatchEvent(new MouseEvent('contextmenu', { bubbles: true, cancelable: true })),
    );
    const hint = (label) =>
      all(document, '[role="menuitem"]')
        .find((m) => m.firstChild?.textContent === label)
        ?.lastChild?.textContent.replace('Option', 'Alt');
    const out = [hint('Move earlier'), hint('Move later')];
    await r.unmount();
    return out;
  };

  afterEach(() => keys.setOverrides({}));

  it('says Alt+← for earlier in LTR and Alt+→ in RTL', async () => {
    expect(await rows('ltr')).toEqual(['Alt+←', 'Alt+→']);
    expect(await rows('rtl')).toEqual(['Alt+→', 'Alt+←']);
  });

  it('says a key that is not an arrow as it is', async () => {
    keys.setOverrides({ 'node.earlier': ['Alt+J'] });
    expect(await rows('rtl')).toEqual(['Alt+J', 'Alt+←']);
  });
});

// A comment can start from a sentence, as in plaid-ud: the shared Comment
// action sits in the block's header, anchored to the sentence token.
describe('SentenceBlock comments', () => {
  const makeStore = async (rows = []) => {
    const client = {
      comments: {
        list: vi.fn(async () => rows),
        create: vi.fn(),
        update: vi.fn(),
        delete: vi.fn(),
      },
      users: { get: vi.fn(async (id) => ({ id, displayName: id })) },
    };
    const store = new CommentStore({
      client,
      projectId: 'p1',
      documentId: 'd1',
      currentUserId: 'me@x.com',
    });
    store.onError = () => {};
    await store.load();
    return store;
  };
  const comment = (id, entityId) => ({
    id,
    projectId: 'p1',
    documentId: 'd1',
    entityType: 'token',
    entityId,
    authorId: 'me@x.com',
    body: `comment ${id}`,
    createdAt: '2026-09-01T00:00:00.000Z',
    updatedAt: '2026-09-01T00:00:00.000Z',
    edited: false,
  });
  const mount = (props) => {
    const { sentence, nodesById } = fixture();
    return renderComponent(
      <SentenceBlock sentence={sentence} nodesById={nodesById} dataVersion={1} {...props} />,
    );
  };

  it('offers a writer the Comment action in the header, in the pill look', async () => {
    const store = await makeStore();
    const r = await mount({ comments: store, canComment: true, commentAnchorLabel: 'Sentence 1' });
    const btn = r.container.querySelector('.umr-block-header .umr-comment-toggle');
    expect(btn).not.toBeNull();
    expect(btn.getAttribute('aria-label')).toBe('Comment on this sentence');
    await r.unmount();
  });

  it("shows a reader this sentence's count, and nothing where nobody has written", async () => {
    const store = await makeStore([
      comment('c1', 't1'),
      comment('c2', 't1'),
      comment('c3', 'other'),
    ]);
    const r = await mount({ comments: store, canComment: false, readOnly: true });
    const btn = r.container.querySelector('.umr-comment-toggle');
    expect(btn.getAttribute('data-count')).toBe('2');
    await r.unmount();

    const empty = await makeStore([comment('c3', 'other')]);
    const r2 = await mount({ comments: empty, canComment: false, readOnly: true });
    expect(r2.container.querySelector('.umr-comment-toggle')).toBeNull();
    await r2.unmount();
  });

  // The header sits inside the block, so its buttons' keys bubbled into the
  // graph's: with a node focused, Enter on Comment opened the node's concept
  // editor (and was prevented, so the thread never opened).
  it("leaves the header's buttons their own keys while a node is focused", async () => {
    const store = await makeStore();
    const doc = {
      canConfirmSentence: () => false,
      canDiscardSentence: () => false,
      canConfirm: () => false,
      graph: {},
    };
    const r = await mount({ comments: store, canComment: true, readOnly: false, doc });
    const node = r.container.querySelector('.umr-node');
    await r.step(() => node.focus());
    for (const selector of ['.umr-comment-toggle', '.umr-text-toggle']) {
      const button = r.container.querySelector(`.umr-block-header ${selector}`);
      await r.step(() => button.focus());
      for (const key of ['Enter', 'ArrowDown', 'Tab']) {
        const ev = new KeyboardEvent('keydown', { key, bubbles: true, cancelable: true });
        await r.step(() => button.dispatchEvent(ev));
        expect([selector, key, ev.defaultPrevented]).toEqual([selector, key, false]);
      }
    }
    expect(document.querySelector('.umr-inline-editor')).toBeNull();
    await r.unmount();
  });

  it('draws no Comment action without a store (a past state)', async () => {
    const r = await mount({ comments: null, canComment: true });
    expect(r.container.querySelector('.umr-comment-toggle')).toBeNull();
    await r.unmount();
  });
});

// Ask on the sentence row, as in plaid-ud: it opens the assistant on "s1".
// Asking is a read, so a reader gets it too. The editor hands no handler
// where there is no assistant, no room for its panel, or a past state.
describe('SentenceBlock Ask', () => {
  const mount = (props) => {
    const { sentence, nodesById } = fixture();
    return renderComponent(
      <SentenceBlock sentence={sentence} nodesById={nodesById} dataVersion={1} {...props} />,
    );
  };
  const askButton = (r) =>
    all(r.container, '.umr-block-header button').find((b) => b.textContent.trim() === 'Ask');

  it('opens the assistant on this sentence, for a writer and for a reader', async () => {
    for (const readOnly of [false, true]) {
      const onAskAssistant = vi.fn();
      const r = await mount({ onAskAssistant, readOnly });
      const button = askButton(r);
      expect(button).toBeTruthy();
      await r.step(() => button.click());
      expect(onAskAssistant).toHaveBeenCalledWith({ ref: 's1', label: 'Sentence' });
      await r.unmount();
    }
  });

  it('is not drawn without a handler', async () => {
    const r = await mount({});
    expect(askButton(r)).toBeUndefined();
    await r.unmount();
  });

  it('keeps its own keys while a node is focused', async () => {
    const doc = {
      canConfirmSentence: () => false,
      canDiscardSentence: () => false,
      canConfirm: () => false,
      graph: {},
    };
    const r = await mount({ onAskAssistant: vi.fn(), readOnly: false, doc });
    await r.step(() => r.container.querySelector('.umr-node').focus());
    const button = askButton(r);
    await r.step(() => button.focus());
    for (const key of ['Enter', 'ArrowDown', 'Tab']) {
      const ev = new KeyboardEvent('keydown', { key, bubbles: true, cancelable: true });
      await r.step(() => button.dispatchEvent(ev));
      expect([key, ev.defaultPrevented]).toEqual([key, false]);
    }
    await r.unmount();
  });
});

// The UMR round of 2026-09-28: the keyboard's ways in and back, and the
// problem list.
describe('SentenceBlock keyboard, with no node focused', () => {
  const wait = (ms) => new Promise((resolve) => setTimeout(resolve, ms));
  const docStub = (extra = {}) => ({
    graph: {},
    canConfirmSentence: () => false,
    canDiscardSentence: () => false,
    canConfirm: () => false,
    ...extra,
  });
  const press = (el, key, init = {}) =>
    el.dispatchEvent(
      new KeyboardEvent('keydown', { key, bubbles: true, cancelable: true, ...init }),
    );

  it('gives an empty sentence a keyboard stop, where n starts a node', async () => {
    const { sentence, nodesById } = fixture();
    const empty = { ...sentence, nodes: [], edges: [], roots: [] };
    const r = await renderComponent(
      <SentenceBlock
        doc={docStub()}
        dataVersion={1}
        readOnly={false}
        sentence={empty}
        nodesById={nodesById}
      />,
    );
    const stop = r.container.querySelector('.umr-graph');
    expect(stop.tabIndex).toBe(0);
    expect(stop.getAttribute('aria-label')).toBe('No graph. N adds a node.');
    await r.step(() => stop.focus());
    await r.step(() => press(stop, 'n'));
    expect(r.container.querySelector('.umr-inline-editor input')).not.toBeNull();
    // Escape hands focus back to the stop, not to the page.
    await r.step(() => press(r.container.querySelector('.umr-inline-editor input'), 'Escape'));
    await r.step(() => wait(20));
    expect(r.container.querySelector('.umr-inline-editor input')).toBeNull();
    expect(document.activeElement).toBe(stop);
    await r.unmount();
  });

  it('is no stop in a sentence with a graph, or for a reader', async () => {
    const { sentence, nodesById } = fixture();
    const withGraph = await renderComponent(
      <SentenceBlock
        doc={docStub()}
        dataVersion={1}
        readOnly={false}
        sentence={sentence}
        nodesById={nodesById}
      />,
    );
    expect(withGraph.container.querySelector('.umr-graph').hasAttribute('tabindex')).toBe(false);
    await withGraph.unmount();
    const reader = await renderComponent(
      <SentenceBlock
        doc={docStub()}
        dataVersion={1}
        sentence={{ ...sentence, nodes: [], edges: [], roots: [] }}
        nodesById={nodesById}
      />,
    );
    expect(reader.container.querySelector('.umr-graph').hasAttribute('tabindex')).toBe(false);
    await reader.unmount();
  });

  it('takes n on the block after Escape let the node go', async () => {
    const { sentence, nodesById } = fixture();
    const r = await renderComponent(
      <SentenceBlock
        doc={docStub()}
        dataVersion={1}
        readOnly={false}
        sentence={sentence}
        nodesById={nodesById}
      />,
    );
    const node = all(r.container, '.umr-node')[0];
    await r.step(() => node.focus());
    await r.step(() => press(node, 'Escape'));
    const section = r.container.querySelector('section');
    expect(document.activeElement).toBe(section);
    await r.step(() => press(section, 'n'));
    expect(r.container.querySelector('.umr-inline-editor input')).not.toBeNull();
    await r.unmount();
  });
});

describe('SentenceBlock node menu, Escape', () => {
  const wait = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

  // The menu is portaled but in the block's React tree, so its Escape used
  // to reach the block's own key handler too, which let the node go.
  it('closes the menu and leaves the node focused', async () => {
    const { sentence, nodesById } = fixture();
    const doc = {
      graph: {},
      canConfirmSentence: () => false,
      canDiscardSentence: () => false,
      canConfirm: () => false,
    };
    const r = await renderComponent(
      <SentenceBlock
        doc={doc}
        dataVersion={1}
        readOnly={false}
        sentence={sentence}
        nodesById={nodesById}
      />,
    );
    const node = all(r.container, '.umr-node')[0];
    await r.step(() =>
      node.dispatchEvent(new MouseEvent('contextmenu', { bubbles: true, cancelable: true })),
    );
    const item = document.querySelector('[role="menuitem"]');
    expect(item).not.toBeNull();
    await r.step(() =>
      item.dispatchEvent(
        new KeyboardEvent('keydown', { key: 'Escape', bubbles: true, cancelable: true }),
      ),
    );
    await r.step(() => wait(100));
    expect(document.querySelector('[role="menu"]')).toBeNull();
    expect(document.activeElement).toBe(node);
    expect(all(r.container, '.umr-node--focused')).toEqual([node]);
    await r.unmount();
  });
});

describe('SentenceBlock document relations from the keyboard and the menu', () => {
  const withTag = () => {
    const { sentence, nodesById } = fixture();
    const author = {
      id: 'c1',
      var: 'author',
      concept: 'author',
      constant: true,
      wordIds: [],
      attrs: [],
      out: [],
      in: [],
    };
    const leave = nodesById.get('n1');
    const triple = {
      id: 'tr1',
      source: 'c1',
      target: 'n1',
      rel: ':full-affirmative',
      group: 'modal',
    };
    author.out.push(triple);
    const leaveT = { ...leave, docOut: [], docIn: [triple] };
    const map = new Map(nodesById);
    map.set('c1', author);
    map.set('n1', leaveT);
    return { sentence: { ...sentence, nodes: [leaveT, ...sentence.nodes.slice(1)] }, map };
  };

  it('lists a node relation to change on d, and greys the menu row out without any', async () => {
    const { sentence, nodesById } = fixture();
    const doc = {
      graph: {},
      canConfirmSentence: () => false,
      canDiscardSentence: () => false,
      canConfirm: () => false,
    };
    const r = await renderComponent(
      <SentenceBlock
        doc={doc}
        dataVersion={1}
        readOnly={false}
        sentence={sentence}
        nodesById={nodesById}
      />,
    );
    const node = all(r.container, '.umr-node')[0];
    await r.step(() =>
      node.dispatchEvent(new MouseEvent('contextmenu', { bubbles: true, cancelable: true })),
    );
    const row = all(document, '[role="menuitem"]').find((m) =>
      m.textContent.includes('Change a document relation'),
    );
    expect(row.hasAttribute('data-disabled')).toBe(true);
    expect(row.lastChild.textContent).toBe(keys.words('node.docRelations'));
    await r.unmount();
  });

  it('opens the list on d, and a pick opens that relation to change or delete', async () => {
    const { sentence, map } = withTag();
    const deleted = [];
    const doc = {
      graph: {},
      canConfirmSentence: () => false,
      canDiscardSentence: () => false,
      canConfirm: () => false,
      deleteTriple: (id) => deleted.push(id),
    };
    const r = await renderComponent(
      <SentenceBlock
        doc={doc}
        dataVersion={1}
        readOnly={false}
        sentence={sentence}
        nodesById={map}
      />,
    );
    const node = all(r.container, '.umr-node')[0];
    await r.step(() => node.focus());
    await r.step(() =>
      node.dispatchEvent(
        new KeyboardEvent('keydown', { key: 'd', bubbles: true, cancelable: true }),
      ),
    );
    const input = r.container.querySelector('.umr-inline-editor input');
    expect(input.placeholder).toBe('Relation');
    expect(texts(document, '[role="option"]')).toEqual(['author :full-affirmative']);
    await r.step(() => all(document, '[role="option"]')[0].click());
    const relation = r.container.querySelector('.umr-inline-editor input');
    expect(relation.value).toBe(':full-affirmative');
    // Shift+Backspace before anything is typed deletes it, as in any
    // relation editor.
    await r.step(() =>
      relation.dispatchEvent(
        new KeyboardEvent('keydown', {
          key: 'Backspace',
          shiftKey: true,
          bubbles: true,
          cancelable: true,
        }),
      ),
    );
    expect(deleted).toEqual(['tr1']);
    await r.unmount();
  });
});

describe('SentenceBlock problem list', () => {
  it('goes when its last problem is fixed, and stays shut when one comes back', async () => {
    const { sentence, nodesById } = fixture();
    const problems = [{ level: 'warning', code: 'missing-attribute', message: 'No aspect.' }];
    const props = { dataVersion: 1, sentence, nodesById };
    const r = await renderComponent(<SentenceBlock {...props} problems={problems} />);
    await r.step(() => r.container.querySelector('.umr-problems-toggle').click());
    expect(texts(r.container, '.umr-problem')).toHaveLength(1);
    await r.rerender(<SentenceBlock {...props} dataVersion={2} problems={[]} />);
    expect(r.container.querySelector('.umr-problems')).toBeNull();
    await r.rerender(<SentenceBlock {...props} dataVersion={3} problems={problems} />);
    expect(r.container.querySelector('.umr-problems')).toBeNull();
    await r.unmount();
  });
});

// ArrowDown goes to the first child in READING order, as Left and Right walk
// a row in it: in an RTL sentence that is the rightmost child. It took the
// leftmost in either script.
describe('SentenceBlock ArrowDown in either script', () => {
  const place = (direction) => {
    // Words 100px apart, running the way the script reads.
    const spot = (id) => {
      const i = Number(String(id).slice(1)) - 1;
      const left = direction === 'rtl' ? 400 - i * 100 : i * 100;
      return { left, right: left + 60, width: 60, top: 0, bottom: 20, height: 20, x: left, y: 0 };
    };
    return vi
      .spyOn(HTMLElement.prototype, 'getBoundingClientRect')
      .mockImplementation(function rect() {
        const id = this.dataset?.wordId;
        return id
          ? spot(id)
          : { left: 0, right: 0, width: 0, top: 0, bottom: 0, height: 0, x: 0, y: 0 };
      });
  };

  afterEach(() => vi.restoreAllMocks());

  it.each(['ltr', 'rtl'])('in %s, goes to the child a reader meets first', async (direction) => {
    place(direction);
    const { sentence, nodesById } = fixture();
    const doc = {
      graph: {},
      canConfirmSentence: () => false,
      canDiscardSentence: () => false,
      canConfirm: () => false,
    };
    const r = await renderComponent(
      <SentenceBlock
        doc={doc}
        dataVersion={1}
        readOnly={false}
        direction={direction}
        sentence={sentence}
        nodesById={nodesById}
      />,
    );
    const byConcept = (c) =>
      all(r.container, '.umr-node').find(
        (n) => n.querySelector('.umr-node-concept')?.textContent === c,
      );
    const children = ['person', 'eat-01'].map((c) => [c, parseFloat(byConcept(c).style.left)]);
    expect(children[0][1]).not.toBe(children[1][1]);
    const sign = direction === 'rtl' ? -1 : 1;
    const first = [...children].sort((a, b) => sign * (a[1] - b[1]))[0][0];
    const root = byConcept('leave-02');
    await r.step(() => root.focus());
    await r.step(() =>
      root.dispatchEvent(
        new KeyboardEvent('keydown', { key: 'ArrowDown', bubbles: true, cancelable: true }),
      ),
    );
    expect(document.activeElement).toBe(byConcept(first));
    await r.unmount();
  });
});

// Out of text mode, focus goes to the graph. On a sentence that had none,
// the root was read from the render BEFORE the apply, which had no root,
// and focus fell to the page.
describe('SentenceBlock text mode, focus after Apply', () => {
  const type = (el, value) => {
    const setter = Object.getOwnPropertyDescriptor(HTMLTextAreaElement.prototype, 'value').set;
    setter.call(el, value);
    el.dispatchEvent(new Event('input', { bubbles: true }));
  };
  const button = (root, name) => all(root, 'button').find((b) => b.textContent.trim() === name);
  const stub = (applied = null) => ({
    graph: {},
    canConfirmSentence: () => false,
    canDiscardSentence: () => false,
    penmanOf: () => '',
    planPenman: () => ({ changes: 1 }),
    applyPenman: () => new Promise(() => {}),
    // The document once the apply's plan is in, which is before the block
    // has drawn it.
    sentence: () => applied,
    node: (id) => applied?.nodes.find((n) => n.id === id) || null,
  });

  it('lands on the new root of a sentence that had no graph', async () => {
    const { sentence, nodesById } = fixture();
    const blank = { ...sentence, nodes: [], edges: [], roots: [] };
    const lone = { ...nodesById.get('n1'), out: [], in: [] };
    const applied = { ...blank, nodes: [lone], roots: [lone] };
    const props = { doc: stub(applied), readOnly: false };
    const r = await renderComponent(
      <SentenceBlock {...props} dataVersion={1} sentence={blank} nodesById={new Map()} />,
    );
    await r.step(() => button(r.container, 'Text').click());
    await r.step(() => type(r.container.querySelector('textarea'), '(s1l / leave-02)'));
    await r.step(() => button(r.container, 'Apply').click());
    // The render after the apply's, which draws the node.
    await r.rerender(
      <SentenceBlock
        {...props}
        dataVersion={2}
        sentence={applied}
        nodesById={new Map([['n1', lone]])}
      />,
    );
    expect(document.activeElement).toBe(r.container.querySelector('.umr-node'));
    await r.unmount();
  });

  it('lands on the empty graph when the sentence is still blank', async () => {
    const { sentence } = fixture();
    const blank = { ...sentence, nodes: [], edges: [], roots: [] };
    const r = await renderComponent(
      <SentenceBlock
        doc={stub(blank)}
        readOnly={false}
        dataVersion={1}
        sentence={blank}
        nodesById={new Map()}
      />,
    );
    await r.step(() => button(r.container, 'Text').click());
    await r.step(() => button(r.container, 'Cancel').click());
    expect(document.activeElement).toBe(r.container.querySelector('.umr-graph'));
    await r.unmount();
  });
});

// V8 F3, the half that needs no ruling: a mode waits for a click on its
// target, and until a key can pick one, no key opens an editor while it
// waits. Enter on the node the arrows had reached opened that node's concept
// editor with "Click the new parent" still up.
describe('SentenceBlock keys in a mode', () => {
  const docStub = () => ({
    graph: {},
    canConfirmSentence: () => false,
    canDiscardSentence: () => false,
    canConfirm: () => false,
  });
  const press = (el, key, init = {}) =>
    el.dispatchEvent(
      new KeyboardEvent('keydown', { key, bubbles: true, cancelable: true, ...init }),
    );
  const nodeByVar = (root, v) => root.querySelector(`[data-node-var="${v}"]`);
  const editorOpen = (root) => !!root.querySelector('.umr-inline-editor');
  const modeOn = (root) => !!root.querySelector('.umr-block-note--mode');

  const mount = async () => {
    const { sentence, nodesById } = fixture();
    const r = await renderComponent(
      <SentenceBlock doc={docStub()} readOnly={false} sentence={sentence} nodesById={nodesById} />,
    );
    return r;
  };

  for (const [key, mode] of [['u', 'anchor']]) {
    it(`opens no editor on Enter, Tab or a letter in ${mode} mode, on another node`, async () => {
      const r = await mount();
      const eat = nodeByVar(r.container, 's1e');
      await r.step(() => eat.focus());
      await r.step(() => press(eat, key));
      expect(modeOn(r.container)).toBe(true);
      // The arrows still move: up to the parent.
      await r.step(() => press(eat, 'ArrowUp'));
      const leave = nodeByVar(r.container, 's1l');
      expect(document.activeElement).toBe(leave);
      for (const k of ['Enter', 'Tab', 'v', 'c']) {
        await r.step(() => press(leave, k));
        expect(editorOpen(r.container)).toBe(false);
      }
      expect(modeOn(r.container)).toBe(true);
      await r.step(() => press(leave, 'Escape'));
      expect(modeOn(r.container)).toBe(false);
      await r.unmount();
    });
  }

  it("still takes Tab on the mode's own node, a child typed instead of clicked", async () => {
    const r = await mount();
    const leave = nodeByVar(r.container, 's1l');
    await r.step(() => leave.focus());
    await r.step(() => press(leave, 'u'));
    await r.step(() => press(leave, 'Tab'));
    expect(editorOpen(r.container)).toBe(true);
    expect(modeOn(r.container)).toBe(false);
    await r.unmount();
  });
});

// V8 F5: a node's accessible name says where it hangs, as CANVAS.md
// specified ("s1p person, ARG0 of leave-02").
describe('SentenceBlock node names', () => {
  it('names each node with the relation from its parent', async () => {
    const { sentence, nodesById } = fixture();
    const r = await renderComponent(<SentenceBlock sentence={sentence} nodesById={nodesById} />);
    expect(all(r.container, '.umr-node').map((n) => n.getAttribute('aria-label'))).toEqual([
      's1l leave-02',
      's1p person, ARG0 of leave-02',
      's1e eat-01, purpose of leave-02',
    ]);
    await r.unmount();
  });
});

// Words laid out 100px apart, so the block leaves its measuring pass and
// draws edges and their labels.
const measureWords = () =>
  vi.spyOn(HTMLElement.prototype, 'getBoundingClientRect').mockImplementation(function rect() {
    const id = this.dataset?.wordId;
    const left = id ? (Number(String(id).slice(1)) - 1) * 100 : 0;
    const width = id ? 60 : 0;
    return { left, right: left + width, width, top: 0, bottom: 20, height: 20, x: left, y: 0 };
  });

// An edge or a document-level relation nobody has reviewed wears the node's
// mark on its label chip: dashed, violet for a machine's, amber for a
// contributor's. Settled ones draw plain, and the line never changes.
describe('SentenceBlock provenance of edges and relations', () => {
  afterEach(() => vi.restoreAllMocks());
  const machine = { prov: 'inferred', provSource: 'service:umr-draft-llm' };
  const contributed = { prov: 'contributed', provSource: 'user:b@x.com' };
  const confirmed = { ...machine, provConfirmed: true };

  it('marks the relation label of an unverified edge, and not its line', async () => {
    measureWords();
    const { sentence, nodesById } = fixture();
    const [e1, e2, e3] = sentence.edges;
    const edges = [
      { ...e1, metadata: machine },
      { ...e2, metadata: contributed },
      { ...e3, metadata: confirmed },
    ];
    const r = await renderComponent(
      <SentenceBlock
        sentence={{ ...sentence, edges }}
        nodesById={nodesById}
        dataVersion={1}
        readOnly={false}
      />,
    );
    const label = (id) => r.container.querySelector(`.umr-edge-label[data-edge-id="${id}"]`);
    expect(label('e1').className).toMatch(/umr-edge-label--machine/);
    expect(label('e1').dataset.prov).toBe('machine');
    expect(label('e1').title).toMatch(/^Machine-made, unverified\. Click to change/);
    expect(label('e2').className).toMatch(/umr-edge-label--contributed/);
    expect(label('e3').className).not.toMatch(/umr-edge-label--(machine|contributed)/);
    expect(label('e3').title).toMatch(/^Machine-made, confirmed\. /);
    expect(all(r.container, '.umr-edge').map((p) => p.getAttribute('class'))).not.toContain(
      expect.stringMatching(/machine|contributed/),
    );
    await r.unmount();
  });

  it('marks a document tag, a merged tag with any unverified relation, and a margin chip', async () => {
    const { sentence, nodesById } = fixture();
    const author = {
      id: 'c1',
      var: 'author',
      concept: 'author',
      constant: true,
      wordIds: [],
      attrs: [],
      out: [],
      in: [],
    };
    const root = { ...author, id: 'c2', var: 'root', concept: 'root' };
    const leave = nodesById.get('n1');
    const eat = nodesById.get('n3');
    const t1 = { id: 'tr1', source: 'c1', target: 'n1', rel: ':full-affirmative', group: 'modal' };
    const t2 = { id: 'tr2', source: 'n3', target: 'n1', rel: ':before', group: 'temporal' };
    const t3 = { id: 'tr3', source: 'c2', target: 'c1', rel: ':modal', group: 'modal' };
    const leaveT = {
      ...leave,
      docOut: [],
      docIn: [
        { ...t1, metadata: machine },
        { ...t2, metadata: confirmed },
      ],
    };
    const eatT = { ...eat, docOut: [{ ...t2, metadata: confirmed }], docIn: [] };
    const map = new Map(nodesById);
    map.set('c1', author);
    map.set('c2', root);
    map.set('n1', leaveT);
    map.set('n3', eatT);
    const doc = {
      graph: {},
      canConfirmSentence: () => false,
      canDiscardSentence: () => false,
      constantNode: () => null,
    };
    const r = await renderComponent(
      <SentenceBlock
        doc={doc}
        sentence={{
          ...sentence,
          nodes: [leaveT, sentence.nodes[1], eatT],
          triples: [
            { ...t1, metadata: machine },
            { ...t2, metadata: confirmed },
            { ...t3, metadata: contributed },
          ],
        }}
        nodesById={map}
        dataVersion={1}
        readOnly={false}
      />,
    );
    const tag = (id) => r.container.querySelector(`.umr-doc-tag[data-triple-id="${id}"]`);
    expect(tag('tr1').className).toMatch(/umr-doc-tag--machine/);
    expect(tag('tr1').title).toMatch(/^Machine-made, unverified\. Click to change/);
    // The same confirmed relation at both of its ends draws plain.
    expect(all(r.container, '.umr-doc-tag--machine, .umr-doc-tag--contributed')).toHaveLength(1);
    const chip = r.container.querySelector('.umr-doc-chip');
    expect(chip.textContent).toBe('root :modal author');
    expect(chip.className).toMatch(/umr-doc-chip--contributed/);
    await r.unmount();
  });
});

// The owner's ruling on the mode keys: `m` and `r` open a list of the
// sentence's nodes, as `c`, `t` and `o` do, and a click on a node still
// picks it. `u` takes a word's number and Enter.
describe('SentenceBlock mode targets from the keyboard', () => {
  const press = (el, key, init = {}) =>
    el.dispatchEvent(
      new KeyboardEvent('keydown', { key, bubbles: true, cancelable: true, ...init }),
    );
  const nodeByVar = (root, v) => root.querySelector(`[data-node-var="${v}"]`);
  const input = (root) => root.querySelector('.umr-inline-editor input');
  const modeNote = (root) => root.querySelector('.umr-block-note--mode');
  const docStub = (extra = {}) => ({
    graph: {},
    canConfirmSentence: () => false,
    canDiscardSentence: () => false,
    canConfirm: () => false,
    wouldCycle: () => false,
    moveEdge: vi.fn(),
    setAnchor: vi.fn(),
    node: () => null,
    edge: () => null,
    relationProblem: () => null,
    ...extra,
  });
  const mount = async (doc) => {
    const { sentence, nodesById } = fixture();
    const r = await renderComponent(
      <SentenceBlock doc={doc} readOnly={false} sentence={sentence} nodesById={nodesById} />,
    );
    return { r, sentence, nodesById };
  };
  const options = () =>
    [...document.querySelectorAll('[role="option"]')].map((o) => o.textContent.trim());
  const type = async (r, el, text) => {
    for (const ch of text) {
      await r.step(() => {
        const set = Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, 'value').set;
        set.call(el, el.value + ch);
        el.dispatchEvent(new Event('input', { bubbles: true }));
      });
    }
  };

  it('m lists the nodes it can move under, and a pick moves it', async () => {
    const doc = docStub();
    const { r } = await mount(doc);
    const person = nodeByVar(r.container, 's1p');
    await r.step(() => person.focus());
    await r.step(() => press(person, 'm'));
    expect(modeNote(r.container).textContent).toMatch(/Pick or click the new parent/);
    expect(document.activeElement).toBe(input(r.container));
    // Not itself, and not the parent it hangs from (s1l); eat-01 is left.
    expect(options()).toEqual(['s1e eat-01']);
    await type(r, input(r.container), 's1e');
    await r.step(() => press(input(r.container), 'Enter'));
    expect(doc.moveEdge).toHaveBeenCalledWith('e1', 'n3');
    expect(modeNote(r.container)).toBeNull();
    expect(input(r.container)).toBeNull();
    await r.unmount();
  });

  it('m leaves out a node under the one moving, and refuses it typed', async () => {
    // Moving leave-02's child eat-01 under person would close no cycle, but
    // under eat-01's own child it would.
    const doc = docStub({ wouldCycle: (source) => source === 'n2' });
    const { r } = await mount(doc);
    const eat = nodeByVar(r.container, 's1e');
    await r.step(() => eat.focus());
    await r.step(() => press(eat, 'm'));
    expect(options()).toEqual([]);
    await type(r, input(r.container), 's1p');
    await r.step(() => press(input(r.container), 'Enter'));
    expect(doc.moveEdge).not.toHaveBeenCalled();
    expect(r.container.querySelector('.umr-inline-problem').textContent).toBe(
      's1p cannot be picked here.',
    );
    await r.step(() => press(input(r.container), 'Escape'));
    expect(modeNote(r.container)).toBeNull();
    expect(input(r.container)).toBeNull();
    await r.unmount();
  });

  it('m still takes a click on the node, with the list open', async () => {
    const doc = docStub();
    const { r } = await mount(doc);
    const person = nodeByVar(r.container, 's1p');
    await r.step(() => person.focus());
    await r.step(() => press(person, 'm'));
    const eat = nodeByVar(r.container, 's1e');
    const down = new MouseEvent('mousedown', { bubbles: true, cancelable: true });
    await r.step(() => eat.dispatchEvent(down));
    // The press keeps focus in the list, whose blur would end the mode.
    expect(down.defaultPrevented).toBe(true);
    await r.step(() => eat.click());
    expect(doc.moveEdge).toHaveBeenCalledWith('e1', 'n3');
    expect(modeNote(r.container)).toBeNull();
    await r.unmount();
  });

  it('r lists the other nodes, and a pick asks for the relation', async () => {
    const doc = docStub();
    const { r } = await mount(doc);
    const eat = nodeByVar(r.container, 's1e');
    await r.step(() => eat.focus());
    await r.step(() => press(eat, 'r'));
    expect(modeNote(r.container).textContent).toMatch(/Pick or click the second parent/);
    expect(options()).toEqual(['s1l leave-02', 's1p person']);
    await type(r, input(r.container), 's1p');
    await r.step(() => press(input(r.container), 'Enter'));
    expect(input(r.container).getAttribute('placeholder')).toBe('Relation');
    expect(modeNote(r.container)).toBeNull();
    await r.unmount();
  });

  it('u takes a word by its number and Enter, and says when there is none', async () => {
    const setAnchor = vi.fn();
    const { sentence, nodesById } = fixture();
    const doc = docStub({ setAnchor, node: (id) => nodesById.get(id) });
    const r = await renderComponent(
      <SentenceBlock doc={doc} readOnly={false} sentence={sentence} nodesById={nodesById} />,
    );
    const eat = nodeByVar(r.container, 's1e');
    await r.step(() => eat.focus());
    await r.step(() => press(eat, 'u'));
    await r.step(() => press(eat, '1'));
    expect(modeNote(r.container).textContent).toMatch(/Word 1, Enter to anchor/);
    await r.step(() => press(eat, 'Enter'));
    // eat-01 stands on word 3; word 1 joins it.
    expect(setAnchor).toHaveBeenCalledWith('n3', ['w3', 'w1']);
    await r.step(() => press(eat, '3'));
    await r.step(() => press(eat, 'Enter'));
    expect(setAnchor).toHaveBeenLastCalledWith('n3', []);
    await r.step(() => press(eat, '9'));
    await r.step(() => press(eat, 'Enter'));
    expect(setAnchor).toHaveBeenCalledTimes(2);
    expect(modeNote(r.container).textContent).toMatch(/Sentence 1 has no word 9\./);
    // Backspace takes back a digit typed.
    await r.step(() => press(eat, '2'));
    await r.step(() => press(eat, '5'));
    await r.step(() => press(eat, 'Backspace'));
    expect(modeNote(r.container).textContent).toMatch(/Word 2,/);
    expect(input(r.container)).toBeNull();
    await r.unmount();
  });
});

// The owner's ruling on leaving a sentence: Escape then Tab goes on to the
// next sentence, and a rebindable pair (PageDown, PageUp) walks them.
describe('SentenceBlock leaving a sentence', () => {
  afterEach(() => keys.setOverrides({}));
  const press = (el, key, init = {}) => {
    const e = new KeyboardEvent('keydown', { key, bubbles: true, cancelable: true, ...init });
    el.dispatchEvent(e);
    return e;
  };
  const docStub = () => ({
    graph: {},
    canConfirmSentence: () => false,
    canDiscardSentence: () => false,
    canConfirm: () => false,
  });

  for (const readOnly of [false, true]) {
    it(`Escape then Tab asks for the next sentence${readOnly ? ', read-only too' : ''}`, async () => {
      const { sentence, nodesById } = fixture();
      const goToSentence = vi.fn(() => true);
      const r = await renderComponent(
        <SentenceBlock
          doc={docStub()}
          readOnly={readOnly}
          sentence={sentence}
          nodesById={nodesById}
          goToSentence={goToSentence}
        />,
      );
      const leave = r.container.querySelector('[data-node-var="s1l"]');
      await r.step(() => leave.focus());
      await r.step(() => press(leave, 'Escape'));
      const section = r.container.querySelector('.umr-block');
      expect(document.activeElement).toBe(section);
      let e;
      await r.step(() => {
        e = press(section, 'Tab');
      });
      expect(goToSentence).toHaveBeenCalledWith(1, 1);
      expect(e.defaultPrevented).toBe(true);
      await r.unmount();
    });
  }

  it('lets Tab go on as usual off the last sentence', async () => {
    const { sentence, nodesById } = fixture();
    const goToSentence = vi.fn(() => false);
    const r = await renderComponent(
      <SentenceBlock
        doc={docStub()}
        readOnly={false}
        sentence={sentence}
        nodesById={nodesById}
        goToSentence={goToSentence}
      />,
    );
    const section = r.container.querySelector('.umr-block');
    await r.step(() => section.focus());
    let e;
    await r.step(() => {
      e = press(section, 'Tab');
    });
    expect(goToSentence).toHaveBeenCalledWith(1, 1);
    expect(e.defaultPrevented).toBe(false);
    await r.unmount();
  });

  it('keeps Tab on a node for a child, and Shift+Tab for leaving backwards', async () => {
    const { sentence, nodesById } = fixture();
    const goToSentence = vi.fn(() => true);
    const r = await renderComponent(
      <SentenceBlock
        doc={docStub()}
        readOnly={false}
        sentence={sentence}
        nodesById={nodesById}
        goToSentence={goToSentence}
      />,
    );
    const section = r.container.querySelector('.umr-block');
    await r.step(() => section.focus());
    await r.step(() => press(section, 'Tab', { shiftKey: true }));
    const leave = r.container.querySelector('[data-node-var="s1l"]');
    await r.step(() => leave.focus());
    await r.step(() => press(leave, 'Tab'));
    expect(goToSentence).not.toHaveBeenCalled();
    expect(r.container.querySelector('.umr-inline-editor')).not.toBeNull();
    await r.unmount();
  });

  it('walks to the next and previous sentence on PageDown and PageUp, rebindable', async () => {
    const { sentence, nodesById } = fixture();
    const goToSentence = vi.fn(() => true);
    const r = await renderComponent(
      <SentenceBlock
        doc={docStub()}
        readOnly={true}
        sentence={{ ...sentence, index: 4 }}
        nodesById={nodesById}
        goToSentence={goToSentence}
      />,
    );
    const leave = r.container.querySelector('[data-node-var="s1l"]');
    await r.step(() => leave.focus());
    await r.step(() => press(leave, 'PageDown'));
    expect(goToSentence).toHaveBeenLastCalledWith(4, 1);
    await r.step(() => press(leave, 'PageUp'));
    expect(goToSentence).toHaveBeenLastCalledWith(4, -1);
    await r.step(() => keys.setOverrides({ 'canvas.nextSentence': ['j'] }));
    await r.step(() => press(leave, 'j'));
    expect(goToSentence).toHaveBeenLastCalledWith(4, 1);
    expect(goToSentence).toHaveBeenCalledTimes(3);
    await r.unmount();
  });
});
