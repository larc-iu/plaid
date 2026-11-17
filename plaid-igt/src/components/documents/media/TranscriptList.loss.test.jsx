// A transcript row's text is saved as the Baseline tab saves it, and asks
// first as that save asks when it deletes glossed words (H10-3). Retyping a
// row whole deleted its words with their glosses and said nothing, where the
// same edit on the Baseline tab asked "Save baseline changes? Deletes 3 words
// and 3 annotations.". The document is the real one, against a server that
// keeps what it stores (test/segmentServer.js).
import { describe, it, expect, vi, beforeEach } from 'vitest';
import { renderComponent } from '@ui/test/renderComponent.jsx';
import { ConfirmProvider, useConfirm } from '@ui/components/shared/ConfirmProvider';
import { useState } from 'react';
import { DocumentProvider } from '../contexts/DocumentContext.jsx';
import { TranscriptList } from './TranscriptList.jsx';
import { buildRawDoc, resetIds, makeIgtDoc, settle } from '@/domain/test-helpers.js';
import { segmentServer } from '@/test/segmentServer.js';

vi.mock('@/utils/feedback', () => ({
  notifyWarning: () => {},
  notifyError: () => {},
}));

const seg = (id, begin, end, timeBegin, timeEnd) => ({
  id,
  text: 'text-1',
  begin,
  end,
  metadata: { timeBegin, timeEnd },
});

//            0         1         2         3
//            0123456789012345678901234567890123
const BODY = 'uno dos tres\ncuatro cinco seis';
const WORDS = [...BODY.matchAll(/\S+/g)].map((m, i) => ({
  id: `w-${i + 1}`,
  begin: m.index,
  end: m.index + m[0].length,
}));

// Two lines, a segment and a sentence each, every morpheme of the second
// glossed when `glossed`.
const RAW = (glossed = true) => {
  const raw = buildRawDoc({
    body: BODY,
    words: WORDS,
    sentences: [
      { id: 's-1', begin: 0, end: 13 },
      { id: 's-2', begin: 13, end: 30 },
    ],
    alignmentTokens: [seg('a-1', 0, 12, 1, 3), seg('a-2', 13, 30, 4, 6)],
  });
  const morphs = raw.textLayers[0].tokenLayers.find((l) => l.id === 'morphL');
  morphs.spanLayers[0].spans = glossed
    ? morphs.tokens
        .filter((m) => m.begin >= 13)
        .map((m) => ({ id: `g-${m.id}`, tokens: [m.id], value: `g.${BODY.slice(m.begin, m.end)}` }))
    : [];
  return raw;
};

const setValue = (el, value) => {
  Object.getOwnPropertyDescriptor(Object.getPrototypeOf(el), 'value').set.call(el, value);
  el.dispatchEvent(new Event('input', { bubbles: true }));
};
const press = (el, key) =>
  el.dispatchEvent(new KeyboardEvent('keydown', { key, bubbles: true, cancelable: true }));
const row = (root, n) => root.querySelector(`textarea[aria-label="Segment ${n} text"]`);
const dialog = () => document.querySelector('[role="alertdialog"]');
const button = (label) =>
  [...(dialog()?.querySelectorAll('button') ?? [])].find((b) => b.textContent === label);

const makeOps = () => ({
  mediaReady: true,
  currentTime: 0,
  duration: 10,
  getCurrentTime: () => null,
  segmentFocusRequest: null,
  isPlaying: false,
  playingNow: () => false,
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
  handleDeleteAlignment: vi.fn(),
  playbackRate: 1,
  handlePlaybackRateChange: vi.fn(),
});

// The transcript, which `show(false)` takes away as a click on another tab
// does, and a button that asks a question of its own, as another part of the
// page may while the row's question is open.
const host = {};
function Host({ doc }) {
  const [shown, setShown] = useState(true);
  host.show = setShown;
  const confirm = useConfirm();
  return (
    <DocumentProvider value={{ doc, readOnly: false }}>
      <button type="button" onClick={() => confirm({ title: 'Other question?' })}>
        Other
      </button>
      {shown && <TranscriptList mediaOps={makeOps()} />}
    </DocumentProvider>
  );
}

async function mount(raw) {
  const server = segmentServer(raw);
  const doc = makeIgtDoc({
    raw: structuredClone(server.stored),
    client: server.client,
    user: { id: 'a' },
  });
  const r = await renderComponent(
    <ConfirmProvider>
      <Host doc={doc} />
    </ConfirmProvider>,
  );
  const drain = () =>
    r.step(async () => {
      for (let i = 0; i < 5 || doc.isSaving; i += 1) await settle();
    });
  return { server, doc, r, drain };
}

// Type `value` over row `n` and press Enter, without waiting for the answer.
const retype = async (r, n, value) => {
  await r.step(() => row(r.container, n).focus());
  await r.step(() => setValue(row(r.container, n), value));
  await r.step(async () => {
    press(row(r.container, n), 'Enter');
    await settle();
  });
};

const blur = (el) => el.dispatchEvent(new FocusEvent('focusout', { bubbles: true }));
const click = (el) => el.dispatchEvent(new MouseEvent('click', { bubbles: true }));
const notSaved = (root) =>
  [...root.querySelectorAll('ul[aria-label="Not saved"] li')].map((li) => li.textContent);

// Type `value` over row `n` and leave the row by blur, as a click elsewhere.
const retypeAndBlur = async (r, n, value) => {
  await r.step(() => row(r.container, n).focus());
  await r.step(() => setValue(row(r.container, n), value));
  await r.step(async () => {
    blur(row(r.container, n));
    await settle();
  });
};

const glosses = (doc) =>
  doc.layerInfo.primaryTextLayer.tokenLayers
    .find((l) => l.id === 'morphL')
    .spanLayers[0].spans.map((s) => s.value)
    .sort();

beforeEach(() => resetIds());

describe('a transcript row retyped over glossed words (H10-3)', () => {
  it('asks first, with the counts the Baseline tab gives, and Cancel writes nothing', async () => {
    const { server, doc, r, drain } = await mount(RAW());
    await retype(r, 2, 'nueve diez once');
    await drain();
    expect(dialog()?.textContent).toContain('Save segment text?');
    expect(dialog()?.textContent).toContain('Deletes 3 words and 3 annotations.');
    await r.step(async () => {
      button('Cancel').click();
      await settle();
    });
    await drain();
    expect(server.body).toBe(BODY);
    expect(glosses(doc)).toEqual(['g.cinco', 'g.cuatro', 'g.seis']);
    // The typing stays in the row.
    expect(row(r.container, 2).value).toBe('nueve diez once');
    await r.unmount();
  });

  it('saves on Save anyway', async () => {
    const { server, r, drain } = await mount(RAW());
    await retype(r, 2, 'nueve diez once');
    await drain();
    await r.step(async () => {
      button('Save anyway').click();
      await settle();
    });
    await drain();
    expect(server.body).toBe('uno dos tres\nnueve diez once');
    await r.unmount();
  });

  // REV-HFM-2: the row counts what the Baseline tab counts, a person's
  // confirmed segmentation included.
  it("asks over morphemes that hold a person's work and no gloss", async () => {
    const raw = RAW(false);
    const morphs = raw.textLayers[0].tokenLayers.find((l) => l.id === 'morphL');
    for (const m of morphs.tokens.filter((t) => t.begin >= 13)) {
      m.metadata = { prov: 'inferred', provConfirmed: true };
    }
    const { r, drain } = await mount(raw);
    await retype(r, 2, 'nueve diez once');
    await drain();
    expect(dialog()?.textContent).toContain('Deletes 3 words and 3 annotations.');
    await r.unmount();
  });

  it('asks nothing when no annotation goes: a word corrected, or unglossed words retyped', async () => {
    const glossed = await mount(RAW());
    await retype(glossed.r, 2, 'cuatro cinko seis');
    await glossed.drain();
    expect(dialog()).toBeNull();
    expect(glossed.server.body).toBe('uno dos tres\ncuatro cinko seis');
    await glossed.r.unmount();

    const plain = await mount(RAW(false));
    await retype(plain.r, 2, 'nueve diez once');
    await plain.drain();
    expect(dialog()).toBeNull();
    expect(plain.server.body).toBe('uno dos tres\nnueve diez once');
    await plain.r.unmount();
  });
});

// REV-HFM-1, -3, -4: the question asked on every way a row is saved, typing
// never dropped, and the segment written as it is when the answer comes.
describe("a row's question, however the row is left", () => {
  it('asks on blur as on Enter', async () => {
    const { server, r, drain } = await mount(RAW());
    await retypeAndBlur(r, 2, 'nueve diez once');
    await drain();
    expect(dialog()?.textContent).toContain('Deletes 3 words and 3 annotations.');
    await r.step(async () => {
      button('Save anyway').click();
      await settle();
    });
    await drain();
    expect(server.body).toBe('uno dos tres\nnueve diez once');
    await r.unmount();
  });

  it('keeps the typing under Not saved when Cancel comes after the tab was left', async () => {
    const { server, doc, r, drain } = await mount(RAW());
    await retypeAndBlur(r, 2, 'nueve diez once');
    await drain();
    expect(dialog()).not.toBeNull();
    // A click on another tab: the transcript goes while the question is open.
    await r.step(() => host.show(false));
    await drain();
    await r.step(async () => {
      button('Cancel').click();
      await settle();
    });
    await drain();
    expect(server.body).toBe(BODY);
    expect(doc.unsavedRows).toMatchObject([{ typed: 'nueve diez once', timeBegin: 4, timeEnd: 6 }]);
    await r.step(() => host.show(true));
    expect(notSaved(r.container).join(' ')).toContain('nueve diez once');
    await r.unmount();
  });

  it('keeps it too when a second question answers the first as Cancel', async () => {
    const { server, doc, r, drain } = await mount(RAW());
    await retype(r, 2, 'nueve diez once');
    await drain();
    // The transcript goes, saving on leaving and asking again, and another
    // question then replaces this one.
    await r.step(() => host.show(false));
    await drain();
    const other = [...r.container.querySelectorAll('button')].find(
      (b) => b.textContent === 'Other',
    );
    await r.step(async () => {
      click(other);
      await settle();
    });
    await drain();
    expect(dialog()?.textContent).toContain('Other question?');
    expect(server.body).toBe(BODY);
    expect(doc.unsavedRows).toMatchObject([{ typed: 'nueve diez once' }]);
    await r.step(async () => {
      button('Cancel').click();
      await settle();
    });
    await r.unmount();
  });

  it('writes the times the segment has when the answer comes, not the ones it had', async () => {
    const { server, doc, r, drain } = await mount(RAW());
    await retype(r, 2, 'nueve diez once');
    await drain();
    // Another writer moves the segment's start while the question is open,
    // and this page has read it.
    server.otherRelabels('a-2', { timeBegin: 4.5 });
    await r.step(async () => {
      await doc.reload();
      await settle();
    });
    expect(doc.alignmentTokens.find((t) => t.id === 'a-2').metadata.timeBegin).toBe(4.5);
    await r.step(async () => {
      button('Save anyway').click();
      await settle();
    });
    await drain();
    expect(server.body).toBe('uno dos tres\nnueve diez once');
    expect(server.segments().find((t) => t.id === 'a-2').metadata.timeBegin).toBe(4.5);
    await r.unmount();
  });

  it('asks once for a save the server refused for a change elsewhere, sent again by Enter', async () => {
    const { server, r, drain } = await mount(RAW());
    // Another user changed this very segment's text meanwhile.
    server.otherRetypes('a-2', 'cuatro cinco seis!');
    await retype(r, 2, 'nueve diez once');
    await drain();
    expect(dialog()).not.toBeNull();
    await r.step(async () => {
      button('Save anyway').click();
      await settle();
    });
    await drain();
    // Refused: the row shows their text with this one under it, and Enter
    // keeps this one, with no second question.
    expect(row(r.container, 2).value).toBe('cuatro cinco seis!');
    await r.step(() => row(r.container, 2).focus());
    await r.step(async () => {
      press(row(r.container, 2), 'Enter');
      await settle();
    });
    await drain();
    expect(dialog()).toBeNull();
    expect(server.body).toBe('uno dos tres\nnueve diez once');
    await r.unmount();
  });
});
