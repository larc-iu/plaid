import { describe, it, expect } from 'vitest';
import { renderComponent } from '@ui/test/renderComponent.jsx';
import { FormLabel } from './FormLabel';

// An entry's number is a SUBSCRIPT after its form, as FieldWorks writes a
// homograph number. It was one until 39f7319e removed Lexicography Mode and
// the surviving branch happened to be the plain-text one, so this pins the
// element rather than only the text: rendering "kai 1" as a span reads as two
// words and is exactly the regression that got through.

const render = (props) => renderComponent(<FormLabel {...props} />);

describe('FormLabel', () => {
  it('draws the number as a subscript', async () => {
    const { container, unmount } = await render({ form: 'kai', index: '1' });
    const num = container.querySelector('sub');
    expect(num).not.toBeNull();
    expect(num.textContent).toBe('1');
    expect(num.className).toContain('vocab-num');
    expect(container.textContent).toBe('kai1');
    await unmount();
  });

  it('draws a sense path the same way', async () => {
    const { container, unmount } = await render({ form: 'adidi', index: '1.2' });
    expect(container.querySelector('sub').textContent).toBe('1.2');
    await unmount();
  });

  it('leaves a lone entry with no number at all', async () => {
    for (const index of ['', null, undefined]) {
      const { container, unmount } = await render({ form: 'kadera', index });
      expect(container.querySelector('sub')).toBeNull();
      expect(container.textContent).toBe('kadera');
      await unmount();
    }
  });

  it('is never a superscript, which marks tone', async () => {
    const { container, unmount } = await render({ form: 'kai', index: '1' });
    expect(container.querySelector('sup')).toBeNull();
    await unmount();
  });
});
