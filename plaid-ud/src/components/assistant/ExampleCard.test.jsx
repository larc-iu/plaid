import { describe, it, expect } from 'vitest';
import { renderComponent, all, byText } from '@ui/test/renderComponent.jsx';
import { ExampleCard } from './ExampleCard.jsx';

// "What is this Miramar?" with a real tree, and FEATS empty on every word so
// the trimming has something to trim.
const CARD = {
  documentId: 'd1',
  documentName: 'Answers',
  sentence: 1,
  sentenceId: 'sent-1',
  text: 'What is this Miramar?',
  columns: ['id', 'form', 'lemma', 'upos', 'head', 'deprel'],
  focus: [4],
  rows: [
    { id: '1', form: 'What', lemma: 'what', upos: 'PRON', head: '0', deprel: 'root', token: false },
    { id: '2', form: 'is', lemma: 'be', upos: 'AUX', head: '1', deprel: 'cop', token: false },
    { id: '3', form: 'this', lemma: 'this', upos: 'DET', head: '4', deprel: 'det', token: false },
    {
      id: '4',
      form: 'Miramar',
      lemma: 'Miramar',
      upos: 'PROPN',
      head: '1',
      deprel: 'nsubj',
      token: false,
      focus: true,
    },
    { id: '5', form: '?', lemma: '?', upos: 'PUNCT', head: '1', deprel: 'punct', token: false },
  ],
};

const mount = (card) => renderComponent(<ExampleCard c={card} projectId="p1" />);

describe('ExampleCard', () => {
  it('opens in the view the model asked for', async () => {
    const { container, unmount } = await mount({ ...CARD, view: 'tree' });
    expect(container.querySelector('svg[role="img"]')).not.toBeNull();
    expect(container.querySelector('table')).toBeNull();
    await unmount();
  });

  it('falls back to the table when the model asked for nothing', async () => {
    const { container, unmount } = await mount(CARD);
    expect(container.querySelector('table')).not.toBeNull();
    expect(container.querySelector('svg[role="img"]')).toBeNull();
    await unmount();
  });

  it('lets the reader switch, because the model chooses a starting point', async () => {
    const { container, step, unmount } = await mount(CARD);
    await step(() => byText(container, 'button', 'Tree').click());
    expect(container.querySelector('svg[role="img"]')).not.toBeNull();
    await step(() => byText(container, 'button', 'Grid').click());
    const headers = all(container, 'th').map((th) => th.textContent.trim());
    // A grid is the words plus what the point is about, not all eight columns.
    expect(headers).toContain('form');
    expect(headers).not.toContain('deprel');
    await unmount();
  });

  it('shows only the columns asked for, when the model named them', async () => {
    const { container, unmount } = await mount({ ...CARD, view: 'grid', fields: ['upos'] });
    const headers = all(container, 'th').map((th) => th.textContent.trim());
    expect(headers).toEqual(['id', 'form', 'upos']);
    await unmount();
  });

  it('does not offer a tree for a sentence nobody has parsed', async () => {
    const flat = {
      ...CARD,
      view: 'tree',
      columns: ['id', 'form'],
      rows: CARD.rows.map((r) => ({ ...r, head: '', deprel: '' })),
    };
    const { container, unmount } = await mount(flat);
    // Asked for, but there is nothing to draw: the table is shown instead and
    // the switch does not offer a view that would be blank.
    expect(container.querySelector('svg[role="img"]')).toBeNull();
    expect(container.querySelector('table')).not.toBeNull();
    expect(byText(container, 'button', 'Tree')).toBeNull();
    await unmount();
  });

  it('draws one arrowhead per word: every word has exactly one head', async () => {
    const { container, unmount } = await mount({ ...CARD, view: 'tree' });
    // Each arc contributes a curve and a filled arrowhead; the heads are the
    // filled ones. Five words, five incoming relations, root included.
    const filled = all(container, 'svg[role="img"] path').filter(
      (p) => p.getAttribute('fill') === 'currentColor',
    );
    expect(filled).toHaveLength(5);
    await unmount();
  });
});
