import { describe, it, expect, beforeEach, vi } from 'vitest';
import { MemoryRouter } from 'react-router-dom';
import { renderComponent, all, texts } from '@ui/test/renderComponent.jsx';
import { AdminLogs } from './AdminLogs';

// The contract that is easy to break here is where the filtering happens. The
// server filters over the whole buffer and this screen only sorts and pages
// what came back, so every narrowing has to go back to the server. A filter
// that quietly became local would look right on a screen holding 300 of 5,000
// entries and be wrong about all of them.

const REQUESTS = [
  {
    ts: 1757800000000,
    method: 'POST',
    path: '/api/v1/tokens/abc/metadata',
    query: null,
    status: 200,
    ms: 20,
    user: 'ada@example.com',
    ip: '127.0.0.1',
    token: null,
    error: null,
  },
  {
    ts: 1757799000000,
    method: 'GET',
    path: '/api/v1/projects',
    query: 'limit=10',
    status: 401,
    ms: 1,
    user: null,
    ip: '10.0.0.4',
    token: null,
    error: null,
  },
];

const EVENTS = [
  {
    ts: 1757800001000,
    level: 'error',
    ns: 'plaid.sql.common',
    message: 'Write failed',
    trace: 'java.lang.IllegalStateException: nope\n\tat plaid.sql.common',
  },
  { ts: 1757799001000, level: 'warn', ns: 'plaid.rest-api.v1.auth', message: 'JWT rejected' },
];

const log = (over = {}) => ({
  requests: {
    entries: REQUESTS,
    matched: 2,
    held: 4812,
    capacity: 5000,
    stats: {
      count: 2,
      failures: 1,
      serverErrors: 0,
      p50: 20,
      p95: 20,
      max: 20,
      perMinute: 12.5,
      oldest: 1757799000000,
      newest: 1757800000000,
    },
  },
  events: { entries: EVENTS, matched: 2, held: 2, capacity: 1000, byLevel: { error: 1, warn: 1 } },
  file: null,
  ...over,
});

const fakeClient = (over = {}) => ({
  admin: {
    logs: vi.fn(async () => log()),
    logFile: vi.fn(async () => ({ file: '/srv/plaid.log', lines: ['a line'] })),
    ...over,
  },
});

const mount = (client) =>
  renderComponent(
    <MemoryRouter>
      <AdminLogs client={client} />
    </MemoryRouter>,
  );

const table = (container, title) =>
  all(container, '.rounded-md.border').find((n) => n.querySelector('h3')?.textContent === title);

const rowCells = (root) =>
  all(root, 'tbody tr').map((tr) =>
    [...tr.querySelectorAll('td')].map((td) => td.textContent.replace(/\s+/g, ' ').trim()),
  );

describe('AdminLogs', () => {
  beforeEach(() => localStorage.clear());

  it('draws requests and events in their own tables', async () => {
    const client = fakeClient();
    const { container, unmount } = await mount(client);

    const requests = rowCells(table(container, 'Requests'));
    expect(requests).toHaveLength(2);
    expect(requests[0]).toEqual(
      expect.arrayContaining(['POST', '/api/v1/tokens/abc/metadata', '200', '20ms']),
    );
    // A request nobody was authenticated for says so, and is not a filter.
    expect(requests[1]).toEqual(expect.arrayContaining(['anonymous']));

    const events = rowCells(table(container, 'Events'));
    expect(events).toHaveLength(2);
    expect(events[0]).toEqual(
      expect.arrayContaining(['error', 'plaid.sql.common', 'Write failed']),
    );
    await unmount();
  });

  it('says what the shown requests are a slice of', async () => {
    const { container, unmount } = await mount(fakeClient());
    const stats = texts(container, '.rounded-md.border > .text-xs.text-muted-foreground');
    expect(stats).toContain('Requests');
    expect(container.textContent).toContain('2 of 4,812');
    await unmount();
  });

  it('asks the server again when an account is picked off a row', async () => {
    const client = fakeClient();
    const { container, step, unmount } = await mount(client);
    expect(client.admin.logs).toHaveBeenCalledTimes(1);
    expect(client.admin.logs.mock.calls[0][0].user).toBeUndefined();

    const account = all(table(container, 'Requests'), 'tbody button').find(
      (b) => b.textContent === 'ada@example.com',
    );
    await step(async () => account.click());

    expect(client.admin.logs).toHaveBeenCalledTimes(2);
    expect(client.admin.logs.mock.calls[1][0].user).toBe('ada@example.com');
    await unmount();
  });

  it('leaves out a number the server had nothing to compute', async () => {
    // An empty window has no percentile. Printing the label with an empty
    // value under it, or "undefinedms", is what this guards against.
    const empty = log({
      requests: {
        entries: [],
        matched: 0,
        held: 0,
        capacity: 5000,
        stats: {
          count: 0,
          failures: 0,
          serverErrors: 0,
          p50: null,
          p95: null,
          max: null,
          perMinute: null,
          oldest: null,
          newest: null,
        },
      },
    });
    const { container, unmount } = await mount(fakeClient({ logs: vi.fn(async () => empty) }));
    expect(container.textContent).not.toContain('undefined');
    expect(container.textContent).not.toContain('Median');
    expect(container.textContent).toContain('Failures');
    await unmount();
  });

  it('offers the log file only where the server has one, and reads it on demand', async () => {
    const { container, unmount } = await mount(fakeClient());
    expect(container.textContent).not.toContain('Log file');
    await unmount();

    const client = fakeClient({ logs: vi.fn(async () => log({ file: '/srv/plaid.log' })) });
    const second = await mount(client);
    expect(second.container.textContent).toContain('/srv/plaid.log');
    expect(client.admin.logFile).not.toHaveBeenCalled();

    const open = second.container.querySelector('button[aria-label="Open"]');
    await second.step(async () => open.click());
    expect(client.admin.logFile).toHaveBeenCalledTimes(1);
    await second.unmount();
  });

  // Every narrowing is a server read, so a filter changed while one is in
  // flight has to issue its own. Dropped, the screen sits on the rows of a
  // filter the reader has already moved off, with no request and no spinner.
  it('asks again for a filter changed during a read, and the newest answer wins', async () => {
    const pending = [];
    const client = fakeClient({
      logs: vi.fn((args) => {
        let resolve;
        const promise = new Promise((r) => (resolve = r));
        pending.push({ args, resolve });
        return promise;
      }),
    });
    const { container, step, unmount } = await mount(client);
    await step(async () => pending[0].resolve(log()));
    expect(client.admin.logs).toHaveBeenCalledTimes(1);

    const account = all(table(container, 'Requests'), 'tbody button').find(
      (b) => b.textContent === 'ada@example.com',
    );
    await step(async () => account.click());
    expect(client.admin.logs).toHaveBeenCalledTimes(2);

    // Cleared again before that read comes back.
    const clear = container.querySelector('button[aria-label="Clear account filter"]');
    await step(async () => clear.click());
    expect(client.admin.logs).toHaveBeenCalledTimes(3);
    expect(pending[2].args.user).toBeUndefined();

    const newest = log({
      requests: {
        ...log().requests,
        entries: [{ ...REQUESTS[0], path: '/api/v1/newest' }],
        matched: 1,
      },
    });
    await step(async () => pending[2].resolve(newest));
    // The read the reader moved off answers last, and does not take the
    // screen back.
    await step(async () => pending[1].resolve(log()));

    const paths = rowCells(table(container, 'Requests')).flat();
    expect(paths).toContain('/api/v1/newest');
    expect(paths).not.toContain('/api/v1/projects');
    await unmount();
  });

  it('replaces the rows on a refresh rather than adding to them', async () => {
    const client = fakeClient();
    const { container, step, unmount } = await mount(client);
    const refresh = all(container, 'button').find((b) => b.textContent.trim() === 'Refresh');
    await step(async () => refresh.click());
    expect(rowCells(table(container, 'Requests'))).toHaveLength(2);
    await unmount();
  });
});
