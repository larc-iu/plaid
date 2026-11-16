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

export const planText = (plan) => {
  if (!plan) return null;
  // Planning ended with no plan: the job ended writing nothing (REV-DF3-2),
  // worded by why it ended (REV-DF4-2).
  if (plan.by === 'none') return `${planEndedText(plan)} Nothing was written.`;
  let text = PIECES_TEXT[plan.pieces] ?? plan.pieces;
  if (plan.pieces === 'sentences' && plan.onlyEmpty) text += ', only those with something empty';
  // The documents worked apart: smaller than planned, or, after all of them
  // at once, walked a few sentences at a time (RP-4).
  const smaller = (plan.fallback || []).length;
  if (smaller) {
    text +=
      plan.pieces === 'selection'
        ? `, then ${smaller.toLocaleString()} in stretches of sentences`
        : `, ${smaller.toLocaleString()} in smaller pieces`;
  }
  text += '.';
  // What the plan fills, by the names the report gives (REV-DF-D-1).
  if (Array.isArray(plan.fillsNames)) {
    text += plan.fillsNames.length ? ` Fills: ${plan.fillsNames.join(', ')}.` : ' Fills nothing.';
  }
  // The plan says the instructions ask for the text itself to change
  // (plan_work's edits_text): only then may the job edit it.
  return plan.editsText ? `${text} Text may be edited.` : text;
};

// What each kind of change a job counts is called (the worker's
// `changes_parts`, CONTRACT, added by RPF): the report's one definition of a
// change, split.
const CHANGE_PART_WORDS = {
  values: ['value', 'values'],
  analyses: ['analysis', 'analyses'],
  links: ['link', 'links'],
  entries: ['lexicon entry', 'lexicon entries'],
  text: ['text edit', 'text edits'],
  other: ['other change', 'other changes'],
};

// Parts `[{kind, n}]` summed by kind, in the order first met.
export const sumParts = (lists) => {
  const sums = new Map();
  lists.forEach((parts) =>
    (parts || []).forEach((p) => sums.set(p.kind, (sums.get(p.kind) ?? 0) + (p.n ?? 0))),
  );
  return [...sums].map(([kind, n]) => ({ kind, n }));
};

// "253 (102 analyses and 151 links)": a count of changes with what they are,
// or the bare count where the parts are not known.
export const changesText = (n, parts) => {
  const said = (parts || [])
    .filter((p) => p.n > 0)
    .map((p) =>
      CHANGE_PART_WORDS[p.kind]
        ? countOf(p.n, ...CHANGE_PART_WORDS[p.kind])
        : `${p.n.toLocaleString()} ${p.kind}`,
    );
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
      `People's work: ${countOf(people, 'value, analysis or link', 'values, analyses or links')} ` +
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
  };
};

// How many pieces the findings of a job that fills nothing hold, each under
// its heading, and how many of the last did not fit whole (the worker's
// `findings_pieces` and `findings_cut`, REV-RPF-W-2). Null for one report
// (a single piece's, or the final context's from them all).
export const findingsPiecesText = (pieces, cut) => {
  if (!(pieces > 1)) return null;
  const head = `Findings of ${countOf(pieces, 'piece')}, each under its heading.`;
  if (!(cut > 0)) return head;
  return cut === 1
    ? `${head} The last one did not fit whole and is cut.`
    : `${head} The last ${cut.toLocaleString()} did not fit whole and are cut.`;
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
  ['peoplesValuesChanged', 'Changes to values people wrote'],
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
