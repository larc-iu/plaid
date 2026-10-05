import { describe, it, expect } from 'vitest';
import { renderComponent, all, texts } from '@ui/test/renderComponent.jsx';
import { LatexOptions } from './LatexOptions.jsx';
import { defaultLatexOptions } from '@/export/latexBook';

const LAYERS = {
  orthographies: ['Latin'],
  wordFields: ['Gloss', 'POS'],
  morphFields: ['Gloss'],
  sentFields: ['Translation', 'Note'],
  hasMorphemes: true,
  fieldLangs: {},
};

const mount = async (initial) => {
  const state = { options: initial };
  const view = await renderComponent(
    <LatexOptions options={state.options} layers={LAYERS} onChange={(o) => (state.options = o)} />,
  );
  const rerender = () =>
    view.rerender(
      <LatexOptions
        options={state.options}
        layers={LAYERS}
        onChange={(o) => (state.options = o)}
      />,
    );
  return { view, state, rerender };
};

// The first list's lines, each as its label reads (name, then scope).
const lineNames = (container) =>
  all(all(container, 'ol')[0], 'li').map((li) => li.querySelector('label').textContent);

describe('LatexOptions', () => {
  it("lists every line in the Analyze tab's order, all on in a new preset", async () => {
    const { view } = await mount(defaultLatexOptions(LAYERS));
    expect(lineNames(view.container)).toEqual([
      'Words',
      'LatinOrthography',
      'GlossWord field',
      'POSWord field',
      'Morphemes',
      'GlossMorpheme field',
    ]);
    const boxes = all(view.container, 'input[type=checkbox]');
    // Six lines and two sentence fields.
    expect(boxes).toHaveLength(8);
    expect(boxes.every((b) => b.checked)).toBe(true);
    expect(texts(view.container, 'label')).toContain('Document metadata');
    await view.unmount();
  });

  it('moves a line with its buttons, and switches one off', async () => {
    const { view, state, rerender } = await mount(defaultLatexOptions(LAYERS));
    const up = view.container.querySelector('button[aria-label="Move Morphemes up"]');
    await view.step(() => up.click());
    await rerender();
    expect(lineNames(view.container).slice(3, 5)).toEqual(['Morphemes', 'POSWord field']);
    expect(view.container.querySelector('button[aria-label="Move Words up"]').disabled).toBe(true);
    const pos = all(view.container, 'label').find((l) => l.textContent === 'POSWord field');
    await view.step(() => pos.querySelector('input').click());
    expect(state.options.rows.find((r) => r.name === 'POS')).toEqual({
      kind: 'wordField',
      name: 'POS',
      on: false,
    });
    expect(state.options.rows.map((r) => r.kind)).toEqual([
      'words',
      'orthography',
      'wordField',
      'morphemes',
      'wordField',
      'morphemeField',
    ]);
    await view.unmount();
  });

  it('orders the sentence fields', async () => {
    const { view, state } = await mount(defaultLatexOptions(LAYERS));
    const down = view.container.querySelector('button[aria-label="Move Translation down"]');
    await view.step(() => down.click());
    expect(state.options.sentenceFields.map((f) => f.name)).toEqual(['Note', 'Translation']);
    await view.unmount();
  });

  describe('the vocabulary', () => {
    const VOCABS = [
      { id: 'v1', name: 'Lexicon', config: { igt: { fields: { gloss: {}, pos: {} } } } },
      { id: 'v2', name: 'Loans', config: {} },
    ];
    const mountWith = async (initial) => {
      const state = { options: initial };
      const el = () => (
        <LatexOptions
          options={state.options}
          layers={LAYERS}
          vocabularies={VOCABS}
          onChange={(o) => (state.options = o)}
        />
      );
      const view = await renderComponent(el());
      return { view, state, rerender: () => view.rerender(el()) };
    };
    const labelled = (container, text) =>
      all(container, 'label').find((l) => l.textContent === text);
    const switchOf = (container, text) => labelled(container, text).querySelector('button');

    it('offers the chapter on, every vocabulary and field on, the used entries, and no numbers in the texts', async () => {
      const { view } = await mountWith(defaultLatexOptions(LAYERS));
      expect(switchOf(view.container, 'Vocabulary chapter').getAttribute('aria-checked')).toBe(
        'true',
      );
      expect(labelled(view.container, 'Used in the texts').querySelector('input').checked).toBe(
        true,
      );
      for (const name of ['Lexicon', 'Loans', 'Gloss', 'POS', 'Morph Type']) {
        expect(labelled(view.container, name)?.querySelector('input').checked, name).toBe(true);
      }
      expect(
        switchOf(view.container, 'Entry numbers in the texts').getAttribute('aria-checked'),
      ).toBe('false');
      expect(view.container.textContent).not.toMatch(/\bitems?\b/i);
      await view.unmount();
    });

    it('stores each choice in the preset', async () => {
      const { view, state, rerender } = await mountWith(defaultLatexOptions(LAYERS));
      await view.step(() => labelled(view.container, 'All').querySelector('input').click());
      await rerender();
      await view.step(() => labelled(view.container, 'POS').querySelector('input').click());
      await rerender();
      await view.step(() => labelled(view.container, 'Loans').querySelector('input').click());
      await rerender();
      await view.step(() => switchOf(view.container, 'Entry numbers in the texts').click());
      expect(JSON.parse(JSON.stringify(state.options.vocabulary))).toEqual({
        include: true,
        scope: 'all',
        numbersInTexts: true,
        vocabularies: [
          {
            id: 'v1',
            on: true,
            fields: [
              { name: 'gloss', on: true },
              { name: 'pos', on: false },
              { name: 'morphType', on: true },
            ],
          },
          {
            id: 'v2',
            on: false,
            fields: [
              { name: 'morphType', on: true },
              { name: 'gloss', on: true },
            ],
          },
        ],
      });
      // The example lines are stored alongside, untouched.
      expect(state.options.rows).toEqual(defaultLatexOptions(LAYERS).rows);
      await rerender();
      expect(labelled(view.container, 'All').querySelector('input').checked).toBe(true);
      await view.step(() => switchOf(view.container, 'Vocabulary chapter').click());
      await rerender();
      expect(state.options.vocabulary.include).toBe(false);
      expect(labelled(view.container, 'Lexicon')).toBeUndefined();
      await view.unmount();
    });
  });
});
