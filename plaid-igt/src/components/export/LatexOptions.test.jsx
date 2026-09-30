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

describe('LatexOptions', () => {
  it('offers each field the project has, all on in a new preset', async () => {
    const view = await renderComponent(
      <LatexOptions options={defaultLatexOptions(LAYERS)} layers={LAYERS} onChange={() => {}} />,
    );
    const boxes = all(view.container, 'input[type=checkbox]');
    expect(boxes).toHaveLength(6);
    expect(boxes.every((b) => b.checked)).toBe(true);
    expect(texts(view.container, 'label')).toContain('Document metadata');
    await view.unmount();
  });

  it('leaves a field out when it is unticked', async () => {
    let options = defaultLatexOptions(LAYERS);
    const view = await renderComponent(
      <LatexOptions options={options} layers={LAYERS} onChange={(o) => (options = o)} />,
    );
    const pos = all(view.container, 'label').find((l) => l.textContent === 'POS');
    await view.step(() => pos.querySelector('input').click());
    expect(options.wordFields).toEqual(['Gloss']);
    expect(options.morphFields).toEqual(['Gloss']);
    await view.unmount();
  });
});
