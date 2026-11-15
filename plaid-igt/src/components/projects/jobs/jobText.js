// The igt job screens' words for what a job reports: how its work was cut, a
// skipped sentence, a harmonize decision, a proposed change. The words for a
// job's codes (its state, phase, reason, a document's state) are plaid-ui's
// (domain/jobs.js), since every app says them. Also how a job is started,
// shared by the Start job dialog and the assistant's job card.
import { createOnce } from '@ui/lib/createOnce.js';
import { statusOf } from '@ui/lib/errors.js';
import { plural } from '@ui/lib/plural.js';

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
// JG, JH and EW): "Worked in stretches of sentences, only those with something
// empty, 2 in smaller pieces."
const PIECES_TEXT = {
  sentences: 'Worked in stretches of sentences',
  document: 'Worked one document at a time',
  selection: 'Worked on all the documents at once',
};

// The default plan, when planning ended with none: stretches of every sentence.
const DEFAULT_PLAN_TEXT =
  'Planning ended with no plan. Worked by the default plan, in stretches of sentences';

export const planText = (plan) => {
  if (!plan) return null;
  let text = PIECES_TEXT[plan.pieces] ?? plan.pieces;
  if (plan.by === 'default') text = DEFAULT_PLAN_TEXT;
  if (plan.pieces === 'sentences' && plan.onlyEmpty) text += ', only those with something empty';
  const smaller = (plan.fallback || []).length;
  if (smaller) text += `, ${smaller.toLocaleString()} in smaller pieces`;
  text += '.';
  // What the plan fills, by the names the report gives (REV-DF-D-1).
  if (Array.isArray(plan.fillsNames)) {
    text += plan.fillsNames.length ? ` Fills: ${plan.fillsNames.join(', ')}.` : ' Fills nothing.';
  }
  // The plan says the instructions ask for the text itself to change
  // (plan_work's edits_text): only then may the job edit it.
  return plan.editsText ? `${text} Text edits allowed.` : text;
};

// The History entry of the job's work in a document, where it wrote
// something there: the worker names the group before its first write, so a
// group with no change opens nothing (REV-DF-S-5).
export const changesGroup = (d) => ((d?.counts?.changes ?? 0) > 0 ? d.glossGroup : null);

// A document of the job the worker did not finish: never reached, or
// stopped partway once it finished a sentence (REV-DAY-P-13).
export const stoppedPartway = (d) => d.state === 'not-reached' && (d.done ?? 0) > 0;

// How many places a document's Left blank lists, by unit, those cut from the
// list included ("4 words, 1 sentence", REV-DF-S N-2), or null when nothing
// was counted there: a job that fills nothing, a document deleted, one that
// could not be read, one the job never reached, core's own report
// (REV-DF-S-2).
export const leftText = (d) => {
  if (!d?.counts?.blank || d.leftUnread || (d.state === 'not-reached' && !(d.done > 0)))
    return null;
  const units = d.counts.leftUnits || [];
  if (!units.length) return '0';
  return units.map((u) => `${u.left.toLocaleString()} ${plural(u.left, u.unit)}`).join(', ');
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
  // The piece's model answered twice with nothing staged and nothing said.
  if (reason === 'no-answer') return 'No answer from the assistant';
  if (reason === 'failed') return FAILURE_TEXT[kind] ? `Failed: ${FAILURE_TEXT[kind]}` : 'Failed';
  return reason;
};

// What a refusal the job could not follow left a sentence for, by the code
// the refusal carries (a closed set, never its text): the label a person
// reads under "Not done, refused:" (REV-DF-S-4).
const REFUSED_TEXT = {
  text: 'Words changed by the job',
  lexicon: 'Lexicon entry changed by the job',
  expression: 'In a multi-word expression the job made',
};
export const refusedText = (code) => REFUSED_TEXT[code] ?? 'Refused';

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
