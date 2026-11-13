// The igt job screens' words for what a job reports: its tasks taken
// together, a skipped sentence, a harmonize decision. The words for a job's
// codes (its state, phase, reason, a task, a document's state) are plaid-ui's
// (domain/jobs.js), since every app says them. Also how a job is started,
// shared by the Start job dialog and the assistant's job card.
import { createOnce } from '@ui/lib/createOnce.js';
import { statusOf } from '@ui/lib/errors.js';

// The tasks an igt job can be given, in the order core keeps them (JOB_APPS).
export const JOB_TASKS = ['translate', 'gloss', 'link'];

// What a job was asked to write, as History names its entries ("Assistant
// job: translations and analyses"), capitalized: "Translations and analyses".
export const tasksText = (tasks = []) => {
  const nouns = [];
  if (tasks.includes('translate')) nouns.push('translations');
  if (tasks.includes('gloss')) {
    nouns.push(tasks.includes('link') ? 'analyses and lexicon links' : 'analyses');
  }
  if (!nouns.length) return '';
  const text =
    nouns.length === 1
      ? nouns[0]
      : nouns[1] === 'analyses'
        ? 'translations and analyses'
        : 'translations, analyses and lexicon links';
  return text[0].toUpperCase() + text.slice(1);
};

const FAILURE_TEXT = {
  budget: 'over budget',
  context: 'prompt too long',
  output: 'answer too long',
  repeating: 'model repeated itself',
};

// Why a sentence was left: `{reason, kind}` of a skipped entry.
export const skippedText = ({ reason, kind }) => {
  if (reason === 'too-long') return 'Too long';
  if (reason === 'changed') return 'Changed during the job';
  if (reason === 'failed') return FAILURE_TEXT[kind] ? `Failed: ${FAILURE_TEXT[kind]}` : 'Failed';
  return reason;
};

export const HARMONIZE_LEFT_TEXT = {
  'people-differ': 'People analyzed it in more than one way',
  'no-clear-majority': 'No two-thirds majority',
  'in-use': 'Document in use',
  touched: 'Changed since the job wrote it',
  commented: 'Has a comment',
  'in-mwe': 'In a multi-word expression',
  refused: 'Could not be written',
};

export const HARMONIZE_BY_TEXT = {
  person: 'A person’s analysis',
  majority: 'Majority',
};

// A stretch of time for a job, which runs for minutes or hours: "Under a
// minute", "12 min", "2 h 5 min".
export const durationText = (ms) => {
  const minutes = Math.floor(Math.max(0, ms) / 60000);
  if (minutes < 1) return 'Under a minute';
  const hours = Math.floor(minutes / 60);
  const rest = minutes % 60;
  if (!hours) return `${minutes} min`;
  return rest ? `${hours} h ${rest} min` : `${hours} h`;
};

// Where a job's page is.
export const jobPath = (projectId, jobId) => `/projects/${projectId}/jobs/${jobId}`;
export const jobsTabPath = (projectId) => `/projects/${projectId}?tab=jobs`;

// A note's length as core counts it: in characters, never UTF-16 units.
export const noteLength = (note) => [...note].length;

// Start a job as the signed-in user: the one client call, under the id `mint`
// holds (createOnce.js: a press again after a lost answer makes no second
// job). `documents` null is every document of the project. Resolves to the job.
export const startJob = (client, projectId, mint, { tasks, documents = null, note = '' }) => {
  const body = { app: 'igt', tasks: JOB_TASKS.filter((t) => tasks.includes(t)) };
  if (documents) body.documents = documents;
  if (note.trim()) body.note = note.trim();
  return createOnce(mint, (id) => client.jobs.create(projectId, { ...body, id }));
};

// The project's job that stood in the way of a start (core's 409 `job-active`),
// or null for any other error.
export const activeJobOf = (err) =>
  statusOf(err) === 409 && err.responseData?.code === 'job-active'
    ? (err.responseData.job ?? null)
    : null;
