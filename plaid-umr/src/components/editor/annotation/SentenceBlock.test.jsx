import { describe, it, expect, afterEach, vi } from 'vitest';
import { CommentStore } from '@ui/domain/CommentStore.js';
import { renderComponent, all, texts } from '@ui/test/renderComponent.jsx';
import { SentenceBlock } from './SentenceBlock.jsx';
import { keys } from '../../../lib/keymap.js';

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
    const doc = { graph: {}, canConfirmSentence: () => false, canConfirm: () => false };
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
    const doc = { canConfirmSentence: () => false, canConfirm: () => false, graph: {} };
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
