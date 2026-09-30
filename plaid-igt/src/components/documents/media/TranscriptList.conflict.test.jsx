// A transcript row whose edit loses to another writer's change of the same
// segment (Luke's ruling Q1): the row shows the stored text with "Yours: X ·
// Enter to keep yours" under it, a toast names the change, leaving the row
// sends nothing, and Enter sends the refused text over the stored one. The
// document is the real one, against a server that keeps what it stores
// (test/segmentServer.js).
import { describe, it, expect, vi, beforeEach } from 'vitest';
import { renderComponent, all } from '@ui/test/renderComponent.jsx';
import { DocumentProvider } from '../contexts/DocumentContext.jsx';
import { TranscriptList } from './TranscriptList.jsx';
import { IgtDocument } from '@/domain/IgtDocument.js';
import { buildRawDoc, resetIds } from '@/domain/test-helpers.js';
import { digestOf, segmentServer } from '@/test/segmentServer.js';

const toasts = vi.hoisted(() => ({ warn: [], error: [] }));
vi.mock('@/utils/feedback', () => ({
  notifyWarning: (message) => toasts.warn.push(message),
  notifyError: (message, title) => toasts.error.push({ message, title }),
}));

const seg = (id, begin, end, timeBegin, timeEnd) => ({
  id,
  text: 'text-1',
  begin,
  end,
  metadata: { timeBegin, timeEnd },
});

// Three segments over "one two three", a second each.
const RAW = () =>
  buildRawDoc({
    body: 'one two three',
    words: [
      { id: 'w-1', begin: 0, end: 3 },
      { id: 'w-2', begin: 4, end: 7 },
      { id: 'w-3', begin: 8, end: 13 },
    ],
    morphemes: [],
    alignmentTokens: [seg('a-1', 0, 3, 0, 1), seg('a-2', 4, 7, 1, 2), seg('a-3', 8, 13, 2, 3)],
  });

const open = (server) => {
  const doc = new IgtDocument({
    raw: structuredClone(server.stored),
    project: { id: 'proj-1', vocabs: [], config: { plaid: {} } },
    vocabularies: {},
    client: server.client,
    projectId: 'proj-1',
    user: { id: 'a' },
  });
  doc.onError = (message, err, title) => toasts.error.push({ message, err, title });
  return doc;
};

const makeOps = (doc) => ({
  mediaReady: true,
  currentTime: 0,
  duration: 10,
  getCurrentTime: () => null,
  segmentFocusRequest: null,
  isPlaying: false,
  playingSelection: null,
  selection: null,
  setSelection: vi.fn(),
  setPopoverOpened: vi.fn(),
  playRange: vi.fn(),
  playRangeFromHere: vi.fn(),
  pausePlayback: vi.fn(),
  togglePlayback: vi.fn(),
  autoPlayOnFocus: false,
  setAutoPlayOnFocus: vi.fn(),
  handleDeleteAlignment: (id, opts) => doc.deleteAlignment(id, opts),
  playbackRate: 1,
  handlePlaybackRateChange: vi.fn(),
});

const setValue = (el, value) => {
  Object.getOwnPropertyDescriptor(Object.getPrototypeOf(el), 'value').set.call(el, value);
  el.dispatchEvent(new Event('input', { bubbles: true }));
};
const press = (el, key, init = {}) =>
  el.dispatchEvent(new KeyboardEvent('keydown', { key, bubbles: true, cancelable: true, ...init }));
const blur = (el) => el.dispatchEvent(new FocusEvent('focusout', { bubbles: true }));
const settle = () => new Promise((r) => setTimeout(r, 0));

const row = (root, n) => root.querySelector(`textarea[aria-label="Segment ${n} text"]`);
const noteOf = (root, n) => {
  const id = row(root, n).getAttribute('aria-describedby');
  return id ? root.querySelector(`#${id}`)?.textContent : null;
};
const writes = (server) => server.sent.length;

async function mount(server) {
  const doc = open(server);
  const r = await renderComponent(
    <DocumentProvider value={{ doc, readOnly: false }}>
      <TranscriptList mediaOps={makeOps(doc)} />
    </DocumentProvider>,
  );
  // Until every write has its answer, the toasts included.
  const drain = () =>
    r.step(async () => {
      for (let i = 0; i < 5 || doc.isSaving; i += 1) await settle();
    });
  return { doc, r, drain };
}

// Type `value` into row `n` and press Enter.
const typeAndEnter = async (r, n, value) => {
  await r.step(() => row(r.container, n).focus());
  await r.step(() => setValue(row(r.container, n), value));
  await r.step(async () => {
    press(row(r.container, n), 'Enter');
    await settle();
  });
};

beforeEach(() => {
  resetIds();
  toasts.warn.length = 0;
  toasts.error.length = 0;
});

describe('a transcript row whose edit lost to another change of its segment', () => {
  it('shows the stored text, the refused one under it, and a toast naming the change', async () => {
    const server = segmentServer(RAW());
    const { r, drain } = await mount(server);
    server.otherEdits('a-2', 'deux');
    await typeAndEnter(r, 2, 'dos');
    await drain();

    expect(row(r.container, 2).value).toBe('deux');
    expect(noteOf(r.container, 2)).toBe('Yours: dos · Enter to keep yours');
    expect(toasts.warn).toEqual(['b changed this to deux.']);
    expect(toasts.error).toEqual([]);
    expect(server.body).toBe('one deux three');
    await r.unmount();
  });

  it('leaving the row sends nothing, and Enter sends the refused text once over the stored one', async () => {
    const server = segmentServer(RAW());
    const { r, drain } = await mount(server);
    server.otherEdits('a-2', 'deux');
    await typeAndEnter(r, 2, 'dos');
    await drain();
    const before = writes(server);

    await r.step(() => row(r.container, 2).focus());
    await r.step(() => blur(row(r.container, 2)));
    await drain();
    expect(writes(server)).toBe(before);
    expect(server.body).toBe('one deux three');
    expect(noteOf(r.container, 2)).toBe('Yours: dos · Enter to keep yours');

    const stored = server.digest;
    await r.step(() => row(r.container, 2).focus());
    await r.step(async () => {
      press(row(r.container, 2), 'Enter');
      await settle();
    });
    await drain();
    expect(writes(server)).toBe(before + 1);
    const [text] = server.sent.at(-1).ops;
    expect(text.kind).toBe('texts.update');
    expect(text.args[3].base).toBe(stored);
    expect(stored).toBe(digestOf('one deux three'));
    expect(server.body).toBe('one dos three');
    expect(row(r.container, 2).value).toBe('dos');
    expect(noteOf(r.container, 2)).toBe(null);
    await r.unmount();
  });

  it('Escape lets the refused text go, and so does typing', async () => {
    const server = segmentServer(RAW());
    const { r, drain } = await mount(server);
    server.otherEdits('a-2', 'deux');
    await typeAndEnter(r, 2, 'dos');
    await drain();
    server.otherEdits('a-3', 'trois');
    await typeAndEnter(r, 3, 'tres');
    await drain();
    expect(noteOf(r.container, 2)).toBe('Yours: dos · Enter to keep yours');
    expect(noteOf(r.container, 3)).toBe('Yours: tres · Enter to keep yours');

    await r.step(() => row(r.container, 2).focus());
    await r.step(() => press(row(r.container, 2), 'Escape'));
    expect(noteOf(r.container, 2)).toBe(null);
    expect(row(r.container, 2).value).toBe('deux');

    await r.step(() => row(r.container, 3).focus());
    await r.step(() => setValue(row(r.container, 3), 'trois!'));
    expect(noteOf(r.container, 3)).toBe(null);
    const before = writes(server);
    // Enter after typing sends what was typed, not the refused text.
    await r.step(async () => {
      press(row(r.container, 3), 'Enter');
      await settle();
    });
    await drain();
    expect(writes(server)).toBe(before + 1);
    expect(server.body).toBe('one deux trois!');
    await r.unmount();
  });

  it('an edit of a segment whose text nobody else touched lands where the segment is now, with no note', async () => {
    const server = segmentServer(RAW());
    const { r, drain } = await mount(server);
    server.otherEdits('a-1', 'uno');
    await typeAndEnter(r, 2, 'dos');
    await drain();

    expect(server.body).toBe('uno dos three');
    expect(row(r.container, 1).value).toBe('uno');
    expect(row(r.container, 2).value).toBe('dos');
    expect(all(r.container, '[role="status"]')).toHaveLength(0);
    expect(toasts.warn).toEqual([]);
    expect(toasts.error).toEqual([]);
    await r.unmount();
  });

  it('deleting a segment with its text after someone else changed that text is refused, and the row comes back', async () => {
    const server = segmentServer(RAW());
    const { r, drain } = await mount(server);
    server.otherEdits('a-2', 'deux');
    const before = writes(server);
    const [, second] = all(r.container, 'button[aria-label="Delete segment"]');
    await r.step(async () => {
      second.click();
      await settle();
    });
    await drain();

    expect(writes(server)).toBe(before + 1); // the refused batch, and nothing after it
    expect(server.body).toBe('one deux three');
    expect(server.segments()).toHaveLength(3);
    expect(row(r.container, 2).value).toBe('deux');
    expect(toasts.error.map((t) => t.title)).toEqual(['Failed to delete segment']);
    expect(toasts.error[0].err.status).toBe(409);
    await r.unmount();
  });

  it('two speakers over one time span each have their own note: Enter in the other row keeps its text', async () => {
    const speaking = (id, begin, end, speaker) => ({
      id,
      text: 'text-1',
      begin,
      end,
      metadata: { timeBegin: 1, timeEnd: 2, speaker },
    });
    const server = segmentServer(
      buildRawDoc({
        body: 'one two three',
        words: [],
        morphemes: [],
        alignmentTokens: [
          seg('a-1', 0, 3, 0, 1),
          speaking('a-2', 4, 7, 'A'),
          speaking('a-3', 8, 13, 'B'),
        ],
      }),
    );
    const { r, drain } = await mount(server);
    expect([row(r.container, 2).value, row(r.container, 3).value]).toEqual(['two', 'three']);
    server.otherEdits('a-2', 'deux');
    await typeAndEnter(r, 2, 'dos');
    await drain();
    expect(row(r.container, 2).value).toBe('deux');
    expect(noteOf(r.container, 2)).toBe('Yours: dos · Enter to keep yours');
    expect(noteOf(r.container, 3)).toBe(null);

    // Enter in speaker B's row, nothing typed: nothing of speaker A's is sent.
    const before = writes(server);
    await r.step(() => row(r.container, 3).focus());
    await r.step(async () => {
      press(row(r.container, 3), 'Enter');
      await settle();
    });
    await drain();
    expect(writes(server)).toBe(before);
    expect(server.body).toBe('one deux three');
    expect(noteOf(r.container, 2)).toBe('Yours: dos · Enter to keep yours');
    await r.unmount();
  });
});

describe('a refused row edit whose segment cannot be told apart (second review)', () => {
  const speaking = (id, begin, end, speaker) => ({
    id,
    text: 'text-1',
    begin,
    end,
    metadata: { timeBegin: 1, timeEnd: 2, speaker },
  });
  const alignLayer = (server) =>
    server.stored.textLayers[0].tokenLayers.find((l) => l.id === 'alignL');

  it('A’s segment deleted with its text and B’s changed: no note on B’s row, and Enter there sends nothing (R6-bis)', async () => {
    const server = segmentServer(
      buildRawDoc({
        body: 'one two three',
        words: [],
        morphemes: [],
        alignmentTokens: [
          seg('a-1', 0, 3, 0, 1),
          speaking('a-2', 4, 7, 'A'),
          speaking('a-3', 8, 13, 'B'),
        ],
      }),
    );
    const { r, drain } = await mount(server);
    server.otherEdits('a-3', 'tres');
    alignLayer(server).tokens = alignLayer(server).tokens.filter((t) => t.id !== 'a-2');
    server.otherSaves([{ type: 'delete', index: 3, value: 4 }]);
    await typeAndEnter(r, 2, 'dos');
    await drain();

    expect(row(r.container, 2).value).toBe('tres');
    expect(noteOf(r.container, 2)).toBe(null);
    expect(toasts.error.map((t) => t.message)).toEqual(['Not saved: dos']);
    const before = writes(server);
    await r.step(() => row(r.container, 2).focus());
    await r.step(async () => {
      press(row(r.container, 2), 'Enter');
      await settle();
    });
    await drain();
    expect(writes(server)).toBe(before);
    expect(server.body).toBe('one tres');
    expect(server.segments()[1].metadata.speaker).toBe('B');
    await r.unmount();
  });

  it('its text and its end changed elsewhere: the row shows the stored text with yours under it (T1)', async () => {
    const server = segmentServer(RAW());
    const { r, drain } = await mount(server);
    const theirs = server.otherEdits('a-3', 'tres!');
    server.otherRelabels(theirs, { timeEnd: 2.7 }, 'c');
    await typeAndEnter(r, 3, 'MINE3');
    await drain();

    expect(row(r.container, 3).value).toBe('tres!');
    expect(noteOf(r.container, 3)).toBe('Yours: MINE3 · Enter to keep yours');
    expect(toasts.error).toEqual([]);

    await r.step(() => row(r.container, 3).focus());
    await r.step(async () => {
      press(row(r.container, 3), 'Enter');
      await settle();
    });
    await drain();
    expect(server.body).toBe('one two MINE3');
    expect(server.segments()[2].metadata.timeEnd).toBe(2.7);
    await r.unmount();
  });
});
