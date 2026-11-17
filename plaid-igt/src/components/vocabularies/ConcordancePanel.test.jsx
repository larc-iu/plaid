import { describe, it, expect } from 'vitest';
import { MemoryRouter } from 'react-router-dom';
import { renderComponent } from '@ui/test/renderComponent.jsx';
import { buildContextRows } from '@/components/projects/search/searchRunner.js';
import { withMorphemeHits } from './vocabConcordance';
import { ConcordancePanel } from './ConcordancePanel.jsx';

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

describe('withMorphemeHits', () => {
  it('adds the morpheme’s range inside its word when the forms spell the word', () => {
    const [, spelled] = rowsOf();
    expect(spelled.marks).toEqual([{ begin: 6, end: 13, inner: [{ begin: 8, end: 11 }] }]);
    expect(spelled.segmentations).toBeUndefined();
  });

  it('adds the segmentation, and no range, when they do not', () => {
    const [underlying] = rowsOf();
    expect(underlying.marks).toEqual([{ begin: 0, end: 8 }]);
    expect(underlying.segmentations).toEqual([
      [
        { joiner: null, form: 'uku', hit: false },
        { joiner: '-', form: 'nge', hit: true },
        { joiner: '-', form: 'ut', hit: false },
      ],
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
      expect(row.segmentations).toBeUndefined();
    }
  });

  it('handles each hit in a row on its own', () => {
    const body = 'pinguuq Ukunguut';
    const two = {
      body,
      layerInfo: { spanLayers: { sentence: [] } },
      sentences: [
        {
          id: 's',
          begin: 0,
          end: 16,
          annotations: {},
          tokens: [
            {
              id: 'a',
              begin: 0,
              end: 7,
              content: 'pinguuq',
              morphemes: [
                { id: 'a1', metadata: { form: 'pi' } },
                { id: 'a2', metadata: { form: 'ngu' } },
                { id: 'a3', metadata: { form: 'uq' } },
              ],
            },
            {
              id: 'b',
              begin: 8,
              end: 16,
              content: 'Ukunguut',
              morphemes: [
                { id: 'b1', metadata: { form: 'uku' } },
                { id: 'b2', metadata: { form: 'nge' } },
                { id: 'b3', metadata: { form: 'ut' } },
              ],
            },
          ],
        },
      ],
    };
    const hits = new Set(['a2', 'b2']);
    const [row] = withMorphemeHits(two, buildContextRows(two, { kind: 'lexicon' }, hits), hits);
    expect(row.marks).toEqual([
      { begin: 0, end: 7, inner: [{ begin: 2, end: 5 }] },
      { begin: 8, end: 16 },
    ]);
    expect(row.segmentations.map((parts) => parts.map((p) => p.form).join('-'))).toEqual([
      'uku-nge-ut',
    ]);
  });
});

describe('ConcordancePanel, a morpheme in its word', () => {
  it('marks the morpheme’s letters inside the word’s highlight', async () => {
    const view = await mount(rowsOf());
    const row = rowLinks(view)[1];
    const mark = row.querySelector('mark');
    expect(mark.textContent).toBe('pinguuq');
    expect(mark.querySelector('span').textContent).toBe('ngu');
    expect(row.textContent).not.toContain('pi-ngu-uq');
    await view.unmount();
  });

  it('shows the segmentation beside the sentence, the morpheme picked out', async () => {
    const view = await mount(rowsOf());
    const row = rowLinks(view)[0];
    const mark = row.querySelector('mark');
    expect(mark.textContent).toBe('Ukunguut');
    expect(mark.querySelector('span')).toBeNull();
    const note = row.querySelector('[data-segmentation]');
    expect(note.textContent).toBe('uku-nge-ut');
    expect(note.querySelector('.bg-highlight-strong').textContent).toBe('nge');
    await view.unmount();
  });

  it('shows a word linked as a whole as before: its highlight and nothing more', async () => {
    const view = await mount(rowsOf());
    const row = rowLinks(view)[2];
    expect(row.querySelector('mark').textContent).toBe('Messiahnguuq');
    expect(row.querySelector('mark span')).toBeNull();
    expect(row.querySelector('[data-segmentation]')).toBeNull();
    await view.unmount();
  });
});
