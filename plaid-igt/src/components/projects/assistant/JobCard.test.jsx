import { describe, it, expect, vi, beforeEach } from 'vitest';
import { MemoryRouter } from 'react-router-dom';
import { renderComponent, byText, all } from '@ui/test/renderComponent.jsx';
import { AuthContext } from '@ui/contexts/useAuth.js';

// The job card: an unattended job the assistant drafted, which the page
// starts as the signed-in user with the Start job dialog's own call, under the
// card's id, and then tells the assistant how the card ended. What a reader,
// another tab and a reloaded panel see.
const feedback = vi.hoisted(() => ({ notifyError: vi.fn() }));
vi.mock('@/utils/feedback', () => feedback);
const { JobCard } = await import('./JobCard.jsx');

const CARD_ID = '0190f000-0000-7000-8000-000000000001';
const docs = (n) =>
  Array.from({ length: n }, (_, i) => ({ id: `d${i + 1}`, name: `Story ${i + 1}` }));
const card = (fields = {}) => ({
  id: CARD_ID,
  all: false,
  count: 2,
  documents: docs(2),
  tasks: ['gloss', 'link'],
  brief: 'Gloss ka as go.',
  summary: '2 documents, gloss and link',
  status: null,
  ...fields,
});

const WRITER = { id: 'w@x', isAdmin: false };
const READER = { id: 'r@x', isAdmin: false };
const PROJECT = { id: 'p1', writers: ['w@x'], readers: ['r@x'], maintainers: [] };

const fakeClient = ({ create, seenAt = new Date().toISOString() } = {}) => ({
  jobs: {
    worker: vi.fn(async () => ({ seenAt, model: 'm', noteMaxChars: 20, documentsMax: 500 })),
    create: vi.fn(create ?? (async (_p, body) => ({ id: body.id, state: 'waiting' }))),
  },
  projects: { get: vi.fn(async () => PROJECT) },
});

const refusal = (status, responseData) =>
  Object.assign(new Error(`HTTP ${status}`), { status, responseData });

const draw = async (props, { user = WRITER, router = true } = {}) => {
  const onSettle = props.onSettle ?? vi.fn(async () => {});
  const el = (
    <AuthContext.Provider value={{ user }}>
      <JobCard projectId="p1" client={fakeClient()} onSettle={onSettle} {...props} />
    </AuthContext.Provider>
  );
  const v = await renderComponent(router ? <MemoryRouter>{el}</MemoryRouter> : el);
  await v.step(async () => {});
  return { v, onSettle };
};

const button = (v, label) =>
  all(v.container, 'button').find((b) => b.textContent.trim() === label) ?? null;
const typeBrief = (v, value) => {
  const area = v.container.querySelector('textarea');
  Object.getOwnPropertyDescriptor(HTMLTextAreaElement.prototype, 'value').set.call(area, value);
  area.dispatchEvent(new Event('input', { bubbles: true }));
};
const text = (v) => v.container.textContent;

beforeEach(() => feedback.notifyError.mockClear());

describe('the job card', () => {
  it('shows what the job covers, the brief to edit with its count, Start job and Discard', async () => {
    const { v } = await draw({ card: card({ documents: docs(7), count: 7 }) });
    expect(text(v)).toContain('Proposed job');
    expect(text(v)).toContain('Story 1, Story 2, Story 3, Story 4, Story 5 and 2 more');
    expect(text(v)).toContain('Segment and gloss, Link to lexicon');
    expect(v.container.querySelector('textarea').value).toBe('Gloss ka as go.');
    expect(byText(v.container, '[data-testid="job-note-count"]', '15 / 20')).toBeTruthy();
    expect(button(v, 'Start job').disabled).toBe(false);
    expect(button(v, 'Discard')).toBeTruthy();
    expect(text(v)).not.toContain('No job worker is running.');
    const link = byText(v.container, 'a', 'Story 1');
    expect(link.getAttribute('href')).toBe('/projects/p1/documents/d1');
  });

  it('names every document of the project as all of them', async () => {
    const { v } = await draw({ card: card({ all: true, count: 42, documents: undefined }) });
    expect(text(v)).toContain('All documents (42)');
  });

  it("says no worker is running, with the dialog's line", async () => {
    const { v } = await draw({
      card: card(),
      client: fakeClient({ seenAt: '2020-01-01T00:00:00Z' }),
    });
    expect(text(v)).toContain('No job worker is running. The job waits until one starts.');
  });

  it("starts the job with the dialog's call under the card's id, the edited brief included", async () => {
    const client = fakeClient();
    const { v, onSettle } = await draw({ card: card(), client });
    await v.step(() => typeBrief(v, 'Gloss ka as come.'));
    await v.step(() => button(v, 'Start job').click());
    await v.step(async () => {});
    expect(client.jobs.create).toHaveBeenCalledWith('p1', {
      app: 'igt',
      tasks: ['gloss', 'link'],
      documents: ['d1', 'd2'],
      note: 'Gloss ka as come.',
      id: CARD_ID,
    });
    expect(onSettle).toHaveBeenCalledWith({ outcome: 'started', brief: 'Gloss ka as come.' });
  });

  it('starts every document of the project when the card names all', async () => {
    const client = fakeClient();
    const { v } = await draw({ card: card({ all: true, count: 3, documents: undefined }), client });
    await v.step(() => button(v, 'Start job').click());
    await v.step(async () => {});
    expect(client.jobs.create.mock.calls[0][1]).not.toHaveProperty('documents');
  });

  it('takes a start that landed before its answer was lost as started', async () => {
    const client = fakeClient({
      create: async () => {
        throw refusal(409, { error: 'id-taken', deleted: false });
      },
    });
    const { v, onSettle } = await draw({ card: card(), client });
    await v.step(() => button(v, 'Start job').click());
    await v.step(async () => {});
    expect(onSettle).toHaveBeenCalledWith({ outcome: 'started', brief: 'Gloss ka as go.' });
  });

  // REV-JB-1: core as it answers a create, job-active checked before the id
  // (plaid-core sql/job.clj create!), over the project's `jobs`.
  const core = (jobs) => async (_p, body) => {
    const active = jobs.find((j) => j.state === 'waiting' || j.state === 'running');
    if (active) {
      throw refusal(409, {
        error: 'This project already has a job.',
        code: 'job-active',
        job: active.id,
      });
    }
    if (jobs.some((j) => j.id === body.id))
      throw refusal(409, { error: 'id-taken', deleted: false });
    jobs.push({ id: body.id, state: 'waiting' });
    return { id: body.id, state: 'waiting' };
  };

  it("takes a press after a reload, refused for the card's own running job, as started", async () => {
    const jobs = [{ id: CARD_ID, state: 'running' }];
    const client = fakeClient({ create: core(jobs) });
    const { v, onSettle } = await draw({ card: card(), client });
    await v.step(() => button(v, 'Start job').click());
    await v.step(async () => {});
    expect(onSettle).toHaveBeenCalledWith({ outcome: 'started', brief: 'Gloss ka as go.' });
    expect(jobs).toHaveLength(1);
  });

  it("sends the card's id on every press, so a start the record missed is started again", async () => {
    const jobs = [];
    const client = fakeClient({ create: core(jobs) });
    // The service did not record the first start: the card still waits.
    const { v, onSettle } = await draw({ card: card(), client });
    await v.step(() => button(v, 'Start job').click());
    await v.step(async () => {});
    await v.step(() => button(v, 'Start job').click());
    await v.step(async () => {});
    expect(client.jobs.create.mock.calls.map((c) => c[1].id)).toEqual([CARD_ID, CARD_ID]);
    expect(onSettle.mock.calls).toEqual([
      [{ outcome: 'started', brief: 'Gloss ka as go.' }],
      [{ outcome: 'started', brief: 'Gloss ka as go.' }],
    ]);
    expect(jobs).toHaveLength(1);
  });

  it("takes a press after the card's job ended as started, and makes no second job", async () => {
    const jobs = [{ id: CARD_ID, state: 'done' }];
    const client = fakeClient({ create: core(jobs) });
    const { v, onSettle } = await draw({ card: card(), client });
    await v.step(() => button(v, 'Start job').click());
    await v.step(async () => {});
    expect(onSettle).toHaveBeenCalledWith({ outcome: 'started', brief: 'Gloss ka as go.' });
    expect(jobs).toEqual([{ id: CARD_ID, state: 'done' }]);
  });

  it('ends as not started when the project already has a job, naming it', async () => {
    const client = fakeClient({
      create: async () => {
        throw refusal(409, {
          error: 'This project already has a job.',
          code: 'job-active',
          job: 'j9',
        });
      },
    });
    const { v, onSettle } = await draw({ card: card(), client });
    await v.step(() => button(v, 'Start job').click());
    await v.step(async () => {});
    expect(onSettle).toHaveBeenCalledWith({
      outcome: 'failed',
      reason: 'This project already has a job.',
      activeJob: 'j9',
    });
  });

  it("ends as not started with core's own sentence when core refuses the start", async () => {
    const client = fakeClient({
      create: async () => {
        throw refusal(400, { error: 'documents: 1 is not a document of this project.' });
      },
    });
    const { v, onSettle } = await draw({ card: card(), client });
    await v.step(() => button(v, 'Start job').click());
    await v.step(async () => {});
    expect(onSettle).toHaveBeenCalledWith({
      outcome: 'failed',
      reason: 'documents: 1 is not a document of this project.',
      activeJob: null,
    });
  });

  it('keeps the card to try again when no answer came', async () => {
    const client = fakeClient({
      create: async () => {
        throw new Error('Network down');
      },
    });
    const { v, onSettle } = await draw({ card: card(), client });
    await v.step(() => button(v, 'Start job').click());
    await v.step(async () => {});
    expect(onSettle).not.toHaveBeenCalled();
    expect(feedback.notifyError).toHaveBeenCalled();
    expect(button(v, 'Start job').disabled).toBe(false);
  });

  it("refuses a brief over core's cap", async () => {
    const { v } = await draw({ card: card() });
    await v.step(() => typeBrief(v, 'x'.repeat(21)));
    expect(button(v, 'Start job').disabled).toBe(true);
    expect(byText(v.container, '[data-testid="job-note-count"]', '21 / 20')).toBeTruthy();
  });

  it('waits to start or discard while a turn runs, as a plan card does', async () => {
    const { v } = await draw({ card: card(), busy: true });
    expect(button(v, 'Start job').disabled).toBe(true);
    expect(button(v, 'Discard').disabled).toBe(true);
  });

  it('discards', async () => {
    const { v, onSettle } = await draw({ card: card() });
    await v.step(() => button(v, 'Discard').click());
    expect(onSettle).toHaveBeenCalledWith({ outcome: 'discarded' });
  });

  it('offers a reader no Start, with the reason, the brief to read and still Discard', async () => {
    const client = fakeClient({ seenAt: '2020-01-01T00:00:00Z' });
    const { v } = await draw({ card: card(), client }, { user: READER });
    expect(button(v, 'Start job')).toBeNull();
    expect(text(v)).toContain('Starting a job needs write access.');
    expect(button(v, 'Discard')).toBeTruthy();
    expect(v.container.querySelector('textarea')).toBeNull();
    expect(byText(v.container, '[data-testid="job-card-brief"]', 'Gloss ka as go.')).toBeTruthy();
    expect(text(v)).not.toContain('No job worker is running.');
  });

  it('offers no decision where the conversation is only read, and reads nothing', async () => {
    const client = fakeClient();
    const { v } = await draw({ card: card(), client, readOnly: true });
    expect(button(v, 'Start job')).toBeNull();
    expect(button(v, 'Discard')).toBeNull();
    expect(v.container.querySelector('textarea')).toBeNull();
    expect(text(v)).toContain('Waiting to start');
    expect(client.projects.get).not.toHaveBeenCalled();
  });

  describe('as the conversation records it, after a reload', () => {
    it('started: the brief as sent and a link to the job', async () => {
      const client = fakeClient();
      const { v } = await draw({
        card: card({ status: 'started', jobId: CARD_ID, sentBrief: 'Gloss ka as come.' }),
        client,
      });
      expect(text(v)).toContain('Started');
      expect(
        byText(v.container, '[data-testid="job-card-brief"]', 'Gloss ka as come.'),
      ).toBeTruthy();
      expect(byText(v.container, 'a', 'Open job').getAttribute('href')).toBe(
        `/projects/p1/jobs/${CARD_ID}`,
      );
      expect(button(v, 'Start job')).toBeNull();
      expect(v.container.querySelector('textarea')).toBeNull();
      expect(client.jobs.worker).not.toHaveBeenCalled();
    });

    it('discarded and replaced: the state alone', async () => {
      let { v } = await draw({ card: card({ status: 'discarded' }) });
      expect(text(v)).toContain('Discarded');
      expect(button(v, 'Discard')).toBeNull();
      ({ v } = await draw({ card: card({ status: 'replaced' }) }));
      expect(text(v)).toContain('Replaced');
    });

    it('not started: the reason, or the job that stood in its way with a link', async () => {
      let { v } = await draw({
        card: card({ status: 'failed', reason: 'tasks: link needs gloss.' }),
      });
      expect(text(v)).toContain('Not started');
      expect(text(v)).toContain('tasks: link needs gloss.');
      ({ v } = await draw({ card: card({ status: 'failed', reason: 'x', activeJob: 'j9' }) }));
      expect(text(v)).toContain('This project already has a job.');
      expect(byText(v.container, 'a', 'Open it').getAttribute('href')).toBe('/projects/p1/jobs/j9');
    });
  });

  it("links by the hash route where no router is (a conversation's HTML export)", async () => {
    const { v } = await draw(
      { card: card({ status: 'started', jobId: CARD_ID, sentBrief: 'x' }), readOnly: true },
      { router: false },
    );
    expect(byText(v.container, 'a', 'Open job').getAttribute('href')).toBe(
      `#/projects/p1/jobs/${CARD_ID}`,
    );
  });
});
