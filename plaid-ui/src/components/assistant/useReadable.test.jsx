import { describe, it, expect, vi } from 'vitest';
import { renderComponent } from '../../test/renderComponent.jsx';
import { useReadable } from './rounds.js';

// The projects the viewer can open, read for the closed-turn rule
// (`closedTurns`). A project named by a later message is read again, so one
// the reader was given since the list was read does not show closed.

const asked = (...ids) => ({
  kind: 'user',
  text: 'q',
  projects: ids.map((id) => ({ id, name: id })),
});

describe('useReadable', () => {
  it('reads the list again when a message names a project not named before', async () => {
    const lists = [[{ id: 'p1' }], [{ id: 'p1' }, { id: 'p2' }]];
    const client = { projects: { list: vi.fn(async () => lists.shift()) } };
    const box = {};
    const Probe = ({ display }) => {
      box.ids = useReadable(client, display);
      return null;
    };
    const r = await renderComponent(<Probe display={[asked('p1')]} />);
    expect([...box.ids]).toEqual(['p1']);
    await r.rerender(<Probe display={[asked('p1'), { kind: 'assistant', text: 'a' }]} />);
    expect(client.projects.list).toHaveBeenCalledTimes(1);
    await r.rerender(
      <Probe display={[asked('p1'), { kind: 'assistant', text: 'a' }, asked('p2')]} />,
    );
    expect(client.projects.list).toHaveBeenCalledTimes(2);
    expect([...box.ids].sort()).toEqual(['p1', 'p2']);
    await r.unmount();
  });

  it('reads nothing for a conversation that names no other project', async () => {
    const client = { projects: { list: vi.fn(async () => []) } };
    const box = {};
    const Probe = () => {
      box.ids = useReadable(client, [{ kind: 'user', text: 'q' }]);
      return null;
    };
    const r = await renderComponent(<Probe />);
    expect(box.ids).toBeNull();
    expect(client.projects.list).not.toHaveBeenCalled();
    await r.unmount();
  });
});
