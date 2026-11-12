// An assistant job as the apps show it: a worker run by the operator glosses
// a project's documents unattended, one stretch of sentences at a time, in the
// name of the person who started it. Core stores the job and the worker moves
// it on (CONTRACT.md of the jobs round, 2026-11-12). This file holds what every
// app reads of it: how often to ask, the words for the codes core stores, and
// the banner over the document the job is working in.

/** A worker that asked for work within this long is running. */
export const JOB_WORKER_SEEN_S = 120;
/** How often the job page reads its job while it is active. */
export const JOB_POLL_MS = 5000;
/** How often an open document reads its project's active job. */
export const JOB_ACTIVE_POLL_MS = 15000;

const ACTIVE = new Set(['waiting', 'running', 'stopping']);
// The states in which a worker holds the job and may be writing.
const WORKING = new Set(['running', 'stopping']);

export const isJobActive = (job) => ACTIVE.has(job?.state);

/**
 * Whether Stop is offered (to whoever may stop it, `canStopJob`): while the job
 * waits or runs. Once Stop was asked (`stopping`) it is offered again only when
 * the worker has gone silent (`lapsed`), as core then ends the job at once.
 */
export const jobStoppable = (job) =>
  job?.state === 'waiting' ||
  job?.state === 'running' ||
  (job?.state === 'stopping' && !!job.lapsed);

const sameDay = (a, b) => a.toDateString() === b.toDateString();

/**
 * For a job whose worker sent no heartbeat within its lease (core's `lapsed`,
 * true only while it runs or stops), when it last did, in the viewer's time:
 * "No worker has reported since 14:05.", with the date when it was not today.
 * Null for any other job.
 */
export const jobSilentText = (job, now = Date.now()) => {
  if (!job?.lapsed) return null;
  const at = new Date(job.heartbeatAt ?? '');
  if (Number.isNaN(at.getTime())) return 'No worker has reported.';
  const when = sameDay(at, new Date(now))
    ? at.toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' })
    : at.toLocaleString([], { dateStyle: 'medium', timeStyle: 'short' });
  return `No worker has reported since ${when}.`;
};

const STATE_WORDS = {
  waiting: 'Waiting',
  running: 'Running',
  stopping: 'Stopping…',
  done: 'Done',
  cancelled: 'Stopped',
  failed: 'Failed',
};

const PHASE_WORDS = {
  checking: 'Checking',
  glossing: 'Analyzing',
  harmonizing: 'Making analyses consistent',
  reporting: 'Writing the report',
};

const DOCUMENT_STATE_WORDS = {
  waiting: 'Waiting',
  working: 'Working',
  deferred: 'Deferred',
  done: 'Done',
  'in-use': 'In use',
  gone: 'Deleted',
  'not-reached': 'Not reached',
};

// As the start dialog's checkboxes name them.
const TASK_WORDS = {
  translate: 'Translate',
  gloss: 'Segment and gloss',
  link: 'Link to lexicon',
};

// A stopped job says so by its state, so `cancelled` has no words here.
const REASON_WORDS = {
  'starter-access': 'The person who started it can no longer write in this project.',
  'missing-field': 'The project has no field for this task.',
  'no-lexicon': 'The project has no lexicon.',
  'no-status-field': 'A lexicon has no Status field.',
  'guidelines-too-long': 'The guidelines are too long for a job.',
  'no-documents': 'None of its documents are left.',
};

const wordFor = (words) => (code) => words[code] ?? null;

export const jobStateText = wordFor(STATE_WORDS);
export const jobPhaseText = wordFor(PHASE_WORDS);
export const jobDocumentStateText = wordFor(DOCUMENT_STATE_WORDS);
export const jobTaskText = wordFor(TASK_WORDS);

/** Why a job ended: the worker's own sentence, else the words for its reason. */
export const jobReasonText = (job) => job?.message || REASON_WORDS[job?.reason] || null;

/** Whether a worker asked for work recently (`worker` is `jobs.worker()`'s answer). */
export const workerSeen = (worker, now = Date.now()) => {
  const seen = Date.parse(worker?.seenAt ?? '');
  return Number.isFinite(seen) && now - seen <= JOB_WORKER_SEEN_S * 1000;
};

/**
 * The RunBanner props for `documentId` while `job` works in it, or null. The
 * percent is of the document's target sentences done, null (the bar pulses)
 * while they are not counted yet or there are none. The banner says nothing
 * about editing: a job holds no write lock, and the document stays editable.
 * Once Stop was asked, its line is the state's word in place of the worker's.
 * A job whose worker has gone silent says so in its place, and the banner's
 * icon stops turning (`still`).
 */
export const bannerProps = (job, documentId) => {
  if (!WORKING.has(job?.state) || !documentId || job.currentDocument !== documentId) return null;
  const row = job.documents?.find((d) => d.documentId === documentId);
  const percent = row?.targets ? Math.round((100 * (row.done ?? 0)) / row.targets) : null;
  const startedAt = Date.parse(job.startedAt ?? '');
  return {
    label: 'Assistant job',
    startedAt: Number.isFinite(startedAt) ? startedAt : undefined,
    percent,
    message:
      jobSilentText(job) ??
      (job.state === 'stopping' ? jobStateText(job.state) : (job.message ?? null)),
    paused: false,
    still: !!job.lapsed,
  };
};
