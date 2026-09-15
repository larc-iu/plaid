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

describe('the chrome is not data', () => {
  it('leaves the toolbar outside the block that flips', () => {
    mount({ body: ARABIC, words: ARABIC_WORDS });
    const toolbar = host.querySelector('.igt-toolbar');
    expect(toolbar).not.toBeNull();
    expect(toolbar.closest('.igt-sentence')).toBeNull();
    expect(toolbar.getAttribute('dir')).toBeNull();
  });
});
