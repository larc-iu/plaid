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
    await view.step(() =>
      byText(view.container, '[data-history-item^="o:"]', 'Set a span').click(),
    );
    expect(onSelectEntry).toHaveBeenLastCalledWith(
      expect.objectContaining({ id: 'op-1', time: '2026-09-01T00:00:00.000000004Z' }),
    );
    await view.unmount();
  });

  it('travels to the entry end when the entry is picked', async () => {
    const onSelectEntry = vi.fn();
    const view = await renderComponent(drawer(onSelectEntry));
    await view.step(() => byText(view.container, 'button', '2 actions').click());
    expect(onSelectEntry).toHaveBeenLastCalledWith(
      expect.objectContaining({ id: 'batch-1', time: '2026-09-01T00:00:00.000000004Z' }),
    );
    await view.unmount();
  });

  // A keyboard reaches the entries: each is a button, one of them is in the
  // tab order at a time, and the arrow keys walk the list.
  describe('from the keyboard', () => {
    const lone = (id, description, time) => ({
      id,
      time,
      user: { id: 'u', displayName: 'u' },
      ops: [{ id: `${id}-op`, description, time }],
    });
    const entries = [
      lone('a', 'First write', '2026-09-01T00:00:01Z'),
      lone('b', 'Second write', '2026-09-01T00:00:02Z'),
      entry,
    ];
    const keyed = (onSelectEntry, selectedEntry = null) => (
      <HistoryDrawer
        isOpen
        onClose={() => {}}
        auditEntries={entries}
        loading={false}
        error={null}
        onSelectEntry={onSelectEntry}
        selectedEntry={selectedEntry}
      />
    );
    const items = (root) => [...root.querySelectorAll('[data-history-item]')];
    const press = (el, key) =>
      el.dispatchEvent(new KeyboardEvent('keydown', { key, bubbles: true, cancelable: true }));

    it('makes every entry a button with a visible focus ring, one of them tabbable', async () => {
      const view = await renderComponent(keyed(vi.fn()));
      const rows = items(view.container);
      expect(rows).toHaveLength(3);
      for (const r of rows) {
        expect(r.tagName).toBe('BUTTON');
        expect(r.className).toMatch(/focus-visible:ring/);
      }
      // Most recent first, and only the first is a tab stop.
      expect(rows.map((r) => r.tabIndex)).toEqual([0, -1, -1]);
      await view.unmount();
    });

    it('walks the list with the arrow keys, Home and End', async () => {
      const view = await renderComponent(keyed(vi.fn()));
      const rows = items(view.container);
      await view.step(() => rows[0].focus());
      await view.step(() => press(rows[0], 'ArrowDown'));
      expect(document.activeElement).toBe(rows[1]);
      await view.step(() => press(rows[1], 'ArrowDown'));
      expect(document.activeElement).toBe(rows[2]);
      await view.step(() => press(rows[2], 'ArrowDown'));
      expect(document.activeElement).toBe(rows[2]);
      await view.step(() => press(rows[2], 'Home'));
      expect(document.activeElement).toBe(rows[0]);
      await view.step(() => press(rows[0], 'End'));
      expect(document.activeElement).toBe(rows[2]);
      await view.step(() => press(rows[2], 'ArrowUp'));
      expect(document.activeElement).toBe(rows[1]);
      // The focused entry is the one Tab comes back to.
      expect(items(view.container).map((r) => r.tabIndex)).toEqual([-1, 0, -1]);
      await view.unmount();
    });

    it('picks the focused entry with Enter, as a click does', async () => {
      const onSelectEntry = vi.fn();
      const view = await renderComponent(keyed(onSelectEntry));
      const rows = items(view.container);
      await view.step(() => rows[1].focus());
      // A button's own Enter behaviour is a click; jsdom does not synthesize
      // it, so the click stands in for it here.
      await view.step(() => rows[1].click());
      expect(onSelectEntry).toHaveBeenLastCalledWith(expect.objectContaining({ id: 'b' }));
      await view.unmount();
    });

    it('opens a multi-action entry with ArrowRight and walks into its actions', async () => {
      const view = await renderComponent(keyed(vi.fn()));
      let rows = items(view.container);
      await view.step(() => rows[0].focus());
      await view.step(() => press(rows[0], 'ArrowRight'));
      rows = items(view.container);
      expect(rows).toHaveLength(5);
      expect(rows[0].getAttribute('aria-expanded')).toBe('true');
      await view.step(() => press(rows[0], 'ArrowDown'));
      expect(document.activeElement.textContent).toContain('Add a token');
      await view.step(() => press(document.activeElement, 'ArrowLeft'));
      // Left from an action goes back to its entry, and again closes it.
      expect(document.activeElement).toBe(items(view.container)[0]);
      await view.step(() => press(document.activeElement, 'ArrowLeft'));
      expect(items(view.container)).toHaveLength(3);
      await view.unmount();
    });

    it('starts the tab order on the selected entry', async () => {
      const view = await renderComponent(keyed(vi.fn(), { id: 'b', time: 'x' }));
      expect(items(view.container).map((r) => r.tabIndex)).toEqual([-1, 0, -1]);
      expect(items(view.container)[1].getAttribute('aria-current')).toBe('true');
      await view.unmount();
    });
  });
});
