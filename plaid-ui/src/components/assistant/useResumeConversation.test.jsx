import { describe, it, expect, vi, beforeEach } from 'vitest';
import { renderComponent } from '../../test/renderComponent.jsx';
import { useResumeConversation } from './useResumeConversation.js';
import { jobs, lastOpen } from './jobs.js';

// Which conversation a surface comes up showing. The panel resumes the
// project's newest thread because it is chrome and comes back on every screen;
// the tab opens new, the way a chat app does.

const row = (id, projectId = 'here') => ({ id, projectId, updatedAt: `2026-09-0${id}T00:00:00Z` });

// Drives the hook with a settable conversation id, and records every call to
// open another.
const mount = async ({
  rows = [],
  resumeNewest = false,
  startAt = null,
  open = null,
  projectId = 'here',
} = {}) => {
  const picked = [];
  const nothing = vi.fn();
  const reload = vi.fn().mockResolvedValue(rows);
  const box = { id: startAt };
  const Probe = ({ pid, read }) => {
    useResumeConversation({
      projectId: pid,
      conversationId: box.id,
      onConversationId: (id, options) => {
        box.id = id;
        picked.push([id, options]);
      },
      reload: read,
      resumeNewest,
      onNothingOpen: nothing,
      openConversationId: () => open,
    });
    return <span />;
  };
  const r = await renderComponent(<Probe pid={projectId} read={reload} />);
  return { ...r, Probe, picked, nothing, reload, box };
};

beforeEach(() => {
  jobs.clear();
  lastOpen.clear();
  vi.clearAllMocks();
});

describe('useResumeConversation', () => {
  it('opens new when the project has no threads', async () => {
    const { picked, nothing, unmount } = await mount();
    expect(picked).toEqual([]);
    expect(nothing).toHaveBeenCalled();
    await unmount();
  });

  it('resumes the newest thread where the surface asks for it', async () => {
    const { picked, unmount } = await mount({ rows: [row('3'), row('1')], resumeNewest: true });
    expect(picked).toEqual([['3', { replace: true }]]);
    await unmount();
  });

  it('leaves the tab on a new conversation, threads or not', async () => {
    const { picked, nothing, unmount } = await mount({ rows: [row('3'), row('1')] });
    expect(picked).toEqual([]);
    expect(nothing).toHaveBeenCalled();
    await unmount();
  });

  it('respects a conversation already named, when it is this project’s', async () => {
    const { picked, nothing, unmount } = await mount({
      rows: [row('3'), row('1')],
      resumeNewest: true,
      startAt: '1',
    });
    expect(picked).toEqual([]);
    expect(nothing).not.toHaveBeenCalled();
    await unmount();
  });

  it('clears one named that belongs to another project', async () => {
    // Walking from one project to another used to leave the thread we came
    // from on screen with a live composer, and sending into it ran the turn
    // against THIS project while carrying the other one's transcript.
    const { picked, unmount } = await mount({ rows: [row('3')], startAt: 'elsewhere' });
    expect(picked).toEqual([[null, { replace: true }]]);
    await unmount();
  });

  it('comes back to the thread this page session left, before the newest one', async () => {
    lastOpen.set('here', '1');
    const { picked, unmount } = await mount({ rows: [row('3'), row('1')], resumeNewest: true });
    expect(picked).toEqual([['1', { replace: true }]]);
    await unmount();
  });

  it('comes back to a thread still running even though it is not listed', async () => {
    lastOpen.set('here', 'running');
    jobs.set('running', { id: 'running', done: false });
    const { picked, unmount } = await mount({ rows: [row('3')], resumeNewest: true });
    expect(picked).toEqual([['running', { replace: true }]]);
    await unmount();
  });

  it('picks once per project, however often the list is read again', async () => {
    // `reload` is a dependency, so widening the list to every project re-runs
    // this: only its READ should. Picking again would choose the newest thread
    // anywhere, which neither surface can open.
    const m = await mount({ rows: [row('3'), row('1')], resumeNewest: true });
    expect(m.picked).toEqual([['3', { replace: true }]]);
    m.box.id = null;
    // A NEW read, the way turning on All projects hands over one.
    const wider = vi.fn().mockResolvedValue([row('9', 'somewhere else')]);
    await m.rerender(<m.Probe pid="here" read={wider} />);
    expect(wider).toHaveBeenCalled();
    expect(m.picked).toEqual([['3', { replace: true }]]);
    await m.unmount();
  });

  it('picks again for another project', async () => {
    const m = await mount({ rows: [row('3')], resumeNewest: true });
    m.box.id = null;
    m.reload.mockResolvedValue([row('7', 'there')]);
    await m.rerender(<m.Probe pid="there" read={m.reload} />);
    expect(m.picked).toEqual([
      ['3', { replace: true }],
      ['7', { replace: true }],
    ]);
    await m.unmount();
  });

  it('remembers the open thread as the surface is left, and forgets an unsent one', async () => {
    const kept = await mount({ open: 'c9' });
    await kept.unmount();
    expect(lastOpen.get('here')).toBe('c9');

    lastOpen.set('here', 'c9');
    const draft = await mount({ open: null });
    await draft.unmount();
    expect(lastOpen.has('here')).toBe(false);
  });
});
