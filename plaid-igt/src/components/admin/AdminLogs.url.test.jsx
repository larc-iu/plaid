import { describe, it, expect, beforeEach, vi } from 'vitest';
import { useEffect } from 'react';
import { MemoryRouter, useLocation, useNavigate, useNavigationType } from 'react-router-dom';
import { renderComponent, all, byText } from '@ui/test/renderComponent.jsx';
import { AdminLogs } from './AdminLogs';

// Every Logs filter lives in the URL beside `?tab=logs`, so a filtered view
// can be reloaded, opened in a new tab or sent to another admin, and the
// account in a request row is a real link to its filtered view. Luke,
// 2026-10-09.

// Radix's Select does not open under jsdom, so the test draws it as a native
// select with the same value and onValueChange. What is under test is the
// screen's wiring to the URL, not the dropdown.
vi.mock('@ui/components/ui/select', () => {
  const Select = ({ value, onValueChange, children }) => (
    <select value={value} onChange={(e) => onValueChange(e.target.value)}>
      {children}
    </select>
  );
  const SelectContent = ({ children }) => children;
  const SelectItem = ({ value, children }) => <option value={value}>{children}</option>;
  return {
    Select,
    SelectContent,
    SelectItem,
    SelectTrigger: () => null,
    SelectValue: () => null,
  };
});

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
  },
];

const log = () => ({
  requests: {
    entries: REQUESTS,
    matched: 1,
    held: 1,
    capacity: 5000,
    stats: { count: 1, failures: 0, p50: 20, p95: 20, max: 20, perMinute: 1 },
  },
  events: { entries: [], matched: 0, held: 0, capacity: 1000, byLevel: {} },
  file: null,
});

const fakeClient = () => ({
  admin: { logs: vi.fn(async () => log()), logFile: vi.fn() },
});

// What the router says after each render, and a way to move it from outside.
const probe = { seen: [], go: null };
const Probe = () => {
  const location = useLocation();
  const type = useNavigationType();
  const navigate = useNavigate();
  useEffect(() => {
    probe.go = navigate;
    probe.seen.push({ search: location.search, type });
  });
  return null;
};
const params = () => new URLSearchParams(probe.seen.at(-1).search);

const at = async (url, client = fakeClient()) => {
  const r = await renderComponent(
    <MemoryRouter initialEntries={[url]}>
      <AdminLogs client={client} />
      <Probe />
    </MemoryRouter>,
  );
  return { ...r, client };
};

const lastAsk = (client) => client.admin.logs.mock.calls.at(-1)[0];
const selects = (container) => all(container, 'select');
const pick = (select, value) => {
  select.value = value;
  select.dispatchEvent(new Event('change', { bubbles: true }));
};
const type = (input, value) => {
  const setter = Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, 'value').set;
  setter.call(input, value);
  input.dispatchEvent(new Event('input', { bubbles: true }));
};
const searchBox = (container) => container.querySelector('input[data-search-box]');
const wait = (ms) => new Promise((r) => setTimeout(r, ms));

describe('the Logs filters live in the URL', () => {
  beforeEach(() => {
    localStorage.clear();
    probe.seen = [];
  });

  it('opens with every filter the address names', async () => {
    const { container, client, unmount } = await at(
      '/admin?tab=logs&q=metadata&status=failures&level=error&account=ada%40example.com',
    );
    expect(client.admin.logs).toHaveBeenCalledTimes(1);
    expect(lastAsk(client)).toMatchObject({
      q: 'metadata',
      status: 'failures',
      level: 'error',
      user: 'ada@example.com',
    });
    expect(searchBox(container).value).toBe('metadata');
    const [status, level] = selects(container);
    expect(status.value).toBe('failures');
    expect(level.value).toBe('error');
    expect(container.querySelector('button[aria-label="Clear account filter"]')).not.toBeNull();
    await unmount();
  });

  it('writes a status and a level, keeping the tab and starting the pages over', async () => {
    const { container, client, step, unmount } = await at('/admin?tab=logs&requests=3&events=2');
    const [status, level] = selects(container);

    await step(async () => pick(status, '5xx'));
    expect(params().get('status')).toBe('5xx');
    expect(params().get('tab')).toBe('logs');
    expect(params().get('requests')).toBeNull();
    expect(params().get('events')).toBeNull();
    expect(lastAsk(client).status).toBe('5xx');

    await step(async () => pick(level, 'warn'));
    expect(params().get('level')).toBe('warn');
    expect(params().get('status')).toBe('5xx');
    expect(lastAsk(client).level).toBe('warn');

    // Any status is the bare address.
    await step(async () => pick(status, 'all'));
    expect(params().get('status')).toBeNull();
    expect(lastAsk(client).status).toBeUndefined();
    await unmount();
  });

  it('writes the search once typing settles, replacing the entry', async () => {
    const { container, client, step, unmount } = await at('/admin?tab=logs');
    const box = searchBox(container);
    await step(async () => type(box, 'm'));
    await step(async () => type(box, 'me'));
    await step(async () => type(box, 'meta '));
    expect(params().get('q')).toBeNull();

    await step(() => wait(350));
    expect(params().get('q')).toBe('meta');
    expect(lastAsk(client).q).toBe('meta');
    // Not one history entry per keystroke, nor one for the search at all.
    expect(probe.seen.filter((s) => s.type === 'PUSH')).toHaveLength(0);
    // What was typed stays as typed.
    expect(box.value).toBe('meta ');

    // Emptied, the search leaves the address.
    await step(async () => type(box, ''));
    await step(() => wait(350));
    expect(params().get('q')).toBeNull();
    await unmount();
  });

  it('shows a search the address changed under the box', async () => {
    const { container, step, unmount } = await at('/admin?tab=logs&q=first');
    await step(async () => probe.go('/admin?tab=logs&q=second'));
    expect(searchBox(container).value).toBe('second');
    // And the box does not write what it held before back over it.
    await step(() => wait(350));
    expect(params().get('q')).toBe('second');
    expect(searchBox(container).value).toBe('second');
    await unmount();
  });

  it('draws the account as a link to its filtered view, keeping the other filters', async () => {
    const { container, client, step, unmount } = await at(
      '/admin?tab=logs&status=failures&requests=2',
    );
    const link = byText(container, 'tbody a', 'ada@example.com');
    expect(link.tagName).toBe('A');
    expect(link.getAttribute('href')).toBe(
      '/admin?tab=logs&status=failures&account=ada%40example.com',
    );

    await step(async () => link.click());
    expect(params().get('account')).toBe('ada@example.com');
    expect(probe.seen.at(-1).type).toBe('PUSH');
    expect(lastAsk(client).user).toBe('ada@example.com');

    // Cleared, the account leaves the address.
    const clear = container.querySelector('button[aria-label="Clear account filter"]');
    await step(async () => clear.click());
    expect(params().get('account')).toBeNull();
    expect(params().get('status')).toBe('failures');
    expect(lastAsk(client).user).toBeUndefined();
    await unmount();
  });

  it('drops a filter it does not offer, and asks without it', async () => {
    const { container, client, unmount } = await at(
      '/admin?tab=logs&status=teapot&level=chatty&account=&q=%20%20',
    );
    expect(lastAsk(client)).toMatchObject({
      status: undefined,
      level: undefined,
      user: undefined,
      q: undefined,
    });
    expect(probe.seen.at(-1).search).toBe('?tab=logs');
    const [status, level] = selects(container);
    expect(status.value).toBe('all');
    expect(level.value).toBe('all');
    await unmount();
  });
});
