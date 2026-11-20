import { describe, it, expect, beforeEach, vi } from 'vitest';
import { MemoryRouter } from 'react-router-dom';
import { renderComponent, all, byText } from '@ui/test/renderComponent.jsx';
import { fullTimestamp } from '@ui/lib/formatTime.js';
import { AdminAssistant } from './AdminAssistant';

// Which conversations ended a turn in an error, and why: the entry's
// `errors` and `lastError` (plaid_agent conversation.py `error_facts`), and
// each error item's `reason`. An entry written before them has neither and
// shows no count.

const PA = '01a04e40-0fbd-7297-9c4b-fef05492ecf1';
const AT = '2026-11-20T10:00:00Z';

const entry = (convId, value) => ({
  key: `igt:assistant:${PA}:meta:${convId}`,
  userId: 'ada@example.com',
  updatedAt: '2026-09-01T10:00:00Z',
  value,
});

const ENTRIES = [
  entry('c1', {
    title: 'Cut off twice',
    turns: 4,
    errors: 2,
    lastError: { reason: 'output-limit', at: AT },
  }),
  entry('c2', { title: 'No errors', turns: 2, errors: 0, lastError: null }),
  entry('c3', { title: 'Written before counts', turns: 1 }),
  entry('c4', {
    title: 'Stopped once',
    turns: 1,
    errors: 1,
    lastError: { reason: 'stopped', at: AT },
  }),
];

const TRANSCRIPT = {
  display: [
    { kind: 'user', text: 'Gloss every sentence.' },
    { kind: 'error', reason: 'output-limit', text: 'The model wrote 9 tokens without finishing.' },
    { kind: 'user', text: 'And now?' },
    { kind: 'error', text: 'An error from before reasons.' },
    { kind: 'user', text: 'Once more.' },
    { kind: 'assistant', text: 'Done.' },
  ],
};

const fakeClient = () => ({
  admin: { userData: vi.fn(async () => ENTRIES) },
  users: {
    list: vi.fn(async () => [{ id: 'ada@example.com', displayName: 'Ada' }]),
    avatarUrl: () => null,
  },
  projects: { list: vi.fn(async () => [{ id: PA, name: 'Lezgi' }]) },
  userData: { get: vi.fn(async () => ({ value: TRANSCRIPT })) },
});

const mount = (client = fakeClient()) =>
  renderComponent(
    <MemoryRouter>
      <AdminAssistant client={client} />
    </MemoryRouter>,
  );

beforeEach(() => localStorage.clear());

const headers = (container) => all(container, 'thead th').map((th) => th.textContent.trim());

const errorsCells = (container) => {
  const i = headers(container).indexOf('Errors');
  return all(container, 'tbody tr').map((tr) => {
    const cells = tr.querySelectorAll('td');
    return { title: cells[0].textContent.trim(), cell: cells[i] };
  });
};

describe('AdminAssistant errors', () => {
  it('counts each conversation’s errors, blank for none, the last one’s kind and time on hover', async () => {
    const { container, unmount } = await mount();
    const byTitle = Object.fromEntries(errorsCells(container).map((r) => [r.title, r.cell]));
    expect(byTitle['Cut off twice'].textContent.trim()).toBe('2');
    expect(byTitle['Cut off twice'].querySelector('[title]').getAttribute('title')).toBe(
      `Last error: Output limit, ${fullTimestamp(AT)}`,
    );
    expect(byTitle['Stopped once'].querySelector('[title]').getAttribute('title')).toBe(
      `Last error: Stopped, ${fullTimestamp(AT)}`,
    );
    expect(byTitle['No errors'].textContent.trim()).toBe('');
    expect(byTitle['Written before counts'].textContent.trim()).toBe('');
    await unmount();
  });

  it('sorts by the count', async () => {
    const { container, step, unmount } = await mount();
    const header = all(container, 'thead button').find((b) => b.textContent.startsWith('Errors'));
    await step(async () => header.click());
    await step(async () => header.click());
    expect(
      errorsCells(container)
        .map((r) => r.title)
        .slice(0, 2),
    ).toEqual(['Cut off twice', 'Stopped once']);
    await unmount();
  });

  it('narrows the list to conversations with errors', async () => {
    const { container, step, unmount } = await mount();
    expect(all(container, 'tbody tr')).toHaveLength(4);
    const toggle = byText(container, 'button', 'With errors');
    await step(async () => toggle.click());
    expect(toggle.getAttribute('aria-pressed')).toBe('true');
    expect(
      errorsCells(container)
        .map((r) => r.title)
        .sort(),
    ).toEqual(['Cut off twice', 'Stopped once']);
    await step(async () => toggle.click());
    expect(all(container, 'tbody tr')).toHaveLength(4);
    await unmount();
  });

  it('names an error item’s kind beside its text in the opened conversation', async () => {
    const { container, step, unmount } = await mount();
    await step(async () => byText(container, 'tbody a', 'Cut off twice').click());
    const lines = all(container, '[role="alert"]').map((el) => el.textContent);
    expect(lines).toEqual([
      'Output limitThe model wrote 9 tokens without finishing.',
      'An error from before reasons.',
    ]);
    await unmount();
  });
});
