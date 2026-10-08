import { describe, it, expect, vi } from 'vitest';
import { MemoryRouter, Route, Routes, useLocation } from 'react-router-dom';
import { renderComponent } from '../../test/renderComponent.jsx';

// A conversation in a list looks like a link, so it is one everywhere: in the
// docked panel too, where a plain click opens it in the panel and a modified
// click opens it on the Assistant screen in a new tab. Luke, 2026-10-08.

vi.mock('../shared/ConfirmProvider.jsx', () => ({ useConfirm: () => async () => false }));

const { ConversationRows } = await import('./ConversationList.jsx');

const rows = [{ id: 'c1', projectId: 'p1', title: 'Gloss sentence 4', updatedAt: '2026-10-06' }];

const Where = () => <span data-where={useLocation().pathname + useLocation().search} />;

const mount = (onPick) =>
  renderComponent(
    <MemoryRouter initialEntries={['/projects/p1/documents/d1']}>
      <Routes>
        <Route
          path="*"
          element={
            <>
              <ConversationRows
                rows={rows}
                activeId={null}
                projectId="p1"
                projectNames={new Map()}
                opening={null}
                loading={false}
                hrefFor={(m) => `/projects/${m.projectId}?tab=assistant&conversation=${m.id}`}
                onPick={onPick}
                onDelete={() => {}}
              />
              <Where />
            </>
          }
        />
      </Routes>
    </MemoryRouter>,
  );

const click = (el, init = {}) =>
  el.dispatchEvent(
    new MouseEvent('click', { bubbles: true, cancelable: true, button: 0, ...init }),
  );

describe('a conversation row in the panel', () => {
  it('is a link to the conversation on the Assistant screen', async () => {
    const view = await mount(vi.fn());
    const link = view.container.querySelector('a');
    expect(link.textContent).toContain('Gloss sentence 4');
    expect(link.getAttribute('href')).toBe('/projects/p1?tab=assistant&conversation=c1');
    await view.unmount();
  });

  it('opens in the panel on a plain click, without leaving the page', async () => {
    const onPick = vi.fn();
    const view = await mount(onPick);
    await view.step(() => click(view.container.querySelector('a')));
    expect(onPick).toHaveBeenCalledWith('c1');
    expect(view.container.querySelector('[data-where]').dataset.where).toBe(
      '/projects/p1/documents/d1',
    );
    await view.unmount();
  });

  it('leaves a modified click to the browser', async () => {
    const onPick = vi.fn();
    const view = await mount(onPick);
    const event = new MouseEvent('click', { bubbles: true, cancelable: true, metaKey: true });
    await view.step(() => view.container.querySelector('a').dispatchEvent(event));
    expect(onPick).not.toHaveBeenCalled();
    await view.unmount();
  });
});
