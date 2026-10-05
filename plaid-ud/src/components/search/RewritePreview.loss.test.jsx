import { describe, it, expect, vi } from 'vitest';
import { act } from 'react';
import { MemoryRouter } from 'react-router-dom';
import { renderComponent, all } from '@ui/test/renderComponent.jsx';

// A rule that deletes words another layer annotates says so on the word's
// line, and Apply's question counts it over the chosen sentences
// (N1-CASCADE-3).

const confirm = vi.hoisted(() => vi.fn(async () => false));
vi.mock('@ui/components/shared/ConfirmProvider', () => ({ useConfirm: () => confirm }));
const { RewritePreview } = await import('./RewritePreview.jsx');

const row = (id, loss) => ({
  key: `d1:${id}`,
  docId: 'd1',
  docName: 'D',
  id,
  text: 'he sang loudly',
  applications: 1,
  changes: [
    loss
      ? {
          kind: 'node',
          loss: true,
          text: 'loudly: word deleted, with 3 annotations and 2 vocabulary links',
          parts: [
            '',
            'loudly',
            ': word deleted, with ',
            '3 annotations and 2 vocabulary links',
            '',
          ],
        }
      : { kind: 'node', text: 'he: word deleted', parts: ['', 'he', ': word deleted'] },
  ],
  loss: loss ? { annotations: 3, links: 2 } : { annotations: 0, links: 0 },
  writes: { tokens: [], lemmaCreates: [], main: [] },
  error: null,
});

const mount = (rows) =>
  renderComponent(
    <MemoryRouter>
      <RewritePreview
        rows={rows}
        selected={new Set(rows.map((r) => r.key))}
        onSelect={() => {}}
        hrefFor={(d, s) => `/d/${d}?sent=${s}`}
        canApply
        busy={false}
        onApply={() => {}}
      />
    </MemoryRouter>,
  );

const apply = (view) =>
  all(view.container, 'button').find((b) => b.textContent.startsWith('Apply'));

describe('rewrite preview, words that take other annotations with them', () => {
  it('marks the line and counts the loss in the question', async () => {
    confirm.mockClear();
    const rows = [row('s1', true), row('s2', true), row('s3', false)];
    const view = await mount(rows);
    const line = all(view.container, 'p').find((p) => p.textContent.startsWith('loudly'));
    expect(line.className).toContain('text-destructive');
    await act(async () => apply(view).click());
    expect(confirm).toHaveBeenCalledTimes(1);
    const asked = confirm.mock.calls[0][0];
    expect(asked.description).toBe(
      '3 sentences in 1 document. Deletes 6 annotations and 4 vocabulary links with the deleted words.',
    );
    expect(asked.destructive).toBe(true);
    await view.unmount();
  });

  it('asks as before when nothing else goes', async () => {
    confirm.mockClear();
    const view = await mount([row('s3', false)]);
    await act(async () => apply(view).click());
    expect(confirm.mock.calls[0][0].description).toBe('1 sentence in 1 document.');
    expect(confirm.mock.calls[0][0].destructive).toBe(false);
    await view.unmount();
  });
});
