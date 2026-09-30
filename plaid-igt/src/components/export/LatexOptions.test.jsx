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

  it('opens a preset saved before the order could be set with its own switches', async () => {
    const { view, state } = await mount({
      orthographies: [],
      wordFields: ['POS'],
      morphFields: ['Gloss'],
      sentFields: ['Translation'],
      includeHeader: true,
    });
    const on = all(view.container, 'input[type=checkbox]').map((b) => b.checked);
    expect(on).toEqual([true, false, false, true, true, true, true, false]);
    const meta = all(view.container, 'label').find((l) => l.textContent === 'Document metadata');
    await view.step(() => meta.querySelector('[role=switch]').click());
    expect(state.options.orthographies).toBeUndefined();
    expect(state.options.rows).toHaveLength(6);
    await view.unmount();
  });
});
