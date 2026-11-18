// The igt job screens' words for what a job reports: how its work was cut, a
// skipped sentence, a harmonize decision, a proposed change. The words for a
// job's codes (its state, phase, reason, a document's state) are plaid-ui's
// (domain/jobs.js), since every app says them. Also how a job is started,
// shared by the Start job dialog and the assistant's job card.
import { isJobActive, planEndedText } from '@ui/domain/jobs.js';
import { createOnce } from '@ui/lib/createOnce.js';
import { statusOf } from '@ui/lib/errors.js';
import { andList, countOf, plural } from '@ui/lib/plural.js';

// Instructions a job can start from, which fill the Start job dialog's box
// and can be edited there. Plain text: nothing knows them once the job is
// started. Two kinds of work, since a job is not glossing alone: a
// translation and a check that writes nothing. None holds a blank to fill
// in: Start takes whatever the box holds.
export const STARTER_TEXTS = [
  {
    label: 'Translate',
    text: 'Write a free translation of every sentence whose translation is empty.',
  },
  {
    label: 'Check',
    text: 'List every value that does not follow the guidelines. Change nothing.',
  },
];

// How a job's work was cut, in one line, from its plan (CONTRACT, added by
// JG, JH and EW): "Worked in stretches of sentences, only those with something
// empty, 2 in smaller parts."
const PIECES_TEXT = {
  sentences: 'Worked in stretches of sentences',
  document: 'Worked one document at a time',
  selection: 'Worked on all the documents at once',
};

// The Plan line in parts, as IsolatedLabel (plaid-ui) draws them: strings,
// and `{isolate: [value]}` for a value drawn in a `<bdi>`.
export const planParts = (plan) => {
  if (!plan) return null;
  // Planning ended with no plan: the job ended writing nothing (REV-DF3-2),
  // worded by why it ended (REV-DF4-2).
  if (plan.by === 'none') return [`${planEndedText(plan)} Nothing was written.`];
  const parts = [];
  let text = PIECES_TEXT[plan.pieces] ?? plan.pieces;
  if (plan.pieces === 'sentences' && plan.search) {
    // Only the sentences the plan's search matched, said by the worker's
    // words for it (`search.said`, CONTRACT, added by SF), as read_job says it.
    // Isolated in a `<bdi>`, as the page isolates every value it shows: a
    // pattern in a right-to-left script keeps its place in the line
    // (REV-SF-2), and its text holds no invisible character (REV-G4-1).
    parts.push(`${text}, only the sentences matching `, { isolate: [plan.search.said] });
    text =
      `: ` +
      `${countOf(plan.search.sentences ?? 0, 'sentence')} in ${countOf(plan.search.documents ?? 0, 'document')}`;
    if (plan.onlyEmpty) text += ', of them only those with something empty';
  } else if (plan.pieces === 'sentences' && plan.onlyEmpty) {
    text += ', only those with something empty';
  }
  // The documents worked apart, in stretches of sentences, whatever the
  // fallback's reason (too long for one piece, its piece failed, its write
  // after the step over all the documents put off), and every document once
  // that step failed (BRIEF RW).
  const fallback = plan.fallback || [];
  if (plan.pieces === 'selection' && fallback.length) {
    const failed = fallback.some((f) => f.documentId === null || f.documentId === undefined);
    const apart = fallback.filter((f) => f.documentId).length;
    if (failed) text += ', then in stretches of sentences';
    else if (apart) text += `, then ${apart.toLocaleString()} in stretches of sentences`;
  } else if (fallback.length) {
    text += `, ${fallback.length.toLocaleString()} in smaller parts`;
  }
  text += '.';
  // What the plan fills, by the names the report gives (REV-DF-D-1).
  if (Array.isArray(plan.fillsNames)) {
    text += plan.fillsNames.length ? ` Fills: ${plan.fillsNames.join(', ')}.` : ' Fills nothing.';
  }
  // The plan says the instructions ask for the text itself to change
  // (plan_work's edits_text): only then may the job edit it.
  return [...parts, plan.editsText ? `${text} Text may be edited.` : text];
};

// What each kind of change a job counts is called (the worker's
// `changes_parts`, CONTRACT, added by RPF), in the worker's order: the
// report's one definition of a change, split. An analysis is a word's, and
// beside one, a value is one set on its own (the analyses' values are theirs:
// REV-RPF2-2).
const CHANGE_PART_WORDS = {
  values: ['value', 'values'],
  analyses: ['word analysis', 'word analyses'],
  links: ['link', 'links'],
  entries: ['lexicon entry', 'lexicon entries'],
  text: ['text edit', 'text edits'],
  other: ['other change', 'other changes'],
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
    if (!CHANGE_PART_WORDS[p.kind]) return `${p.n.toLocaleString()} ${p.kind}`;
    const base = countOf(p.n, ...CHANGE_PART_WORDS[p.kind]);
    if (p.kind === 'values' && analysed)
      return `${base} ${p.n === 1 ? 'on its own' : 'on their own'}`;
    if (p.kind === 'analyses') {
      const held = [
        ...(p.morphemes > 0 ? [countOf(p.morphemes, 'morpheme')] : []),
        ...(p.values > 0 ? [countOf(p.values, 'value')] : []),
      ];
      if (held.length) return `${base} holding ${held.join(' and ')}`;
    }
    return base;
  });
  const count = (n ?? 0).toLocaleString();
  return said.length ? `${count} (${andList(said)})` : count;
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
  const t = totals || {};
  const out = [];
  const people = t.peoplesValuesChanged || 0;
  if (people) {
    out.push(
      `People's work: ${countOf(people, 'value, morpheme or link', 'values, morphemes or links')} ` +
        `people wrote ${people === 1 ? 'was' : 'were'} changed or removed. What the job wrote in ` +
        'their place is unverified.',
    );
  }
  const added = t.wordsAdded || 0;
  const changed = t.tokensChanged || 0;
  const said = [
    ...(added ? [`${countOf(added, 'word')} added`] : []),
    ...(changed
      ? [
          `${countOf(changed, 'existing word or punctuation mark', 'existing words or punctuation marks')} changed or removed`,
        ]
      : []),
  ];
  if (said.length) out.push(`Text: ${said.join(', ')}.`);
  else if (t.textChanges) {
    out.push(`Text: ${countOf(t.textChanges, 'text edit')}, no word added, changed or removed.`);
  }
  // What the whole-selection step did, after which nothing more is worked
  // (the lead's ruling after RP4-5), and that it did not read every sentence
  // where it did not.
  const one = t.documentsInOneStep || 0;
  if (one) {
    const k = t.documentsChangedInOneStep || 0;
    const of = t.documentsInJob || one;
    // "All" and "its one" only when the step ended every document of the
    // job (REV-SF2-2).
    let did;
    if (of > one) {
      const what =
        one === 1
          ? k
            ? 'changed it'
            : 'did not change it'
          : `changed ${k ? k.toLocaleString() : 'none'} of them`;
      did = `The job worked on ${one.toLocaleString()} of its ${of.toLocaleString()} documents in one step and ${what}.`;
    } else {
      did =
        one === 1
          ? `The job worked on its one document in one step and ${k ? 'changed it' : 'did not change it'}.`
          : `The job worked on all ${one.toLocaleString()} documents in one step and changed ${k ? k.toLocaleString() : 'none'} of them.`;
    }
    out.push(did + (t.documentsNotAllRead ? ' It did not read every sentence.' : ''));
  }
  // Documents a big piece did not finish, nothing walked after it there,
  // by what happened in each (the worker's `ran_out`, REV-RW-R2-2).
  const ranOut = t.documentsRanOut || 0;
  if (ranOut) {
    out.push(
      `${countOf(ranOut, 'document')} ended before the job had done its work there: what it had staged there was written, and the rest was not done.`,
    );
  }
  const unchanged = t.documentsStepUnchanged || 0;
  if (unchanged) {
    const one = unchanged === 1;
    out.push(
      `${countOf(unchanged, 'document')} ${one ? 'was' : 'were'} read in part and not changed: the job's step over the documents ended before it finished ${one ? 'it' : 'them'}.`,
    );
  }
  const notRead = t.documentsStepNotRead || 0;
  if (notRead) {
    const one = notRead === 1;
    out.push(
      `${countOf(notRead, 'document')} ${one ? 'was' : 'were'} not read: the job's step over the documents ended before ${one ? 'it' : 'them'}.`,
    );
  }
  const failedHere = t.documentsStepFailed || 0;
  if (failedHere) {
    const one = failedHere === 1;
    out.push(
      `${countOf(failedHere, 'document')} ${one ? 'was' : 'were'} not worked: the job's step over ${one ? 'it' : 'them'} failed.`,
    );
  }
  const partFailed = t.documentsPartFailed || 0;
  if (partFailed) {
    const one = partFailed === 1;
    out.push(
      `${countOf(partFailed, 'document')} ${one ? 'was' : 'were'} not worked: ${one ? 'its part' : 'the part for each'} failed.`,
    );
  }
  const putOff = t.documentsPutOff || 0;
  if (putOff) {
    const one = putOff === 1;
    out.push(
      `${countOf(putOff, 'document')} ${one ? 'was' : 'were'} not changed: someone was editing ${one ? 'it' : 'them'} when the job's changes there were to be written.`,
    );
  }
  // Documents the server never answered for, ended unworked (the worker's
  // `unanswered`, REV-JR2-3).
  const unanswered = t.documentsUnanswered || 0;
  if (unanswered) {
    out.push(
      `${unanswered.toLocaleString()} ${unanswered === 1 ? 'document was' : 'documents were'} not worked: the server did not answer.`,
    );
  }
  return out.join(' ') || null;
};

// The counts the top line is made of, for a report: its totals', and where
// core's own report has no total of the text's words, its documents' summed.
export const noticeCounts = (report) => {
  const t = report?.totals || {};
  const sum = (k) =>
    t[k] ?? (report?.documents || []).reduce((n, d) => n + (d.counts?.[k] ?? 0), 0);
  return {
    peoplesValuesChanged: sum('peoplesValuesChanged'),
    wordsAdded: sum('wordsAdded'),
    tokensChanged: sum('tokensChanged'),
    textChanges: sum('textChanges'),
    documentsRanOut:
      t.documentsRanOut ??
      (report?.documents || []).filter((d) => d.counts?.ranOut === 'written').length,
    documentsStepUnchanged:
      t.documentsStepUnchanged ??
      (report?.documents || []).filter((d) => d.counts?.ranOut === 'unchanged').length,
    documentsStepNotRead:
      t.documentsStepNotRead ??
      (report?.documents || []).filter((d) => d.counts?.ranOut === 'not-read').length,
    documentsStepFailed:
      t.documentsStepFailed ??
      (report?.documents || []).filter((d) => d.counts?.ranOut === 'failed').length,
    documentsPartFailed:
      t.documentsPartFailed ??
      (report?.documents || []).filter((d) => d.counts?.ranOut === 'part-failed').length,
    documentsPutOff:
      t.documentsPutOff ??
      (report?.documents || []).filter((d) => d.counts?.ranOut === 'put-off').length,
    documentsUnanswered:
      t.documentsUnanswered ??
      (report?.documents || []).filter((d) => d.counts?.unanswered === true).length,
    // Core's own report: the whole-selection step's documents from their rows.
    ...(t.documentsInOneStep !== undefined
      ? {
          documentsInOneStep: t.documentsInOneStep,
          documentsInJob: t.documentsInJob,
          documentsChangedInOneStep: t.documentsChangedInOneStep,
          documentsNotAllRead: t.documentsNotAllRead,
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
  if (!(cut > 0)) return `Findings of ${countOf(pieces, 'part')}, each under its heading.`;
  return (
    `Findings of ${(pieces - cut).toLocaleString()} of ${pieces.toLocaleString()} parts are shown ` +
    `here, each under its heading. ${cut.toLocaleString()} ${cut === 1 ? 'is' : 'are'} left out: ` +
    'each part’s findings are on its row of the work list.'
  );
};

// How many values the job wrote in one target, as the report's rows and a
// piece's line say it: "8 values (7 in word analyses)", the values word
// analyses carried (the worker's `in_analyses`, REV-RPF-W-5) said, and one
// written outside the setup said so.
export const fieldValuesText = (f) =>
  `${f.values.toLocaleString()} ${plural(f.values, 'value')}` +
  (f.inAnalyses > 0 ? ` (${f.inAnalyses.toLocaleString()} in word analyses)` : '') +
  (f.outside === true ? ', not in the setup' : '');

// What one piece of a job wrote, in the report's words for its totals, in
// their order: "Sentences written in: 2, Changes written: 6, Words analyzed: 4,
// Gloss: 2 values." Each target's values as the report's rows say them, one
// written outside the setup said so. "Nothing written." when it wrote nothing.
const PIECE_COUNTS_BEFORE = [
  ['analyzed', 'Sentences written in'],
  ['changes', 'Changes written'],
  ['deletions', 'Deletions'],
  ['peoplesValuesChanged', 'People’s values, morphemes and links changed or removed'],
  ['textChanges', 'Changes to the text'],
  ['wordsAdded', 'Words added'],
  ['tokensChanged', 'Existing words or punctuation marks changed or removed'],
  ['translations', 'Translations written'],
  ['refreshed', 'Translations replaced'],
  ['words', 'Words analyzed'],
];
const PIECE_COUNTS_AFTER = [
  ['links', 'Lexicon links made'],
  ['entries', 'Entries created'],
  ['changed', 'Changes not written, changed during the job'],
  ['repeated', 'Changes left out, sentence written before an interruption'],
];
export const pieceWrittenText = (piece) => {
  const counts = piece?.counts || {};
  const said = (pairs) =>
    pairs
      .filter(([k]) => counts[k] > 0)
      .map(([k, label]) =>
        k === 'changes'
          ? `${label}: ${changesText(counts[k], piece.changesParts)}`
          : `${label}: ${counts[k].toLocaleString()}`,
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
    .map((f) => `${f.field}: ${fieldValuesText(f)}`);
  const parts = [...said(PIECE_COUNTS_BEFORE), ...fields, ...said(PIECE_COUNTS_AFTER)];
  return parts.length ? `${parts.join(', ')}.` : 'Nothing written.';
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
    ? 'you'
    : userId && userId === job?.startedBy && job.startedByName
      ? job.startedByName
      : (names[userId] ?? 'another user');

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
  if (oneStep(d)) return 'Worked in the one step';
  if (d.targets === null || d.targets === undefined) return '';
  // Under a plan limited by a search, those worked of the sentences the walk
  // takes, then the document's others as not found by the search (SF,
  // REV-SF-5, true of a sentence added since the planning too, REV-SF-7: a
  // document not yet reached reads by its matched count): "0 of 20, none
  // found by the plan's search", "0 of 3 matching, 17 not found by the
  // plan's search".
  if (plan?.pieces === 'sentences' && plan.search && typeof d.counts?.matched === 'number') {
    const all = Math.max(d.sentences ?? 0, d.targets);
    if (d.counts.matched === 0)
      return `0 of ${all.toLocaleString()}, none found by the plan’s search`;
    const skippedHere = Math.min(skippedCount(d), d.done ?? 0);
    const others = all - d.targets;
    return [
      `${((d.done ?? 0) - skippedHere).toLocaleString()} of ${d.targets.toLocaleString()} matching`,
      ...(skippedHere > 0 ? [`${skippedHere.toLocaleString()} skipped`] : []),
      ...(tooLongCount(d) > 0 ? [`${tooLongCount(d).toLocaleString()} too long`] : []),
      ...(others > 0
        ? [
            `${others.toLocaleString()} not found by the plan’s search` +
              (plan.onlyEmpty ? ' or with nothing to fill' : ''),
          ]
        : []),
    ].join(', ');
  }
  const skipped = Math.min(skippedCount(d), d.done ?? 0);
  const worked = `${((d.done ?? 0) - skipped).toLocaleString()} of ${d.targets.toLocaleString()}`;
  const tooLong = tooLongCount(d);
  return [
    worked,
    ...(skipped > 0 ? [`${skipped.toLocaleString()} skipped`] : []),
    ...(tooLong > 0 ? [`${tooLong.toLocaleString()} too long`] : []),
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
  const t = report?.totals || {};
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
    done: Math.max(0, (t.documentsDone ?? 0) - skipped - unmatched),
    changed,
    withNothingFoundByTheSearch: unmatched,
    skipped,
    stoppedPartway: partway,
    notReached: report?.documents
      ? Math.max(0, unfinished.length - partway - leftMore)
      : Math.max(0, (t.documentsNotReached ?? 0) - left - (t.documentsUnanswered ?? 0)),
    leftOut: left,
    unanswered: report?.documents ? unanswered : (t.documentsUnanswered ?? 0),
  };
};

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

// What follows a piece of the whole document or of all the documents in
// stretches is not done in a document that ended in use, deleted or not
// reached: those say so (REV-RW-7).
const NOT_AGAIN = {
  'in-use': 'Not worked again: in use.',
  gone: 'Not worked again: deleted.',
  'not-reached': 'Not worked again: the job ended.',
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
        ? 'No answer from the assistant.'
        : `${skippedText({ reason: 'failed', kind: piece.failed })}.`,
    );
  }
  if (piece.ended) {
    // `repeating`: the same tool call failed or was repeated three times in
    // a row (REV-JR1-6), in the words a skipped sentence uses for it.
    const what =
      piece.ended === 'output'
        ? 'Answer too long'
        : piece.ended === 'repeating'
          ? 'Model repeated itself'
          : 'Steps used up';
    out.push(
      (piece.counts?.changes ?? 0) > 0
        ? `${what}: written as staged.`
        : `${what}: what it had staged was not written.`,
    );
  }
  // Its documents then worked in stretches (`rest`, how many, and
  // `restDocuments`, which), said once the job has ended and only of those
  // documents (REV-RW-R2-6): while it runs that work is still to come.
  if (piece.rest > 0 && !active) {
    const listed = piece.restDocuments || [];
    const going = listed.filter((d) => !NOT_AGAIN[states.get(d)]).length;
    const what = piece.failed ? 'Worked again' : 'The rest worked';
    if (!piece.document && listed.length < piece.rest) {
      // Past the documents the summary lists, no outcome is claimed: only
      // how many the rest went to (REV-RW-R3-3).
      out.push(
        piece.failed
          ? `Then ${countOf(piece.rest, 'document')} went to stretches of sentences.`
          : `The rest went to stretches of sentences in ${countOf(piece.rest, 'document')}.`,
      );
    } else if (piece.document) {
      out.push(NOT_AGAIN[states.get(piece.document)] ?? `${what} in stretches of sentences.`);
    } else if (going === 0) {
      out.push('Not worked again.');
    } else if (going === piece.rest) {
      out.push(`${what} in stretches of sentences in ${countOf(going, 'document')}.`);
    } else {
      out.push(
        `${what} in stretches of sentences in ${countOf(going, 'document')} of ${piece.rest.toLocaleString()}.`,
      );
    }
  }
  return out;
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

// What a refusal the job could not follow left undone in a sentence, by the
// code the refusal carries (a closed set, never its text): the label a
// person reads under "Not done, refused:", naming the change not made
// (REV-DF-S-4, REV-DF3-5).
const REFUSED_TEXT = {
  text: 'Change to words the job retyped, split, merged or deleted',
  shape: 'Retype, split, merge or delete of words the job also changed',
  'entry-new': 'Change that uses an entry the job made',
  'entry-gone': 'Change that uses an entry the job deleted or merged',
  expression: 'Link inside a multi-word expression the job made',
  // A job set up to fill only the words it adds (R3).
  'not-added': 'Value on a word or sentence the job did not add',
  // An analysis of a word in a sentence the piece's own plan retyped (RPF3-B).
  retyped: 'Analysis of a word in a sentence the job retyped',
  // A change outside the piece's own sentences (RP3-2), a text edit too
  // under onlynew (REV-RPF3B-5). Named by where, as it was never made
  // (REV-RPF3B-10).
  outside: 'Outside the part’s own sentences',
};
export const refusedText = (code) => REFUSED_TEXT[code] ?? 'Refused';

// Why a change the job applied is listed among the proposed changes: its
// write was cut short (a lost answer, a crash, a refusal) and it was not
// written. The one reason there is.
export const changeReasonText = (reason) =>
  reason === 'interrupted' ? 'Not written, the write was interrupted' : reason;

// Why a form the job wrote is left inconsistent, by the worker's code (a
// closed set, each true of every analysis listed, CONTRACT, added by RPF).
export const HARMONIZE_LEFT_TEXT = {
  'job-differs-people-differ': 'The job’s analyses differ, and so do people’s',
  'job-differs-no-majority': 'The job’s analyses differ, none by two thirds',
  changed: 'Changed after the job wrote it',
  verified: 'A person verified it after the job wrote it',
  'beside-others': 'Also holds work that is not the job’s',
  unvouched: 'Not checked',
  commented: 'Has a comment',
  'in-mwe': 'In a multi-word expression',
  'in-use': 'Document in use',
  refused: 'Could not be written',
};

export const HARMONIZE_BY_TEXT = {
  person: 'A person’s analysis',
  majority: 'Majority',
};

// What is ahead of a waiting job in the queue, from core's `ahead`. Core lets a
// project hold one active job, so each of them is another project's.
export const aheadText = (n) =>
  n === 1 ? '1 job of another project ahead' : `${n.toLocaleString()} jobs of other projects ahead`;

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
export const setupTextText = (text) => (text ? 'May be edited' : 'Unchanged');

// The project's job that stood in the way of a start (core's 409 `job-active`),
// or null for any other error.
export const activeJobOf = (err) =>
  statusOf(err) === 409 && err.responseData?.code === 'job-active'
    ? (err.responseData.job ?? null)
    : null;
