import { describe, it, expect } from 'vitest';
import { renderComponent } from '../../test/renderComponent.jsx';
import { IsolatedLabel } from './IsolatedLabel.jsx';

// REV-G4-1: each value of a label is drawn in a <bdi>, and the text of the
// label is the stored label exactly: what a person copies has no invisible
// isolate characters in it.
describe('IsolatedLabel', () => {
  const AR = '\u0630\u0647\u0628 Ahmed \u0625\u0644\u0649';

  it('draws each value in a <bdi>, and its text is the label', async () => {
    const label = `Translation of sentence 1: ${AR}`;
    const view = await renderComponent(<IsolatedLabel label={label} />);
    expect(view.container.textContent).toBe(label);
    expect(view.container.textContent).not.toMatch(/[\u2066-\u2069]/);
    expect([...view.container.querySelectorAll('bdi')].map((b) => b.textContent)).toEqual([AR]);
    await view.unmount();
  });

  it('draws each side of a Respell arrow in a <bdi>', async () => {
    const view = await renderComponent(<IsolatedLabel label="Respell kat → cat" />);
    expect(view.container.textContent).toBe('Respell kat → cat');
    expect([...view.container.querySelectorAll('bdi')].map((b) => b.textContent)).toEqual([
      'Respell kat',
      'cat',
    ]);
    await view.unmount();
  });

  it('nests a quoted name inside a value', async () => {
    const label = 'Undo entry: Gloss of "kai" in sentence 1: go';
    const view = await renderComponent(<IsolatedLabel label={label} />);
    expect(view.container.textContent).toBe(label);
    expect(view.container.querySelector('bdi bdi').textContent).toBe('kai');
    await view.unmount();
  });
});
