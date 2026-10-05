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

  // Q1-IGT-POLISH-3: opened from the keyboard, focus dropped to the page,
  // Escape did nothing, and Close left focus on the page.
  describe('focus', () => {
    const Host = ({ open, loading = false, onClose = () => {} }) => (
      <div>
        <button type="button" data-opener>
          History
        </button>
        <HistoryDrawer
          isOpen={open}
          onClose={onClose}
          auditEntries={loading ? [] : [entry]}
          loading={loading}
          error={null}
          onSelectEntry={() => {}}
          selectedEntry={null}
        />
      </div>
    );
    const opener = (view) => view.container.querySelector('[data-opener]');

    it('moves into the list on open, and back to the opener on close', async () => {
      const view = await renderComponent(<Host open={false} />);
      await view.step(() => opener(view).focus());
      await view.rerender(<Host open />);
      expect(document.activeElement.getAttribute('data-history-item')).toBe('u:batch-1');
      await view.rerender(<Host open={false} />);
      expect(document.activeElement).toBe(opener(view));
      await view.unmount();
    });

    it('waits on Close while the list loads, then moves into it', async () => {
      const view = await renderComponent(<Host open={false} />);
      await view.step(() => opener(view).focus());
      await view.rerender(<Host open loading />);
      expect(document.activeElement.textContent).toContain('Close');
      await view.rerender(<Host open />);
      expect(document.activeElement.getAttribute('data-history-item')).toBe('u:batch-1');
      await view.unmount();
    });

    it('closes on Escape from inside it', async () => {
      const onClose = vi.fn();
      const view = await renderComponent(<Host open onClose={onClose} />);
      await view.step(() =>
        document.activeElement.dispatchEvent(
          new KeyboardEvent('keydown', { key: 'Escape', bubbles: true, cancelable: true }),
        ),
      );
      expect(onClose).toHaveBeenCalledTimes(1);
      await view.unmount();
    });

    it('leaves focus where the reader put it outside the drawer', async () => {
      const view = await renderComponent(<Host open={false} />);
      const elsewhere = document.createElement('input');
      document.body.appendChild(elsewhere);
      await view.step(() => opener(view).focus());
      await view.rerender(<Host open />);
      await view.step(() => elsewhere.focus());
      await view.rerender(<Host open={false} />);
      expect(document.activeElement).toBe(elsewhere);
      elsewhere.remove();
      await view.unmount();
    });
  });

  it('names the kind of an operation that has one, and nothing for one that has none', async () => {
    const one = (id, kind, message) => ({
      id,
      time: '2026-09-01T00:00:00.000000001Z',
      ...(kind ? { kind } : {}),
      message,
      user: { id: 'u', displayName: 'u' },
      ops: [{ id: `${id}-op`, description: message, time: '2026-09-01T00:00:00.000000001Z' }],
    });
    const view = await renderComponent(
      <HistoryDrawer
        isOpen
        onClose={() => {}}
        auditEntries={[
          one('a', 'review', 'Accept word analysis'),
          one('b', 'guess-adoption', 'Update Gloss'),
          one('c', null, 'Update POS'),
        ]}
        loading={false}
        error={null}
        onSelectEntry={() => {}}
        selectedEntry={null}
      />,
    );
    const row = (label) => byText(view.container, '[data-history-item^="u:"]', label);
    expect(row('Accept word analysis').textContent).toContain('Review');
    expect(row('Update Gloss').textContent).toContain('Guess taken');
    expect(row('Update POS').querySelector('[data-operation-kind]')).toBe(null);
    await view.unmount();
  });
});

// An entry read cut to its oldest actions counts all of them, and open, it
// offers the rest under its newest held action.
describe('an entry holding only some of its actions', () => {
  const cut = { ...entry, opCount: 40000 };
  const open = (props) => (
    <HistoryDrawer
      isOpen
      onClose={() => {}}
      auditEntries={[cut]}
      loading={false}
      error={null}
      onSelectEntry={() => {}}
      selectedEntry={null}
      {...props}
    />
  );

  it('counts every action and reads the later ones on request', async () => {
    const onLoadMoreOps = vi.fn();
    const view = await renderComponent(open({ onLoadMoreOps }));
    expect(byText(view.container, 'button', '40,000 actions')).not.toBeNull();
    await view.step(() => view.container.querySelector('button[aria-label="Expand"]').click());
    const rows = [...view.container.querySelectorAll('[data-history-item]')].map((r) =>
      r.getAttribute('data-history-item'),
    );
    expect(rows).toEqual(['u:batch-1', 'm:batch-1', 'o:batch-1:op-2', 'o:batch-1:op-1']);
    const more = view.container.querySelector('[data-history-item="m:batch-1"]');
    expect(more.textContent).toContain('39,998 not shown');
    await view.step(() => more.click());
    expect(onLoadMoreOps).toHaveBeenCalledWith('batch-1');
    await view.unmount();
  });

  it('reads nothing more while a read is out, or with nowhere to send it', async () => {
    const onLoadMoreOps = vi.fn();
    const view = await renderComponent(open({ onLoadMoreOps, loadingMoreOps: 'batch-1' }));
    await view.step(() => view.container.querySelector('button[aria-label="Expand"]').click());
    const more = view.container.querySelector('[data-history-item="m:batch-1"]');
    expect(more.textContent).toContain('Loading…');
    await view.step(() => more.click());
    expect(onLoadMoreOps).not.toHaveBeenCalled();
    await view.unmount();

    const bare = await renderComponent(open({}));
    await bare.step(() => bare.container.querySelector('button[aria-label="Expand"]').click());
    expect(bare.container.querySelector('[data-history-item^="m:"]')).toBeNull();
    await bare.unmount();
  });
});
