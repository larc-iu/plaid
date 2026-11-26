// The igt job screens' words for what a job reports: how its work was cut, a
// skipped sentence, a harmonize decision, a proposed change. The words for a
// job's codes (its state, phase, reason, a document's state) are plaid-ui's
// (domain/jobs.js), since every app says them. Also how a job is started,
// shared by the Start job dialog and the assistant's job card.
import { isJobActive, planEndedText } from '@ui/domain/jobs.js';
import { createOnce } from '@ui/lib/createOnce.js';
import { statusOf } from '@ui/lib/errors.js';
import { listOf, msg, t } from '@ui/lib/i18n.js';

// Instructions a job can start from, which fill the Start job dialog's box
// and can be edited there. Plain text: nothing knows them once the job is
// started. Two kinds of work, since a job is not glossing alone: a
// translation and a check that writes nothing. None holds a blank to fill
// in: Start takes whatever the box holds. The labels are messages, the texts
// stay English: they are instructions to the model.
export const STARTER_TEXTS = [
  {
    label: msg('Translate'),
    text: 'Write a free translation of every sentence whose translation is empty.', // i18n-ignore: instructions sent to the model
  },
  {
    label: msg('Check'),
    text: 'List every value that does not follow the guidelines. Change nothing.', // i18n-ignore: instructions sent to the model
  },
];

// How a job's work was cut, in one line, from its plan (CONTRACT, added by
// JG, JH and EW): "Worked in stretches of sentences, only those with something
// empty, 2 in smaller parts."
const PIECES_TEXT = {
  sentences: msg('Worked in stretches of sentences'),
  document: msg('Worked one document at a time'),
  selection: msg('Worked on all the documents at once'),
};

// Stands for the search in the Plan line's message, where the line is cut in
// two around it. A character no translation holds.
const SEARCH_MARK = String.fromCharCode(0xe000);

// The Plan line in parts, as IsolatedLabel (plaid-ui) draws them: strings,
// and `{isolate: [value]}` for a value drawn in a `<bdi>`. Its first sentence
// is how the work was cut, then each clause that qualifies it, after a comma.
export const planParts = (plan) => {
  if (!plan) return null;
  // Planning ended with no plan: the job ended writing nothing (REV-DF3-2),
  // worded by why it ended (REV-DF4-2).
  if (plan.by === 'none') {
    return [t('{ended} Nothing was written.', { ended: planEndedText(plan) })];
  }
  const parts = [];
  let head = PIECES_TEXT[plan.pieces] ? t(PIECES_TEXT[plan.pieces]) : plan.pieces;
  const clauses = [];
  // A one-step plan over some of the job's documents (the worker's
  // `documents_named`, S2-2).
  if (plan.pieces === 'selection' && plan.documentsNamed > 0) {
    head = t('Worked on {n, plural, one {# document} other {# documents}} in one part', {
      n: plan.documentsNamed,
    });
  }
  if (plan.pieces === 'sentences' && plan.search) {
    // Only the sentences the plan's search matched, said by the worker's
    // words for it (`search.said`, CONTRACT, added by SF), as read_job says it.
    // Isolated in a `<bdi>`, as the page isolates every value it shows: a
    // pattern in a right-to-left script keeps its place in the line
    // (REV-SF-2), and its text holds no invisible character (REV-G4-1).
    const [before, after] = t(
      'Worked in stretches of sentences, only the sentences matching {search}: {sentences, plural, one {# sentence} other {# sentences}} in {documents, plural, one {# document} other {# documents}}',
      {
        search: SEARCH_MARK,
        sentences: plan.search.sentences ?? 0,
        documents: plan.search.documents ?? 0,
      },
    ).split(SEARCH_MARK);
    parts.push(before, { isolate: [plan.search.said] });
    head = after;
    if (plan.onlyEmpty) clauses.push(t('of them only those with something empty'));
  } else if (plan.pieces === 'sentences' && plan.onlyEmpty) {
    clauses.push(t('only those with something empty'));
  }
  // The documents worked apart, in stretches of sentences, whatever the
  // fallback's reason (too long for one piece, its piece failed, its write
  // after the step over all the documents put off), and every document once
  // that step failed (BRIEF RW).
  const fallback = plan.fallback || [];
  if (plan.pieces === 'selection' && fallback.length) {
    const failed = fallback.some((f) => f.documentId === null || f.documentId === undefined);
    const apart = fallback.filter((f) => f.documentId).length;
    if (failed) clauses.push(t('then in stretches of sentences'));
    else if (apart) clauses.push(t('then {n, number} in stretches of sentences', { n: apart }));
  } else if (fallback.length) {
    clauses.push(t('{n, number} in smaller parts', { n: fallback.length }));
  }
  const sentences = [[head, ...clauses].join(', ') + '.'];
  // What the plan fills, by the names the report gives (REV-DF-D-1).
  if (Array.isArray(plan.fillsNames)) {
    sentences.push(
      plan.fillsNames.length
        ? t('Fills: {names}.', { names: plan.fillsNames.join(', ') })
        : t('Fills nothing.'),
    );
  }
  // The plan says the instructions ask for the text itself to change
  // (plan_work's edits_text): only then may the job edit it.
  if (plan.editsText) sentences.push(t('Text may be edited.'));
  return [...parts, sentences.join(' ')];
};

// What each kind of change a job counts is called (the worker's
// `changes_parts`, CONTRACT, added by RPF), in the worker's order: the
// report's one definition of a change, split. An analysis is a word's, and
// beside one, a value is one set on its own (the analyses' values are theirs:
// REV-RPF2-2).
const CHANGE_PART_WORDS = {
  values: msg('{n, plural, one {# value} other {# values}}'),
  analyses: msg('{n, plural, one {# word analysis} other {# word analyses}}'),
  links: msg('{n, plural, one {# link} other {# links}}'),
  entries: msg('{n, plural, one {# lexicon entry} other {# lexicon entries}}'),
  text: msg('{n, plural, one {# text edit} other {# text edits}}'),
  other: msg('{n, plural, one {# other change} other {# other changes}}'),
};
const PART_ORDER = Object.keys(CHANGE_PART_WORDS);
const HELD = ['morphemes', 'values'];

// Parts `[{kind, n, morphemes?, values?}]` summed by kind, in the worker's
// order of kinds (an unknown kind last).
export const sumParts = (lists) => {
  const sums = new Map();
  lists.forEach((parts) =>
    (parts || []).forEach((p) => {
      const s = sums.get(p.kind) ?? { kind: p.kind, n: 0 };
      s.n += p.n ?? 0;
      HELD.forEach((k) => p[k] > 0 && (s[k] = (s[k] ?? 0) + p[k]));
      sums.set(p.kind, s);
    }),
  );
  const at = (k) => (PART_ORDER.includes(k) ? PART_ORDER.indexOf(k) : PART_ORDER.length);
  return [...sums.values()].sort((a, b) => at(a.kind) - at(b.kind));
};

// "6 (3 values on their own and 3 word analyses holding 5 morphemes and 5
// values)": a count of changes with what they are, an analysis with what it
// holds in the Changes view's nouns where the worker says (REV-RPF2-2), or
// the bare count where the parts are not known.
export const changesText = (n, parts) => {
  const shown = (parts || []).filter((p) => p.n > 0);
  const analysed = shown.some((p) => p.kind === 'analyses');
  const said = shown.map((p) => {
    // A kind the worker added since: its own code, after the count.
    if (!CHANGE_PART_WORDS[p.kind]) return `${p.n.toLocaleString()} ${p.kind}`;
    if (p.kind === 'values' && analysed) {
      return t('{n, plural, one {# value on its own} other {# values on their own}}', { n: p.n });
    }
    if (p.kind === 'analyses') {
      const held = [
        ...(p.morphemes > 0
          ? [t('{n, plural, one {# morpheme} other {# morphemes}}', { n: p.morphemes })]
          : []),
        ...(p.values > 0
          ? [t('{n, plural, one {# value} other {# values}}', { n: p.values })]
          : []),
      ];
      if (held.length) {
        return t('{n, plural, one {# word analysis} other {# word analyses}} holding {held}', {
          n: p.n,
          held: listOf(held),
        });
      }
    }
    return t(CHANGE_PART_WORDS[p.kind], { n: p.n });
  });
  const total = (n ?? 0).toLocaleString();
  return said.length ? t('{total} ({parts})', { total, parts: listOf(said) }) : total;
};

// Whether a job edited the text, by its report's counts or its documents'.
export const jobEditedText = (job) =>
  (job?.report?.totals?.textChanges ?? 0) > 0 ||
  (job?.report?.totals?.changesParts || []).some((p) => p.kind === 'text' && p.n > 0) ||
  (job?.documents || []).some((d) => (d.counts?.textChanges ?? 0) > 0);

// Whether an ended job wrote nothing at all: one that never started (stopped
// while it waited, REV-RPF-P-3), or one whose report says so: a count of no
// change in its totals, none in any document, and nothing harmonize changed.
// Not known (false) for a started job with no report, or one whose totals
// count no changes.
// The line under the headline of a job the server ended with a report of
// its own, made from the rows its worker last recorded: one stopped with no
// worker running ("Stopped with no worker running.", a fact its reason does
// not say), or one the server failed (`worker-lost`, or `starter-access` at a
// claim) whose report has no worker's `notice`, whose reason words already
// say what ended it. When History holds its writes, that the counts may be
// short (S3-1, REV-SJ1-10, REV-SJ1-R2-3). Null when there is nothing to add.
export const serverEndLine = (job) => {
  const report = job?.report;
  if (!report) return null;
  const stopped = report.stopped === 'without-worker';
  const failed =
    ['worker-lost', 'starter-access'].includes(job.reason) && report.notice === undefined;
  if (!stopped && !failed) return null;
  const hedge = job.wrote ? t('The counts are what its worker recorded before it stopped.') : null;
  if (!stopped) return hedge;
  const line = t('Stopped with no worker running.');
  return hedge ? `${line} ${hedge}` : line;
};

export const wroteNothing = (job) => {
  if (job && !job.startedAt && !isJobActive(job)) return true;
  const report = job?.report;
  if (report?.totals?.changes !== 0) return false;
  const harmonize = report.harmonize || {};
  return !(
    (report.documents || []).some((d) => (d.counts?.changes ?? 0) > 0) ||
    (job.documents || []).some((d) => (d.counts?.changes ?? 0) > 0) ||
    (harmonize.changed || []).length > 0 ||
    (harmonize.changedMore ?? 0) > 0
  );
};

// The worker's fixed top line of a report (plaid-agent's `core.job.notice`,
// the owner's R4), from the same counts in the same words, for a report that
// has none: core's own, of a job no worker finished (REV-RPF-W-3). Pinned
// equal to the worker's by plaid-agent's test_notice_mirror, its straight
// apostrophe included. Null when the job
// changed nothing people wrote and nothing of the text.
export const noticeText = (totals) => {
  const c = totals || {};
  const out = [];
  const people = c.peoplesValuesChanged || 0;
  if (people) {
    // Those a lexicon change took or moved outside the job's documents (S6-2).
    const elsewhere = c.peoplesOutside || 0;
    out.push(
      elsewhere
        ? t(
            "People's work: {n, plural, one {# value, morpheme or link people wrote was} other {# values, morphemes or links people wrote were}} changed or removed, {elsewhere, number} of them outside the job's documents. What the job wrote in their place is unverified.",
            { n: people, elsewhere },
          )
        : t(
            "People's work: {n, plural, one {# value, morpheme or link people wrote was} other {# values, morphemes or links people wrote were}} changed or removed. What the job wrote in their place is unverified.",
            { n: people },
          ),
    );
  }
  const added = c.wordsAdded || 0;
  const changed = c.tokensChanged || 0;
  const said = [
    ...(added ? [t('{n, plural, one {# word} other {# words}} added', { n: added })] : []),
    ...(changed
      ? [
          t(
            '{n, plural, one {# existing word or punctuation mark} other {# existing words or punctuation marks}} changed or removed',
            { n: changed },
          ),
        ]
      : []),
  ];
  if (said.length) out.push(t('Text: {parts}.', { parts: said.join(', ') }));
  else if (c.textChanges) {
    out.push(
      t(
        'Text: {n, plural, one {# text edit} other {# text edits}}, no word added, changed or removed.',
        { n: c.textChanges },
      ),
    );
  }
  // What the whole-selection step did, after which nothing more is worked
  // (the lead's ruling after RP4-5), and that it did not read every sentence
  // where it did not.
  const one = c.documentsInOneStep || 0;
  if (one) {
    const k = c.documentsChangedInOneStep || 0;
    const of = c.documentsInJob || one;
    // "All" and "its one" only when the step ended every document of the
    // job (REV-SF2-2).
    let did;
    if (of > one) {
      if (one === 1) {
        did = k
          ? t('The job worked on 1 of its {of, number} documents in one step and changed it.', {
              of,
            })
          : t(
              'The job worked on 1 of its {of, number} documents in one step and did not change it.',
              { of },
            );
      } else {
        did = k
          ? t(
              'The job worked on {one, number} of its {of, number} documents in one step and changed {k, number} of them.',
              { one, of, k },
            )
          : t(
              'The job worked on {one, number} of its {of, number} documents in one step and changed none of them.',
              { one, of },
            );
      }
    } else if (one === 1) {
      did = k
        ? t('The job worked on its one document in one step and changed it.')
        : t('The job worked on its one document in one step and did not change it.');
    } else {
      did = k
        ? t(
            'The job worked on all {one, number} documents in one step and changed {k, number} of them.',
            { one, k },
          )
        : t('The job worked on all {one, number} documents in one step and changed none of them.', {
            one,
          });
    }
    out.push(did);
    if (c.documentsNotAllRead) out.push(t('It did not read every sentence.'));
  }
  // Documents a big piece did not finish, nothing walked after it there,
  // by what happened in each (the worker's `ran_out`, REV-RW-R2-2).
  const ranOut = c.documentsRanOut || 0;
  if (ranOut) {
    out.push(
      t(
        '{n, plural, one {# document} other {# documents}} ended before the job had done its work there: what it had staged there was written, and the rest was not done.',
        { n: ranOut },
      ),
    );
  }
  const unchanged = c.documentsStepUnchanged || 0;
  if (unchanged) {
    out.push(
      t(
        "{n, plural, one {# document was read in part and not changed: the job's step over the documents ended before it finished it.} other {# documents were read in part and not changed: the job's step over the documents ended before it finished them.}}",
        { n: unchanged },
      ),
    );
  }
  const notRead = c.documentsStepNotRead || 0;
  if (notRead) {
    out.push(
      t(
        "{n, plural, one {# document was not read: the job's step over the documents ended before it.} other {# documents were not read: the job's step over the documents ended before them.}}",
        { n: notRead },
      ),
    );
  }
  const failedHere = c.documentsStepFailed || 0;
  if (failedHere) {
    out.push(
      t(
        "{n, plural, one {# document was not worked: the job's step over it failed.} other {# documents were not worked: the job's step over them failed.}}",
        { n: failedHere },
      ),
    );
  }
  const partFailed = c.documentsPartFailed || 0;
  if (partFailed) {
    out.push(
      t(
        '{n, plural, one {# document was not worked: its part failed.} other {# documents were not worked: the part for each failed.}}',
        { n: partFailed },
      ),
    );
  }
  const putOff = c.documentsPutOff || 0;
  if (putOff) {
    out.push(
      t(
        "{n, plural, one {# document was not changed: someone was editing it when the job's changes there were to be written.} other {# documents were not changed: someone was editing them when the job's changes there were to be written.}}",
        { n: putOff },
      ),
    );
  }
  // Documents the server never answered for, ended unworked (the worker's
  // `unanswered`, REV-JR2-3).
  const unanswered = c.documentsUnanswered || 0;
  if (unanswered) {
    out.push(
      t(
        '{n, plural, one {# document was} other {# documents were}} not worked: the server did not answer.',
        { n: unanswered },
      ),
    );
  }
  return out.join(' ') || null;
};

// The counts the top line is made of, for a report: its totals', and where
// core's own report has no total of the text's words, its documents' summed.
export const noticeCounts = (report) => {
  const totals = report?.totals || {};
  const sum = (k) =>
    totals[k] ?? (report?.documents || []).reduce((n, d) => n + (d.counts?.[k] ?? 0), 0);
  return {
    // People's work outside the job's documents is in no row's own count,
    // and part of the whole (REV-SJ3-4, the worker's `build_report`).
    peoplesValuesChanged:
      totals.peoplesValuesChanged ?? sum('peoplesValuesChanged') + sum('peoplesOutside'),
    peoplesOutside: sum('peoplesOutside'),
    wordsAdded: sum('wordsAdded'),
    tokensChanged: sum('tokensChanged'),
    textChanges: sum('textChanges'),
    documentsRanOut:
      totals.documentsRanOut ??
      (report?.documents || []).filter((d) => d.counts?.ranOut === 'written').length,
    documentsStepUnchanged:
      totals.documentsStepUnchanged ??
      (report?.documents || []).filter((d) => d.counts?.ranOut === 'unchanged').length,
    documentsStepNotRead:
      totals.documentsStepNotRead ??
      (report?.documents || []).filter((d) => d.counts?.ranOut === 'not-read').length,
    documentsStepFailed:
      totals.documentsStepFailed ??
      (report?.documents || []).filter((d) => d.counts?.ranOut === 'failed').length,
    documentsPartFailed:
      totals.documentsPartFailed ??
      (report?.documents || []).filter((d) => d.counts?.ranOut === 'part-failed').length,
    documentsPutOff:
      totals.documentsPutOff ??
      (report?.documents || []).filter((d) => d.counts?.ranOut === 'put-off').length,
    documentsUnanswered:
      totals.documentsUnanswered ??
      (report?.documents || []).filter((d) => d.counts?.unanswered === true).length,
    // Core's own report: the whole-selection step's documents from their rows.
    ...(totals.documentsInOneStep !== undefined
      ? {
          documentsInOneStep: totals.documentsInOneStep,
          documentsInJob: totals.documentsInJob,
          documentsChangedInOneStep: totals.documentsChangedInOneStep,
          documentsNotAllRead: totals.documentsNotAllRead,
        }
      : oneStepCounts(report?.documents || [])),
  };
};

// A document the whole-selection piece covered and ended in its one step
// (the worker's `counts.one_step`, CONTRACT, added by SF round 2).
export const oneStep = (d) => d?.state === 'done' && d.counts?.oneStep === true;

// The top line's counts of the one step's documents, from their rows
// (plaid-agent's `core.job.one_step_totals`).
const oneStepCounts = (docs) => {
  const stepped = docs.filter(oneStep);
  return {
    documentsInOneStep: stepped.length,
    documentsInJob: docs.length,
    documentsChangedInOneStep: stepped.filter((d) => (d.counts?.changes ?? 0) > 0).length,
    documentsNotAllRead: stepped.filter((d) => d.counts?.notAllRead === true).length,
  };
};

// How many pieces the findings of a job that fills nothing hold, each under
// its heading, and how many are left out past the report's cap (the
// worker's `findings_pieces` and `findings_cut`, REV-RPF-W-2): each piece's
// findings are on its own row of the work list (REV-RPF2-4). Null for one
// report (a single piece's, or the final context's from them all).
export const findingsPiecesText = (pieces, cut) => {
  if (!(pieces > 1)) return null;
  if (!(cut > 0)) {
    return t('Findings of {n, plural, one {# part} other {# parts}}, each under its heading.', {
      n: pieces,
    });
  }
  return t(
    'Findings of {shown, number} of {pieces, number} parts are shown here, each under its heading. {cut, plural, one {# is} other {# are}} left out: each part’s findings are on its row of the work list.',
    { shown: pieces - cut, pieces, cut },
  );
};

// How many values the job wrote in one target, as the report's rows and a
// piece's line say it: "8 values (7 in word analyses)", the values word
// analyses carried (the worker's `in_analyses`, REV-RPF-W-5) said, and one
// written outside the setup said so.
export const fieldValuesText = (f) => {
  const values =
    f.inAnalyses > 0
      ? t('{n, plural, one {# value} other {# values}} ({inAnalyses, number} in word analyses)', {
          n: f.values,
          inAnalyses: f.inAnalyses,
        })
      : t('{n, plural, one {# value} other {# values}}', { n: f.values });
  return f.outside === true ? t('{values}, not in the setup', { values }) : values;
};

// What one piece of a job wrote, in the report's words for its totals, in
// their order: "Sentences written in: 2, Changes written: 6, Words analyzed: 4,
// Gloss: 2 values." Each target's values as the report's rows say them, one
// written outside the setup said so. "Nothing written." when it wrote nothing.
const PIECE_COUNTS_BEFORE = [
  ['analyzed', msg('Sentences written in')],
  ['changes', msg('Changes written')],
  ['deletions', msg('Deletions')],
  ['peoplesValuesChanged', msg('People’s values, morphemes and links changed or removed')],
  ['textChanges', msg('Changes to the text')],
  ['wordsAdded', msg('Words added')],
  ['tokensChanged', msg('Existing words or punctuation marks changed or removed')],
  ['translations', msg('Translations written')],
  ['refreshed', msg('Translations replaced')],
  ['words', msg('Words analyzed')],
];
const PIECE_COUNTS_AFTER = [
  ['links', msg('Lexicon links made')],
  ['entries', msg('Entries created')],
  ['changed', msg('Changes not written, changed during the job')],
  ['repeated', msg('Changes left out, sentence written before an interruption')],
];

// A label and its value, as the totals and a piece's line say them.
export const labelled = (label, value) => t('{label}: {value}', { label, value });
export const pieceWrittenText = (piece) => {
  const counts = piece?.counts || {};
  const said = (pairs) =>
    pairs
      .filter(([k]) => counts[k] > 0)
      .map(([k, label]) =>
        labelled(
          t(label),
          k === 'changes' ? changesText(counts[k], piece.changesParts) : counts[k].toLocaleString(),
        ),
      );
  // A target written outside the setup reads its outside row's count, as the
  // report's rows do, in the order of their names.
  const byId = new Map((piece?.fields || []).map((f) => [f.id, f]));
  (piece?.outside || []).forEach((f) =>
    byId.set(f.id, { ...f, inAnalyses: byId.get(f.id)?.inAnalyses, outside: true }),
  );
  const fields = [...byId.values()]
    .filter((f) => f.values > 0)
    .sort((a, b) => (a.field < b.field ? -1 : a.field > b.field ? 1 : 0))
    .map((f) => labelled(f.field, fieldValuesText(f)));
  const parts = [...said(PIECE_COUNTS_BEFORE), ...fields, ...said(PIECE_COUNTS_AFTER)];
  return parts.length ? `${parts.join(', ')}.` : t('Nothing written.');
};

// Whether the pieces' rows count less than the documents' rows do, in any of
// the counts both keep (REV-LV-3): a piece whose worker stopped before its
// row was kept. By the numbers only.
const COMPARED = [
  'analyzed',
  'words',
  'changes',
  'deletions',
  'links',
  'entries',
  'translations',
  'refreshed',
  'peoplesValuesChanged',
  'textChanges',
];
export const piecesFallShort = (pieces, documents) =>
  COMPARED.some(
    (k) =>
      pieces.reduce((n, p) => n + (p.counts?.[k] ?? 0), 0) <
      (documents || []).reduce((n, d) => n + (d.counts?.[k] ?? 0), 0),
  );

// The History entry of the job's work in a document, where it wrote
// something there: the worker names the group before its first write, so a
// group with no change opens nothing (REV-DF-S-5).
export const changesGroup = (d) => ((d?.counts?.changes ?? 0) > 0 ? d.glossGroup : null);

// A document of the job the worker did not finish: never reached, or
// stopped partway once it finished a sentence (REV-DAY-P-13) or holds any of
// the job's changes, which a step over all the documents may have written
// before the walk reached it (RPF3-D2, RP2-4: "Not reached" beside "Changes 1").
export const stoppedPartway = (d) =>
  d.state === 'not-reached' && ((d.done ?? 0) > 0 || (d.counts?.changes ?? 0) > 0);

// Who a job's own field names: "you" for the reader, the starter by name,
// another person by the name the user directory gives (`names`, id to
// display name, where the reader may read it), else "another user": never a
// raw user id (REV-RPF3-6).
export const whoText = (userId, job, user, names = {}) =>
  user?.id && userId === user.id
    ? t('you')
    : userId && userId === job?.startedBy && job.startedByName
      ? job.startedByName
      : (names[userId] ?? t('another user'));

// How many of a document's sentences the job skipped (its rows' skipped list,
// and those past the list's cap). Its `done` counts them with the sentences
// it worked. A sentence too long for a job was never a target, and `done`
// does not count it: counted apart (D11).
const skippedCount = (d) =>
  (d?.skipped ?? []).filter((s) => s.reason !== 'too-long').length + (d?.counts?.skippedMore ?? 0);
const tooLongCount = (d) =>
  (d?.skipped ?? []).filter((s) => s.reason === 'too-long').length + (d?.counts?.tooLongMore ?? 0);

// Whether the job finished a document by skipping every sentence of it:
// nothing in it was worked, so it never reads "Done" (REV-RPF-P-9).
export const allSkipped = (d) =>
  d.state === 'done' && (d.done ?? 0) > 0 && skippedCount(d) >= (d.done ?? 0);

// A document a plan limited by a search ended with no sentence of it found by
// the search, and no model call (the worker's `counts.matched` 0, CONTRACT,
// added by SF).
export const nothingFound = (d) => d?.state === 'done' && d.counts?.matched === 0;

// A document's sentences as the Documents table says them: those worked of
// its sentences, and those skipped, "0 of 2, 2 skipped" (REV-RPF-P-9). One
// the whole-selection step ended reads "Worked in the one step", never a
// count of sentences it may not have opened (RP4-4 finding 2, RP4-5 F3).
export const documentSentencesText = (d, plan = null) => {
  if (oneStep(d)) return t('Worked in the one step');
  if (d.targets === null || d.targets === undefined) return '';
  // Under a plan limited by a search, those worked of the sentences the walk
  // takes, then the document's others as not found by the search (SF,
  // REV-SF-5, true of a sentence added since the planning too, REV-SF-7: a
  // document not yet reached reads by its matched count): "0 of 20, none
  // found by the plan's search", "0 of 3 matching, 17 not found by the
  // plan's search".
  if (plan?.pieces === 'sentences' && plan.search && typeof d.counts?.matched === 'number') {
    const all = Math.max(d.sentences ?? 0, d.targets);
    if (d.counts.matched === 0) {
      return t('0 of {all, number}, none found by the plan’s search', { all });
    }
    const skippedHere = Math.min(skippedCount(d), d.done ?? 0);
    const others = all - d.targets;
    return [
      t('{done, number} of {n, number} matching', {
        done: (d.done ?? 0) - skippedHere,
        n: d.targets,
      }),
      ...(skippedHere > 0 ? [t('{n, number} skipped', { n: skippedHere })] : []),
      ...(tooLongCount(d) > 0 ? [t('{n, number} too long', { n: tooLongCount(d) })] : []),
      ...(others > 0
        ? [
            plan.onlyEmpty
              ? t('{n, number} not found by the plan’s search or with nothing to fill', {
                  n: others,
                })
              : t('{n, number} not found by the plan’s search', { n: others }),
          ]
        : []),
    ].join(', ');
  }
  const skipped = Math.min(skippedCount(d), d.done ?? 0);
  const worked = t('{done, number} of {n, number}', {
    done: (d.done ?? 0) - skipped,
    n: d.targets,
  });
  const tooLong = tooLongCount(d);
  return [
    worked,
    ...(skipped > 0 ? [t('{n, number} skipped', { n: skipped })] : []),
    ...(tooLong > 0 ? [t('{n, number} too long', { n: tooLong })] : []),
  ].join(', ');
};

// The report's documents counted as the page says them (REV-RPF3-4): done
// (those the whole-selection step ended among them: RP4-4 finding 1 counted
// them out and read "Documents done 0"), those of them changed, with nothing
// found by the plan's search (SF), skipped, stopped partway and not reached,
// each document once. "Done" leaves out those with nothing found and those
// all skipped. The
// worker's read_job and final context say the same, by plaid-agent's
// `document_counts`, pinned equal by its test_document_counts_mirror.
export const documentCounts = (report) => {
  const docs = report?.documents || [];
  const totals = report?.totals || {};
  const changed = docs.filter((d) => d.state === 'done' && (d.counts?.changes ?? 0) > 0).length;
  const unmatched = docs.filter(nothingFound).length;
  const skipped = docs.filter(allSkipped).length;
  // The documents the plan left out are no documents not reached (D22),
  // those cut from its list (`leftOutMore`) counted too.
  const leftIds = new Set((report?.plan?.leftOut || []).map((d) => d.documentId));
  const leftMore = report?.plan?.leftOutMore ?? 0;
  const left = (report?.plan?.leftOut?.length ?? 0) + leftMore;
  // Those the server never answered for are counted apart (REV-JR2-3).
  const unanswered = docs.filter(
    (d) => d.state === 'not-reached' && d.counts?.unanswered === true,
  ).length;
  const unfinished = docs.filter(
    (d) => d.state === 'not-reached' && !leftIds.has(d.documentId) && d.counts?.unanswered !== true,
  );
  const partway = unfinished.filter(stoppedPartway).length;
  return {
    done: Math.max(0, (totals.documentsDone ?? 0) - skipped - unmatched),
    changed,
    withNothingFoundByTheSearch: unmatched,
    skipped,
    stoppedPartway: partway,
    notReached: report?.documents
      ? Math.max(0, unfinished.length - partway - leftMore)
      : Math.max(0, (totals.documentsNotReached ?? 0) - left - (totals.documentsUnanswered ?? 0)),
    leftOut: left,
    unanswered: report?.documents ? unanswered : (totals.documentsUnanswered ?? 0),
  };
};

// How many places a document's Left blank lists, by unit, those cut from the
// list included ("4 words, 1 sentence", REV-DF-S N-2), or null when nothing
// was counted there: a job that fills nothing, a document deleted, one that
// could not be read, one the job worked none of (not reached, or in use all
// along, S8-3), core's own report (REV-DF-S-2).
export const leftText = (d) => {
  const never = (d?.state === 'not-reached' || d?.state === 'in-use') && !(d.done > 0);
  if (!d?.counts?.blank || d.leftUnread || never) return null;
  const units = d.counts.leftUnits || [];
  if (!units.length) return '0';
  return units.map((u) => unitCount(u.left, u.unit)).join(', ');
};

// A count of places in the unit Left blank lists them by (the worker's
// `unit`: a word, a morpheme or a sentence): "4 words".
export const unitCount = (n, unit) =>
  t(
    '{unit, select, word {{n, plural, one {# word} other {# words}}} morpheme {{n, plural, one {# morpheme} other {# morphemes}}} sentence {{n, plural, one {# sentence} other {# sentences}}} other {{n, number} {unit}}}',
    { n, unit },
  );

const FAILURE_TEXT = {
  budget: msg('Failed: over budget'),
  context: msg('Failed: prompt too long'),
  output: msg('Failed: answer too long'),
  repeating: msg('Failed: model repeated itself'),
  // The model's provider refused the call (S1-2).
  refused: msg('Failed: refused by the model'),
};

// What follows a piece of the whole document or of all the documents in
// stretches is not done in a document that ended in use, deleted or not
// reached: those say so (REV-RW-7).
const NOT_AGAIN = {
  'in-use': msg('Not worked again: in use.'),
  gone: msg('Not worked again: deleted.'),
  'not-reached': msg('Not worked again: the job ended.'),
};

// How a piece that did not finish ended and what followed it, each line
// true whatever happened after (the worker's `failed`, `ended` and `rest`,
// BRIEF RW, REV-RW-7). `states`: each document's state by id. `active`: the
// job still runs.
export const pieceEndLines = (piece, states = new Map(), active = false) => {
  const out = [];
  if (piece.failed) {
    out.push(
      piece.failed === 'no-answer'
        ? t('No answer from the assistant.')
        : `${skippedText({ reason: 'failed', kind: piece.failed })}.`,
    );
  }
  if (piece.ended) {
    // `repeating`: the same tool call failed or was repeated three times in
    // a row (REV-JR1-6), in the words a skipped sentence uses for it.
    const why = piece.ended;
    out.push(
      (piece.counts?.changes ?? 0) > 0
        ? t(
            '{why, select, output {Answer too long} repeating {Model repeated itself} other {Steps used up}}: written as staged.',
            { why },
          )
        : t(
            '{why, select, output {Answer too long} repeating {Model repeated itself} other {Steps used up}}: what it had staged was not written.',
            { why },
          ),
    );
  }
  // Its documents then worked in stretches (`rest`, how many, and
  // `restDocuments`, which), said once the job has ended and only of those
  // documents (REV-RW-R2-6): while it runs that work is still to come.
  if (piece.rest > 0 && !active) {
    const listed = piece.restDocuments || [];
    const going = listed.filter((d) => !NOT_AGAIN[states.get(d)]).length;
    // Worked again after a failure, or the rest of a piece that ended.
    const again = piece.failed ? 'yes' : 'no';
    if (!piece.document && listed.length < piece.rest) {
      // Past the documents the summary lists, no outcome is claimed: only
      // how many the rest went to (REV-RW-R3-3).
      out.push(
        piece.failed
          ? t(
              'Then {n, plural, one {# document} other {# documents}} went to stretches of sentences.',
              { n: piece.rest },
            )
          : t(
              'The rest went to stretches of sentences in {n, plural, one {# document} other {# documents}}.',
              { n: piece.rest },
            ),
      );
    } else if (piece.document) {
      const notAgain = NOT_AGAIN[states.get(piece.document)];
      out.push(
        notAgain
          ? t(notAgain)
          : t(
              '{again, select, yes {Worked again} other {The rest worked}} in stretches of sentences.',
              { again },
            ),
      );
    } else if (going === 0) {
      out.push(t('Not worked again.'));
    } else if (going === piece.rest) {
      out.push(
        t(
          '{again, select, yes {Worked again} other {The rest worked}} in stretches of sentences in {n, plural, one {# document} other {# documents}}.',
          { again, n: going },
        ),
      );
    } else {
      out.push(
        t(
          '{again, select, yes {Worked again} other {The rest worked}} in stretches of sentences in {n, plural, one {# document} other {# documents}} of {rest, number}.',
          { again, n: going, rest: piece.rest },
        ),
      );
    }
  }
  return out;
};

// Why a sentence was left: `{reason, kind}` of a skipped entry.
export const skippedText = ({ reason, kind }) => {
  if (reason === 'too-long') return t('Too long');
  if (reason === 'changed') return t('Changed during the job');
  if (reason === 'interrupted') return t('Write interrupted');
  // The piece's model answered twice with nothing staged and nothing said.
  if (reason === 'no-answer') return t('No answer from the assistant');
  if (reason === 'failed') return FAILURE_TEXT[kind] ? t(FAILURE_TEXT[kind]) : t('Failed');
  // A reason the worker added since: its own code.
  return reason;
};

// What a refusal the job could not follow left undone in a sentence, by the
// code the refusal carries (a closed set, never its text): the label a
// person reads under "Not done, refused:", naming the change not made
// (REV-DF-S-4, REV-DF3-5).
const REFUSED_TEXT = {
  text: msg('Change to words the job retyped, split, merged or deleted'),
  shape: msg('Retype, split, merge or delete of words the job also changed'),
  'entry-new': msg('Change that uses an entry the job made'),
  'entry-gone': msg('Change that uses an entry the job deleted or merged'),
  expression: msg('Link inside a multi-word expression the job made'),
  // A job set up to fill only the words it adds (R3).
  'not-added': msg('Value on a word or sentence the job did not add'),
  // An analysis of a word in a sentence the piece's own plan retyped (RPF3-B).
  retyped: msg('Analysis of a word in a sentence the job retyped'),
  // A change outside the piece's own sentences (RP3-2), a text edit too
  // under onlynew (REV-RPF3B-5). Named by where, as it was never made
  // (REV-RPF3B-10).
  outside: msg('Outside the part’s own sentences'),
  // A change in a sentence too long for a job (S8-1).
  'too-long': msg('Change in a sentence too long for a job'),
};
export const refusedText = (code) => (REFUSED_TEXT[code] ? t(REFUSED_TEXT[code]) : t('Refused'));

// Why a change the job applied is listed among the proposed changes: its
// write was cut short (a lost answer, a crash, a refusal) and it was not
// written. The one reason there is.
export const changeReasonText = (reason) =>
  reason === 'interrupted' ? t('Not written, the write was interrupted') : reason;

// Why a form the job wrote is left inconsistent, by the worker's code (a
// closed set, each true of every analysis listed, CONTRACT, added by RPF).
export const HARMONIZE_LEFT_TEXT = {
  'job-differs-people-differ': msg('The job’s analyses differ, and so do people’s'),
  'job-differs-no-majority': msg('The job’s analyses differ, none by two thirds'),
  changed: msg('Changed after the job wrote it'),
  verified: msg('A person verified it after the job wrote it'),
  'beside-others': msg('Also holds work that is not the job’s'),
  unvouched: msg('Not checked'),
  commented: msg('Has a comment'),
  'in-mwe': msg('In a multi-word expression'),
  'in-use': msg('Document in use'),
  refused: msg('Could not be written'),
};

export const HARMONIZE_BY_TEXT = {
  person: msg('A person’s analysis'),
  majority: msg('Majority'),
};

// What is ahead of a waiting job in the queue, from core's `ahead`. Core lets a
// project hold one active job, so each of them is another project's.
export const aheadText = (n) =>
  t('{n, plural, one {# job of another project ahead} other {# jobs of other projects ahead}}', {
    n,
  });

// A stretch of time for a job, which runs for minutes or hours: "Under a
// minute", "12 min", "2 h 5 min".
export const durationText = (ms) => {
  const minutes = Math.floor(Math.max(0, ms) / 60000);
  if (minutes < 1) return t('Under a minute');
  const hours = Math.floor(minutes / 60);
  const rest = minutes % 60;
  if (!hours) return t('{minutes} min', { minutes });
  return rest ? t('{hours} h {minutes} min', { hours, minutes: rest }) : t('{hours} h', { hours });
};

// What the assistant panel calls a job, on the messages asked from its page
// and in the conversation list: when it was started, by the reader's clock.
// "Job of Nov 13, 2026, 3:10 AM". Stored with the conversation's messages
// (their `about`), so it stays English.
export const jobName = (job) =>
  // i18n-ignore: stored on the conversation's messages, as data
  `Job of ${new Date(job.createdAt).toLocaleString(undefined, { dateStyle: 'medium', timeStyle: 'short' })}`;

// Where a job's page is.
export const jobPath = (projectId, jobId) => `/projects/${projectId}/jobs/${jobId}`;
export const jobsTabPath = (projectId) => `/projects/${projectId}?tab=jobs`;

// Instructions' length as core counts it: in characters, never UTF-16 units.
export const instructionsLength = (text) => [...text].length;

// Start a job as the signed-in user: the one client call, under the id `mint`
// holds (createOnce.js: a press again after a lost answer makes no second
// job). `documents` null is every document of the project. `setup` is what
// the job was set up to do (`jobSetupOf`), none for a job started from the
// form. Resolves to the job.
export const startJob = (
  client,
  projectId,
  mint,
  { documents = null, instructions = '', setup = null },
) => {
  const body = { app: 'igt', instructions: instructions.trim() };
  if (documents) body.documents = documents;
  if (setup) body.setup = setup;
  return createOnce(mint, (id) => client.jobs.create(projectId, { ...body, id }));
};

// The setup a job card gives the job it starts (CONTRACT, "Added by SU"):
// the targets it may fill, by id and the name the card showed, whether it may
// edit the text, whether it fills only the words it adds (`onlynew`, sent
// only when the card says so, R3), and the conversation that set it up. Keys
// of one word, since the client re-cases keys. A card with no `fills`
// (drafted before cards had them) gives none, and its job has no limit.
export const jobSetupOf = (card, conversationId = null) => {
  if (!Array.isArray(card?.fills)) return null;
  return {
    fills: card.fills.map((f) => ({ id: f.id, name: f.name })),
    text: card.editsText === true,
    ...(card.onlyNew === true ? { onlynew: true } : {}),
    ...(conversationId ? { conversation: conversationId } : {}),
  };
};

// Whether a job's `setup` has the card's shape (the worker's rule,
// igt/targets.py `readable`): `fills` a list of maps each with a string `id`
// and a string `name`, `text` true or false, and `onlynew`, where there is
// one, true or false. Core keeps any map, so the page draws nothing of one
// that is not (REV-SU-F-1).
export const readableSetup = (setup) =>
  Array.isArray(setup?.fills) &&
  typeof setup.text === 'boolean' &&
  (setup.onlynew === undefined || typeof setup.onlynew === 'boolean') &&
  setup.fills.every(
    (f) =>
      f !== null &&
      typeof f === 'object' &&
      typeof f.id === 'string' &&
      f.id !== '' &&
      typeof f.name === 'string',
  );

// What a card's Text row says of a setup's `text`.
export const setupTextText = (text) => (text ? t('May be edited') : t('Unchanged'));

// The project's job that stood in the way of a start (core's 409 `job-active`),
// or null for any other error.
export const activeJobOf = (err) =>
  statusOf(err) === 409 && err.responseData?.code === 'job-active'
    ? (err.responseData.job ?? null)
    : null;
