// An assistant job as the apps show it: a worker run by the operator works
// through a project's documents unattended, a part at a time, in the name of
// the person who started it. Core stores the job and the worker moves
// it on (CONTRACT.md of the jobs round, 2026-11-12). This file holds what every
// app reads of it: how often to ask, the words for the codes core stores, and
// the banner over the document the job is working in.
import { language, msg, t } from '../lib/i18n.js';

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
  if (Number.isNaN(at.getTime())) return t('No worker has reported.');
  // The interface's language, or in English the browser's own conventions.
  const locale = language() === 'en' ? [] : language();
  const when = sameDay(at, new Date(now))
    ? at.toLocaleTimeString(locale, { hour: '2-digit', minute: '2-digit' })
    : at.toLocaleString(locale, { dateStyle: 'medium', timeStyle: 'short' });
  return t('No worker has reported since {when}.', { when });
};

const STATE_WORDS = {
  waiting: msg('Waiting'),
  running: msg('Running'),
  stopping: msg('Stopping…'),
  done: msg('Done'),
  cancelled: msg('Stopped'),
  failed: msg('Failed'),
};

const PHASE_WORDS = {
  checking: msg('Checking'),
  planning: msg('Planning'),
  working: msg('Working'),
  harmonizing: msg('Making analyses consistent'),
  reporting: msg('Writing the report'),
};

const DOCUMENT_STATE_WORDS = {
  waiting: msg('Waiting'),
  working: msg('Working'),
  deferred: msg('Deferred'),
  done: msg('Done'),
  'in-use': msg('In use'),
  gone: msg('Deleted'),
  'not-reached': msg('Not reached'),
};

// A stopped job says so by its state, so `cancelled` has no words here. Each
// says what happened, never what to do about it.
const REASON_WORDS = {
  'starter-access': msg('The person who started it can no longer write in this project.'),
  'guidelines-too-long': msg('The guidelines are too long for a job.'),
  'no-documents': msg('None of its documents are left.'),
  'no-plan': msg('Planning ended with no plan.'),
  'planning-failed': msg('The assistant’s model failed during planning.'),
  'setup-gone': msg('The fields this job was set up to fill are gone.'),
  'setup-unreadable': msg('This job’s setup could not be read.'),
  // The model's provider refused the job's key or model (S1-2).
  'model-refused': msg('The model’s provider refused the job’s calls.'),
  // Core ended it after taking it up again too often (S3-3).
  'worker-lost': msg('Its worker stopped during it ten times.'),
};

/**
 * How a job whose planning kept no plan says so, by its plan's `why`: the
 * model planned nothing it could keep (`no-plan`), the fields its setup names
 * are all gone (`setup-gone`, named as the card named them, from the plan's
 * `gone`, an empty name by its id as the page's setup line shows it), its
 * setup could not be read (`setup-unreadable`), or it failed during planning
 * (any other `why`, the kind of the fault).
 */
export const planEndedText = (plan) => {
  if (plan?.why === 'no-plan') return t('Planning ended with no plan.');
  if (plan?.why === 'setup-gone') {
    const names = (Array.isArray(plan.gone) ? plan.gone : [])
      .map((g) => (typeof g?.name === 'string' && g.name ? g.name : g?.id))
      .filter(Boolean);
    return t('The fields this job was set up to fill are gone: {names}.', {
      names: names.join(', '),
    });
  }
  if (plan?.why === 'setup-unreadable') return t('This job’s setup could not be read.');
  return t('The assistant’s model failed during planning.');
};

const wordFor = (words) => (code) => (words[code] ? t(words[code]) : null);

export const jobStateText = wordFor(STATE_WORDS);
export const jobPhaseText = wordFor(PHASE_WORDS);
export const jobDocumentStateText = wordFor(DOCUMENT_STATE_WORDS);

/** Why a job ended: the worker's own sentence, else the words for its reason. */
export const jobReasonText = (job) =>
  job?.message || (REASON_WORDS[job?.reason] ? t(REASON_WORDS[job.reason]) : null);

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
    label: t('Assistant job'),
    startedAt: Number.isFinite(startedAt) ? startedAt : undefined,
    percent,
    message:
      jobSilentText(job) ??
      (job.state === 'stopping' ? jobStateText(job.state) : (job.message ?? null)),
    paused: false,
    still: !!job.lapsed,
  };
};
