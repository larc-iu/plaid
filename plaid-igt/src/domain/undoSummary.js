// Undoing one History entry: what core's answer (`client.audit.undo`) says
// would be undone and what would be left, in the app's words, for the Undo
// dialog of a document's or a vocabulary's History.
//
// Core puts every row the entry wrote back as it was just before it, and
// leaves a row it cannot put back with a reason. The reasons are read through
// one table, so a reason core adds later shows as its own code rather than
// breaking the dialog.

import { countOf, andList } from '@ui/lib/plural.js';
import { humanizeError, statusOf } from '@ui/lib/errors.js';
import { TOKEN_ROLE_WORDS } from './restoreSummary.js';

// What each kind of row is called, in the order the line names them. Tokens
// are named by role where the entry's rows say which (see undoneLine). An
// entry or a document is named by what happens to it: one the entry deleted
// is brought back, one it made is removed, and one it changed is set back
// (a document's own row is its name and details).
const KIND_WORDS = [
  ['spans', ['value', 'values']],
  ['tokens', null],
  ['vocabLinks', ['link', 'links']],
  ['vocabItems', null],
  ['texts', ['text', 'texts']],
  ['documents', null],
  ['relations', ['other annotation', 'other annotations']],
];

const ENTRY = ['lexicon entry', 'lexicon entries'];
const DOCUMENT = ['document', 'documents'];

const byWhatHappens = (c, words, changed) => [
  ...(c?.inserted ? [`${countOf(c.inserted, ...words)} brought back`] : []),
  ...(c?.deleted ? [`${countOf(c.deleted, ...words)} removed`] : []),
  ...(c?.updated ? [changed(c.updated)] : []),
];

const TOKEN_WORDS = ['token', 'tokens'];

const ROLE_ORDER = Object.keys(TOKEN_ROLE_WORDS);

const sum = (c) => (c?.inserted ?? 0) + (c?.updated ?? 0) + (c?.deleted ?? 0);

// The tokens undone by role: each of the entry's token rows (`tokenRows`,
// `[{id, role}]`) not left. Only when that accounts for every token core
// counts and every row left is listed; otherwise null, and the tokens are
// one count.
const tokensByRole = (summary, tokenRows) => {
  const total = sum(summary?.undone?.tokens);
  const skipped = summary?.skipped || [];
  if (!tokenRows?.length || (summary?.skippedCount ?? skipped.length) > skipped.length) return null;
  const left = new Set(skipped.filter((r) => r.kind === 'token').map((r) => r.id));
  const counts = {};
  let n = 0;
  for (const r of tokenRows) {
    if (left.has(r.id) || !TOKEN_ROLE_WORDS[r.role]) continue;
    counts[r.role] = (counts[r.role] || 0) + 1;
    n += 1;
  }
  return n === total ? counts : null;
};

/**
 * What `summary` undoes, as one line: "12 values, 3 morphemes, 2 lexicon
 * entries and 5 links". Empty when it undoes nothing. `tokenRows`, the
 * entry's token rows with the role of each one's layer, name the tokens by
 * role.
 */
export const undoneLine = (summary, { tokenRows } = {}) => {
  const parts = [];
  for (const [kind, words] of KIND_WORDS) {
    const n = sum(summary?.undone?.[kind]);
    if (!n) continue;
    const c = summary.undone[kind];
    if (kind === 'vocabItems') {
      parts.push(...byWhatHappens(c, ENTRY, (k) => `${countOf(k, ...ENTRY)} set back`));
      continue;
    }
    if (kind === 'documents') {
      parts.push(
        ...byWhatHappens(c, DOCUMENT, (k) =>
          k === 1 ? 'the document’s name or details' : `${k} documents’ names or details`,
        ),
      );
      continue;
    }
    if (kind !== 'tokens') {
      parts.push(countOf(n, ...words));
      continue;
    }
    const roles = tokensByRole(summary, tokenRows);
    if (!roles) {
      parts.push(countOf(n, ...TOKEN_WORDS));
      continue;
    }
    for (const role of ROLE_ORDER) {
      if (roles[role]) parts.push(countOf(roles[role], ...TOKEN_ROLE_WORDS[role]));
    }
  }
  return andList(parts);
};

// Why a row is left, in the order the dialog lists them.
const REASONS = [
  ['changed-since', 'Changed again later'],
  ['changed-between', 'Changed by someone else during the entry'],
  ['built-on', 'Something was added to it since'],
  ['needs', 'Needs something not brought back'],
  ['text-changed-since', 'Text changed since'],
  ['place-taken', 'Its place is taken'],
  ['not-permitted', 'Not permitted'],
  ['locked', 'Document locked by someone else'],
  ['name-taken', 'Name taken by another document'],
  ['does-not-fit', 'Would not fit the document'],
  ['value-not-allowed', 'Value no longer allowed'],
  ['not-undone', 'Vocabulary name and settings'],
];
const REASON_WORDS = new Map(REASONS);
const REASON_ORDER = new Map(REASONS.map(([r], i) => [r, i]));

/**
 * The rows `summary` leaves, grouped by reason in the dialog's order (a
 * reason this table does not know comes last, named by its code): `[{reason,
 * label, count, places}]`. `count` is the group's listed rows: core lists the
 * first of them only (`leftCounts` says how many it did not). `place(row)`
 * says where a row can be shown (`{key, label, to}`, `to` an address or
 * null), or null where it cannot: `places` counts the group's rows per place,
 * in the order first met, the rows no place takes last as one place with no
 * key.
 */
export const leftGroups = (summary, place = () => null) => {
  const skipped = summary?.skipped || [];
  const groups = new Map();
  for (const row of skipped) {
    let g = groups.get(row.reason);
    if (!g) {
      g = {
        reason: row.reason,
        label: REASON_WORDS.get(row.reason) ?? String(row.reason),
        count: 0,
        byPlace: new Map(),
        unplaced: 0,
      };
      groups.set(row.reason, g);
    }
    g.count += 1;
    const at = place(row);
    if (!at) {
      g.unplaced += 1;
      continue;
    }
    const p = g.byPlace.get(at.key);
    if (p) p.count += 1;
    else g.byPlace.set(at.key, { ...at, count: 1 });
  }
  return [...groups.values()]
    .sort(
      (a, b) =>
        (REASON_ORDER.get(a.reason) ?? REASONS.length) -
        (REASON_ORDER.get(b.reason) ?? REASONS.length),
    )
    .map(({ byPlace, unplaced, ...g }) => ({
      ...g,
      places: [
        // In the order the place gives (`rank`), else as first met.
        ...[...byPlace.values()].sort((a, b) => (a.rank ?? 0) - (b.rank ?? 0)),
        ...(unplaced ? [{ key: null, label: 'Elsewhere', to: null, count: unplaced }] : []),
      ],
    }));
};

/**
 * How many rows `summary` leaves (`total`, core's count), how many of them it
 * lists (`listed`), and how many it does not (`unlisted`), whose reasons are
 * not known.
 */
export const leftCounts = (summary) => {
  const listed = summary?.skipped?.length ?? 0;
  const total = Math.max(summary?.skippedCount ?? listed, listed);
  return { total, listed, unlisted: total - listed };
};

// What core never undoes, by the operation types that wrote it.
const NOT_UNDONE = [
  [/^project\//, 'Project settings'],
  [/^(text-layer|token-layer|span-layer|relation-layer|layer)\//, 'Fields and their settings'],
  [/^vocab\//, 'Vocabularies and their settings'],
  [/^(user|invite|api-token)\//, 'Users and invitations'],
  [/^comment\//, 'Comments'],
  [/^media\//, 'Recordings'],
];

/**
 * One line for each kind of change the entry made that no undo takes back
 * (`summary.notUndone`): "Project settings are not undone." An operation type
 * the table does not know reads "Changes of type <code> are not undone."
 */
export const notUndoneLines = (summary) => {
  const words = [];
  for (const { opType } of summary?.notUndone || []) {
    const w = NOT_UNDONE.find(([re]) => re.test(opType))?.[1] ?? `Changes of type ${opType}`;
    if (!words.includes(w)) words.push(w);
  }
  return words.map((w) => `${w} are not undone.`);
};

/**
 * The toast after an undo: `{title, message, undid}`. Titled by what the call
 * did, which a write between the dry run and it may have changed: "Undone",
 * or "Nothing undone".
 */
export const undoneToast = (summary, opts) => {
  const line = undoneLine(summary, opts);
  const left = leftCounts(summary).total;
  const message = [
    line ? `${line[0].toUpperCase()}${line.slice(1)}.` : '',
    left ? `${countOf(left, 'change')} left as ${left === 1 ? 'it was' : 'they were'}.` : '',
  ]
    .filter(Boolean)
    .join(' ');
  return { title: line ? 'Undone' : 'Nothing undone', message, undid: !!line };
};

/** The sentence for an undo core refused, or failed to give. */
export const undoError = (err, fallback) => {
  const status = statusOf(err);
  if (status === 413) return 'Too many changes to undo. An undo takes at most 20,000.';
  if (status === 422) return 'A project’s deletion cannot be undone.';
  if (status === 404 || (status === 403 && err?.responseData?.unresolved)) {
    return 'This entry does not exist or cannot be opened.';
  }
  if (status === 403) return 'Only a maintainer can undo this entry.';
  return humanizeError(err, fallback);
};

/**
 * The sentence for a job's undo core refused. Past the limit, how many
 * changes the job made (core's 413 names the number) and that it is undone
 * document by document, from each document's Changes link on this page.
 */
export const jobUndoError = (err, fallback) => {
  const status = statusOf(err);
  if (status === 413) {
    const n = Number(
      /changed (\d+) rows/.exec(err?.responseData?.error ?? err?.message ?? '')?.[1],
    );
    const made =
      Number.isFinite(n) && n > 0
        ? `This job made ${countOf(n, 'change')}.`
        : 'This job made more than 20,000 changes.';
    return `${made} An undo takes at most 20,000, so this job is undone document by document, from each document’s Changes link on this page.`;
  }
  if (status === 409) return 'This job has not ended. A job is undone once it has stopped.';
  if (status === 403 && !err?.responseData?.unresolved)
    return 'Only a maintainer can undo this job.';
  if (status === 404 || status === 403) return 'This job does not exist or cannot be opened.';
  return undoError(err, fallback);
};
