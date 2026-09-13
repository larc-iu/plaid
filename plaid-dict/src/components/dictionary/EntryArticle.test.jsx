import { describe, it, expect } from 'vitest';
import { renderComponent } from '@ui/test/renderComponent.jsx';
import { normalizeVocabFields } from '@igt/domain/vocabFields.js';
import { EntryArticle } from './EntryArticle.jsx';

// How the reader names an entry, and where a headword's own meaning sits.
//
// Both came from one page: `ọmọ` drew a full-size `1` after the headword, an
// unnumbered "n / child", and then a sense labelled `1.1` a few pixels further
// left again, so two rows of one entry read as a flat pair, one of them
// numbered for no visible reason. The editor writes the same two rows as
// `ọmọ₁` and `ọmọ₁.₁`.

const fields = normalizeVocabFields({
  pos: { inline: true },
  gloss: { inline: true },
  status: { inline: false, tagset: 'Status' },
});

const node = (id, form, number, gloss, senses = []) => ({
  item: { id, form, metadata: { gloss, status: 'published' } },
  number,
  shown: true,
  senses,
});

const render = (n) => renderComponent(<EntryArticle node={n} fields={fields} lang="yo" />);

describe('EntryArticle', () => {
  it('writes the entry number as a subscript after the form, never full size', async () => {
    // The ruling is FieldWorks', which these users read elsewhere: kai₁, and
    // never a superscript, which marks tone. Shared with the editor through
    // FormLabel so the two cannot drift.
    const { container, unmount } = await render(node('e1', 'ọmọ', '1', 'child'));
    const num = container.querySelector('sub.vocab-num');
    expect(num).not.toBeNull();
    expect(num.textContent).toBe('1');
    expect(container.querySelector('sup')).toBeNull();
    await unmount();
  });

  it('leaves a lone headword form alone', async () => {
    const { container, unmount } = await render(node('e1', 'ilé', '', 'house'));
    expect(container.querySelector('sub')).toBeNull();
    expect(container.textContent).toContain('ilé');
    await unmount();
  });

  it("lines a headword's own meaning up with the senses under it", async () => {
    // Both must start at the same x: the senses' number column is w-10, so the
    // headword's meaning needs that column too, empty.
    const withSense = node('e1', 'ọmọ', '1', 'child', [
      node('e2', 'ọmọ', '1.1', 'offspring, young of an animal'),
    ]);
    const { container, unmount } = await render(withSense);
    const columns = [...container.querySelectorAll('span.w-10')];
    expect(columns).toHaveLength(2);
    // The headword's is the empty one; the sense's carries the number.
    expect(columns[0].textContent).toBe('');
    expect(columns[1].textContent).toBe('1.1');
    await unmount();
  });
});
