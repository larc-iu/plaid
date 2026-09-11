import { describe, it, expect, beforeEach, vi } from 'vitest';
import { MemoryRouter } from 'react-router-dom';
import { renderComponent, all, byText, texts } from '@ui/test/renderComponent.jsx';
import { AdminAssistant } from './AdminAssistant';

// The index is built entirely out of the STORE KEY plus a small value, and
// both can be stale: a project the conversation names may have been deleted,
// and a value written by an older version may be missing fields. None of that
// may take the screen down, because there is no other way for an operator to
// see what the assistant did here.

const entry = (userId, projectId, convId, value, app = 'igt') => ({
  key: `${app}:assistant:${projectId}:meta:${convId}`,
  userId,
  updatedAt: '2026-09-01T10:00:00Z',
  value,
});

const PA = '01a04e40-0fbd-7297-9c4b-fef05492ecf1';
const GONE = '01a04e40-0fbd-7297-9c4b-000000000000';

const ENTRIES = [
  entry('ada@example.com', PA, 'c1', {
    title: 'Which words are unglossed?',
    turns: 3,
    model: 'openai/gpt-oss-120b',
  }),
  entry('bob@example.com', GONE, 'c2', { title: 'About a project since deleted', turns: 1 }),
  // Written before `turns` and `model` existed, or by a failed save.
  entry('bob@example.com', PA, 'c3', {}),
];

const TRANSCRIPT = {
  display: [
    { kind: 'user', text: 'How many words are unglossed?' },
    { kind: 'assistant', text: 'Fourteen, across three documents.' },
  ],
};

const fakeClient = (overrides = {}) => ({
  admin: { userData: vi.fn(async () => ENTRIES) },
  users: {
    list: vi.fn(async () => [
      { id: 'ada@example.com', displayName: 'Ada Lovelace' },
      { id: 'bob@example.com', displayName: null },
    ]),
    avatarUrl: () => null,
  },
  projects: { list: vi.fn(async () => [{ id: PA, name: 'Lezgi' }]) },
  userData: { get: vi.fn(async () => ({ value: TRANSCRIPT })) },
  ...overrides,
});

const mount = (client) =>
  renderComponent(
    <MemoryRouter>
      <AdminAssistant client={client} />
    </MemoryRouter>,
  );

const rowCells = (container) =>
  all(container, 'tbody tr').map((tr) =>
    [...tr.querySelectorAll('td')].map((td) => td.textContent.replace(/\s+/g, ' ').trim()),
  );

describe('AdminAssistant', () => {
  beforeEach(() => localStorage.clear());

  it('lists every account it was given, newest first', async () => {
    const client = fakeClient();
    const { container, unmount } = await mount(client);

    expect(client.admin.userData).toHaveBeenCalledWith({
      pattern: '*:assistant:*:meta:*',
      includeValues: true,
    });
    const cells = rowCells(container);
    expect(cells).toHaveLength(3);
    expect(cells.map((c) => c[0])).toEqual(
      expect.arrayContaining([
        'Which words are unglossed?',
        'About a project since deleted',
        'Untitled',
      ]),
    );
    // The person shown is the account that owns the entry, whether or not the
    // directory has a display name for them. The cell's text is the avatar's
    // initials run together with the name, so match the end of it.
    const people = cells.map((c) => c[1]);
    expect(people.filter((p) => p.endsWith('Ada Lovelace'))).toHaveLength(1);
    expect(people.filter((p) => p.endsWith('bob@example.com'))).toHaveLength(2);
    await unmount();
  });

  it('names a deleted project instead of showing a blank or breaking', async () => {
    const { container, unmount } = await mount(fakeClient());
    const row = rowCells(container).find((c) => c[0] === 'About a project since deleted');
    expect(row[3]).toBe('Deleted project');
    await unmount();
  });

  it('sorts by project with a deleted one in the list', async () => {
    // The badge on the row is drawn from `projectExists`, so it says "Deleted
    // project" whether or not the row carries a name to sort and search by.
    // Ordering is what actually reads the name, and a missing one took the
    // whole screen down rather than sorting first.
    const { container, step, unmount } = await mount(fakeClient());
    const header = all(container, 'thead button').find((b) => b.textContent.startsWith('Project'));

    await step(async () => header.click());
    expect(rowCells(container).map((c) => c[3])).toEqual(['Deleted project', 'Lezgi', 'Lezgi']);

    await step(async () => header.click());
    expect(rowCells(container).map((c) => c[3])).toEqual(['Lezgi', 'Lezgi', 'Deleted project']);
    await unmount();
  });

  it('shows a dash where an older record has no turn count or model', async () => {
    const { container, unmount } = await mount(fakeClient());
    const row = rowCells(container).find((c) => c[0] === 'Untitled');
    expect(row[4]).toBe('—');
    expect(row[4]).toBe('—');
    await unmount();
  });

  it('drops a key that is not a conversation rather than rendering a broken row', async () => {
    const client = fakeClient({
      admin: {
        userData: vi.fn(async () => [
          ...ENTRIES,
          { key: 'igt:prefs:documents:sort', userId: 'ada@example.com', value: {} },
        ]),
      },
    });
    const { container, unmount } = await mount(client);
    expect(rowCells(container)).toHaveLength(3);
    await unmount();
  });

  it('opens one conversation and renders the whole transcript', async () => {
    const client = fakeClient();
    const { container, step, unmount } = await mount(client);

    await step(async () => {
      byText(container, 'tbody button', 'Which words are unglossed?').click();
    });

    expect(client.userData.get).toHaveBeenCalledWith(
      'ada@example.com',
      `igt:assistant:${PA}:conv:c1`,
    );
    const body = container.textContent;
    expect(body).toContain('How many words are unglossed?');
    expect(body).toContain('Fourteen, across three documents.');
    // Both sides are labelled, so an operator can tell who said what.
    expect(texts(container, 'h2')).toEqual(
      expect.arrayContaining(['Which words are unglossed?', 'You', 'Assistant']),
    );
    await unmount();
  });

  it('says so when the transcript is gone and keeps the summary', async () => {
    const client = fakeClient({
      userData: {
        get: vi.fn(async () => {
          throw Object.assign(new Error('Not found'), { status: 404 });
        }),
      },
    });
    const { container, step, unmount } = await mount(client);

    await step(async () => {
      byText(container, 'tbody button', 'Which words are unglossed?').click();
    });

    expect(container.textContent).toContain('The transcript is gone');
    expect(container.textContent).toContain('Which words are unglossed?');
    await unmount();
  });
});

describe('AdminAssistant across apps', () => {
  // plaid-ud writes `ud:assistant:` records against the same projects. An
  // admin looking for "who has been talking to an assistant" means all of
  // them, so the index is not this app's tag alone.
  const withUd = () =>
    fakeClient({
      admin: {
        userData: vi.fn(async () => [
          ...ENTRIES,
          entry('ada@example.com', PA, 'c4', { title: 'Words with no lemma?', turns: 2 }, 'ud'),
        ]),
      },
    });

  it("lists another app's conversations beside its own, and says which is which", async () => {
    const { container, unmount } = await mount(withUd());
    const rows = rowCells(container);
    expect(rows).toHaveLength(4);
    expect(rows.map((r) => r[2]).sort()).toEqual(['igt', 'igt', 'igt', 'ud']);
    await unmount();
  });

  it('does not link a foreign project from the conversation it opens either', async () => {
    // The list column got this right and the detail header did not, so opening
    // a ud: conversation offered the very route the list refuses to build.
    const { container, step, unmount } = await mount(withUd());
    await step(async () => {
      byText(container, 'tbody button', 'Words with no lemma?').click();
    });
    expect(container.textContent).toContain('Lezgi');
    expect(container.querySelector('a[href*="/projects/"]')).toBeNull();
    await unmount();
  });

  it('still links its own project from the conversation it opens', async () => {
    const { container, step, unmount } = await mount(withUd());
    await step(async () => {
      byText(container, 'tbody button', 'Which words are unglossed?').click();
    });
    expect(container.querySelector('a[href*="/projects/"]')).not.toBeNull();
    await unmount();
  });

  it("does not link a foreign conversation's project into this app's routes", async () => {
    const { container, unmount } = await mount(withUd());
    const foreign = all(container, 'tbody tr').find((tr) =>
      tr.textContent.includes('Words with no lemma?'),
    );
    const mine = all(container, 'tbody tr').find((tr) =>
      tr.textContent.includes('Which words are unglossed?'),
    );
    // Both name the project; only this app's row makes it a link, because the
    // other app's editor is not at a route this one can build.
    expect(foreign.textContent).toContain('Lezgi');
    expect(foreign.querySelector('a[href*="/projects/"]')).toBeNull();
    expect(mine.querySelector('a[href*="/projects/"]')).not.toBeNull();
    await unmount();
  });
});
