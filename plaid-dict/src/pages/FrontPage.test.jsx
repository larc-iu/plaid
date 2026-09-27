import { describe, it, expect, vi } from 'vitest';
import { MemoryRouter } from 'react-router-dom';
import { renderComponent, all } from '@ui/test/renderComponent.jsx';

// A headword on the index is the language being documented, so it takes its
// own direction. Without one, the Arabic prefix `ال-` drew its hyphen at the
// start of the letters in reading order and read as a suffix. And a long one
// breaks rather than pushing the page sideways at phone width.

const dictionary = vi.hoisted(() => ({ current: null }));
vi.mock('@/contexts/DictionaryContext', () => ({ useDictionary: () => dictionary.current }));
const { FrontPage } = await import('./FrontPage.jsx');

const FORMS = ['ال-', '-ة', 'كتاب'];

describe('the front page index', () => {
  it('gives each headword link its own direction and lets it break', async () => {
    dictionary.current = {
      slug: 'ar',
      vocab: { id: 'v1', name: 'Arabic' },
      record: null,
      pages: FORMS.map((form) => ({ form, headwords: [{}] })),
      index: [{ letter: 'ا', forms: FORMS }],
      fields: [],
      searchIndex: new Map(),
      objectLang: 'ar',
      loading: false,
      missing: false,
      error: '',
    };
    const view = await renderComponent(
      <MemoryRouter>
        <FrontPage />
      </MemoryRouter>,
    );
    const links = all(view.container, 'a[lang="ar"]');
    expect(links.map((a) => a.textContent)).toEqual(FORMS);
    for (const a of links) {
      expect(a.getAttribute('dir')).toBe('auto');
      expect(a.className).toContain('[overflow-wrap:anywhere]');
    }
    await view.unmount();
  });
});
