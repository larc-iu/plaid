import PlaidClient from '@larc-iu/plaid-client';
import { test, expect, seedAuth, readToken, CORE } from './fixtures.js';
import { createScratchProject } from './fixtureProject.js';
import { runScriptedJobWorker, skipUnlessAgent } from './assistantService.js';

// What a running job has done, on its page (BRIEF LV). plaid-agent's own
// worker on a scripted model plans the job, glosses kai in its one piece and
// then writes its report on a model that answers 40 seconds late. While it
// waits the job is still running, and its page already lists the plan and
// the piece (its document as a link, what it wrote, its note),
// "Work so far" counts the piece's steps, and the document's "Changes so far" opens
// the History entry of what the job has written there. Once it ends the rows
// stay above the report. A throwaway project, deleted afterwards with its job.

const DOC = 'Story A';
const NOTE = 'Glossed kai as "go". Left pele and tuna: no precedent.';

let client;
let projectId;
let documentId;

test.beforeAll(async () => {
  client = new PlaidClient(CORE, readToken().token);
  ({ projectId, documentId } = await createScratchProject({
    name: `job activity ${Date.now()}`,
    docName: DOC,
    body: 'kai pele tuna',
  }));
});

test.afterAll(async () => {
  if (projectId) await client.projects.delete(projectId).catch(() => {});
});

test('a running job lists each piece as it finishes, with its note and its Changes so far', async ({
  page,
}) => {
  test.setTimeout(240_000);
  skipUnlessAgent(test);
  await seedAuth(page);
  const job = await client.jobs.create(projectId, {
    app: 'igt',
    instructions: 'Gloss kai as "go".',
    documents: [documentId],
  });
  const worker = runScriptedJobWorker({
    token: readToken().token,
    timeoutMs: 200_000,
    script: [
      { calls: [{ name: 'plan_work', arguments: { pieces: 'document', fills: ['Gloss'] } }] },
      { content: 'Planned.' },
      {
        calls: [
          {
            name: 'set_field',
            arguments: { document: DOC, refs: ['s1.w1.m1'], field: 'Gloss', value: 'go' },
          },
        ],
      },
      { content: NOTE },
      // The report's summary, late: the job is still running meanwhile.
      { content: 'The job glossed kai.', wait_s: 40 },
    ],
  });
  try {
    await page.goto(`/#/projects/${projectId}/jobs/${job.id}`);
    const activity = page.getByRole('region', { name: 'Work so far' });
    const rows = activity.getByTestId('job-activity').locator(':scope > li');
    await expect(rows).toHaveCount(2, { timeout: 90_000 });
    // Still running: no report yet.
    expect((await client.jobs.get(job.id)).state).toBe('running');
    await expect(page.getByRole('region', { name: 'Report' })).toHaveCount(0);

    const [piece, plan] = [rows.nth(0), rows.nth(1)];
    await expect(plan).toContainText('Plan');
    await expect(plan).toContainText('Worked one document at a time. Fills: Gloss.');
    await expect(piece).toContainText('Gloss: 1 value.');
    await expect(piece).toContainText('1 step');
    await expect(piece.locator('p[dir="auto"]')).toHaveText(NOTE);
    const where = piece.getByRole('link', { name: DOC, exact: true });
    // A piece of the whole document links the document.
    await expect(where).toHaveAttribute('href', `#/projects/${projectId}/documents/${documentId}`);

    // The document's link to what the job has written there so far.
    // Read as any reader reads it (by the route: node here resolves the
    // client of the checkout the node_modules link names).
    const read = await fetch(`${CORE}/api/v1/jobs/${job.id}/pieces`, {
      headers: { authorization: `Bearer ${readToken().token}` },
    });
    expect((await read.json()).entries.map((p) => p.seq)).toEqual(['000001', '000000']);
    const group = (await client.jobs.get(job.id)).documents[0].glossGroup;
    const link = page.getByRole('link', { name: 'Changes so far', exact: true });
    await expect(link).toBeVisible({ timeout: 20_000 });
    await link.click();
    await expect(page).toHaveURL(new RegExp(`documents/${documentId}\\?.*history=${group}`));
    await expect(page.getByTestId('change-count')).toHaveText(
      '1 change, 0 replaced a person’s value',
      {
        timeout: 20_000,
      },
    );
    expect((await client.jobs.get(job.id)).state).toBe('running');

    // Once it ends the rows stay, above the report.
    const ran = await worker;
    expect(ran.code, ran.log).toBe(0);
    await page.goto(`/#/projects/${projectId}/jobs/${job.id}`);
    await expect(page.getByRole('region', { name: 'Report' })).toBeVisible({ timeout: 30_000 });
    const ended = page.getByRole('region', { name: 'Work, in order' });
    await expect(ended.getByTestId('job-activity').locator(':scope > li')).toHaveCount(2);
    await expect(page.getByRole('link', { name: 'Changes', exact: true })).toBeVisible();
  } finally {
    await client.jobs.cancel(job.id).catch(() => {});
    await worker;
  }
});
