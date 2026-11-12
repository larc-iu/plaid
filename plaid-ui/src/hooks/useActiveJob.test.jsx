import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { renderComponent } from '../test/renderComponent.jsx';
import { useActiveJob } from './useActiveJob.js';
import { JOB_ACTIVE_POLL_MS } from '../domain/jobs.js';

// The project's active assistant job, as an open document reads it: once on
// open, then every JOB_ACTIVE_POLL_MS, and never again once the document is
// left. Core answers 204 when the project has none, which the client hands
// back as null.

const running = { id: 'j1', state: 'running', currentDocument: 'd1', documents: [] };

const clientAnswering = (...answers) => {
  const active = vi.fn();
  for (const a of answers) {
    if (a instanceof Error) active.mockRejectedValueOnce(a);
    else active.mockResolvedValueOnce(a);
  }
  active.mockResolvedValue(answers.at(-1) instanceof Error ? null : answers.at(-1));
  return { jobs: { active } };
};

const mount = async (client, projectId = 'p1') => {
  const seen = {};
  const Probe = () => {
    Object.assign(seen, useActiveJob(client, projectId));
    return null;
  };
  const view = await renderComponent(<Probe />);
  return { view, seen };
};

// Let the timer fire and the answer land.
const tick = (view, ms) =>
  view.step(async () => {
    await vi.advanceTimersByTimeAsync(ms);
  });

beforeEach(() => vi.useFakeTimers());
afterEach(() => vi.useRealTimers());

describe('useActiveJob', () => {
  it('reads the active job on mount', async () => {
    const client = clientAnswering(running);
    const { view, seen } = await mount(client);
    await tick(view, 0);
    expect(client.jobs.active).toHaveBeenCalledWith('p1');
    expect(seen.job).toEqual(running);
    await view.unmount();
  });

  it('reads it again every JOB_ACTIVE_POLL_MS, and takes the newest answer', async () => {
    const client = clientAnswering(running, { ...running, message: 'Sentences 6 to 10 of 40.' });
    const { view, seen } = await mount(client);
    await tick(view, 0);
    expect(client.jobs.active).toHaveBeenCalledTimes(1);
    await tick(view, JOB_ACTIVE_POLL_MS - 1);
    expect(client.jobs.active).toHaveBeenCalledTimes(1);
    await tick(view, 1);
    expect(client.jobs.active).toHaveBeenCalledTimes(2);
    expect(seen.job.message).toBe('Sentences 6 to 10 of 40.');
    await view.unmount();
  });

  it('stops reading once unmounted', async () => {
    const client = clientAnswering(running);
    const { view } = await mount(client);
    await tick(view, 0);
    await view.unmount();
    await vi.advanceTimersByTimeAsync(JOB_ACTIVE_POLL_MS * 3);
    expect(client.jobs.active).toHaveBeenCalledTimes(1);
  });

  it('is no job when the project has none (204)', async () => {
    const client = clientAnswering(running, null);
    const { view, seen } = await mount(client);
    await tick(view, 0);
    expect(seen.job).toEqual(running);
    await tick(view, JOB_ACTIVE_POLL_MS);
    expect(seen.job).toBe(null);
    await view.unmount();
  });

  it('is no job after a read that failed, and reads again on time', async () => {
    const client = clientAnswering(running, new Error('offline'), running);
    const { view, seen } = await mount(client);
    await tick(view, 0);
    await tick(view, JOB_ACTIVE_POLL_MS);
    expect(seen.job).toBe(null);
    await tick(view, JOB_ACTIVE_POLL_MS);
    expect(seen.job).toEqual(running);
    expect(client.jobs.active).toHaveBeenCalledTimes(3);
    await view.unmount();
  });

  it('reads at once when asked to, and keeps one timer', async () => {
    const client = clientAnswering(running, { ...running, state: 'stopping' });
    const { view, seen } = await mount(client);
    await tick(view, 0);
    await view.step(() => seen.refresh());
    expect(seen.job.state).toBe('stopping');
    await tick(view, JOB_ACTIVE_POLL_MS);
    expect(client.jobs.active).toHaveBeenCalledTimes(3);
    await view.unmount();
  });

  it('reads nothing without a client or a project', async () => {
    const client = clientAnswering(running);
    const { view, seen } = await mount(client, null);
    await tick(view, JOB_ACTIVE_POLL_MS);
    expect(client.jobs.active).not.toHaveBeenCalled();
    expect(seen.job).toBe(null);
    await view.unmount();
  });
});
