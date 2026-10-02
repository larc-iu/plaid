import { describe, it, expect, vi } from 'vitest';
import { MemoryRouter } from 'react-router-dom';
import { renderComponent, all } from '@ui/test/renderComponent.jsx';

// A change line names forms from the sentence around English words and an
// arrow. Each form is isolated, so two Arabic forms and the arrow between
// them never join one right-to-left run that reads the relation backwards.

vi.mock('@ui/components/shared/ConfirmProvider', () => ({ useConfirm: () => vi.fn() }));
const { RewritePreview } = await import('./RewritePreview.jsx');

describe('rewrite preview change lines', () => {
  it('isolate every value and leave the arrow outside them', async () => {
    const row = {
      key: 'd1:s1',
      docId: 'd1',
      docName: 'نص',
      id: 's1',
      text: 'قال الرئيس',
      applications: 1,
      changes: [
        {
          kind: 'edge',
          text: 'قال → الرئيس: nsubj removed',
          parts: ['', 'قال', ' → ', 'الرئيس', ': ', 'nsubj', ' removed'],
        },
      ],
      error: null,
    };
    const view = await renderComponent(
      <MemoryRouter>
        <RewritePreview
          rows={[row]}
          selected={new Set([row.key])}
          onSelect={() => {}}
          hrefFor={(d, s) => `/d/${d}?sent=${s}`}
          canApply
          busy={false}
          onApply={() => {}}
        />
      </MemoryRouter>,
    );
    const p = all(view.container, 'p').find((el) => el.textContent === row.changes[0].text);
    expect(p).toBeTruthy();
    expect(all(p, 'bdi').map((b) => b.textContent)).toEqual(['قال', 'الرئيس', 'nsubj']);
    await view.unmount();
  });
});
