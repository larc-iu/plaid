import { describe, it, expect, vi, beforeEach } from 'vitest';
import { MemoryRouter, Route, Routes, useLocation } from 'react-router-dom';
import { renderComponent, byText, all } from '@ui/test/renderComponent.jsx';

// Start job: what the dialog offers, and what it sends. Link to lexicon goes
// with Segment and gloss, the note is counted against core's limit, a project
// with no worker seen lately says so, and a project that already has a job is
// answered with a link to it.
const feedback = vi.hoisted(() => ({ notifyError: vi.fn() }));
vi.mock('@/utils/feedback', () => feedback);
const { StartJob } = await import('./StartJobDialog.jsx');

const DOCS = [
  { id: 'd2', name: 'Story B' },
  { id: 'd1', name: 'Story A' },
  { id: 'd3', name: 'Story C' },
];

const fakeClient = ({ seenAt = new Date().toISOString(), create, documentsMax = 10 } = {}) => ({
  jobs: {
    worker: vi.fn(async () => ({ seenAt, model: 'm', noteMaxChars: 20, documentsMax })),
    create: vi.fn(create ?? (async (_p, body) => ({ id: body.id, state: 'waiting' }))),
  },
  projects: { listDocuments: vi.fn(async () => DOCS) },
});

const Where = ({ onAt }) => {
  onAt(useLocation().pathname);
  return null;
};

const typeNote = (value) => {
  const area = document.body.querySelector('#job-note');
  Object.getOwnPropertyDescriptor(HTMLTextAreaElement.prototype, 'value').set.call(area, value);
  area.dispatchEvent(new Event('input', { bubbles: true }));
};

const box = (label) => byText(document.body, 'label', label).querySelector('input');
const button = (label) =>
  all(document.body, 'button').find((b) => b.textContent.trim() === label) ?? null;
const search = (value) => {
  const input = document.body.querySelector('input[aria-label="Search documents"]');
  Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, 'value').set.call(input, value);
  input.dispatchEvent(new Event('input', { bubbles: true }));
};
const listed = () =>
  all(document.body, '[role="group"][aria-label="Documents"] label').map((l) =>
    l.textContent.trim(),
  );
const LIMIT = 'A job takes at most 2 documents.';
const startButton = () =>
  all(document.body, 'button').find((b) => b.textContent.trim() === 'Start');

// A project that links a lexicon, as the callers pass it.
const PROJECT = { id: 'p1', vocabs: [{ id: 'v1', name: 'Lexicon' }] };

const open = async (client, props = {}) => {
  let at = null;
  const v = await renderComponent(
    <MemoryRouter initialEntries={['/projects/p1']}>
      <Routes>
        <Route
          path="*"
          element={
            <>
              <StartJob projectId="p1" project={PROJECT} client={client} {...props} />
              <Where onAt={(p) => (at = p)} />
            </>
          }
        />
      </Routes>
    </MemoryRouter>,
  );
  await v.step(() => byText(v.container, 'button', 'Start job').click());
  await v.step(async () => {});
  return { v, at: () => at };
};

beforeEach(() => feedback.notifyError.mockClear());

describe('Start job', () => {
  it('offers Link to lexicon only with Segment and gloss', async () => {
    const { v } = await open(fakeClient(), { documents: DOCS });
    expect(box('Translate').checked).toBe(true);
    expect(box('Segment and gloss').checked).toBe(true);
    expect(box('Link to lexicon').disabled).toBe(false);
    await v.step(() => box('Segment and gloss').click());
    expect(box('Link to lexicon').checked).toBe(false);
    expect(box('Link to lexicon').disabled).toBe(true);
    await v.step(() => box('Segment and gloss').click());
    expect(box('Link to lexicon').disabled).toBe(false);
    expect(box('Link to lexicon').checked).toBe(false);
    await v.unmount();
  });

  // A link job on a project with no lexicon can only fail its checks
  // (no-lexicon), possibly hours later (REV-J-C-7).
  it('offers no Link to lexicon on a project that links no lexicon, and says why', async () => {
    const client = fakeClient();
    const { v } = await open(client, { documents: DOCS, project: { id: 'p1', vocabs: [] } });
    expect(box('Link to lexicon').checked).toBe(false);
    expect(box('Link to lexicon').disabled).toBe(true);
    expect(byText(document.body, 'label', 'Link to lexicon').textContent).toContain(
      'The project has no lexicon.',
    );
    // Segment and gloss off and on again leaves it as it is.
    await v.step(() => box('Segment and gloss').click());
    await v.step(() => box('Segment and gloss').click());
    expect(box('Link to lexicon').disabled).toBe(true);
    expect(box('Link to lexicon').checked).toBe(false);
    await v.step(() => startButton().click());
    await v.step(async () => {});
    expect(client.jobs.create.mock.calls[0][1].tasks).toEqual(['translate', 'gloss']);
    await v.unmount();
  });

  it('says nothing of a lexicon on a project that links one', async () => {
    const { v } = await open(fakeClient(), { documents: DOCS });
    expect(document.body.textContent).not.toContain('The project has no lexicon.');
    await v.unmount();
  });

  it('counts the note against the limit core gives, and refuses one over it', async () => {
    const { v } = await open(fakeClient(), { documents: DOCS });
    const count = () => document.body.querySelector('[data-testid="job-note-count"]').textContent;
    expect(count()).toBe('0 / 20');
    // Characters, not UTF-16 units: an astral letter is one.
    await v.step(() => typeNote('ka 𐐀'));
    expect(count()).toBe('4 / 20');
    expect(startButton().disabled).toBe(false);
    await v.step(() => typeNote('x'.repeat(21)));
    expect(count()).toBe('21 / 20');
    expect(startButton().disabled).toBe(true);
    await v.unmount();
  });

  it('says when no worker asked for work lately, and not when one did', async () => {
    const line = 'No job worker is running. The job waits until one starts.';
    const stale = await open(fakeClient({ seenAt: null }), { documents: DOCS });
    expect(document.body.textContent).toContain(line);
    await stale.v.unmount();

    const old = new Date(Date.now() - 121_000).toISOString();
    const late = await open(fakeClient({ seenAt: old }), { documents: DOCS });
    expect(document.body.textContent).toContain(line);
    await late.v.unmount();

    const fresh = await open(fakeClient(), { documents: DOCS });
    expect(document.body.textContent).not.toContain(line);
    await fresh.v.unmount();
  });

  it('sends every document by leaving them out, and opens the job made', async () => {
    const client = fakeClient();
    const { v, at } = await open(client, { documents: DOCS });
    expect(byText(document.body, 'label', 'All documents').textContent).toContain(
      'All documents (3)',
    );
    await v.step(() => box('Translate').click());
    await v.step(() => typeNote('  Gloss ka as GO.  '));
    await v.step(() => startButton().click());
    await v.step(async () => {});
    expect(client.jobs.create).toHaveBeenCalledTimes(1);
    const [projectId, body] = client.jobs.create.mock.calls[0];
    expect(projectId).toBe('p1');
    expect(body).toEqual({
      app: 'igt',
      tasks: ['gloss', 'link'],
      note: 'Gloss ka as GO.',
      id: expect.stringMatching(/^[0-9a-f-]{36}$/),
    });
    expect(at()).toBe(`/projects/p1/jobs/${body.id}`);
    expect(document.body.querySelector('#job-note')).toBe(null);
    await v.unmount();
  });

  it('sends the documents checked, in name order, and no note when blank', async () => {
    const client = fakeClient();
    const { v } = await open(client, { documents: DOCS });
    await v.step(() => box('Selected documents').click());
    expect(startButton().disabled).toBe(true);
    await v.step(() => box('Story C').click());
    await v.step(() => box('Story A').click());
    await v.step(() => startButton().click());
    await v.step(async () => {});
    expect(client.jobs.create.mock.calls[0][1]).toEqual({
      app: 'igt',
      tasks: ['translate', 'gloss', 'link'],
      documents: ['d1', 'd3'],
      id: expect.any(String),
    });
    await v.unmount();
  });

  it('opens from a document with that document chosen, reading the list itself', async () => {
    const client = fakeClient();
    const { v } = await open(client, { documentId: 'd2' });
    expect(client.projects.listDocuments).toHaveBeenCalledWith('p1');
    expect(box('Selected documents').checked).toBe(true);
    expect(box('Story B').checked).toBe(true);
    expect(box('Story A').checked).toBe(false);
    await v.step(() => startButton().click());
    await v.step(async () => {});
    expect(client.jobs.create.mock.calls[0][1].documents).toEqual(['d2']);
    await v.unmount();
  });

  // A project of more documents than a job takes (REV-J-C-5): the limit is
  // core's, read from jobs.worker(), and said as a fact.
  it('says the limit on a project over it, and offers only Selected documents', async () => {
    const client = fakeClient({ documentsMax: 2 });
    const { v } = await open(client, { documents: DOCS });
    expect(document.body.textContent).toContain(LIMIT);
    expect(box('All documents').disabled).toBe(true);
    expect(box('All documents').checked).toBe(false);
    expect(box('Selected documents').checked).toBe(true);
    expect(startButton().disabled).toBe(true);
    await v.step(() => box('Story A').click());
    await v.step(() => box('Story B').click());
    expect(startButton().disabled).toBe(false);
    await v.step(() => box('Story C').click());
    expect(startButton().disabled).toBe(true);
    await v.step(() => box('Story C').click());
    await v.step(() => startButton().click());
    await v.step(async () => {});
    expect(client.jobs.create.mock.calls[0][1].documents).toEqual(['d1', 'd2']);
    await v.unmount();
  });

  it('says no limit and offers All documents on a project within it', async () => {
    const { v } = await open(fakeClient({ documentsMax: 3 }), { documents: DOCS });
    expect(document.body.textContent).not.toContain('A job takes at most');
    expect(box('All documents').disabled).toBe(false);
    expect(box('All documents').checked).toBe(true);
    await v.unmount();
  });

  it('narrows the list by name, selects what it shows, and clears', async () => {
    const { v } = await open(fakeClient({ documentsMax: 2 }), { documents: DOCS });
    expect(listed()).toEqual(['Story A', 'Story B', 'Story C']);
    await v.step(() => search('b'));
    expect(listed()).toEqual(['Story B']);
    await v.step(() => button('Select shown').click());
    await v.step(() => search(''));
    expect(box('Story B').checked).toBe(true);
    expect(box('Story A').checked).toBe(false);
    expect(document.body.textContent).toContain('1 selected');
    await v.step(() => button('Select shown').click());
    expect(['Story A', 'Story B', 'Story C'].map((n) => box(n).checked)).toEqual([
      true,
      true,
      true,
    ]);
    expect(document.body.textContent).toContain('3 selected');
    expect(startButton().disabled).toBe(true);
    await v.step(() => button('Clear').click());
    expect(['Story A', 'Story B', 'Story C'].map((n) => box(n).checked)).toEqual([
      false,
      false,
      false,
    ]);
    await v.unmount();
  });

  it('says the project already has a job, with a link to it, and stays open', async () => {
    const client = fakeClient({
      create: async () => {
        throw Object.assign(new Error('HTTP 409'), {
          status: 409,
          responseData: { error: 'This project already has a job.', code: 'job-active', job: 'j9' },
        });
      },
    });
    const { v, at } = await open(client, { documents: DOCS });
    await v.step(() => startButton().click());
    await v.step(async () => {});
    const alert = document.body.querySelector('[role="alert"]');
    expect(alert.textContent).toContain('This project already has a job.');
    expect(alert.querySelector('a').getAttribute('href')).toBe('/projects/p1/jobs/j9');
    expect(at()).toBe('/projects/p1');
    expect(feedback.notifyError).not.toHaveBeenCalled();
    await v.unmount();
  });

  it('sends the same id when Start is pressed again after a failure', async () => {
    let calls = 0;
    const client = fakeClient({
      create: async (_p, body) => {
        calls += 1;
        if (calls === 1) throw Object.assign(new Error('HTTP 503'), { status: 503 });
        return { id: body.id };
      },
    });
    const { v } = await open(client, { documents: DOCS });
    await v.step(() => startButton().click());
    await v.step(async () => {});
    expect(feedback.notifyError).toHaveBeenCalledTimes(1);
    await v.step(() => startButton().click());
    await v.step(async () => {});
    const [first, second] = client.jobs.create.mock.calls.map((c) => c[1].id);
    expect(second).toBe(first);
    await v.unmount();
  });
});
