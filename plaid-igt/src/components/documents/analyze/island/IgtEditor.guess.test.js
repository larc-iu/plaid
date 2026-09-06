import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import { IgtEditor } from './IgtEditor.js';
import { IgtDocument } from '@/domain/IgtDocument.js';
import { buildRawDoc, makeFakeClient, resetIds } from '@/domain/test-helpers.js';

// Where a placeholder suggestion came from, as the grid shows it: a lexicon
// entry reached through a link wears a teal wash and names the entry, project
// precedent stays plain and says how often it was seen, and the LINK's own
// provenance decides which of the two the cell offers first.

vi.mock('@/utils/feedback', () => ({
  humanizeError: (e) => String(e),
  notifyInfo: vi.fn(),
  notifyError: vi.fn(),
}));

let host;
let editor;

const ENTRY = { id: 'i-cat', form: 'cat', metadata: { pos: 'N' } };

// "the cat the": w-2 is linked to the entry above, and w-1 already carries a
// POS, so w-3 (the same form) has precedent and no link. `linkProv` is the
// metadata on the LINK, which is what decides how far the entry is trusted.
function mount({ linkProv = null } = {}) {
  const raw = buildRawDoc({
    body: 'the cat the',
    words: [
      { id: 'w-1', begin: 0, end: 3 },
      { id: 'w-2', begin: 4, end: 7 },
      { id: 'w-3', begin: 8, end: 11 },
    ],
  });
  const posLayer = raw.textLayers[0].tokenLayers
    .flatMap((tl) => tl.spanLayers || [])
    .find((sl) => sl.id === 'wsl-0');
  posLayer.spans = [{ id: 's-1', tokens: ['w-1'], value: 'DET' }];

  const client = makeFakeClient();
  client.query = async () => ({ results: [] });
  const doc = new IgtDocument({
    raw,
    project: { id: 'proj-1', vocabs: [{ id: 'v1' }], config: { plaid: {} } },
    vocabularies: {
      v1: {
        id: 'v1',
        name: 'Lexicon',
        items: [ENTRY],
        vocabLinks: [
          {
            id: 'l-1',
            tokens: ['w-2'],
            vocabItem: ENTRY,
            ...(linkProv ? { metadata: linkProv } : {}),
          },
        ],
      },
    },
    client,
    projectId: 'proj-1',
  });
  client.documents.get = async () => doc.raw;
  host = document.createElement('div');
  document.body.appendChild(host);
  editor = new IgtEditor(host, doc, {});
  return doc;
}

const cell = (key) => host.querySelector(`[data-cell-key="${key}"]`);
const cls = (key) => [...cell(key).classList];

beforeEach(() => resetIds());
afterEach(() => {
  editor?.destroy?.();
  host?.remove();
  host = null;
  editor = null;
});

describe('IgtEditor suggestion provenance', () => {
  it('washes an entry-backed suggestion and names the entry it came from', () => {
    mount();
    const c = cell('wa:w-2:POS');
    expect(c.value).toBe('');
    expect(c.placeholder).toBe('N');
    expect(cls('wa:w-2:POS')).toEqual(
      expect.arrayContaining(['igt-field--guess', 'igt-field--guess-entry']),
    );
    expect(c.title).toContain('Guess: N, from the entry “cat”');
    expect(c.title).not.toContain('unconfirmed');
  });

  it('leaves a precedent suggestion unwashed and says how often it was seen', () => {
    mount();
    const c = cell('wa:w-3:POS');
    expect(c.placeholder).toBe('DET');
    expect(cls('wa:w-3:POS')).toContain('igt-field--guess');
    expect(cls('wa:w-3:POS')).not.toContain('igt-field--guess-entry');
    expect(c.title).toContain('Guess: DET, seen 1 time in this project');
  });

  it('marks an unconfirmed auto-link, and keeps the wash', () => {
    mount({ linkProv: { prov: 'inferred', provSource: 'service:x' } });
    const c = cell('wa:w-2:POS');
    expect(c.placeholder).toBe('N');
    // The wash says where it came from either way; the link chip in the same
    // column is what says the link is unconfirmed.
    expect(cls('wa:w-2:POS')).toContain('igt-field--guess-entry');
    expect(c.title).toContain('from the entry “cat”, unconfirmed link');
  });

  it('has no suggestion, and no wash, once the cell is filled', async () => {
    const doc = mount();
    await doc.updateTokenSpan('w-2', 'POS', 'V', {});
    const c = cell('wa:w-2:POS');
    expect(c.value).toBe('V');
    expect(cls('wa:w-2:POS')).not.toContain('igt-field--guess');
    expect(cls('wa:w-2:POS')).not.toContain('igt-field--guess-entry');
  });
});
