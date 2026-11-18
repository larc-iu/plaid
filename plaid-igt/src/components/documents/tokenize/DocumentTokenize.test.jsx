import { describe, it, expect, vi, afterEach } from 'vitest';
import { renderComponent } from '@ui/test/renderComponent.jsx';
import { DocumentProvider } from '../contexts/DocumentContext.jsx';
import { TooltipProvider } from '@ui/components/ui/tooltip';
import { SentenceComponent, SentenceSplitWords, TokenComponent } from './DocumentTokenize.jsx';
import { segmentSplitDescription } from '@/domain/segments.js';

// Alt+click on a word here opens the same word on the Analyze tab. It used to
// ask for the tab by dispatching a window event that the tab hook listens for,
// which is the island's way in and not a React screen's: both sit under one
// provider, and a listener is invisible to anything reading this file. The
// switch now goes through the context.

const piece = { id: 'w1', begin: 0, end: 3, content: 'abc', isToken: true };
const sentence = { id: 's1', pieces: [piece] };

const mount = (ctx, props) =>
  renderComponent(
    <DocumentProvider value={{ doc: { id: 'd1' }, goToTab: () => {}, ...ctx }}>
      <TokenComponent
        ops={{ splitSentence: () => {} }}
        sentence={sentence}
        piece={piece}
        pieceIndex={1}
        drag={null}
        setDrag={() => {}}
        dragRef={{ current: null }}
        {...props}
      />
    </DocumentProvider>,
  );

const click = (el, init) => el.dispatchEvent(new MouseEvent('click', { bubbles: true, ...init }));

afterEach(() => vi.restoreAllMocks());

describe('a word on the Tokenize tab', () => {
  it('asks the document for the Analyze tab on Alt+click', async () => {
    const goToTab = vi.fn();
    const view = await mount({ goToTab });
    const token = view.container.querySelector('.token');
    await view.step(() => click(token, { altKey: true }));
    expect(goToTab).toHaveBeenCalledWith('analyze');
    await view.unmount();
  });

  it('switches tabs read-only too, since it changes nothing', async () => {
    const goToTab = vi.fn();
    const view = await mount({ goToTab }, { readOnly: true });
    const token = view.container.querySelector('.token');
    await view.step(() => click(token, { altKey: true }));
    expect(goToTab).toHaveBeenCalledWith('analyze');
    await view.unmount();
  });

  it('leaves Ctrl/Cmd+click as the sentence split', async () => {
    const goToTab = vi.fn();
    const splitSentence = vi.fn();
    const view = await mount({ goToTab }, { ops: { splitSentence } });
    const token = view.container.querySelector('.token');
    await view.step(() => click(token, { ctrlKey: true }));
    expect(splitSentence).toHaveBeenCalledWith(0);
    await view.step(() => click(token, { metaKey: true }));
    expect(splitSentence).toHaveBeenCalledTimes(2);
    expect(goToTab).not.toHaveBeenCalled();
    await view.unmount();
  });
});

// The splitter lays a word's letters out as boxes in a flex row, which takes
// its order from the row's direction. In an Arabic document a Latin word or a
// number would then read backwards ("Plaid" as "dialP"), so the box takes the
// word's own direction, as every value does.
describe('the splitter', () => {
  it("lays a word's letters out in the word's own direction", async () => {
    const word = { id: 'w2', begin: 0, end: 5, content: 'Plaid', isToken: true };
    const view = await mount({}, { piece: word, sentence: { id: 's1', pieces: [word] } });
    await view.step(() => click(view.container.querySelector('.token')));
    const box = view.container.querySelector('.splitter-box');
    expect(box).not.toBeNull();
    expect(box.getAttribute('dir')).toBe('auto');
    await view.unmount();
  });
});

// H1-5, H16-4: the split points sat between code points, so a letter and
// its combining marks could be cut apart, leaving a word that starts with a
// lone mark. REV-HFT-2: a fixed rule over code points, not grapheme
// clusters (which keep a whole Indic conjunct as one): no split before a
// combining mark, U+200D or a variation selector, and none after U+200D.
describe('the split points', () => {
  const lettersOf = async (content, splitToken = vi.fn()) => {
    const word = { id: 'w2', begin: 10, end: 10 + [...content].length, content, isToken: true };
    const view = await mount(
      {},
      { piece: word, sentence: { id: 's1', pieces: [word] }, ops: { splitToken } },
    );
    await view.step(() => click(view.container.querySelector('.token')));
    const letters = [...view.container.querySelectorAll('.splitter-char')].map(
      (e) => e.textContent,
    );
    const points = view.container.querySelectorAll('.splitter-split-point');
    return { view, letters, points };
  };

  it('keeps a letter with its combining marks', async () => {
    const a = await lettersOf('q\u0313\u02b7ala');
    expect(a.letters).toEqual(['q\u0313', '\u02b7', 'a', 'l', 'a']);
    await a.view.unmount();
    const b = await lettersOf('\u0627\u0644\u062f\u064e\u0651\u0631\u0652\u0633\u064e');
    expect(b.letters).toEqual([
      '\u0627',
      '\u0644',
      '\u062f\u064e\u0651',
      '\u0631\u0652',
      '\u0633\u064e',
    ]);
    await b.view.unmount();
  });

  it('splits after the whole letter, in code points', async () => {
    const splitToken = vi.fn();
    const { view, points } = await lettersOf('x\u0331ach', splitToken);
    expect(points.length).toBe(3);
    await view.step(() => click(points[0]));
    // splitToken takes the offset of the last code point of the left half.
    expect(splitToken).toHaveBeenCalledWith('w2', 1);
    await view.unmount();
  });

  it('splits a Devanagari compound at a conjunct, after the virama', async () => {
    const splitToken = vi.fn();
    // vāg|devī, written as one word with the conjunct g+d.
    const { view, letters, points } = await lettersOf(
      '\u0935\u093e\u0917\u094d\u0926\u0947\u0935\u0940',
      splitToken,
    );
    expect(letters).toEqual(['\u0935\u093e', '\u0917\u094d', '\u0926\u0947', '\u0935\u0940']);
    await view.step(() => click(points[1]));
    expect(splitToken).toHaveBeenCalledWith('w2', 3);
    await view.unmount();
  });

  it('keeps a ZWJ emoji and a variation selector whole, and splits a flag pair and a skin tone', async () => {
    const zwj = await lettersOf('a\u{1F469}\u200d\u{1F4BB}\u2764\ufe0f');
    expect(zwj.letters).toEqual(['a', '\u{1F469}\u200d\u{1F4BB}', '\u2764\ufe0f']);
    await zwj.view.unmount();
    // A flag is two regional indicators and a skin tone is a modifier letter
    // of its own, neither a mark: the fixed rule offers a point between them.
    const flag = await lettersOf('\u{1F1EB}\u{1F1F7}\u{1F44D}\u{1F3FD}');
    expect(flag.letters).toEqual(['\u{1F1EB}', '\u{1F1F7}', '\u{1F44D}', '\u{1F3FD}']);
    await flag.view.unmount();
  });

  it('does not open on a word of one letter with a mark', async () => {
    const { view } = await lettersOf('x\u0331');
    expect(view.container.querySelector('.splitter-box')).toBeNull();
    await view.unmount();
  });
});

// The splitter closed only when the pointer left the word, so a pointer
// resting on it kept the scissors up and a Ctrl+click there landed on a letter.
describe('Escape on the splitter', () => {
  const press = (key) =>
    document.dispatchEvent(new KeyboardEvent('keydown', { key, bubbles: true, cancelable: true }));

  it('closes it, wherever focus is', async () => {
    const word = { id: 'w2', begin: 0, end: 5, content: 'Plaid', isToken: true };
    const view = await mount({}, { piece: word, sentence: { id: 's1', pieces: [word] } });
    await view.step(() => click(view.container.querySelector('.token')));
    await view.step(() => press('a'));
    expect(view.container.querySelector('.splitter-box')).not.toBeNull();
    await view.step(() => press('Escape'));
    expect(view.container.querySelector('.splitter-box')).toBeNull();
    expect(view.container.querySelector('.token')).not.toBeNull();
    await view.unmount();
  });
});

describe("a sentence's merge-with-previous button", () => {
  it('has a name a screen reader can say', async () => {
    // Lazy shows the row once it scrolls into view.
    vi.stubGlobal(
      'IntersectionObserver',
      class {
        constructor(cb) {
          this.cb = cb;
        }
        observe() {
          this.cb([{ isIntersecting: true }]);
        }
        disconnect() {}
      },
    );
    const view = await renderComponent(
      <DocumentProvider value={{ doc: { id: 'd1' }, goToTab: () => {} }}>
        <TooltipProvider>
          <SentenceComponent
            sentence={sentence}
            ops={{ mergeSentence: () => {}, splitSentence: () => {} }}
            index={1}
            drag={null}
            setDrag={() => {}}
            dragRef={{ current: null }}
          />
        </TooltipProvider>
      </DocumentProvider>,
    );
    const button = view.container.querySelector('.merge-button button');
    expect(button.getAttribute('aria-label')).toBe('Merge with above');
    await view.unmount();
    vi.unstubAllGlobals();
  });
});

// H6-2: a split that puts a multi-word expression's words in two sentences
// says so in the split confirmation. The expression is not deleted, so the
// line says what is shown, and nothing about deleting.
describe('the sentence split confirmation', () => {
  const none = { annotations: 0, links: 0, hiddenMwes: 0, partialMwes: 0 };
  const render = (loss) =>
    renderComponent(
      <div>
        <SentenceSplitWords loss={loss} />
      </div>,
    );
  const lines = (view) => [...view.container.querySelectorAll('p')].map((p) => p.textContent);

  it('names a multi-word expression it hides, when it deletes nothing', async () => {
    const view = await render({ ...none, hiddenMwes: 1 });
    expect(lines(view)).toEqual([
      '1 multi-word expression will not be shown until the sentences are merged again.',
    ]);
    expect(view.container.querySelector('strong').textContent).toBe('1 multi-word expression');
    await view.unmount();
  });

  it('names those it shows in part, after what it deletes', async () => {
    const view = await render({ ...none, annotations: 2, hiddenMwes: 2, partialMwes: 1 });
    expect(lines(view)).toEqual([
      'Splitting the sentence here deletes 2 annotations that cross the new break.',
      '2 multi-word expressions will not be shown until the sentences are merged again.',
      '1 multi-word expression will be shown only in part until the sentences are merged again.',
    ]);
    await view.unmount();
  });

  it('says only what it deletes when it cuts no multi-word expression', async () => {
    const view = await render({ ...none, links: 1 });
    expect(lines(view)).toEqual([
      'Splitting the sentence here deletes 1 vocabulary link that cross the new break.',
    ]);
    await view.unmount();
  });

  it('Split sentences at segments says it too', () => {
    expect(segmentSplitDescription(2, 0, { ...none, hiddenMwes: 1 })).toBe(
      '2 sentence breaks will be added where segments start.' +
        ' 1 multi-word expression will not be shown until the sentences are merged again.',
    );
    expect(segmentSplitDescription(1, 1, { ...none, annotations: 1, partialMwes: 2 })).toBe(
      '1 sentence break will be added where segments start.' +
        ' 1 segment starts inside a word and is left alone.' +
        ' Deletes 1 annotation that cross the new break.' +
        ' 2 multi-word expressions will be shown only in part until the sentences are merged again.',
    );
    expect(segmentSplitDescription(3, 0, none)).toBe(
      '3 sentence breaks will be added where segments start.',
    );
  });
});
