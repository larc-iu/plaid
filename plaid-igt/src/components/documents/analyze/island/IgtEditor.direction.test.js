import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import { IgtEditor } from './IgtEditor.js';
import { IgtDocument } from '@/domain/IgtDocument.js';
import { buildRawDoc, makeFakeClient, resetIds } from '@/domain/test-helpers.js';

// Which way the grid lays out, and what that does and does not reach.
//
// The rule the whole feature rests on: LAYOUT takes the document's direction,
// a VALUE takes its own. So the sentence block is flipped as one unit and
// every cell in it carries dir="auto", which is what lets an English gloss
// read left to right in a column standing under an Arabic word.

vi.mock('@/utils/feedback', () => ({
  humanizeError: (e) => String(e),
  notifyInfo: vi.fn(),
  notifyError: vi.fn(),
}));

// "قرأ الولد", by code point: 0-3 and 4-9.
const ARABIC = 'قرأ الولد';
const ARABIC_WORDS = [
  { id: 'w-1', begin: 0, end: 3 },
  { id: 'w-2', begin: 4, end: 9 },
];

let host;
let editor;

const mount = (docOpts = {}) => {
  const client = makeFakeClient();
  client.query = async () => ({ results: [] });
  const doc = new IgtDocument({
    raw: buildRawDoc(docOpts),
    project: { id: 'proj-1', vocabs: [], config: {}, maintainers: [], writers: [] },
    vocabularies: {},
    client,
    projectId: 'proj-1',
    user: null,
  });
  client.documents.get = async () => doc.raw;
  host = document.createElement('div');
  document.body.appendChild(host);
  editor = new IgtEditor(host, doc, {});
  return doc;
};

beforeEach(() => resetIds());
afterEach(() => {
  editor?.destroy();
  host?.remove();
  editor = null;
  host = null;
});

describe('the grid takes its direction from the document', () => {
  it('lays an Arabic document out right to left', () => {
    mount({ body: ARABIC, words: ARABIC_WORDS });
    expect(host.querySelector('.igt-sentence').getAttribute('dir')).toBe('rtl');
  });

  it('leaves a Latin document alone', () => {
    mount();
    expect(host.querySelector('.igt-sentence').getAttribute('dir')).toBe('ltr');
  });

  it('lets the document override its own text', () => {
    // A transliterated Arabic corpus: the text is Latin and the project wants
    // it laid out the way the language reads.
    mount({ metadata: { plaid: { textDirection: 'rtl' } } });
    expect(host.querySelector('.igt-sentence').getAttribute('dir')).toBe('rtl');
  });

  it('flips every sentence the same way, not one by one', () => {
    // Detection reads the whole baseline, so a sentence that happens to open
    // with a Latin loanword does not stand backwards among its neighbours.
    const body = `${ARABIC} radio ${ARABIC}`;
    mount({
      body,
      words: [...ARABIC_WORDS, { id: 'w-3', begin: 10, end: 15 }],
      sentences: [
        { id: 's-1', begin: 0, end: 9 },
        { id: 's-2', begin: 10, end: [...body].length },
      ],
    });
    const dirs = [...host.querySelectorAll('.igt-sentence')].map((el) => el.getAttribute('dir'));
    expect(dirs.length).toBeGreaterThan(1);
    expect(new Set(dirs)).toEqual(new Set(['rtl']));
  });
});

describe('a value decides for itself', () => {
  it('marks every editable cell auto, whichever way the grid runs', () => {
    mount({ body: ARABIC, words: ARABIC_WORDS });
    const fields = [...host.querySelectorAll('.igt-field')];
    expect(fields.length).toBeGreaterThan(0);
    for (const f of fields) expect(f.getAttribute('dir')).toBe('auto');
  });
});

// Which cell Tab, Enter and the arrows reach. This grid navigates by SCREEN
// GEOMETRY, so in an RTL sentence the next cell is the one further LEFT and
// every horizontal comparison has to know it. Getting it wrong is worse than
// leaving the grid unflipped: Tab would walk backwards through the sentence.
describe('navigation follows the words', () => {
  // happy-dom lays nothing out, so the cells are given a synthetic row. The
  // x values are the ones an RTL grid produces: word 1 on the RIGHT.
  const layOut = (cells, xs) =>
    cells.forEach((el, i) => {
      el.getBoundingClientRect = () => ({
        left: xs[i],
        right: xs[i] + 60,
        top: 0,
        bottom: 20,
        width: 60,
        height: 20,
        x: xs[i],
        y: 0,
      });
    });

  // One cell per word, on the same tier: the word-annotation row.
  const wordCells = () => [...host.querySelectorAll('.igt-field[data-cell-key^="wa:"]')];

  it('moves to the cell on the LEFT when the sentence runs right to left', () => {
    mount({ body: ARABIC, words: ARABIC_WORDS });
    const cells = wordCells();
    expect(cells).toHaveLength(2);
    layOut(cells, [300, 100]);
    expect(editor._navMove(cells[0], 'next')).toBe(true);
    expect(document.activeElement).toBe(cells[1]);
  });

  it('moves back to the cell on the right', () => {
    mount({ body: ARABIC, words: ARABIC_WORDS });
    const cells = wordCells();
    layOut(cells, [300, 100]);
    expect(editor._navMove(cells[1], 'prev')).toBe(true);
    expect(document.activeElement).toBe(cells[0]);
  });

  it('runs the usual way in a Latin sentence', () => {
    mount();
    const cells = wordCells();
    expect(cells).toHaveLength(2);
    layOut(cells, [100, 300]);
    expect(editor._navMove(cells[0], 'next')).toBe(true);
    expect(document.activeElement).toBe(cells[1]);
  });

  // Deliberately not tested here: what happens at the END of a row. This grid
  // WRAPS into bands, and the second pass that crosses a band boundary would
  // need every cell of every row laid out, not just the two on the tier under
  // test. The e2e spec drives the real thing.
});

describe('the copy names the key that works', () => {
  // Gathering a multi-word expression steps along the SENTENCE, so the arrow
  // that does it is the left one in an RTL grid. Two strings tell a person
  // which key to press, and both would otherwise name the wrong one.
  it('says the left arrow in an RTL grid', () => {
    mount({ body: ARABIC, words: ARABIC_WORDS });
    expect(editor._gatherKey()).toBe('←');
  });

  it('says the right arrow in a Latin one', () => {
    mount();
    expect(editor._gatherKey()).toBe('→');
  });
});

describe('the chrome is not data', () => {
  it('leaves the toolbar outside the block that flips', () => {
    mount({ body: ARABIC, words: ARABIC_WORDS });
    const toolbar = host.querySelector('.igt-toolbar');
    expect(toolbar).not.toBeNull();
    expect(toolbar.closest('.igt-sentence')).toBeNull();
    expect(toolbar.getAttribute('dir')).toBeNull();
  });
});
