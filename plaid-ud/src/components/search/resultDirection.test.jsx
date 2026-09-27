import { describe, it, expect, vi } from 'vitest';
import { MemoryRouter } from 'react-router-dom';
import { renderComponent, all } from '@ui/test/renderComponent.jsx';
import { SearchResults } from './SearchResults.jsx';

// A hit is a sentence of the document, so it takes its own direction. An
// Arabic hit was drawn as a left-aligned LTR paragraph, its full stop at the
// visual start of the sentence. A sentence goes by the letters most of it is
// written in, since its first word may be a Latin name or acronym.

vi.mock('@ui/components/shared/ConfirmProvider', () => ({ useConfirm: () => vi.fn() }));
const { RewritePreview } = await import('./RewritePreview.jsx');

const ARABIC = 'قال الرئيس.';
const LATIN_FIRST = 'CNN قالت إن الاقتصاد ينمو.';
const ARABIC_FIRST = 'قال he would come tomorrow.';
const hrefFor = (doc, sent) => `/d/${doc}?sent=${sent}`;

describe('search hits and the rewrite preview', () => {
  it('give each hit and each document name its own direction', async () => {
    const view = await renderComponent(
      <MemoryRouter>
        <SearchResults
          groups={[{ docId: 'd1', sentenceId: 's1', text: ARABIC, highlights: [] }]}
          count={1}
          truncated={false}
          warnings={[]}
          searched
          docName={() => 'نص'}
          hrefFor={hrefFor}
        />
      </MemoryRouter>,
    );
    const hit = all(view.container, 'a').find((a) => a.textContent === ARABIC);
    expect(hit?.getAttribute('dir')).toBe('rtl');
    const name = all(view.container, 'div').find((d) => d.textContent === 'نص');
    expect(name?.getAttribute('dir')).toBe('auto');
    await view.unmount();
  });

  it('gives each previewed sentence its own direction', async () => {
    const row = {
      key: 'd1:s1',
      docId: 'd1',
      docName: 'نص',
      id: 's1',
      text: ARABIC,
      applications: 1,
      changes: [],
      warnings: [],
      error: null,
    };
    const view = await renderComponent(
      <MemoryRouter>
        <RewritePreview
          rows={[row]}
          selected={new Set([row.key])}
          onSelect={() => {}}
          hrefFor={hrefFor}
          canApply
          busy={false}
          onApply={() => {}}
        />
      </MemoryRouter>,
    );
    const hit = all(view.container, 'a').find((a) => a.textContent === ARABIC);
    expect(hit?.getAttribute('dir')).toBe('rtl');
    await view.unmount();
  });

  it('lays a hit out by most of its letters, not its first word', async () => {
    const view = await renderComponent(
      <MemoryRouter>
        <SearchResults
          groups={[LATIN_FIRST, ARABIC_FIRST].map((text, i) => ({
            docId: 'd1',
            sentenceId: `s${i}`,
            text,
            highlights: [],
          }))}
          count={2}
          truncated={false}
          warnings={[]}
          searched
          docName={() => 'نص'}
          hrefFor={hrefFor}
        />
      </MemoryRouter>,
    );
    const dirOf = (t) =>
      all(view.container, 'a')
        .find((a) => a.textContent === t)
        ?.getAttribute('dir');
    expect(dirOf(LATIN_FIRST)).toBe('rtl');
    expect(dirOf(ARABIC_FIRST)).toBe('ltr');
    await view.unmount();
  });

  it('lays a previewed sentence out by most of its letters, not its first word', async () => {
    const rows = [LATIN_FIRST, ARABIC_FIRST].map((text, i) => ({
      key: `d1:s${i}`,
      docId: 'd1',
      docName: 'نص',
      id: `s${i}`,
      text,
      applications: 1,
      changes: [],
      warnings: [],
      error: null,
    }));
    const view = await renderComponent(
      <MemoryRouter>
        <RewritePreview
          rows={rows}
          selected={new Set()}
          onSelect={() => {}}
          hrefFor={hrefFor}
          canApply
          busy={false}
          onApply={() => {}}
        />
      </MemoryRouter>,
    );
    const dirOf = (t) =>
      all(view.container, 'a')
        .find((a) => a.textContent === t)
        ?.getAttribute('dir');
    expect(dirOf(LATIN_FIRST)).toBe('rtl');
    expect(dirOf(ARABIC_FIRST)).toBe('ltr');
    await view.unmount();
  });
});
