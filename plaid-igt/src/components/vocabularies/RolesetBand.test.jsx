import { describe, it, expect } from 'vitest';
import { renderComponent } from '@ui/test/renderComponent.jsx';
import { RolesetBand } from './RolesetBand';

// An empty roleset read "leave-02" in every lexicon, Arapaho and Lamkang
// included, where it looked like a value the entry had. A placeholder names
// the box, as every other field's does, and never shows an example value.
describe('RolesetBand', () => {
  it('names its boxes rather than showing example values', async () => {
    const fields = { umr: { roleset: '', args: { ARG0: '' } } };
    const { container, unmount } = await renderComponent(
      <RolesetBand uid="e1" fields={fields} setFields={() => {}} />,
    );
    const placeholders = [...container.querySelectorAll('input[placeholder]')].map((i) =>
      i.getAttribute('placeholder'),
    );
    expect(placeholders).toEqual(['Roleset', 'Description']);
    await unmount();
  });
});
