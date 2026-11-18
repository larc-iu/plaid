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
// are named by role where the entry's rows say which (see undoneLine). A
// document's own row is its name and details.
const KIND_WORDS = [
  ['spans', ['value', 'values']],
  ['tokens', null],
  ['vocabLinks', ['link', 'links']],
  ['vocabItems', ['lexicon entry', 'lexicon entries']],
  ['texts', ['text', 'texts']],
  ['documents', null],
  ['relations', ['other annotation', 'other annotations']],
];

const DOCUMENT = ['document', 'documents'];

// What happens to `k` rows by the undo's act on them, one verb for one act
// whatever the kind (REV-RPF3B-7): one the entry deleted is brought back, one
// it made is removed, one it changed is put back as it was.
const VERBS = {
  inserted: () => 'brought back',
  deleted: () => 'removed',
  updated: (k) => `put back as ${k === 1 ? 'it was' : 'they were'}`,
};
const ACTS = ['inserted', 'deleted', 'updated'];

// Every part of `c` said by what happens to it (REV-RPF3B-2: a bare count
// read under the next part's verb). `noun(k)` names `k` rows.
const byWhatHappens = (c, noun) =>
  ACTS.filter((a) => c?.[a]).map((a) => `${noun(c[a])} ${VERBS[a](c[a])}`);

const counted = (words) => (k) => countOf(k, ...words);

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

// The texts undone, said with the words and sentences of them a text edit
// moved, added or removed, which no count a person reads says (RP-6).
const textWithWords = (n) =>
  n === 1
    ? 'the text with its words and sentences'
    : `${n.toLocaleString()} texts with their words and sentences`;

// The tokens' parts: by role where the rows give the roles and either one
// role or one act, so each count has its own verb; else as one noun (a job's
// morphemes, words, or tokens), each act its own count.
const tokenParts = (c, roles, fallback) => {
  const present = roles ? ROLE_ORDER.filter((r) => roles[r]) : [];
  const acts = ACTS.filter((a) => c?.[a]);
  if (present.length === 1) return byWhatHappens(c, counted(TOKEN_ROLE_WORDS[present[0]]));
  if (present.length > 1 && acts.length === 1) {
    return present.map(
      (r) => `${countOf(roles[r], ...TOKEN_ROLE_WORDS[r])} ${VERBS[acts[0]](roles[r])}`,
    );
  }
  return byWhatHappens(c, counted(fallback));
};

/**
 * What `summary` undoes, as one line, every part said by what happens to it:
 * "12 values put back as they were, 3 morphemes removed and 2 lexicon
 * entries brought back". Empty when it undoes nothing. `tokenRows`, the
 * entry's token rows with the role of each one's layer, name the tokens by
 * role. Where there are none, `tokens` says what the tokens are, from what
 * wrote them (a job's report): `morphemes` (a job that edited no text writes
 * tokens only as morphemes), or `with-text` (a job that edited the text: the
 * tokens are not counted, and the text is said with its words and
 * sentences). Otherwise they are counted as tokens.
 */
export const undoneLine = (summary, { tokenRows, tokens } = {}) => {
  const parts = [];
  const withText = tokens === 'with-text' && !tokenRows?.length;
  for (const [kind, words] of KIND_WORDS) {
    const n = sum(summary?.undone?.[kind]);
    if (!n) continue;
    const c = summary.undone[kind];
    if (kind === 'documents') {
      // A document's own row changed is its name and details.
      parts.push(
        ...ACTS.filter((a) => c[a]).map((a) =>
          a === 'updated'
            ? `${c[a] === 1 ? 'the document’s name or details' : `${c[a].toLocaleString()} documents’ names or details`} ${VERBS.updated(2)}`
            : `${countOf(c[a], ...DOCUMENT)} ${VERBS[a](c[a])}`,
        ),
      );
      continue;
    }
    if (kind === 'texts' && withText) {
      parts.push(...byWhatHappens(c, textWithWords));
      continue;
    }
    if (kind !== 'tokens') {
      parts.push(...byWhatHappens(c, counted(words)));
      continue;
    }
    const roles = tokensByRole(summary, tokenRows);
    if (!roles && withText) {
      // Said with the text, or, with no text undone, as words.
      if (!sum(summary?.undone?.texts)) parts.push(...byWhatHappens(c, counted(['word', 'words'])));
      continue;
    }
    parts.push(
      ...tokenParts(
        c,
        roles,
        tokens === 'morphemes' && !tokenRows?.length ? ['morpheme', 'morphemes'] : TOKEN_WORDS,
      ),
    );
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

// What each kind of row left is called, in the nouns of the line of what
// is undone, in its order (core's `kind` of a row left).
const ROW_WORDS = [
  ['span', ['value', 'values']],
  ['token', null],
  ['vocab-link', ['link', 'links']],
  ['vocab-item', ['lexicon entry', 'lexicon entries']],
  ['text', ['text', 'texts']],
  ['document', ['document detail', 'document details']],
  ['relation', ['other annotation', 'other annotations']],
];

/**
 * Rows left (`rows`, core's `skipped` rows, `{kind, id}`), as one line in
 * the nouns of the line of what is undone: "2 values, 1 morpheme and 1
 * link". A token is named by its role where `tokenRows` says it, else by
 * what wrote it (`tokens`, as undoneLine reads it). `more` rows whose kind
 * is not known (core lists the first rows left only) close the line as "N
 * more". A kind this table does not know is named by its code.
 */
export const leftLine = (rows, { tokenRows, tokens } = {}, more = 0) => {
  const roles = new Map((tokenRows || []).map((r) => [r.id, r.role]));
  const tokenWords = (id) =>
    TOKEN_ROLE_WORDS[roles.get(id)] ??
    (tokens === 'morphemes'
      ? ['morpheme', 'morphemes']
      : tokens === 'with-text'
        ? ['word', 'words']
        : TOKEN_WORDS);
  const counts = new Map();
  const add = (key, words) => {
    const c = counts.get(key) ?? { n: 0, words };
    c.n += 1;
    counts.set(key, c);
  };
  for (const r of rows || []) {
    if (r.kind === 'token') {
      const words = tokenWords(r.id);
      add(`token ${words[0]}`, words);
    } else {
      const words = ROW_WORDS.find(([k]) => k === r.kind)?.[1] ?? [String(r.kind), String(r.kind)];
      add(r.kind, words);
    }
  }
  const order = (key) => {
    const kind = key.startsWith('token ') ? 'token' : key;
    const i = ROW_WORDS.findIndex(([k]) => k === kind);
    return i < 0 ? ROW_WORDS.length : i;
  };
  const parts = [...counts]
    .sort(([a], [b]) => order(a) - order(b))
    .map(([, c]) => countOf(c.n, ...c.words));
  if (more > 0) parts.push(`${more.toLocaleString()} more`);
  return andList(parts);
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
 * or "Nothing undone". A caller that knows why nothing was undone puts its
 * sentence in `summary.already` (a job another page undid first, S6-3).
 */
export const undoneToast = (summary, opts) => {
  if (summary?.already) return { title: 'Nothing undone', message: summary.already, undid: false };
  const line = undoneLine(summary, opts);
  const { total, unlisted } = leftCounts(summary);
  const left = total ? leftLine(summary?.skipped, opts, unlisted) : '';
  const message = [
    line ? `${line[0].toUpperCase()}${line.slice(1)}.` : '',
    // Said apart from what was undone, never "as they were" twice
    // (REV-RPF3B-7).
    left ? `${left[0].toUpperCase()}${left.slice(1)} not undone.` : '',
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
