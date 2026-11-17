import { describe, it, expect } from 'vitest';
import { MemoryRouter } from 'react-router-dom';
import { renderComponent } from '@ui/test/renderComponent.jsx';
import { buildContextRows } from '@/components/projects/search/searchRunner.js';
import { withMorphemeHits } from './vocabConcordance';
import { ConcordancePanel } from './ConcordancePanel.jsx';
import { MarkedText } from '@ui/components/shared/MarkedText.jsx';

// GH #68: an entry linked at morpheme level is picked out inside its word in
// the concordance. Where the word's morpheme forms spell the written word,
// the morpheme's letters get a stronger mark inside the word's highlight.
// Where they do not, the word keeps its highlight and the row shows the
// word's segmentation with the morpheme picked out. A word linked as a whole
// shows what it always did.

const BODY = 'Ukunguut nengllugutet. David pinguuq. Jesus Messiahnguuq.';

const m = (id, form, begin, end, morphType = null) => ({
  id,
  begin,
  end,
  content: BODY.slice(begin, end),
  morphType,
  metadata: { form },
});
const w = (id, begin, end, morphemes) => ({
  id,
  begin,
  end,
  content: BODY.slice(begin, end),
  morphemes: morphemes(begin, end),
});

const doc = {
  body: BODY,
  layerInfo: { spanLayers: { sentence: [] } },
  sentences: [
    {
      // Underlying forms: "uku-nge-ut" is written "Ukunguut" (rule 2).
      id: 's1',
      begin: 0,
      end: 22,
      annotations: {},
      tokens: [
        w('w1', 0, 8, (b, e) => [
          m('m1a', 'uku', b, e),
          m('m1b', 'nge', b, e),
          m('m1c', 'ut', b, e),
        ]),
        w('w2', 9, 21, () => []),
      ],
    },
    {
      // The forms spell the word (rule 1).
      id: 's2',
      begin: 23,
      end: 37,
      annotations: {},
      tokens: [
        w('w3', 23, 28, () => []),
        w('w4', 29, 36, (b, e) => [
          m('m4a', 'pi', b, e),
          m('m4b', 'ngu', b, e),
          m('m4c', 'uq', b, e),
        ]),
      ],
    },
    {
      // The word itself is linked (a word-level hit).
      id: 's3',
      begin: 38,
      end: 57,
      annotations: {},
      tokens: [w('w5', 38, 43, () => []), w('w6', 44, 56, () => [])],
    },
  ],
};

const HITS = new Set(['m1b', 'm4b', 'w6']);
const rowsOf = () => withMorphemeHits(doc, buildContextRows(doc, { kind: 'lexicon' }, HITS), HITS);

const mount = (rows) =>
  renderComponent(
    <MemoryRouter>
      <ConcordancePanel
        conc={{
          concPlan: { totalHits: 3, totalDocs: 1 },
          concGroups: [{ docId: 'd1', projectId: 'p1', docName: 'Matthew 1', docHits: 3, rows }],
          concLoaded: 1,
        }}
        selectedItem={{ id: 'e1', metadata: {} }}
        canEdit={false}
        onAddExample={() => {}}
      />
    </MemoryRouter>,
  );

const rowLinks = (view) => [...view.container.querySelectorAll('a')];

// One sentence, split on spaces. `analyses` maps a word to its forms, the
// form marked with a leading "!" being the hit.
const oneSentence = (text, analyses) => {
  const tokens = [];
  const hits = new Set();
  let pos = 0;
  for (const piece of text.split(' ')) {
    const begin = pos;
    const end = pos + [...piece].length;
    pos = end + 1;
    const forms = analyses[piece] || [];
    tokens.push({
      id: `w${begin}`,
      begin,
      end,
      content: piece,
      morphemes: forms.map((f, i) => {
        const id = `w${begin}m${i}`;
        if (f.startsWith('!')) hits.add(id);
        return { id, begin, end, metadata: { form: f.replace(/^!/, '') } };
      }),
    });
  }
  const d = {
    body: text,
    layerInfo: { spanLayers: { sentence: [] } },
    sentences: [{ id: 's', begin: 0, end: [...text].length, annotations: {}, tokens }],
  };
  return withMorphemeHits(d, buildContextRows(d, { kind: 'lexicon' }, hits), hits);
};

describe('withMorphemeHits', () => {
  it('adds the morpheme’s range inside its word when the forms spell the word', () => {
    const [, spelled] = rowsOf();
    expect(spelled.marks).toEqual([{ begin: 6, end: 13, inner: [{ begin: 8, end: 11 }] }]);
    expect(spelled.stacks).toBeUndefined();
  });

  it('adds the word’s segmentation at the word, and no range, when they do not', () => {
    const [underlying] = rowsOf();
    expect(underlying.marks).toEqual([{ begin: 0, end: 8 }]);
    expect(underlying.stacks).toEqual([
      {
        begin: 0,
        end: 8,
        parts: [
          { joiner: null, form: 'uku', hit: false },
          { joiner: '-', form: 'nge', hit: true },
          { joiner: '-', form: 'ut', hit: false },
        ],
      },
    ]);
  });

  it('leaves a word-level hit’s row exactly as Search would build it', () => {
    const plain = buildContextRows(doc, { kind: 'lexicon' }, HITS);
    expect(rowsOf()[2]).toEqual(plain[2]);
  });

  it('does not change what buildContextRows gives Search', () => {
    // The concordance adds its detail on top. Search's rows carry none.
    for (const row of buildContextRows(doc, { kind: 'lexicon' }, HITS)) {
      expect(row.marks.every((mk) => !('inner' in mk))).toBe(true);
      expect(row.stacks).toBeUndefined();
    }
  });

  it('handles each hit in a row on its own', () => {
    const [row] = oneSentence('pinguuq Ukunguut', {
      pinguuq: ['pi', '!ngu', 'uq'],
      Ukunguut: ['uku', '!nge', 'ut'],
    });
    expect(row.marks).toEqual([
      { begin: 0, end: 7, inner: [{ begin: 2, end: 5 }] },
      { begin: 8, end: 16 },
    ]);
    expect(row.stacks.map((st) => [st.begin, st.end])).toEqual([[8, 16]]);
  });
});

const stacksIn = (row) => [...row.querySelectorAll('[data-stack]')];
const mountRow = (rows) => mount(rows).then((view) => [view, rowLinks(view)[0]]);

describe('ConcordancePanel, a morpheme in its word', () => {
  it('marks the morpheme’s letters inside the word’s highlight, on one line', async () => {
    const view = await mount(rowsOf());
    const row = rowLinks(view)[1];
    const mark = row.querySelector('mark');
    expect(mark.textContent).toBe('pinguuq');
    expect(mark.querySelector('span').textContent).toBe('ngu');
    expect(stacksIn(row)).toEqual([]);
    expect(row.textContent).not.toContain('pi-ngu-uq');
    await view.unmount();
  });

  it('sets the segmentation under its word, in one group with it', async () => {
    const view = await mount(rowsOf());
    const row = rowLinks(view)[0];
    const [stack] = stacksIn(row);
    expect(stacksIn(row)).toHaveLength(1);
    const mark = stack.querySelector('mark');
    expect(mark.textContent).toBe('Ukunguut');
    expect(mark.querySelector('span')).toBeNull();
    const seg = stack.querySelector('[data-segmentation]');
    expect(seg.parentElement).toBe(stack);
    expect(stack.firstElementChild).toBe(mark);
    expect(seg.textContent).toBe('uku-nge-ut');
    expect(seg.querySelector('.bg-highlight-strong').textContent).toBe('nge');
    // The rest of the sentence is on the first line, outside any stack.
    expect(row.querySelector('bdi').textContent).toBe('Ukunguutuku-nge-ut nengllugutet.');
    await view.unmount();
  });

  it('shows a word linked as a whole as before: its highlight and nothing more', async () => {
    const view = await mount(rowsOf());
    const row = rowLinks(view)[2];
    expect(row.querySelector('mark').textContent).toBe('Messiahnguuq');
    expect(row.querySelector('mark span')).toBeNull();
    expect(stacksIn(row)).toEqual([]);
    expect(row.querySelector('[data-segmentation]')).toBeNull();
    await view.unmount();
  });

  it('draws a row with no segmented hit exactly as MarkedText does', async () => {
    const view = await mount(rowsOf());
    const row = rowLinks(view)[1];
    const alone = await renderComponent(
      <MarkedText text={rowsOf()[1].text} marks={rowsOf()[1].marks} />,
    );
    expect(row.querySelector('bdi').outerHTML).toBe(alone.container.innerHTML);
    await alone.unmount();
    await view.unmount();
  });

  it('stacks two neighbouring words each under its own', async () => {
    const [view, row] = await mountRow(
      oneSentence('Ukunguut angayuqaungurtut .', {
        Ukunguut: ['uku', '!nge', 'ut'],
        angayuqaungurtut: ['angayuqaq', '!ngu', 'rte', 'ut'],
      }),
    );
    const stacks = stacksIn(row);
    expect(stacks.map((st) => st.querySelector('mark').textContent)).toEqual([
      'Ukunguut',
      'angayuqaungurtut',
    ]);
    expect(stacks.map((st) => st.querySelector('[data-segmentation]').textContent)).toEqual([
      'uku-nge-ut',
      'angayuqaq-ngu-rte-ut',
    ]);
    await view.unmount();
  });

  it('stacks only the segmented hit in a row that mixes both', async () => {
    const [view, row] = await mountRow(
      oneSentence('pinguuq Ukunguut .', {
        pinguuq: ['pi', '!ngu', 'uq'],
        Ukunguut: ['uku', '!nge', 'ut'],
      }),
    );
    const marks = [...row.querySelectorAll('mark')];
    expect(marks.map((mk) => mk.textContent)).toEqual(['pinguuq', 'Ukunguut']);
    expect(marks[0].closest('[data-stack]')).toBeNull();
    expect(marks[0].querySelector('span').textContent).toBe('ngu');
    expect(marks[1].closest('[data-stack]')).not.toBeNull();
    await view.unmount();
  });

  it('stacks in a right-to-left sentence, the stack following its direction', async () => {
    const [view, row] = await mountRow(
      oneSentence('قرأ الولد الكتاب .', { الكتاب: ['!ال', 'كتب'] }),
    );
    const bdi = row.querySelector('bdi');
    expect(bdi.getAttribute('dir')).toBe('rtl');
    const [stack] = stacksIn(row);
    expect(stack.querySelector('mark').textContent).toBe('الكتاب');
    expect(stack.querySelector('[data-segmentation]').textContent).toBe('ال-كتب');
    expect(stack.className).toContain('text-start');
    await view.unmount();
  });
});
