import { describe, it, expect } from 'vitest';
import { MemoryRouter } from 'react-router-dom';
import { renderComponent, all } from '@ui/test/renderComponent.jsx';
import { SearchResults } from './SearchResults.jsx';

// A Grew hit is marked by the one search highlight every app shares
// (plaid-ui's MarkedText), and the query's warnings wear the warning tone.

describe('Grew search results', () => {
  it('marks each matched word by code point with the shared highlight', async () => {
    const view = await renderComponent(
      <MemoryRouter>
        <SearchResults
          groups={[
            {
              docId: 'd1',
              sentenceId: 's1',
              text: 'the 😀dog runs',
              highlights: [
                { start: 4, end: 7 },
                { start: 9, end: 13 },
              ],
            },
          ]}
          count={1}
          truncated={false}
          warnings={['Enhanced relations are not searched.']}
          searched
          docName={() => 'Doc'}
          hrefFor={(doc, sent) => `/d/${doc}?sent=${sent}`}
        />
      </MemoryRouter>,
    );
    expect(all(view.container, 'mark').map((m) => m.textContent)).toEqual(['😀do', 'runs']);
    const hit = all(view.container, 'a').find((a) => a.textContent === 'the 😀dog runs');
    expect(hit.querySelector('bdi')).not.toBe(null);
    const notice = view.container.querySelector('[data-tone]');
    expect(notice.getAttribute('data-tone')).toBe('warning');
    expect(notice.textContent).toBe('Enhanced relations are not searched.');
    await view.unmount();
  });
});
