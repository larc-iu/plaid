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
    // The one step ended before its work was done: its documents carry what
    // happened there (the worker's `ran_out`, REV-RW-R2-2), those it never
    // read 'not-read' (the owner's "Say both", 2026-11-18).
    stepUnfinished: docs.some(oneStep) && docs.some((d) => d.counts?.ranOut),
    notGotTo: docs.filter((d) => d.counts?.ranOut === 'not-read').length,
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
  const said = headlineWhat(f);
  // A job worked in one step that ended unfinished says so after what it
  // changed, and how many documents the step did not get to.
  if (!f.stepUnfinished) return said;
  const notGot = f.notGotTo > 0 ? ` and did not get to ${countOf(f.notGotTo, 'document')}` : '';
  return `${said} Its one step ended unfinished${notGot}.`;
};

const headlineWhat = (f) => {
  // A job of one document says it so, never "1 of 1 document".
  const where =
    f.documents === 1
      ? 'its one document'
      : `${f.changedDocuments.toLocaleString()} of ${countOf(f.documents, 'document')}`;
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

// A count of blanks of one kind, the sentence said once where the blank is a
// sentence's: "6 words with Gloss left blank in sentences the job changed",
// "192 sentences the job did not change with Translation blank".
const blankSaid = (n, unit, target, blank, changed) =>
  unit === 'sentence'
    ? `${countOf(n, 'sentence')} the job ${changed} with ${target} ${blank}`
    : `${countOf(n, unit)} with ${target} ${blank} in sentences the job ${changed}`;

// What of an ended job needs a person, a row per kind with a count above
// zero, in a fixed order (the documents' states from the job's own rows where
// it has no report): `{key, text, view, filter?}`, `view` the section
// that lists the items (`filter` the Documents filter), none where nothing
// lists them.
export const toCheckRows = (job) => {
  const report = job?.report;
  const t = report?.totals || {};
  const docs = documentsOf(job);
  const rows = [];
  const add = (key, n, text, view, filter) =>
    n > 0 && rows.push({ key, text, view, ...(filter ? { filter } : {}) });
  // A row of documents opens the Documents table filtered to its reason.
  const check = (key, n, text) => add(key, n, text, 'documents', key);

  const inUse = docs.filter((d) => d.state === 'in-use').length;
  check('in-use', inUse, `${countOf(inUse, 'document')} in use, not worked`);
  // The plan's left-out documents and those the server never answered for
  // are not "not reached" (D22, REV-JR2-3).
  const leftIds = new Set((report?.plan?.leftOut || []).map((d) => d.documentId));
  const unanswered = docs.filter((d) => d.state === 'not-reached' && d.counts?.unanswered === true);
  const unfinished = docs.filter(
    (d) => d.state === 'not-reached' && !leftIds.has(d.documentId) && d.counts?.unanswered !== true,
  );
  const partway = unfinished.filter(stoppedPartway).length;
  const notReached = unfinished.length - partway;
  check('not-reached', notReached, `${countOf(notReached, 'document')} not reached`);
  check('partway', partway, `${countOf(partway, 'document')} stopped partway`);
  check(
    'unanswered',
    unanswered.length,
    `${countOf(unanswered.length, 'document')} not worked: the server did not answer`,
  );
  // An ended job core failed before its worker's report arrived has only its
  // documents' rows: nothing else is known (REV-RP-4).
  if (!report) return rows;

  // The documents the plan chose not to work, of those the person chose.
  const plan = report.plan || {};
  const leftOut = (plan.leftOut?.length ?? 0) + (plan.leftOutMore ?? 0);
  add('leftout', leftOut, `${countOf(leftOut, 'document')} left out by the plan`, 'leftout');

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
  // Too long for a job, past a document's list (D11).
  const tooLongNotListed = t.tooLongMore ?? sum(docs, (d) => d.counts?.tooLongMore);
  add(
    'too-long-more',
    tooLongNotListed,
    `${countOf(tooLongNotListed, 'sentence')} too long and not listed`,
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
      `${blankSaid(left, b.unit, b.target, 'left blank', 'changed')}, ` +
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
      `${blankSaid(b.untouched ?? 0, b.unit, b.target, 'blank', 'did not change')}, ` +
        `in ${countOf(inDocuments(b.target, 'untouched'), 'document')}`,
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
    `${countOf(people, ...VALUES_PEOPLE_WROTE)} people wrote that the job changed or removed, in ` +
      `${countOf(touched, 'document')}`,
  );

  // The text the job edited, which its notice says (R4). Values written
  // outside the setup and changes not written as edited during the job stay
  // totals rows, as the old page had them.
  const texted = docs.filter((d) => (d.counts?.textChanges ?? 0) > 0).length;
  check('text', texted, `${countOf(texted, 'document')} with text the job changed`);

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
  unanswered: 'Server did not answer',
  skipped: 'Skipped',
  left: 'Left blank',
  untouched: 'Not changed',
  people: 'People’s values',
  refused: 'Refused',
  unread: 'Could not be read',
  text: 'Text changed',
};

// Why one document of an ended job needs a person, each `{kind, text}` in a
// few words, or none: the Documents table's To check column and filters. `d`
// is the job's row, `reported` the report's row of it where there is one.
export const documentChecks = (d, reported = null, leftOut = new Set()) => {
  const r = reported ?? d;
  const out = [];
  const add = (kind, text) => out.push({ kind, text });
  if (d.state === 'in-use') add('in-use', 'In use, not worked');
  // `leftOut`: the plan's left-out document ids, never "not reached" (D22).
  if (d.state === 'not-reached' && !leftOut.has(d.documentId)) {
    if (d.counts?.unanswered === true) add('unanswered', 'Not worked: the server did not answer');
    else if (stoppedPartway(d)) add('partway', 'Stopped partway');
    else add('not-reached', 'Not reached');
  }
  const skipped =
    (r.skipped?.length ?? 0) + (r.counts?.skippedMore ?? 0) + (r.counts?.tooLongMore ?? 0);
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
  if (people > 0) {
    add('people', `${countOf(people, ...VALUES_PEOPLE_WROTE)} people wrote that the job changed`);
  }
  const refused = (r.refused?.length ?? 0) + (r.refusedMore ?? 0);
  if (refused > 0) add('refused', `${countOf(refused, 'change')} refused`);
  if (r.leftUnread) add('unread', 'Could not be read');
  const texted = r.counts?.textChanges ?? d.counts?.textChanges ?? 0;
  if (texted > 0) add('text', `${countOf(texted, 'text edit')}`);
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
  if (!isJobActive(job) && notes > 0) out.push({ key: 'notes', label: 'Notes', count: notes });
  if (!isJobActive(job) && report) {
    const add = (key, label, count) => count > 0 && out.push({ key, label, count });
    // Blank places come in two kinds (left blank in sentences the job
    // changed, blank in those it did not) and in several units: no one count
    // is true of them, so the tab has none (REV-RP-3).
    if (blankDocuments(report).length) out.push({ key: 'blank', label: 'Blank' });
    add(
      'skipped',
      'Skipped',
      sum(
        skippedDocuments(report),
        (d) =>
          (d.skipped?.length ?? 0) + (d.counts?.skippedMore ?? 0) + (d.counts?.tooLongMore ?? 0),
      ),
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
