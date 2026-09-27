import { describe, it, expect } from 'vitest';
import { renderComponent } from '@ui/test/renderComponent.jsx';
import { MarkedText } from './MarkedText.jsx';

// An excerpt sits in an English row beside "#1" and the document's name, so
// it isolates its own direction: an Arabic sentence keeps its full stop at its
// end, on the left.

describe('an excerpt with its hits marked', () => {
  it('isolates its direction, with or without marks', async () => {
    for (const marks of [[], [{ begin: 0, end: 3 }]]) {
      const view = await renderComponent(<MarkedText text="قرأ الولد الكتاب." marks={marks} />);
      const bdi = view.container.querySelector('bdi');
      expect(bdi?.getAttribute('dir')).toBe('rtl');
      expect(bdi.textContent).toBe('قرأ الولد الكتاب.');
      await view.unmount();
    }
  });

  it('takes the direction most of its letters read in, not its first word', async () => {
    for (const [text, dir] of [
      ['CNN قالت إن الاقتصاد ينمو.', 'rtl'],
      ['قال he would come tomorrow.', 'ltr'],
    ]) {
      for (const marks of [[], [{ begin: 0, end: 3 }]]) {
        const view = await renderComponent(<MarkedText text={text} marks={marks} />);
        expect(view.container.querySelector('bdi')?.getAttribute('dir')).toBe(dir);
        await view.unmount();
      }
    }
  });

  it('marks the hit by code points', async () => {
    const view = await renderComponent(<MarkedText text="a😀bc" marks={[{ begin: 1, end: 3 }]} />);
    expect(view.container.querySelector('mark').textContent).toBe('😀b');
    await view.unmount();
  });
});
