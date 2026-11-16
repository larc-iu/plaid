import PlaidClient, { ROLES } from '@larc-iu/plaid-client';
import { test, expect, seedAuth, readToken, CORE } from './fixtures.js';
import { createScratchProject, roleOf } from './fixtureProject.js';
import { runScriptedJobWorker, skipUnlessAgent } from './assistantService.js';

// A job's report as the worker writes it, read on the real page (CONTRACT,
// added by RPF). plaid-agent's own worker runs each job on a scripted model
// (runScriptedJobWorker), so every key the page reads is the worker's:
// - a job that retypes a sentence, adding a word and dropping a punctuation
//   mark, and writes over a person's gloss: the worker's notice line first,
//   the changes said in their parts, words added and existing tokens changed,
//   what is blank where the job wrote nothing counted apart, a form left
//   inconsistent with a reason from the new set, and the Changes view and the
//   Undo dialog saying their counts in the same nouns,
// - a job set up to fill only the words it adds: the value it stages on an
//   existing word is refused as not added,
// - a job that fills nothing: its findings first on the page, with Copy, and
//   no Undo job.
// A throwaway project, deleted afterwards with its jobs.

test.describe.configure({ mode: 'serial' });

let client;
let projectId;
let layers;
let glossLayerId;
let posLayerId;

// A document of one sentence per string, one morpheme a word.
const addDocument = async (name, sentences) => {
  const doc = await client.documents.create(projectId, name);
  const body = sentences.join(' ');
  const text = await client.texts.create(layers.text, doc.id, body);
  let at = 0;
  const spans = sentences.map((s, i) => {
    const begin = at;
    at += s.length + 1;
    return { begin, end: i === sentences.length - 1 ? body.length : at };
  });
  await client.tokens.bulkCreate(
    spans.map((s) => ({ tokenLayerId: layers.sentence, text: text.id, ...s })),
  );
  const words = [...body.matchAll(/\S+/g)].map((m) => ({
    begin: m.index,
    end: m.index + m[0].length,
  }));
  await client.tokens.bulkCreate(
    words.map((w) => ({ tokenLayerId: layers.word, text: text.id, ...w })),
  );
  await client.tokens.bulkCreate(
    words.map((w) => ({ tokenLayerId: layers.morpheme, text: text.id, ...w, precedence: 1 })),
  );
  return doc.id;
};

// The document's body and its tokens of `role` in reading order, each with
// its text and the value of `spanLayerId` on it.
const tokensOf = async (documentId, role, spanLayerId) => {
  const raw = await client.documents.get(documentId, true);
  const tl = raw.textLayers.find((l) => roleOf(l) === ROLES.BASELINE);
  const layer = tl.tokenLayers.find((t) => roleOf(t) === role);
  const spans = (layer.spanLayers || []).find((s) => s.id === spanLayerId)?.spans || [];
  return {
    body: tl.text.body,
    tokens: layer.tokens
      .slice()
      .sort((a, b) => a.begin - b.begin)
      .map((t) => ({
        id: t.id,
        form: tl.text.body.slice(t.begin, t.end),
        value: spans.find((s) => s.tokens.includes(t.id))?.value ?? null,
      })),
  };
};

const set = (document, ref, field, value) => ({
  name: 'set_field',
  arguments: { document, refs: [ref], field, value },
});

// The Report region's totals, label to value.
const totalsOf = async (page) => {
  const report = page.getByRole('region', { name: 'Report' });
  const labels = await report.locator('dl > div > dt').allInnerTexts();
  const values = await report.locator('dl > div > dd').allInnerTexts();
  return Object.fromEntries(labels.map((l, i) => [l, values[i]]));
};

const openJob = async (page, job) => {
  await page.goto(`/#/projects/${projectId}/jobs/${job.id}`);
  await expect(page.getByRole('region', { name: 'Report' })).toBeVisible({ timeout: 30_000 });
};

test.beforeAll(async () => {
  client = new PlaidClient(CORE, readToken().token);
  ({ projectId } = await createScratchProject({
    name: `E2E Job Report ${Date.now()}`,
    docName: 'Unused',
    body: 'x',
  }));
  const project = await client.projects.get(projectId);
  const tl = project.textLayers.find((l) => roleOf(l) === ROLES.BASELINE);
  const layer = (role) => tl.tokenLayers.find((t) => roleOf(t) === role).id;
  layers = {
    text: tl.id,
    sentence: layer(ROLES.SENTENCE),
    word: layer(ROLES.WORD),
    morpheme: layer(ROLES.MORPHEME),
  };
  const spanLayers = tl.tokenLayers.flatMap((t) => t.spanLayers || []);
  glossLayerId = spanLayers.find((s) => s.name === 'Gloss').id;
  posLayerId = spanLayers.find((s) => s.name === 'Part of Speech').id;
});

test.afterAll(async () => {
  if (projectId) await client.projects.delete(projectId).catch(() => {});
});

test('a job that edits the text and writes over a person: its line, its counts in their parts, and one set of nouns', async ({
  page,
}) => {
  test.setTimeout(240_000);
  skipUnlessAgent(test);
  const DOC = 'Story A';
  const doc = await addDocument(DOC, ['kai pele', 'kai lo', 'tuna , mo', 'pele lo']);
  const { tokens: morphemes } = await tokensOf(doc, ROLES.MORPHEME, glossLayerId);
  // A person's gloss the job writes over.
  await client.withOperation('Seed a gloss', async () => {
    await client.spans.create(glossLayerId, [morphemes[1].id], 'fly');
  });
  const job = await client.jobs.create(projectId, {
    app: 'igt',
    instructions: 'Gloss kai and pele, and fix sentence 3.',
    documents: [doc],
  });
  const ran = await runScriptedJobWorker({
    token: readToken().token,
    script: [
      {
        calls: [
          {
            name: 'plan_work',
            arguments: { pieces: 'document', fills: ['Gloss'], edits_text: true },
          },
        ],
      },
      { content: 'Planned.' },
      {
        calls: [
          set(DOC, 's1.w1.m1', 'Gloss', 'go'),
          set(DOC, 's1.w2.m1', 'Gloss', 'bird'),
          // kai two ways, both the job's: none holds two thirds.
          set(DOC, 's2.w1.m1', 'Gloss', 'come'),
          // A word added and the comma dropped. Sentence 4 is worked and
          // nothing is written there.
          {
            name: 'retype_sentence',
            arguments: { document: DOC, ref: 's3', text: 'tuna mo sa' },
          },
        ],
      },
      { content: 'Glossed kai and pele, and retyped sentence 3.' },
      { content: 'The job glossed **kai** twice and retyped sentence 3.' },
    ],
  });
  expect(ran.code, ran.log).toBe(0);
  const ended = await client.jobs.get(job.id);
  expect(ended.state).toBe('done');
  expect((await tokensOf(doc, ROLES.MORPHEME, glossLayerId)).body).toBe(
    'kai pele kai lo tuna mo sa pele lo',
  );

  await seedAuth(page);
  await openJob(page, job);
  const report = page.getByRole('region', { name: 'Report' });
  // The worker's own line first, from its counts (R4).
  await expect(report.getByTestId('job-notice')).toHaveText(
    "People's work: 1 value, morpheme or link people wrote was changed or removed. What the job wrote in their place is unverified. Text: 1 word added, 1 existing word or punctuation mark changed or removed.",
  );
  const totals = await totalsOf(page);
  expect(totals).toMatchObject({
    'Changes written': '4 (3 values and 1 text edit)',
    'People’s values, morphemes and links changed or removed': '1',
    'Changes to the text': '1',
    'Words added': '1',
    'Existing words or punctuation marks changed or removed': '1',
    Gloss: '3 values',
    'Gloss left blank': '4 morphemes',
    // Sentence 4, worked and not written in: counted, never listed.
    'Gloss blank in sentences the job did not change': '2 morphemes',
  });
  // The notice comes before the totals, the assistant's account after them.
  const order = await report.evaluate((el) =>
    [...el.querySelectorAll('[data-testid="job-notice"], h3, [data-testid="job-summary"]')].map(
      (n) => n.getAttribute('data-testid') || n.textContent,
    ),
  );
  expect(order.slice(0, 4)).toEqual(['job-notice', 'Totals', 'Assistant’s summary', 'job-summary']);
  await expect(report.getByTestId('job-summary')).toHaveText(
    'The job glossed kai twice and retyped sentence 3.',
  );
  await expect(report.getByTestId('job-summary').locator('strong')).toHaveText('kai');
  await expect(
    report.getByText('Blank in sentences the job did not change: Gloss 2 morphemes.'),
  ).toBeVisible();
  const leftList = report.getByRole('listitem').filter({ hasText: /^s\d/ });
  await expect(leftList).toHaveText([
    's2.w2.m1 lo Gloss',
    's3.w1.m1 tuna Gloss',
    's3.w2.m1 mo Gloss',
    's3.w3.m1 sa Gloss',
  ]);
  // The form the job glossed two ways, with a reason from the new set.
  const inconsistent = report.getByRole('row').filter({ hasText: 'kai ‘go’' });
  await expect(inconsistent).toContainText('The job’s analyses differ, none by two thirds');
  // The piece's line says the same parts.
  await expect(page.getByTestId('job-activity')).toContainText(
    'Changes written: 4 (3 values and 1 text edit), People’s values, morphemes and links changed or removed: 1, Changes to the text: 1, Words added: 1, Existing words or punctuation marks changed or removed: 1, Gloss: 3 values.',
  );

  // The Undo dialog names what it undoes in the report's nouns: the values,
  // and the text with its words, never tokens.
  await page.getByRole('button', { name: 'Undo job' }).click();
  const dialog = page.getByRole('dialog');
  await expect(dialog.getByText('Comparing…')).toHaveCount(0, { timeout: 20_000 });
  await expect(dialog.getByTestId('undo-line')).toHaveText(
    '3 values and the text with its words and sentences',
  );
  await dialog.getByRole('button', { name: 'Cancel' }).click();
  await expect(dialog).toHaveCount(0);

  // The document's Changes view: what it changed in the same nouns (the word
  // the retype added is the one word changed), never a bare count of changes.
  await page.getByRole('link', { name: 'Changes', exact: true }).first().click();
  await expect(page.getByTestId('change-count')).toHaveText(
    '3 values and 1 word changed, 1 replaced a person’s value',
    { timeout: 20_000 },
  );
});

// REV-RPF-P-1 (the reviewer's job j6): an analysis job counted 4 changes in its
// report and 11 in the Changes view, the same noun for counts of different
// units. Each screen now says its parts with their nouns, and the report's
// field line counts the values the analyses carried.
test('an analysis job: the report and the Changes view each say what they count, no bare count of changes', async ({
  page,
}) => {
  test.setTimeout(240_000);
  skipUnlessAgent(test);
  const DOC = 'Story J6';
  const doc = await addDocument(DOC, ['kaii pele', 'kaii lo', 'tuna mo']);
  const { tokens: morphemes } = await tokensOf(doc, ROLES.MORPHEME, glossLayerId);
  await client.withOperation('Seed a gloss', async () => {
    await client.spans.create(glossLayerId, [morphemes[1].id], 'fly');
  });
  const job = await client.jobs.create(projectId, {
    app: 'igt',
    instructions: 'Segment and gloss sentences 1 and 2.',
    documents: [doc],
  });
  const ran = await runScriptedJobWorker({
    token: readToken().token,
    script: [
      {
        calls: [
          {
            name: 'plan_work',
            arguments: { pieces: 'document', fills: ['segmentation', 'Gloss'] },
          },
        ],
      },
      { content: 'Planned.' },
      {
        calls: [
          {
            name: 'analyze_sentence',
            arguments: {
              document: DOC,
              sentences: [
                { ref: 's1', words: ['ka-ii go-PST', 'pele bird'] },
                { ref: 's2', words: ['ka-ii go-PRS', 'lo here'] },
              ],
            },
          },
        ],
      },
      { content: 'Segmented kaii two ways.' },
      { content: 'The job segmented **kaii**.' },
    ],
  });
  expect(ran.code, ran.log).toBe(0);
  await seedAuth(page);
  await openJob(page, job);
  // The report: one value (pele's, in place) and three analyses written, and
  // the six glosses they hold, five of them carried by the analyses.
  const totals = await totalsOf(page);
  expect(totals['Changes written']).toBe(
    '4 (1 value on its own and 3 word analyses holding 5 morphemes and 5 values)',
  );
  expect(totals.Gloss).toBe('6 values (5 in word analyses)');
  // The Changes view: the marks it draws, each with its noun.
  await page.getByRole('link', { name: 'Changes', exact: true }).first().click();
  await expect(page.getByTestId('change-count')).toHaveText(
    '6 values and 5 morphemes changed, 1 replaced a person’s value',
    { timeout: 20_000 },
  );
});

// REV-RPF2-1 (the reviewer's Story Q): two retypes take away a person's ro (its
// morpheme, its Gloss and its Part of Speech) and type over a person's tqmc
// (its morpheme and Gloss). The report counts what people wrote piece by
// piece, as the Changes view does: 5 and 5.
test('a retype that removes people’s words counts what people wrote as the Changes view does', async ({
  page,
}) => {
  test.setTimeout(240_000);
  skipUnlessAgent(test);
  const DOC = 'Story Q';
  const doc = await addDocument(DOC, ['pa ro', 'sc tqmc']);
  const { tokens: morphemes } = await tokensOf(doc, ROLES.MORPHEME, glossLayerId);
  const { tokens: words } = await tokensOf(doc, ROLES.WORD, posLayerId);
  await client.withOperation('Seed', async () => {
    await client.spans.create(glossLayerId, [morphemes[1].id], 'come');
    await client.spans.create(posLayerId, [words[1].id], 'V');
    await client.spans.create(glossLayerId, [morphemes[3].id], 'he');
  });
  const job = await client.jobs.create(projectId, {
    app: 'igt',
    instructions: 'Fix the text.',
    documents: [doc],
  });
  const ran = await runScriptedJobWorker({
    token: readToken().token,
    script: [
      {
        calls: [
          {
            name: 'plan_work',
            arguments: { pieces: 'document', fills: ['Gloss'], edits_text: true },
          },
        ],
      },
      { content: 'Planned.' },
      {
        calls: [
          { name: 'retype_sentence', arguments: { document: DOC, ref: 's1', text: 'pa' } },
          { name: 'retype_sentence', arguments: { document: DOC, ref: 's2', text: 'sc bolo' } },
        ],
      },
      { content: 'Done.' },
      { content: 'Fixed.' },
    ],
  });
  expect(ran.code, ran.log).toBe(0);
  await seedAuth(page);
  await openJob(page, job);
  const report = page.getByRole('region', { name: 'Report' });
  await expect(report.getByTestId('job-notice')).toContainText(
    "People's work: 5 values, morphemes or links people wrote were changed or removed.",
  );
  expect((await totalsOf(page))['People’s values, morphemes and links changed or removed']).toBe(
    '5',
  );
  await page.getByRole('link', { name: 'Changes', exact: true }).first().click();
  await expect(page.getByTestId('change-count')).toHaveText(
    '3 values, 2 morphemes and 3 words changed, 5 replaced a person’s value',
    { timeout: 20_000 },
  );
});

test('a job set up to fill only the words it adds is refused a value on a word it did not add', async ({
  page,
}) => {
  test.setTimeout(240_000);
  skipUnlessAgent(test);
  const DOC = 'Story B';
  const doc = await addDocument(DOC, ['kai pele', 'tuna lo']);
  const job = await client.jobs.create(projectId, {
    app: 'igt',
    instructions: 'Insert a zero subject before kai, and give it the Part of Speech PRON.',
    documents: [doc],
    setup: { fills: [{ id: posLayerId, name: 'Part of Speech' }], text: true, onlynew: true },
  });
  const ran = await runScriptedJobWorker({
    token: readToken().token,
    script: [
      {
        calls: [
          {
            name: 'plan_work',
            arguments: { pieces: 'document', fills: ['Part of Speech'], edits_text: true },
          },
        ],
      },
      { content: 'Planned.' },
      {
        calls: [
          { name: 'retype_sentence', arguments: { document: DOC, ref: 's1', text: '∅ kai pele' } },
          set(DOC, 's1.w1 "∅"', 'Part of Speech', 'PRON'),
          set(DOC, 's2.w1', 'Part of Speech', 'N'),
        ],
      },
      { content: 'Inserted the zero subject.' },
      { content: 'The job inserted one zero subject.' },
    ],
  });
  expect(ran.code, ran.log).toBe(0);
  const ended = await client.jobs.get(job.id);
  expect(ended.state).toBe('done');
  expect(ended.report.documents[0].refused.map((r) => [r.sentence, r.code])).toEqual([
    ['s2', 'not-added'],
  ]);
  // The inserted word has its value, no other word has one.
  const { tokens: words } = await tokensOf(doc, ROLES.WORD, posLayerId);
  expect(words.map((w) => [w.form, w.value])).toEqual([
    ['∅', 'PRON'],
    ['kai', null],
    ['pele', null],
    ['tuna', null],
    ['lo', null],
  ]);

  await seedAuth(page);
  await openJob(page, job);
  await expect(page.getByTestId('job-setup')).toHaveText(
    /^Set up to fill Part of Speech, only on the words it adds\. Text may be edited\./,
  );
  const report = page.getByRole('region', { name: 'Report' });
  await expect(report.getByTestId('job-notice')).toHaveText('Text: 1 word added.');
  expect(await totalsOf(page)).toMatchObject({
    'Changes written': '2 (1 value and 1 text edit)',
    'Words added': '1',
    'Part of Speech': '1 value',
  });
  await expect(report.getByText('Not done, refused:')).toBeVisible();
  await expect(report.getByRole('listitem').filter({ hasText: /^s2 / })).toHaveText(
    's2 Value on a word or sentence the job did not add',
  );
});

test('a job that fills nothing shows its findings first, with Copy, and offers no Undo', async ({
  page,
  context,
}) => {
  test.setTimeout(240_000);
  skipUnlessAgent(test);
  const doc = await addDocument('Story C', ['kai pele', 'kai lo']);
  const job = await client.jobs.create(projectId, {
    app: 'igt',
    instructions: 'List every form that occurs more than once.',
    documents: [doc],
  });
  const FINDINGS = '## Forms seen twice\n\n- **kai**: sentences 1 and 2';
  const ran = await runScriptedJobWorker({
    token: readToken().token,
    script: [
      { calls: [{ name: 'plan_work', arguments: { pieces: 'document', fills: [] } }] },
      { content: 'Planned.' },
      { content: FINDINGS },
      { content: 'The job listed one form.' },
    ],
  });
  expect(ran.code, ran.log).toBe(0);
  const ended = await client.jobs.get(job.id);
  expect(ended.state).toBe('done');
  expect(ended.report.findings).toBe(FINDINGS);

  await context.grantPermissions(['clipboard-read', 'clipboard-write']);
  await seedAuth(page);
  await openJob(page, job);
  const findings = page.getByRole('region', { name: 'Findings' });
  await expect(findings.getByRole('heading', { name: 'Forms seen twice' })).toBeVisible();
  await expect(findings.locator('li strong')).toHaveText('kai');
  // First on the page: before the instructions and the report.
  const first = await page.evaluate(() => {
    const at = (el) => (el ? [...document.querySelectorAll('*')].indexOf(el) : -1);
    return {
      findings: at(document.querySelector('[data-testid="job-findings"]')),
      instructions: at(
        [...document.querySelectorAll('dt')].find((d) => d.textContent === 'Instructions'),
      ),
      report: at(document.querySelector('section[aria-label="Report"]')),
    };
  });
  expect(first.findings).toBeLessThan(first.instructions);
  expect(first.findings).toBeLessThan(first.report);
  await findings.getByRole('button', { name: 'Copy' }).click();
  expect(await page.evaluate(() => navigator.clipboard.readText())).toBe(FINDINGS);
  await expect(page.getByRole('button', { name: 'Undo job' })).toHaveCount(0);
  await expect(page.getByTestId('job-notice')).toHaveCount(0);
  await expect(page.getByTestId('job-summary')).toHaveText(
    'The job wrote no change and proposed none.',
  );
});
