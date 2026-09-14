import { describe, it, expect, vi } from 'vitest';
import { MemoryRouter } from 'react-router-dom';
import { renderComponent, texts } from '../../test/renderComponent.jsx';
import { ActivityPanel } from './ActivityPanel.jsx';

// One panel serves every project: the reader picks another and this component
// stays mounted, so two tallies are out at once with nothing ordering them.
// A test that reads only the end state of one load cannot see this.

// A client whose tally answers only when the test says so, per project.
const deferredClient = () => {
  const pending = new Map();
  return {
    settle: (projectId, rows) => pending.get(projectId)(rows),
    client: {
      audit: {
        tally: vi.fn(({ projectId }) => new Promise((resolve) => pending.set(projectId, resolve))),
      },
      users: { avatarUrl: () => null },
    },
  };
};

const row = (name, changes) => ({
  user: { id: name, displayName: name },
  changes,
  documents: 1,
  lastTs: '2026-09-01T00:00:00Z',
  byDay: [],
});

const panel = (client, projectId) => (
  <MemoryRouter>
    <ActivityPanel
      client={client}
      projectId={projectId}
      roster={[]}
      projectHref={() => '/p'}
      documentHref={() => '/d'}
    />
  </MemoryRouter>
);

const shown = (container) => texts(container, 'td').join(' ');

describe('the activity panel when the project changes under it', () => {
  it('keeps the project it was last asked for, however late the other answers', async () => {
    const d = deferredClient();
    const view = await renderComponent(panel(d.client, 'A'));
    await view.rerender(panel(d.client, 'B'));
    // B answers, then the project nobody is looking at answers late.
    await view.step(async () => d.settle('B', [row('bea', 2)]));
    await view.step(async () => d.settle('A', [row('ada', 9)]));

    expect(shown(view.container)).toContain('bea');
    expect(shown(view.container)).not.toContain('ada');
    await view.unmount();
  });

  it('shows the newest project even when the abandoned one answers first', async () => {
    const d = deferredClient();
    const view = await renderComponent(panel(d.client, 'A'));
    await view.rerender(panel(d.client, 'B'));
    await view.step(async () => d.settle('A', [row('ada', 9)]));
    expect(shown(view.container)).not.toContain('ada');

    await view.step(async () => d.settle('B', [row('bea', 2)]));
    expect(shown(view.container)).toContain('bea');
    await view.unmount();
  });

  it('shows what the one project it was asked for said', async () => {
    const d = deferredClient();
    const view = await renderComponent(panel(d.client, 'A'));
    await view.step(async () => d.settle('A', [row('ada', 9)]));
    expect(shown(view.container)).toContain('ada');
    await view.unmount();
  });
});
