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
// are named by role where the entry's rows say which (see undoneLine).
const KIND_WORDS = [
  ['spans', ['value', 'values']],
  ['tokens', null],
  ['vocabLinks', ['link', 'links']],
  ['vocabItems', ['lexicon entry', 'lexicon entries']],
  ['texts', ['text', 'texts']],
  ['documents', ['document', 'documents']],
  ['relations', ['other annotation', 'other annotations']],
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
 * label, count, places}]`. `count` is the group's listed rows, or for the
 * only group core's whole count. `place(row)` says where a row can be shown
 * (`{key, label, to}`, `to` an address or null), or null where it cannot:
 * `places` counts the group's rows per place, in the order first met, the
 * rows no place takes last as one place with no key.
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
  const out = [...groups.values()]
    .sort(
      (a, b) =>
        (REASON_ORDER.get(a.reason) ?? REASONS.length) -
        (REASON_ORDER.get(b.reason) ?? REASONS.length),
    )
    .map(({ byPlace, unplaced, ...g }) => ({
      ...g,
      places: [
        ...byPlace.values(),
        ...(unplaced ? [{ key: null, label: 'Elsewhere', to: null, count: unplaced }] : []),
      ],
    }));
  // One reason for every row: core's count covers the rows past those it
  // lists too.
  const total = summary?.skippedCount ?? skipped.length;
  if (out.length === 1 && total > out[0].count) out[0].count = total;
  return out;
};

/** How many rows `summary` leaves, listed or not. */
export const leftCount = (summary) => summary?.skippedCount ?? summary?.skipped?.length ?? 0;

// What core never undoes, by the operation types that wrote it.
const NOT_UNDONE = [
  [/^project\//, 'Project settings'],
  [/^(text-layer|token-layer|span-layer|relation-layer|layer)\//, 'Fields and their settings'],
  [/^vocab\//, 'Vocabularies and their settings'],
  [/^(user|invite|api-token)\//, 'Users and invitations'],
  [/^comment\//, 'Comments'],
];

/**
 * One line for each kind of change the entry made that no undo takes back
 * (`summary.notUndone`): "Project settings are not undone." An operation type
 * the table does not know is named by its code.
 */
export const notUndoneLines = (summary) => {
  const words = [];
  for (const { opType } of summary?.notUndone || []) {
    const w = NOT_UNDONE.find(([re]) => re.test(opType))?.[1] ?? opType;
    if (!words.includes(w)) words.push(w);
  }
  return words.map((w) => `${w} are not undone.`);
};

/** The toast after an undo: `{title, message}`. */
export const undoneToast = (summary, opts) => {
  const line = undoneLine(summary, opts);
  const left = leftCount(summary);
  const message = [
    line ? `${line[0].toUpperCase()}${line.slice(1)} undone.` : 'Nothing undone.',
    left ? `${countOf(left, 'change')} left as ${left === 1 ? 'it was' : 'they were'}.` : '',
  ]
    .filter(Boolean)
    .join(' ');
  return { title: 'Undone', message };
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
