import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import { PlaidClient } from '@larc-iu/plaid-client';
import { IgtEditor } from './IgtEditor.js';
import { IgtDocument } from '@/domain/IgtDocument.js';
import { buildRawDoc, makeFakeClient, resetIds } from '@/domain/test-helpers.js';

// Research telemetry on the guesses (core manual, "Research telemetry"): a
// guess drawn in a cell is `suggestion.shown` once per page session however
// often the grid re-renders, Enter or Ctrl+Enter taking it is
// `suggestion.adopted`, and a different value typed over it is
// `suggestion.dismissed`. The real client recorder sits behind the editor, and
// what reaches the wire is read off a stubbed fetch.

vi.mock('@/utils/feedback', () => ({
  humanizeError: (e) => String(e),
  notifyInfo: vi.fn(),
  notifyError: vi.fn(),
}));

const ENTRY = { id: 'i-cat', form: 'cat', metadata: { pos: 'N' } };

let host;
let editor;
let posted;
let realFetch;
let serial = 0;

// "the cat the": w-2 is linked to the entry (a POS guess of N from the
// entry), and w-3 has precedent from w-1 (a POS guess of DET).
function mount({ telemetry = true, readOnly = false } = {}) {
  const raw = buildRawDoc({
    body: 'the cat the',
    words: [
      { id: 'w-1', begin: 0, end: 3 },
      { id: 'w-2', begin: 4, end: 7 },
      { id: 'w-3', begin: 8, end: 11 },
    ],
  });
  raw.textLayers[0].tokenLayers
    .flatMap((tl) => tl.spanLayers || [])
    .find((sl) => sl.id === 'wsl-0').spans = [{ id: 's-1', tokens: ['w-1'], value: 'DET' }];
  const client = makeFakeClient();
  client.query = async () => ({ results: [] });
  // A server of its own per test, so each test has a fresh recorder.
  const real = new PlaidClient(`http://t${++serial}`, 'tok');
  real.events.setEnabled('proj-1', telemetry);
  client.events = real.events;
  vi.spyOn(client.events, 'record');
  const doc = new IgtDocument({
    raw,
    project: { id: 'proj-1', vocabs: [{ id: 'v1' }], config: { plaid: {} } },
    vocabularies: {
      v1: {
        id: 'v1',
        name: 'Lexicon',
        items: [ENTRY],
        vocabLinks: [{ id: 'l-1', tokens: ['w-2'], vocabItem: ENTRY }],
      },
    },
    client,
    projectId: 'proj-1',
  });
  client.documents.get = async () => doc.raw;
  host = document.createElement('div');
  document.body.appendChild(host);
  editor = new IgtEditor(host, doc, { readOnly });
  return { doc, client };
}

const cell = (key) => host.querySelector(`[data-cell-key="${key}"]`);
const key = (el, k, init = {}) =>
  el.dispatchEvent(
    new KeyboardEvent('keydown', { key: k, bubbles: true, cancelable: true, ...init }),
  );
const settle = async (n = 10) => {
  for (let i = 0; i < n; i++) await new Promise((r) => setTimeout(r, 0));
};
const typeInto = (el, value) => {
  el.value = value;
  el.dispatchEvent(new Event('input', { bubbles: true }));
};

// What went over the wire once the recorder is flushed.
const sent = async (client) => {
  client.events.flush();
  await settle(2);
  return posted.flat();
};

beforeEach(() => {
  resetIds();
  posted = [];
  realFetch = globalThis.fetch;
  globalThis.fetch = vi.fn(async (url, opts) => {
    if (String(url).endsWith('/events')) posted.push(JSON.parse(opts.body));
    return { status: 201, ok: true };
  });
});

afterEach(() => {
  editor?.destroy?.();
  host?.remove();
  host = null;
  editor = null;
  globalThis.fetch = realFetch;
});

describe('suggestion.shown', () => {
  it('records each guess the grid draws, with its target, field, value and source', async () => {
    const { client } = mount();
    const events = await sent(client);
    const shown = events.filter((e) => e.type === 'suggestion.shown');
    const pos = shown.filter((e) => e.data.field === 'POS');
    expect(pos).toEqual(
      expect.arrayContaining([
        expect.objectContaining({
          'document-id': 'doc-1',
          'target-id': 'w-2',
          data: expect.objectContaining({ value: 'N', field: 'POS' }),
        }),
        expect.objectContaining({
          'target-id': 'w-3',
          data: expect.objectContaining({ value: 'DET', field: 'POS' }),
        }),
      ]),
    );
    expect(pos.every((e) => typeof e.data.source === 'string' && e.data.source)).toBe(true);
    // A filled cell shows no guess, so w-1's POS is not among them.
    expect(pos.some((e) => e['target-id'] === 'w-1')).toBe(false);
  });

  it('records a guess once however often the grid re-renders', async () => {
    const { client } = mount();
    editor._render(true);
    editor._render(true);
    await settle();
    const calls = client.events.record.mock.calls.filter(
      ([type, f]) => type === 'suggestion.shown' && f.targetId === 'w-3' && f.data.field === 'POS',
    );
    expect(calls.length).toBeGreaterThanOrEqual(3);
    const events = await sent(client);
    expect(
      events.filter(
        (e) => e.type === 'suggestion.shown' && e['target-id'] === 'w-3' && e.data.field === 'POS',
      ),
    ).toHaveLength(1);
  });

  it('sends nothing while the project has the switch off', async () => {
    const { client } = mount({ telemetry: false });
    const c = cell('wa:w-2:POS');
    c.focus();
    key(c, 'Enter');
    await settle();
    expect(await sent(client)).toEqual([]);
    expect(globalThis.fetch).not.toHaveBeenCalled();
  });

  it('records nothing in a read-only grid, which shows no guesses', async () => {
    const { client } = mount({ readOnly: true });
    expect(client.events.record).not.toHaveBeenCalled();
  });
});

describe('suggestion.adopted and suggestion.dismissed', () => {
  it('Enter on a guess adopts it', async () => {
    const { client } = mount();
    const c = cell('wa:w-2:POS');
    c.focus();
    key(c, 'Enter');
    await settle();
    const adopted = (await sent(client)).filter((e) => e.type === 'suggestion.adopted');
    expect(adopted).toEqual([
      expect.objectContaining({
        'target-id': 'w-2',
        data: expect.objectContaining({ value: 'N', field: 'POS' }),
      }),
    ]);
  });

  it('typing a different value over a guess dismisses it and says what was written', async () => {
    const { client } = mount();
    const c = cell('wa:w-3:POS');
    c.focus();
    typeInto(c, 'PRON');
    c.blur();
    await settle();
    const events = await sent(client);
    expect(events.filter((e) => e.type === 'suggestion.adopted')).toEqual([]);
    expect(events.filter((e) => e.type === 'suggestion.dismissed')).toEqual([
      expect.objectContaining({
        'target-id': 'w-3',
        data: expect.objectContaining({ value: 'DET', field: 'POS', written: 'PRON' }),
      }),
    ]);
  });

  it('typing the guess itself counts as taking it', async () => {
    const { client } = mount();
    const c = cell('wa:w-3:POS');
    c.focus();
    typeInto(c, 'DET');
    c.blur();
    await settle();
    const events = await sent(client);
    expect(events.filter((e) => e.type === 'suggestion.adopted')).toHaveLength(1);
    expect(events.filter((e) => e.type === 'suggestion.dismissed')).toEqual([]);
  });

  it('passing over a guess with Tab, Shift+Enter or a blur records no answer', async () => {
    const { client } = mount();
    const c = cell('wa:w-2:POS');
    c.focus();
    key(c, 'Tab');
    c.focus();
    key(c, 'Enter', { shiftKey: true });
    c.focus();
    c.blur();
    await settle();
    const events = await sent(client);
    expect(events.filter((e) => e.type !== 'suggestion.shown')).toEqual([]);
  });

  it('Ctrl+Enter on a word adopts every guess in its column', async () => {
    const { client } = mount();
    const c = cell('wa:w-3:POS');
    c.focus();
    key(c, 'Enter', { ctrlKey: true });
    await settle(20);
    const adopted = (await sent(client)).filter((e) => e.type === 'suggestion.adopted');
    expect(adopted.length).toBeGreaterThanOrEqual(1);
    expect(adopted).toEqual(
      expect.arrayContaining([
        expect.objectContaining({
          'target-id': 'w-3',
          data: expect.objectContaining({ value: 'DET', field: 'POS' }),
        }),
      ]),
    );
    expect(adopted.every((e) => e['target-id'] === 'w-3' && e.data.source)).toBe(true);
  });

  it('writing over a value a person already made is not about a guess', async () => {
    const { client } = mount();
    const c = cell('wa:w-1:POS');
    c.focus();
    typeInto(c, 'PRON');
    c.blur();
    await settle();
    const events = await sent(client);
    expect(events.filter((e) => e.type !== 'suggestion.shown')).toEqual([]);
  });
});
