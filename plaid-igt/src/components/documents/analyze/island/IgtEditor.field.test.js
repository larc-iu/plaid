import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import { render } from 'lit-html';
import {
  buildRawDoc,
  makeFakeClient,
  resetIds,
  makeIgtDoc,
  mountIsland,
} from '@/domain/test-helpers.js';
import { VOCAB_ENTRY_SOURCE } from '@/domain/glossGuess';

// What `_field` writes on a cell's element, the one-line input and the
// sentence textarea alike, in every state a cell can be in: the attributes,
// the classes (as a set), and the hand-read properties. The snapshot pins the
// markup so the two branches can share what they compute.

vi.mock('@/utils/feedback', () => ({
  notifyWarning: vi.fn(),
  humanizeError: (e) => String(e),
  notifyInfo: vi.fn(),
  notifyError: vi.fn(),
}));

let mounted;
let editor;

beforeEach(() => {
  resetIds();
  const raw = buildRawDoc({ body: 'cat', words: [{ id: 'w-1', begin: 0, end: 3 }] });
  const client = makeFakeClient();
  client.query = async () => ({ results: [] });
  const doc = makeIgtDoc({ raw, project: { id: 'proj-1', config: { plaid: {} } }, client });
  mounted = mountIsland(doc);
  editor = mounted.editor;
});
afterEach(() => {
  mounted?.destroy();
  mounted = null;
  editor = null;
});

const tagset = (mode) => ({
  mode,
  delimiters: '.-',
  values: [{ value: 'PL' }, { value: 'DET' }],
});

// A cell engine that answers what the case asks for.
const cellsOf = ({ held = null, conflict = false, unsent = false } = {}) => ({
  display: (key, v) => (held != null ? held : v),
  conflictOf: () => (conflict ? { typed: 'theirs', recut: null } : null),
  unsentOf: () => (unsent ? { value: 'mine' } : null),
  canonical: (key) => key,
});

const describeEl = (el) => {
  const attrs = {};
  for (const a of [...el.attributes].sort((x, y) => x.name.localeCompare(y.name))) {
    attrs[a.name] = a.name === 'class' ? a.value.split(/\s+/).filter(Boolean).sort() : a.value;
  }
  return {
    tag: el.tagName.toLowerCase(),
    attrs,
    disabled: el.disabled,
    value: el.value,
    igtAlts: typeof el.igtAlts === 'function' ? 'fn' : el.igtAlts,
    igtPartAlts: typeof el.igtPartAlts === 'function' ? 'fn' : (el.igtPartAlts ?? null),
    igtTagset: el.igtTagset ? el.igtTagset.mode : el.igtTagset,
    igtWhat: el.igtWhat,
    igtEntityIds: el.igtEntityIds,
    face: el.parentElement.className,
  };
};

const draw = (opts, { readOnly = false, cells = {} } = {}) => {
  const ctx = Object.create(editor);
  ctx.readOnly = readOnly;
  ctx._cells = cellsOf(cells);
  ctx._guessShown = () => {};
  const host = document.createElement('div');
  render(ctx._field(opts), host);
  return describeEl(host.querySelector('.igt-field'));
};

const BASE = {
  key: 'wa:w-1:Gloss',
  apply: () => {},
  what: 'gloss',
  entityIds: ['w-1'],
  ariaLabel: 'Gloss',
  fieldName: 'Gloss',
};

const CASES = {
  empty: [{ value: '' }],
  filled: [{ value: 'cat' }],
  'filled read-only': [{ value: 'cat' }, { readOnly: true }],
  'held value': [{ value: 'cat' }, { cells: { held: 'dog' } }],
  conflict: [{ value: 'cat' }, { cells: { conflict: true } }],
  'conflict read-only': [{ value: 'cat' }, { readOnly: true, cells: { conflict: true } }],
  unsent: [{ value: 'cat' }, { cells: { unsent: true } }],
  machine: [{ value: 'cat', prov: 'machine', provOrigin: 'svc' }],
  'machine doubtful': [
    { value: 'cat', prov: 'machine', confidence: { doubtful: true, note: '38% confident' } },
  ],
  'doubtful when empty': [{ value: '', prov: 'machine', confidence: { doubtful: true } }],
  'closed tagset, valid': [{ value: 'DET', tagset: tagset('closed') }],
  'closed tagset, unknown': [{ value: 'FOO', tagset: tagset('closed') }],
  'suggest tagset, stray delimiter': [{ value: 'PL.', tagset: tagset('suggest') }],
  guess: [{ value: '', guess: { value: 'cat', source: 'doc' }, guessTarget: 'w-1' }],
  'guess from the lexicon': [
    { value: '', guess: { value: 'cat', source: VOCAB_ENTRY_SOURCE }, guessTarget: 'w-1' },
  ],
  'guess read-only': [
    { value: '', guess: { value: 'cat', source: 'doc' }, guessTarget: 'w-1' },
    { readOnly: true },
  ],
  alternatives: [
    {
      value: 'cat',
      alternatives: () => [{ value: 'cat' }, { value: 'dog' }],
      partAlternatives: () => [],
    },
  ],
  'one alternative': [{ value: 'cat', alternatives: () => [{ value: 'cat' }] }],
  'small caps': [{ value: 'DET', gloss: {} }],
  badge: [{ value: 'cat', badge: 'B' }],
  'extra class and confirm ids': [
    { value: 'cat', extraClass: 'igt-field--x', confirmWord: 'w-1', confirmSentence: 's-1' },
  ],
};

describe('_field markup', () => {
  for (const [name, [opts, how]] of Object.entries(CASES)) {
    it(`one-line cell: ${name}`, () => {
      expect(draw({ ...BASE, ...opts }, how)).toMatchSnapshot();
    });
    it(`sentence cell: ${name}`, () => {
      expect(
        draw({ ...BASE, key: 'sa:s-1:Translation', sentence: true, ...opts }, how),
      ).toMatchSnapshot();
    });
  }
});
