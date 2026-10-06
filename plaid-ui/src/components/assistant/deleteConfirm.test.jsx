import { describe, it, expect, vi, beforeEach } from 'vitest';
import { MemoryRouter } from 'react-router-dom';
import { renderComponent } from '../../test/renderComponent.jsx';

// A4-CROSS-2: one click on the hover trash icon deleted a conversation, plans
// and all, with no confirm and no undo. Every delete is asked first, naming
// the conversation.

const { confirm } = vi.hoisted(() => ({ confirm: vi.fn(async () => false) }));
vi.mock('../shared/ConfirmProvider.jsx', () => ({ useConfirm: () => confirm }));

const { ConversationRows } = await import('./ConversationList.jsx');

const rows = [{ id: 'c1', projectId: 'p1', title: 'Gloss sentence 4', updatedAt: '2026-10-06' }];

const mount = (onDelete) =>
  renderComponent(
    <MemoryRouter>
      <ConversationRows
        rows={rows}
        activeId={null}
        projectId="p1"
        projectNames={new Map()}
        opening={null}
        loading={false}
        hrefFor={() => '/'}
        onDelete={onDelete}
      />
    </MemoryRouter>,
  );

describe('deleting a conversation', () => {
  beforeEach(() => confirm.mockReset());

  it('asks first, naming it, and keeps it when declined', async () => {
    confirm.mockResolvedValue(false);
    const onDelete = vi.fn();
    const view = await mount(onDelete);
    await view.step(() => view.container.querySelector('[title="Delete conversation"]').click());
    expect(confirm).toHaveBeenCalledWith({
      title: 'Delete “Gloss sentence 4”?',
      confirmLabel: 'Delete',
      destructive: true,
    });
    expect(onDelete).not.toHaveBeenCalled();
    await view.unmount();
  });

  it('deletes once the confirm is taken', async () => {
    confirm.mockResolvedValue(true);
    const onDelete = vi.fn();
    const view = await mount(onDelete);
    await view.step(() => view.container.querySelector('[title="Delete conversation"]').click());
    expect(onDelete).toHaveBeenCalledWith(rows[0]);
    await view.unmount();
  });
});
