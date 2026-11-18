// What the first screen of an ended job's page says, by fixed rules from the
// job and its report alone: the one sentence of what the job changed, the
// list of what needs a person, each with the section that lists it, a
// document's reasons to check it, and which sections the page draws. No rule
// here knows what the job filled: a translation, a gloss and a part of speech
// are counted alike.
import { isJobActive } from '@ui/domain/jobs.js';
import { countOf } from '@ui/lib/plural.js';
import { leftText, noticeCounts, oneStep, stoppedPartway } from './jobText.js';
import { blankDocuments, blankSums, draftLexiconsOf, skippedDocuments } from './jobTotals.js';

const sum = (list, f) => list.reduce((n, x) => n + (f(x) ?? 0), 0);

// The report's documents, or the job's own rows where the report has none.
const documentsOf = (job) => job?.report?.documents ?? job?.documents ?? [];

// The facts the headline is made of (`headlineText`).
export const headlineFacts = (job) => {
  const report = job?.report || {};
  const t = report.totals || {};
  const docs = documentsOf(job);
  const harmonize = report.harmonize || {};
  return {
    state: job?.undone ? 'undone' : job?.state,
    sentences: t.sentences ?? 0,
    changes: t.changes ?? sum(docs, (d) => d.counts?.changes),
    changedDocuments: docs.filter((d) => (d.counts?.changes ?? 0) > 0).length,
    documents: (job?.documents ?? docs).length,
    harmonized: (harmonize.changed || []).length + (harmonize.changedMore ?? 0),
    oneStep: docs.some(oneStep),
    findings: typeof report.findings === 'string' && report.findings !== '',
  };
};

const capital = (s) => s.charAt(0).toUpperCase() + s.slice(1);

// The one sentence of what an ended job changed: "Changed 1,354 sentences in
// 129 of 130 documents." Sentences are those the job wrote in, whatever it
// filled. A job that wrote without writing in a sentence (the lexicon, the
// analyses harmonize made consistent) says its changes. A job worked in one
// step says so, a stopped, failed or undone one says how it ended after what
// it changed, and one that changed nothing says that.
export const headlineText = (f) => {
  const where = `${f.changedDocuments.toLocaleString()} of ${countOf(f.documents, 'document')}`;
  let what = null;
  if (f.sentences > 0) what = `changed ${countOf(f.sentences, 'sentence')} in ${where}`;
  else if (f.changes > 0) {
    what = `made ${countOf(f.changes, 'change')}${f.changedDocuments > 0 ? ` in ${where}` : ''}`;
  } else if (f.harmonized > 0) what = `made ${countOf(f.harmonized, 'form')} consistent`;
  if (what && f.oneStep) what += ' in one step';
  const ended = { undone: 'undone', cancelled: 'stopped', failed: 'failed' }[f.state];
  if (what) return `${capital(what)}${ended ? `, then ${ended}` : ''}.`;
  if (f.findings)
    return ended ? `Wrote findings, then ${ended}.` : 'Wrote findings, changed nothing.';
  if (f.state === 'cancelled') return 'Stopped before changing anything.';
  if (f.state === 'failed') return 'Failed before changing anything.';
  return f.state === 'undone' ? 'Undone.' : 'Changed nothing.';
};

export const jobHeadline = (job) => headlineText(headlineFacts(job));

// The sentences skipped, by reason, in the totals' order: each reason's
// count from the totals, or from the documents' lists where the totals hold
// none (core's own report).
const SKIPPED_KINDS = [
  ['too-long', 'skippedTooLong', 'skipped, too long'],
  ['failed', 'skippedFailed', 'skipped, failed'],
  ['changed', 'skippedChanged', 'skipped, changed during the job'],
  ['interrupted', 'skippedInterrupted', 'skipped after an interrupted write'],
  ['no-answer', 'skippedNoAnswer', 'skipped, no answer from the assistant'],
];

const VALUES_PEOPLE_WROTE = ['value, morpheme or link', 'values, morphemes or links'];

// What of an ended job needs a person, a row per kind with a count above
// zero, in a fixed order: `{key, text, view, filter?}`, `view` the section
// that lists the items (`filter` the Documents filter), none where nothing
// lists them.
export const toCheckRows = (job) => {
  const report = job?.report;
  if (!report) return [];
  const t = report.totals || {};
  const docs = documentsOf(job);
  const rows = [];
  const add = (key, n, text, view, filter) =>
    n > 0 && rows.push({ key, text, view, ...(filter ? { filter } : {}) });
  // A row of documents opens the Documents table filtered to its reason.
  const check = (key, n, text) => add(key, n, text, 'documents', key);

  const inUse = docs.filter((d) => d.state === 'in-use').length;
  check('in-use', inUse, `${countOf(inUse, 'document')} in use, not worked`);
  const unfinished = docs.filter((d) => d.state === 'not-reached');
  const partway = unfinished.filter(stoppedPartway).length;
  const notReached = unfinished.length - partway;
  check('not-reached', notReached, `${countOf(notReached, 'document')} not reached`);
  check('partway', partway, `${countOf(partway, 'document')} stopped partway`);

  const listed = docs.flatMap((d) => d.skipped || []);
  SKIPPED_KINDS.forEach(([reason, key, label]) => {
    const n = t[key] ?? listed.filter((s) => s.reason === reason).length;
    add(`skipped-${reason}`, n, `${countOf(n, 'sentence')} ${label}`, 'skipped');
  });
  // Those the worker moved past a document's list, or a report too large for
  // core cut, counted apart from their reason's total (REV-RP-1): the Skipped
  // section counts them as each document's "And N more skipped."
  const notListed = t.skippedMore ?? sum(docs, (d) => d.counts?.skippedMore);
  add(
    'skipped-more',
    notListed,
    `${countOf(notListed, 'sentence')} skipped and not listed`,
    'skipped',
  );

  const inDocuments = (target, key) =>
    docs.filter((d) => (d.counts?.blank || []).some((b) => b.target === target && b[key] > 0))
      .length;
  blankSums(report).forEach((b) => {
    const left = b.left ?? 0;
    add(
      `left-${b.target}`,
      left,
      `${countOf(left, b.unit)} with ${b.target} left blank in sentences the job changed, ` +
        `in ${countOf(inDocuments(b.target, 'left'), 'document')}`,
      'blank',
    );
    add(
      `unsegmented-${b.target}`,
      b.unsegmented ?? 0,
      `${countOf(b.unsegmented ?? 0, 'word')} not segmented, ${b.target} left blank`,
      'blank',
    );
    add(
      `untouched-${b.target}`,
      b.untouched ?? 0,
      `${countOf(b.untouched ?? 0, b.unit)} with ${b.target} blank in sentences the job did not ` +
        `change, in ${countOf(inDocuments(b.target, 'untouched'), 'document')}`,
      'blank',
    );
  });

  const unread = docs.filter((d) => d.leftUnread).length;
  add('unread', unread, `${countOf(unread, 'document')} could not be read`, 'blank');
  const refused = sum(docs, (d) => (d.refused?.length ?? 0) + (d.refusedMore ?? 0));
  add('refused', refused, `${countOf(refused, 'change')} not done, refused`, 'blank');

  const people = noticeCounts(report).peoplesValuesChanged;
  const touched = docs.filter((d) => (d.counts?.peoplesValuesChanged ?? 0) > 0).length;
  check(
    'people',
    people,
    `${countOf(people, ...VALUES_PEOPLE_WROTE)} people wrote, changed or removed, in ` +
      `${countOf(touched, 'document')}`,
  );

  const respelled = (report.respelled?.length ?? 0) + (report.respelledMore ?? 0);
  add(
    'respelled',
    respelled,
    `${countOf(respelled, 'word')} respelled, analysis kept`,
    'respelled',
  );

  const proposed = report.proposed || [];
  const staged = proposed.filter((c) => !c.reason).length + (report.proposedMore ?? 0);
  add('proposed', staged, `${countOf(staged, 'change')} proposed, not applied`, 'proposed');
  const unwritten = proposed.filter((c) => c.reason).length;
  add(
    'unwritten',
    unwritten,
    `${countOf(unwritten, 'change')} not written, the write was interrupted`,
    'proposed',
  );

  const h = report.harmonize || {};
  const inconsistent = (h.left?.length ?? 0) + (h.leftMore ?? 0);
  add(
    'inconsistent',
    inconsistent,
    `${countOf(inconsistent, 'form')} left inconsistent`,
    'inconsistent',
  );
  const e = report.entries || {};
  const unlinked = (e.unlinked?.length ?? 0) + (e.unlinkedMore ?? 0);
  add('unlinked', unlinked, `${countOf(unlinked, 'entry')} with no links`, 'entries');

  if (report.summaryFailed)
    rows.push({ key: 'summary', text: 'The summary could not be written', view: null });
  return rows;
};

// The reasons a document of an ended job needs a person, each a Documents
// filter of its own (`?filter=<kind>`, `check` for all of them), with the
// filter's label.
export const CHECK_KINDS = {
  'in-use': 'In use',
  'not-reached': 'Not reached',
  partway: 'Stopped partway',
  skipped: 'Skipped',
  left: 'Left blank',
  untouched: 'Blank, not changed',
  people: 'People’s values',
  refused: 'Refused',
  unread: 'Not read',
};

// Why one document of an ended job needs a person, each `{kind, text}` in a
// few words, or none: the Documents table's To check column and filters. `d`
// is the job's row, `reported` the report's row of it where there is one.
export const documentChecks = (d, reported = null) => {
  const r = reported ?? d;
  const out = [];
  const add = (kind, text) => out.push({ kind, text });
  if (d.state === 'in-use') add('in-use', 'In use, not worked');
  if (d.state === 'not-reached') {
    if (stoppedPartway(d)) add('partway', 'Stopped partway');
    else add('not-reached', 'Not reached');
  }
  const skipped = (r.skipped?.length ?? 0) + (r.counts?.skippedMore ?? 0);
  if (skipped > 0) add('skipped', `${countOf(skipped, 'sentence')} skipped`);
  const left = leftText(r);
  if (left !== null && left !== '0') add('left', `${left} left blank`);
  (r.counts?.blank || [])
    .filter((b) => b.untouched > 0)
    .forEach((b) =>
      add(
        'untouched',
        `${b.target} blank in ${countOf(b.untouched, b.unit)} the job did not change`,
      ),
    );
  const people = r.counts?.peoplesValuesChanged ?? d.counts?.peoplesValuesChanged ?? 0;
  if (people > 0) add('people', `${countOf(people, ...VALUES_PEOPLE_WROTE)} people wrote, changed`);
  const refused = (r.refused?.length ?? 0) + (r.refusedMore ?? 0);
  if (refused > 0) add('refused', `${countOf(refused, 'change')} refused`);
  if (r.leftUnread) add('unread', 'Could not be read');
  return out;
};

// The page's sections, in order, each `{key, label, count?}`, the `key` its
// `?view=`. An ended job: its Overview, its Documents, its Notes (`notes`,
// the work list's rows, null while not read), each list its report holds with
// something in it, and its Setup. A job still waiting or running: Overview
// (the live work list), Documents and Setup.
export const jobSections = (job, notes = null, vocabs = []) => {
  const docs = job?.documents || [];
  const out = [{ key: 'overview', label: 'Overview' }];
  if (docs.length) out.push({ key: 'documents', label: 'Documents', count: docs.length });
  const report = job?.report;
  if (!isJobActive(job) && report) {
    if (notes > 0) out.push({ key: 'notes', label: 'Notes', count: notes });
    const add = (key, label, count) => count > 0 && out.push({ key, label, count });
    add('blank', 'Left blank', blankDocuments(report).length);
    add(
      'skipped',
      'Skipped',
      sum(skippedDocuments(report), (d) => d.skipped.length + (d.counts?.skippedMore ?? 0)),
    );
    add('proposed', 'Proposed', (report.proposed?.length ?? 0) + (report.proposedMore ?? 0));
    const e = report.entries || {};
    const created = (e.created?.length ?? 0) + (e.createdMore ?? 0);
    const unlinked = (e.unlinked?.length ?? 0) + (e.unlinkedMore ?? 0);
    if (created > 0 || unlinked > 0 || draftLexiconsOf(report, vocabs).length > 0) {
      out.push({ key: 'entries', label: 'Entries', count: created || unlinked || undefined });
    }
    add('respelled', 'Respelled', (report.respelled?.length ?? 0) + (report.respelledMore ?? 0));
    const plan = report.plan || {};
    add('leftout', 'Left out', (plan.leftOut?.length ?? 0) + (plan.leftOutMore ?? 0));
    add('tables', 'Tables', (report.tables?.length ?? 0) + (report.tablesMore ?? 0));
    const h = report.harmonize || {};
    add('consistent', 'Made consistent', (h.changed?.length ?? 0) + (h.changedMore ?? 0));
    add('inconsistent', 'Left inconsistent', (h.left?.length ?? 0) + (h.leftMore ?? 0));
  }
  out.push({ key: 'setup', label: 'Setup' });
  return out;
};
