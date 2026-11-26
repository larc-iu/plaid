// What the first screen of an ended job's page says, by fixed rules from the
// job and its report alone: the one sentence of what the job changed, the
// list of what needs a person, each with the section that lists it, a
// document's reasons to check it, and which sections the page draws. No rule
// here knows what the job filled: a translation, a gloss and a part of speech
// are counted alike.
import { isJobActive } from '@ui/domain/jobs.js';
import { msg, t } from '@ui/lib/i18n.js';
import { leftText, noticeCounts, oneStep, stoppedPartway, unitCount } from './jobText.js';
import { blankDocuments, blankSums, draftLexiconsOf, skippedDocuments } from './jobTotals.js';

const sum = (list, f) => list.reduce((n, x) => n + (f(x) ?? 0), 0);

// The report's documents, or the job's own rows where the report has none.
const documentsOf = (job) => job?.report?.documents ?? job?.documents ?? [];

// The worker's `ran_out` values that say the one step itself ended before
// its work was done (CONTRACT, added by RW).
const STEP_UNFINISHED = ['written', 'unchanged', 'not-read'];

// The facts the headline is made of (`headlineText`).
export const headlineFacts = (job) => {
  const report = job?.report || {};
  const totals = report.totals || {};
  const docs = documentsOf(job);
  const harmonize = report.harmonize || {};
  return {
    state: job?.undone ? 'undone' : job?.state,
    sentences: totals.sentences ?? 0,
    changes: totals.changes ?? sum(docs, (d) => d.counts?.changes),
    changedDocuments: docs.filter((d) => (d.counts?.changes ?? 0) > 0).length,
    documents: (job?.documents ?? docs).length,
    harmonized: (harmonize.changed || []).length + (harmonize.changedMore ?? 0),
    oneStep: docs.some(oneStep),
    // The one step ended before its work was done: its documents carry what
    // happened there (the worker's `ran_out`, REV-RW-R2-2), those it never
    // read 'not-read' (the owner's "Say both", 2026-11-18). Only the step's
    // own values: 'put-off' and the others say what followed a step that may
    // have finished (REV-JOIN18-1).
    stepUnfinished:
      docs.some(oneStep) && docs.some((d) => STEP_UNFINISHED.includes(d.counts?.ranOut)),
    notGotTo: docs.filter((d) => d.counts?.ranOut === 'not-read').length,
    findings: typeof report.findings === 'string' && report.findings !== '',
    // History holds changes the job wrote, whatever its report counts: core
    // reads its groups (S3-1).
    wrote: job?.wrote === true,
  };
};

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
  const unfinished =
    f.notGotTo > 0
      ? t(
          'Its one step ended unfinished and did not get to {n, plural, one {# document} other {# documents}}.',
          { n: f.notGotTo },
        )
      : t('Its one step ended unfinished.');
  return `${said} ${unfinished}`;
};

// How an ended job ended, for the headline's selects: `none` for one that
// finished.
const ENDED = { undone: 'undone', cancelled: 'cancelled', failed: 'failed' };

const headlineWhat = (f) => {
  const ended = ENDED[f.state] ?? 'none';
  // A job of one document says it so, never "1 of 1 document".
  const values = {
    single: f.documents === 1 ? 'yes' : 'no',
    changed: f.changedDocuments,
    total: f.documents,
    step: f.oneStep ? 'yes' : 'no',
    ended,
  };
  if (f.sentences > 0) {
    return t(
      'Changed {n, plural, one {# sentence} other {# sentences}} in {single, select, yes {its one document} other {{changed, number} of {total, plural, one {# document} other {# documents}}}}{step, select, yes { in one step} other {}}{ended, select, undone {, then undone} cancelled {, then stopped} failed {, then failed} other {}}.',
      { ...values, n: f.sentences },
    );
  }
  if (f.changes > 0) {
    return f.changedDocuments > 0
      ? t(
          'Made {n, plural, one {# change} other {# changes}} in {single, select, yes {its one document} other {{changed, number} of {total, plural, one {# document} other {# documents}}}}{step, select, yes { in one step} other {}}{ended, select, undone {, then undone} cancelled {, then stopped} failed {, then failed} other {}}.',
          { ...values, n: f.changes },
        )
      : t(
          'Made {n, plural, one {# change} other {# changes}}{step, select, yes { in one step} other {}}{ended, select, undone {, then undone} cancelled {, then stopped} failed {, then failed} other {}}.',
          { ...values, n: f.changes },
        );
  }
  if (f.harmonized > 0) {
    return t(
      'Made {n, plural, one {# form} other {# forms}} consistent{step, select, yes { in one step} other {}}{ended, select, undone {, then undone} cancelled {, then stopped} failed {, then failed} other {}}.',
      { ...values, n: f.harmonized },
    );
  }
  if (f.findings) {
    return ended === 'none'
      ? t('Wrote findings, changed nothing.')
      : t(
          'Wrote findings, then {ended, select, undone {undone} cancelled {stopped} other {failed}}.',
          { ended },
        );
  }
  // Its report counts no change and History holds some: a worker that died
  // after a write and before it recorded it, then a report the server wrote
  // from the rows (S3-1). Only a stopped or failed job: a done job's report
  // is its worker's, which counts what landed (REV-SJ1-14).
  if (f.wrote && f.state === 'cancelled') {
    return t('Stopped after writing changes its report does not count.');
  }
  if (f.wrote && f.state === 'failed') {
    return t('Failed after writing changes its report does not count.');
  }
  if (f.state === 'cancelled') return t('Stopped before changing anything.');
  if (f.state === 'failed') return t('Failed before changing anything.');
  return f.state === 'undone' ? t('Undone.') : t('Changed nothing.');
};

export const jobHeadline = (job) => headlineText(headlineFacts(job));

// The sentences skipped, by reason, in the totals' order: each reason's
// count from the totals, or from the documents' lists where the totals hold
// none (core's own report).
const SKIPPED_KINDS = [
  [
    'too-long',
    'skippedTooLong',
    msg('{n, plural, one {# sentence} other {# sentences}} skipped, too long'),
  ],
  [
    'failed',
    'skippedFailed',
    msg('{n, plural, one {# sentence} other {# sentences}} skipped, failed'),
  ],
  [
    'changed',
    'skippedChanged',
    msg('{n, plural, one {# sentence} other {# sentences}} skipped, changed during the job'),
  ],
  [
    'interrupted',
    'skippedInterrupted',
    msg('{n, plural, one {# sentence} other {# sentences}} skipped after an interrupted write'),
  ],
  [
    'no-answer',
    'skippedNoAnswer',
    msg('{n, plural, one {# sentence} other {# sentences}} skipped, no answer from the assistant'),
  ],
];

// A document the job never began, with why by the job's state: a person
// stopped the job, or it failed. Its reason stands at the top of the page.
const NOT_REACHED_WHY = {
  cancelled: msg('Not reached: the job was stopped'),
  failed: msg('Not reached: the job failed'),
};
export const notReachedText = (job) =>
  NOT_REACHED_WHY[job?.state] ? t(NOT_REACHED_WHY[job.state]) : t('Not reached');

// A count of blanks of one kind, the sentence said once where the blank is a
// sentence's, and how many documents hold them: "6 words with Gloss left
// blank in sentences the job changed, in 2 documents", "192 sentences the job
// did not change with Translation blank, in 3 documents".
const blankSaid = (n, unit, target, changed, docs) => {
  if (unit === 'sentence') {
    return changed
      ? t(
          '{n, plural, one {# sentence} other {# sentences}} the job changed with {target} left blank, in {docs, plural, one {# document} other {# documents}}',
          { n, target, docs },
        )
      : t(
          '{n, plural, one {# sentence} other {# sentences}} the job did not change with {target} blank, in {docs, plural, one {# document} other {# documents}}',
          { n, target, docs },
        );
  }
  const places = unitCount(n, unit);
  return changed
    ? t(
        '{places} with {target} left blank in sentences the job changed, in {docs, plural, one {# document} other {# documents}}',
        { places, target, docs },
      )
    : t(
        '{places} with {target} blank in sentences the job did not change, in {docs, plural, one {# document} other {# documents}}',
        { places, target, docs },
      );
};

// What of an ended job needs a person, a row per kind with a count above
// zero, in a fixed order (the documents' states from the job's own rows where
// it has no report): `{key, text, view, filter?}`, `view` the section
// that lists the items (`filter` the Documents filter), none where nothing
// lists them.
export const toCheckRows = (job) => {
  const report = job?.report;
  const totals = report?.totals || {};
  const docs = documentsOf(job);
  const rows = [];
  const add = (key, n, text, view, filter) =>
    n > 0 && rows.push({ key, text, view, ...(filter ? { filter } : {}) });
  // A row of documents opens the Documents table filtered to its reason.
  const check = (key, n, text) => add(key, n, text, 'documents', key);

  const inUse = docs.filter((d) => d.state === 'in-use').length;
  check(
    'in-use',
    inUse,
    t('{n, plural, one {# document} other {# documents}} in use, not worked', { n: inUse }),
  );
  // The plan's left-out documents and those the server never answered for
  // are not "not reached" (D22, REV-JR2-3).
  const leftIds = new Set((report?.plan?.leftOut || []).map((d) => d.documentId));
  const unanswered = docs.filter((d) => d.state === 'not-reached' && d.counts?.unanswered === true);
  const unfinished = docs.filter(
    (d) => d.state === 'not-reached' && !leftIds.has(d.documentId) && d.counts?.unanswered !== true,
  );
  const partway = unfinished.filter(stoppedPartway).length;
  // Those left out past the plan's cut list have no id here: taken off as
  // documentCounts takes them (REV-JOIN18-2).
  const notReached = Math.max(0, unfinished.length - partway - (report?.plan?.leftOutMore ?? 0));
  check(
    'not-reached',
    notReached,
    t(
      '{n, plural, one {# document} other {# documents}} not reached{why, select, cancelled {: the job was stopped} failed {: the job failed} other {}}',
      { n: notReached, why: job?.state ?? 'none' },
    ),
  );
  check(
    'partway',
    partway,
    t('{n, plural, one {# document} other {# documents}} stopped partway', { n: partway }),
  );
  check(
    'unanswered',
    unanswered.length,
    t('{n, plural, one {# document} other {# documents}} not worked: the server did not answer', {
      n: unanswered.length,
    }),
  );
  // An ended job core failed before its worker's report arrived has only its
  // documents' rows: nothing else is known (REV-RP-4).
  if (!report) return rows;

  // The documents the plan chose not to work, of those the person chose.
  const plan = report.plan || {};
  const leftOut = (plan.leftOut?.length ?? 0) + (plan.leftOutMore ?? 0);
  add(
    'leftout',
    leftOut,
    t('{n, plural, one {# document} other {# documents}} left out by the plan', { n: leftOut }),
    'leftout',
  );

  const listed = docs.flatMap((d) => d.skipped || []);
  SKIPPED_KINDS.forEach(([reason, key, message]) => {
    const n = totals[key] ?? listed.filter((s) => s.reason === reason).length;
    add(`skipped-${reason}`, n, t(message, { n }), 'skipped');
  });
  // Those the worker moved past a document's list, or a report too large for
  // core cut, counted apart from their reason's total (REV-RP-1): the Skipped
  // section counts them as each document's "And N more skipped."
  const notListed = totals.skippedMore ?? sum(docs, (d) => d.counts?.skippedMore);
  add(
    'skipped-more',
    notListed,
    t('{n, plural, one {# sentence} other {# sentences}} skipped and not listed', {
      n: notListed,
    }),
    'skipped',
  );
  // Too long for a job, past a document's list (D11).
  const tooLongNotListed = totals.tooLongMore ?? sum(docs, (d) => d.counts?.tooLongMore);
  add(
    'too-long-more',
    tooLongNotListed,
    t('{n, plural, one {# sentence} other {# sentences}} too long and not listed', {
      n: tooLongNotListed,
    }),
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
      blankSaid(left, b.unit, b.target, true, inDocuments(b.target, 'left')),
      'blank',
    );
    add(
      `unsegmented-${b.target}`,
      b.unsegmented ?? 0,
      t('{n, plural, one {# word} other {# words}} not segmented, {target} left blank', {
        n: b.unsegmented ?? 0,
        target: b.target,
      }),
      'blank',
    );
    add(
      `untouched-${b.target}`,
      b.untouched ?? 0,
      blankSaid(b.untouched ?? 0, b.unit, b.target, false, inDocuments(b.target, 'untouched')),
      'blank',
    );
  });

  const unread = docs.filter((d) => d.leftUnread).length;
  add(
    'unread',
    unread,
    t('{n, plural, one {# document} other {# documents}} could not be read', { n: unread }),
    'blank',
  );
  const refused = sum(docs, (d) => (d.refused?.length ?? 0) + (d.refusedMore ?? 0));
  add(
    'refused',
    refused,
    t('{n, plural, one {# change} other {# changes}} not done, refused', { n: refused }),
    'blank',
  );

  // People's links a lexicon change took or moved outside the job's documents
  // are in no row of its own (REV-SJ3-R2-3): said apart, never as one of the
  // job's documents.
  const { peoplesValuesChanged: people, peoplesOutside: outside } = noticeCounts(report);
  const touched = docs.filter((d) => (d.counts?.peoplesValuesChanged ?? 0) > 0).length;
  const elsewhere = Math.min(outside, people);
  check(
    'people',
    people,
    elsewhere === 0
      ? t(
          '{n, plural, one {# value, morpheme or link} other {# values, morphemes or links}} people wrote that the job changed or removed, in {docs, plural, one {# document} other {# documents}}',
          { n: people, docs: touched },
        )
      : elsewhere === people
        ? t(
            "{n, plural, one {# value, morpheme or link} other {# values, morphemes or links}} people wrote that the job changed or removed, outside the job's documents",
            { n: people },
          )
        : t(
            "{n, plural, one {# value, morpheme or link} other {# values, morphemes or links}} people wrote that the job changed or removed, {inside, number} in {docs, plural, one {# document} other {# documents}} and {elsewhere, number} outside the job's documents",
            { n: people, inside: people - elsewhere, docs: touched, elsewhere },
          ),
  );

  // The text the job edited, which its notice says (R4). Values written
  // outside the setup and changes not written as edited during the job stay
  // totals rows, as the old page had them.
  const texted = docs.filter((d) => (d.counts?.textChanges ?? 0) > 0).length;
  check(
    'text',
    texted,
    t('{n, plural, one {# document} other {# documents}} with text the job changed', {
      n: texted,
    }),
  );

  const respelled = (report.respelled?.length ?? 0) + (report.respelledMore ?? 0);
  add(
    'respelled',
    respelled,
    t('{n, plural, one {# word} other {# words}} respelled, analysis kept', { n: respelled }),
    'respelled',
  );

  const proposed = report.proposed || [];
  const staged = proposed.filter((c) => !c.reason).length + (report.proposedMore ?? 0);
  add(
    'proposed',
    staged,
    t('{n, plural, one {# change} other {# changes}} proposed, not applied', { n: staged }),
    'proposed',
  );
  const unwritten = proposed.filter((c) => c.reason).length;
  add(
    'unwritten',
    unwritten,
    t('{n, plural, one {# change} other {# changes}} not written, the write was interrupted', {
      n: unwritten,
    }),
    'proposed',
  );

  const h = report.harmonize || {};
  const inconsistent = (h.left?.length ?? 0) + (h.leftMore ?? 0);
  add(
    'inconsistent',
    inconsistent,
    t('{n, plural, one {# form} other {# forms}} left inconsistent', { n: inconsistent }),
    'inconsistent',
  );
  const e = report.entries || {};
  const unlinked = (e.unlinked?.length ?? 0) + (e.unlinkedMore ?? 0);
  add(
    'unlinked',
    unlinked,
    t('{n, plural, one {# entry} other {# entries}} with no links', { n: unlinked }),
    'entries',
  );

  if (report.summaryFailed)
    rows.push({ key: 'summary', text: t('The summary could not be written'), view: null });
  return rows;
};

// The reasons a document of an ended job needs a person, each a Documents
// filter of its own (`?filter=<kind>`, `check` for all of them), with the
// filter's label.
export const CHECK_KINDS = {
  'in-use': msg('In use'),
  'not-reached': msg('Not reached'),
  partway: msg('Stopped partway'),
  unanswered: msg('Server did not answer'),
  skipped: msg('Skipped'),
  left: msg('Left blank'),
  untouched: msg('Not changed'),
  people: msg('People’s values'),
  refused: msg('Refused'),
  unread: msg('Could not be read'),
  text: msg('Text changed'),
};

// Why one document of an ended job needs a person, each `{kind, text}` in a
// few words, or none: the Documents table's To check column and filters. `d`
// is the job's row, `reported` the report's row of it where there is one,
// `job` the job, whose state says why a document was not reached.
export const documentChecks = (d, reported = null, leftOut = new Set(), job = null) => {
  const r = reported ?? d;
  const out = [];
  const add = (kind, text) => out.push({ kind, text });
  if (d.state === 'in-use') add('in-use', t('In use, not worked'));
  // `leftOut`: the plan's left-out document ids, never "not reached" (D22).
  if (d.state === 'not-reached' && !leftOut.has(d.documentId)) {
    if (d.counts?.unanswered === true) {
      add('unanswered', t('Not worked: the server did not answer'));
    } else if (stoppedPartway(d)) add('partway', t('Stopped partway'));
    else add('not-reached', notReachedText(job));
  }
  const skipped =
    (r.skipped?.length ?? 0) + (r.counts?.skippedMore ?? 0) + (r.counts?.tooLongMore ?? 0);
  if (skipped > 0) {
    add('skipped', t('{n, plural, one {# sentence} other {# sentences}} skipped', { n: skipped }));
  }
  const left = leftText(r);
  if (left !== null && left !== '0') add('left', t('{places} left blank', { places: left }));
  (r.counts?.blank || [])
    .filter((b) => b.untouched > 0)
    .forEach((b) =>
      add(
        'untouched',
        t('{target} blank in {places} the job did not change', {
          target: b.target,
          places: unitCount(b.untouched, b.unit),
        }),
      ),
    );
  const people = r.counts?.peoplesValuesChanged ?? d.counts?.peoplesValuesChanged ?? 0;
  if (people > 0) {
    add(
      'people',
      t(
        '{n, plural, one {# value, morpheme or link} other {# values, morphemes or links}} people wrote that the job changed',
        { n: people },
      ),
    );
  }
  const refused = (r.refused?.length ?? 0) + (r.refusedMore ?? 0);
  if (refused > 0) {
    add('refused', t('{n, plural, one {# change} other {# changes}} refused', { n: refused }));
  }
  if (r.leftUnread) add('unread', t('Could not be read'));
  const texted = r.counts?.textChanges ?? d.counts?.textChanges ?? 0;
  if (texted > 0) {
    add('text', t('{n, plural, one {# text edit} other {# text edits}}', { n: texted }));
  }
  return out;
};

// The page's sections, in order, each `{key, label, count?}`, the `key` its
// `?view=`. An ended job: its Overview, its Documents, its Notes (`notes`,
// the work list's rows, null while not read), each list its report holds with
// something in it, and its Setup. A job still waiting or running: Overview
// (the live work list), Documents and Setup.
export const jobSections = (job, notes = null, vocabs = []) => {
  const docs = job?.documents || [];
  const out = [{ key: 'overview', label: t('Overview') }];
  if (docs.length) out.push({ key: 'documents', label: t('Documents'), count: docs.length });
  const report = job?.report;
  if (!isJobActive(job) && notes > 0) {
    out.push({ key: 'notes', label: t('Notes'), count: notes });
  }
  if (!isJobActive(job) && report) {
    const add = (key, label, count) => count > 0 && out.push({ key, label, count });
    // Blank places come in two kinds (left blank in sentences the job
    // changed, blank in those it did not) and in several units: no one count
    // is true of them, so the tab has none (REV-RP-3).
    if (blankDocuments(report).length) out.push({ key: 'blank', label: t('Blank') });
    add(
      'skipped',
      t('Skipped'),
      sum(
        skippedDocuments(report),
        (d) =>
          (d.skipped?.length ?? 0) + (d.counts?.skippedMore ?? 0) + (d.counts?.tooLongMore ?? 0),
      ),
    );
    add('proposed', t('Proposed'), (report.proposed?.length ?? 0) + (report.proposedMore ?? 0));
    const e = report.entries || {};
    const created = (e.created?.length ?? 0) + (e.createdMore ?? 0);
    const unlinked = (e.unlinked?.length ?? 0) + (e.unlinkedMore ?? 0);
    if (created > 0 || unlinked > 0 || draftLexiconsOf(report, vocabs).length > 0) {
      out.push({ key: 'entries', label: t('Entries'), count: created || unlinked || undefined });
    }
    add('respelled', t('Respelled'), (report.respelled?.length ?? 0) + (report.respelledMore ?? 0));
    const plan = report.plan || {};
    add('leftout', t('Left out'), (plan.leftOut?.length ?? 0) + (plan.leftOutMore ?? 0));
    add('tables', t('Tables'), (report.tables?.length ?? 0) + (report.tablesMore ?? 0));
    const h = report.harmonize || {};
    add('consistent', t('Made consistent'), (h.changed?.length ?? 0) + (h.changedMore ?? 0));
    add('inconsistent', t('Left inconsistent'), (h.left?.length ?? 0) + (h.leftMore ?? 0));
  }
  out.push({ key: 'setup', label: t('Setup') });
  return out;
};
