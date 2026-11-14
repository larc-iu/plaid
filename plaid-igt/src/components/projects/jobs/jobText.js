// The igt job screens' words for what a job reports: how its work was cut, a
// skipped sentence, a harmonize decision, a proposed change. The words for a
// job's codes (its state, phase, reason, a document's state) are plaid-ui's
// (domain/jobs.js), since every app says them. Also how a job is started,
// shared by the Start job dialog and the assistant's job card.
import { createOnce } from '@ui/lib/createOnce.js';
import { statusOf } from '@ui/lib/errors.js';

// Instructions a job can start from, which fill the Start job dialog's box
// and can be edited there. Plain text: nothing knows them once the job is
// started.
export const STARTER_TEXTS = [
  {
    label: 'Translate',
    text: 'Write a free translation of every sentence whose translation is empty.',
  },
  {
    label: 'Segment and gloss',
    text: 'Segment and gloss every word nobody has analyzed. Follow how people in the project analyzed the same forms.',
  },
  {
    label: 'Segment, gloss and link',
    text: 'Segment and gloss every word nobody has analyzed, and link each morpheme to its lexicon entry, making an entry where none fits. Follow how people in the project analyzed the same forms.',
  },
];

// How a job's work was cut, in one line, from its plan (CONTRACT, added by
// JG and JH): "Worked in stretches of sentences, every sentence, 2 documents
// in smaller pieces."
const PIECES_TEXT = {
  sentences: 'Worked in stretches of sentences',
  document: 'Worked one document at a time',
  selection: 'Worked on all the documents at once',
};

export const planText = (plan) => {
  if (!plan) return null;
  let text = PIECES_TEXT[plan.pieces] ?? plan.pieces;
  if (plan.pieces === 'sentences' && plan.everySentence) text += ', every sentence';
  if (plan.by === 'default') text += ', as planning gave no plan';
  const smaller = (plan.fallback || []).length;
  if (smaller) text += `, ${smaller.toLocaleString()} in smaller pieces`;
  return `${text}.`;
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
  if (reason === 'interrupted') return 'Write interrupted';
  if (reason === 'failed') return FAILURE_TEXT[kind] ? `Failed: ${FAILURE_TEXT[kind]}` : 'Failed';
  return reason;
};

// Why a change the job applied is listed among the proposed changes: its
// write was cut short (a lost answer, a crash, a refusal) and it was not
// written. The one reason there is.
export const changeReasonText = (reason) =>
  reason === 'interrupted' ? 'Not written, the write was interrupted' : reason;

export const HARMONIZE_LEFT_TEXT = {
  'people-differ': 'People analyzed it in more than one way',
  'no-clear-majority': 'No two-thirds majority',
  'in-use': 'Document in use',
  touched: 'Changed since the job wrote it',
  unvouched: 'Not checked',
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

// What the assistant panel calls a job, on the messages asked from its page
// and in the conversation list: when it was started, by the reader's clock.
// "Job of Nov 13, 2026, 3:10 AM".
export const jobName = (job) =>
  `Job of ${new Date(job.createdAt).toLocaleString(undefined, { dateStyle: 'medium', timeStyle: 'short' })}`;

// Where a job's page is.
export const jobPath = (projectId, jobId) => `/projects/${projectId}/jobs/${jobId}`;
export const jobsTabPath = (projectId) => `/projects/${projectId}?tab=jobs`;

// Instructions' length as core counts it: in characters, never UTF-16 units.
export const instructionsLength = (text) => [...text].length;

// Start a job as the signed-in user: the one client call, under the id `mint`
// holds (createOnce.js: a press again after a lost answer makes no second
// job). `documents` null is every document of the project. Resolves to the job.
export const startJob = (client, projectId, mint, { documents = null, instructions = '' }) => {
  const body = { app: 'igt', instructions: instructions.trim() };
  if (documents) body.documents = documents;
  return createOnce(mint, (id) => client.jobs.create(projectId, { ...body, id }));
};

// The project's job that stood in the way of a start (core's 409 `job-active`),
// or null for any other error.
export const activeJobOf = (err) =>
  statusOf(err) === 409 && err.responseData?.code === 'job-active'
    ? (err.responseData.job ?? null)
    : null;
