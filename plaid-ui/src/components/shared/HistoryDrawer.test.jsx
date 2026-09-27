import { describe, it, expect, vi } from 'vitest';
import { renderComponent, byText } from '../../test/renderComponent.jsx';
import { HistoryDrawer } from './HistoryDrawer.jsx';

// A batch is atomic, so the moment after one of its writes was never a state
// anyone saw, and the server reads such a time as before the whole batch. An
// op carries `endTime`, the time to read at to see it done, and picking the op
// travels there, so a restore from it keeps the op.

const entry = {
  id: 'batch-1',
  time: '2026-09-01T00:00:00.000000001Z',
  endTime: '2026-09-01T00:00:00.000000004Z',
  user: { id: 'u', displayName: 'u' },
  ops: [
    {
      id: 'op-1',
      description: 'Set a span',
      time: '2026-09-01T00:00:00.000000001Z',
      endTime: '2026-09-01T00:00:00.000000004Z',
    },
    {
      id: 'op-2',
      description: 'Add a token',
      time: '2026-09-01T00:00:00.000000002Z',
      endTime: '2026-09-01T00:00:00.000000004Z',
    },
  ],
};

const drawer = (onSelectEntry) => (
  <HistoryDrawer
    isOpen
    onClose={() => {}}
    auditEntries={[entry]}
    loading={false}
    error={null}
    onSelectEntry={onSelectEntry}
    selectedEntry={null}
  />
);

describe('HistoryDrawer', () => {
  it('travels to the end of the batch when one of its ops is picked', async () => {
    const onSelectEntry = vi.fn();
    const view = await renderComponent(drawer(onSelectEntry));
    await view.step(() => view.container.querySelector('button[aria-label="Expand"]').click());
    await view.step(() => byText(view.container, 'div.pl-9', 'Set a span').click());
    expect(onSelectEntry).toHaveBeenLastCalledWith(
      expect.objectContaining({ id: 'op-1', time: '2026-09-01T00:00:00.000000004Z' }),
    );
    await view.unmount();
  });

  it('travels to the entry end when the entry is picked', async () => {
    const onSelectEntry = vi.fn();
    const view = await renderComponent(drawer(onSelectEntry));
    await view.step(() => byText(view.container, 'div.cursor-pointer', '2 actions').click());
    expect(onSelectEntry).toHaveBeenLastCalledWith(
      expect.objectContaining({ id: 'batch-1', time: '2026-09-01T00:00:00.000000004Z' }),
    );
    await view.unmount();
  });
});
