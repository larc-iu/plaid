// Undoing one History entry: what core's answer (`client.audit.undo`) says
// would be undone and what would be left, in the app's words, for the Undo
// dialog of a document's or a vocabulary's History.
//
// Core puts every row the entry wrote back as it was just before it, and
// leaves a row it cannot put back with a reason. The reasons are read through
// one table, so a reason core adds later shows as its own code rather than
// breaking the dialog.

import { ROLES } from '@larc-iu/plaid-client';
import { t, msg, listOf } from '@ui/lib/i18n.js';
import { humanizeError, statusOf } from '@ui/lib/errors.js';

// Each kind of row: `n` of them named (`count`), and `n` of them said with
// what the undo does to them (`done`, by `act`, one of ACTS). One verb for one
// act whatever the kind (REV-RPF3B-7): one the entry deleted is brought back,
// one it made is removed, one it changed is put back as it was.
const NOUNS = {
  value: {
    count: msg('{n, plural, one {# value} other {# values}}'),
    done: msg(
      '{act, select, inserted {{n, plural, one {# value brought back} other {# values brought back}}} deleted {{n, plural, one {# value removed} other {# values removed}}} other {{n, plural, one {# value put back as it was} other {# values put back as they were}}}}',
    ),
  },
  link: {
    count: msg('{n, plural, one {# link} other {# links}}'),
    done: msg(
      '{act, select, inserted {{n, plural, one {# link brought back} other {# links brought back}}} deleted {{n, plural, one {# link removed} other {# links removed}}} other {{n, plural, one {# link put back as it was} other {# links put back as they were}}}}',
    ),
  },
  lexiconEntry: {
    count: msg('{n, plural, one {# lexicon entry} other {# lexicon entries}}'),
    done: msg(
      '{act, select, inserted {{n, plural, one {# lexicon entry brought back} other {# lexicon entries brought back}}} deleted {{n, plural, one {# lexicon entry removed} other {# lexicon entries removed}}} other {{n, plural, one {# lexicon entry put back as it was} other {# lexicon entries put back as they were}}}}',
    ),
  },
  text: {
    count: msg('{n, plural, one {# text} other {# texts}}'),
    done: msg(
      '{act, select, inserted {{n, plural, one {# text brought back} other {# texts brought back}}} deleted {{n, plural, one {# text removed} other {# texts removed}}} other {{n, plural, one {# text put back as it was} other {# texts put back as they were}}}}',
    ),
  },
  // The texts undone, said with the words and sentences of them a text edit
  // moved, added or removed, which no count a person reads says (RP-6).
  textWithWords: {
    done: msg(
      '{act, select, inserted {{n, plural, one {the text with its words and sentences brought back} other {# texts with their words and sentences brought back}}} deleted {{n, plural, one {the text with its words and sentences removed} other {# texts with their words and sentences removed}}} other {{n, plural, one {the text with its words and sentences put back as it was} other {# texts with their words and sentences put back as they were}}}}',
    ),
  },
  // A document's own row changed is its name and details.
  document: {
    done: msg(
      '{act, select, inserted {{n, plural, one {# document brought back} other {# documents brought back}}} deleted {{n, plural, one {# document removed} other {# documents removed}}} other {{n, plural, one {the document’s name or details put back as they were} other {# documents’ names or details put back as they were}}}}',
    ),
  },
  documentDetail: {
    count: msg('{n, plural, one {# document detail} other {# document details}}'),
  },
  otherAnnotation: {
    count: msg('{n, plural, one {# other annotation} other {# other annotations}}'),
    done: msg(
      '{act, select, inserted {{n, plural, one {# other annotation brought back} other {# other annotations brought back}}} deleted {{n, plural, one {# other annotation removed} other {# other annotations removed}}} other {{n, plural, one {# other annotation put back as it was} other {# other annotations put back as they were}}}}',
    ),
  },
  token: {
    count: msg('{n, plural, one {# token} other {# tokens}}'),
    done: msg(
      '{act, select, inserted {{n, plural, one {# token brought back} other {# tokens brought back}}} deleted {{n, plural, one {# token removed} other {# tokens removed}}} other {{n, plural, one {# token put back as it was} other {# tokens put back as they were}}}}',
    ),
  },
  sentence: {
    count: msg('{n, plural, one {# sentence} other {# sentences}}'),
    done: msg(
      '{act, select, inserted {{n, plural, one {# sentence brought back} other {# sentences brought back}}} deleted {{n, plural, one {# sentence removed} other {# sentences removed}}} other {{n, plural, one {# sentence put back as it was} other {# sentences put back as they were}}}}',
    ),
  },
  word: {
    count: msg('{n, plural, one {# word} other {# words}}'),
    done: msg(
      '{act, select, inserted {{n, plural, one {# word brought back} other {# words brought back}}} deleted {{n, plural, one {# word removed} other {# words removed}}} other {{n, plural, one {# word put back as it was} other {# words put back as they were}}}}',
    ),
  },
  morpheme: {
    count: msg('{n, plural, one {# morpheme} other {# morphemes}}'),
    done: msg(
      '{act, select, inserted {{n, plural, one {# morpheme brought back} other {# morphemes brought back}}} deleted {{n, plural, one {# morpheme removed} other {# morphemes removed}}} other {{n, plural, one {# morpheme put back as it was} other {# morphemes put back as they were}}}}',
    ),
  },
  timeAlignment: {
    count: msg('{n, plural, one {# time alignment} other {# time alignments}}'),
    done: msg(
      '{act, select, inserted {{n, plural, one {# time alignment brought back} other {# time alignments brought back}}} deleted {{n, plural, one {# time alignment removed} other {# time alignments removed}}} other {{n, plural, one {# time alignment put back as it was} other {# time alignments put back as they were}}}}',
    ),
  },
};

// `n` rows of `noun` named, and said with what `act` does to them.
const named = (noun, n) => t(NOUNS[noun].count, { n });
const doneOf = (noun) => (n, act) => t(NOUNS[noun].done, { n, act });

// What each kind of row is called, in the order the line names them. Tokens
// are named by role where the entry's rows say which (see undoneLine). A
// document's own row is its name and details.
const KIND_NOUNS = [
  ['spans', 'value'],
  ['tokens', null],
  ['vocabLinks', 'link'],
  ['vocabItems', 'lexiconEntry'],
  ['texts', 'text'],
  ['documents', 'document'],
  ['relations', 'otherAnnotation'],
];

const ACTS = ['inserted', 'deleted', 'updated'];

// Every part of `c` said by what happens to it (REV-RPF3B-2: a bare count
// read under the next part's verb). `said(k, act)` says `k` rows.
const byWhatHappens = (c, said) => ACTS.filter((a) => c?.[a]).map((a) => said(c[a], a));

// What this app calls the tokens of each role, in the order the line names
// them.
const ROLE_NOUNS = {
  [ROLES.SENTENCE]: 'sentence',
  [ROLES.WORD]: 'word',
  [ROLES.MORPHEME]: 'morpheme',
  [ROLES.TIME_ALIGNMENT]: 'timeAlignment',
};

const ROLE_ORDER = Object.keys(ROLE_NOUNS);

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
    if (left.has(r.id) || !ROLE_NOUNS[r.role]) continue;
    counts[r.role] = (counts[r.role] || 0) + 1;
    n += 1;
  }
  return n === total ? counts : null;
};

// The tokens' parts: by role where the rows give the roles and either one
// role or one act, so each count has its own verb; else as one noun (a job's
// morphemes, words, or tokens), each act its own count.
const tokenParts = (c, roles, fallback) => {
  const present = roles ? ROLE_ORDER.filter((r) => roles[r]) : [];
  const acts = ACTS.filter((a) => c?.[a]);
  if (present.length === 1) return byWhatHappens(c, doneOf(ROLE_NOUNS[present[0]]));
  if (present.length > 1 && acts.length === 1) {
    return present.map((r) => doneOf(ROLE_NOUNS[r])(roles[r], acts[0]));
  }
  return byWhatHappens(c, doneOf(fallback));
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
  for (const [kind, noun] of KIND_NOUNS) {
    const n = sum(summary?.undone?.[kind]);
    if (!n) continue;
    const c = summary.undone[kind];
    if (kind === 'texts' && withText) {
      parts.push(...byWhatHappens(c, doneOf('textWithWords')));
      continue;
    }
    if (kind !== 'tokens') {
      parts.push(...byWhatHappens(c, doneOf(noun)));
      continue;
    }
    const roles = tokensByRole(summary, tokenRows);
    if (!roles && withText) {
      // Said with the text, or, with no text undone, as tokens: a text
      // edit's are sentences or words, and the job may segment too
      // (S7-1, REV-SJ3-7).
      if (!sum(summary?.undone?.texts)) parts.push(...byWhatHappens(c, doneOf('token')));
      continue;
    }
    parts.push(
      ...tokenParts(c, roles, tokens === 'morphemes' && !tokenRows?.length ? 'morpheme' : 'token'),
    );
  }
  return listOf(parts);
};

// Why a row is left, in the order the dialog lists them.
const REASONS = [
  ['changed-since', msg('Changed again later')],
  ['changed-between', msg('Changed by someone else during the entry')],
  ['built-on', msg('Something was added to it since')],
  ['needs', msg('Needs something not brought back')],
  ['text-changed-since', msg('Text changed since')],
  ['place-taken', msg('Its place is taken')],
  ['not-permitted', msg('Not permitted')],
  ['locked', msg('Document locked by someone else')],
  ['name-taken', msg('Name taken by another document')],
  ['does-not-fit', msg('Would not fit the document')],
  ['value-not-allowed', msg('Value no longer allowed')],
  ['not-undone', msg('Vocabulary name and settings')],
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
      const words = REASON_WORDS.get(row.reason);
      g = {
        reason: row.reason,
        label: words ? t(words) : String(row.reason),
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
        ...(unplaced ? [{ key: null, label: t('Elsewhere'), to: null, count: unplaced }] : []),
      ],
    }));
};

// What each kind of row left is called, in the nouns of the line of what
// is undone, in its order (core's `kind` of a row left).
const ROW_NOUNS = [
  ['span', 'value'],
  ['token', null],
  ['vocab-link', 'link'],
  ['vocab-item', 'lexiconEntry'],
  ['text', 'text'],
  ['document', 'documentDetail'],
  ['relation', 'otherAnnotation'],
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
  const tokenNoun = (id) =>
    ROLE_NOUNS[roles.get(id)] ?? (tokens === 'morphemes' ? 'morpheme' : 'token');
  const counts = new Map();
  const add = (key, say) => {
    const c = counts.get(key) ?? { n: 0, say };
    c.n += 1;
    counts.set(key, c);
  };
  for (const r of rows || []) {
    if (r.kind === 'token') {
      const noun = tokenNoun(r.id);
      add(`token ${noun}`, (n) => named(noun, n));
    } else {
      const noun = ROW_NOUNS.find(([k]) => k === r.kind)?.[1];
      // A kind this table does not know is named by core's own code.
      add(r.kind, (n) =>
        noun ? named(noun, n) : t('{n, number} {kind}', { n, kind: String(r.kind) }),
      );
    }
  }
  const order = (key) => {
    const kind = key.startsWith('token ') ? 'token' : key;
    const i = ROW_NOUNS.findIndex(([k]) => k === kind);
    return i < 0 ? ROW_NOUNS.length : i;
  };
  const parts = [...counts].sort(([a], [b]) => order(a) - order(b)).map(([, c]) => c.say(c.n));
  if (more > 0) parts.push(t('{n, number} more', { n: more }));
  return listOf(parts);
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
  [/^project\//, msg('Project settings are not undone.')],
  [
    /^(text-layer|token-layer|span-layer|relation-layer|layer)\//,
    msg('Fields and their settings are not undone.'),
  ],
  [/^vocab\//, msg('Vocabularies and their settings are not undone.')],
  [/^(user|invite|api-token)\//, msg('Users and invitations are not undone.')],
  [/^comment\//, msg('Comments are not undone.')],
  [/^media\//, msg('Recordings are not undone.')],
];

/**
 * One line for each kind of change the entry made that no undo takes back
 * (`summary.notUndone`): "Project settings are not undone." An operation type
 * the table does not know reads "Changes of type <code> are not undone."
 */
export const notUndoneLines = (summary) => {
  const lines = [];
  for (const { opType } of summary?.notUndone || []) {
    const known = NOT_UNDONE.find(([re]) => re.test(opType))?.[1];
    const line = known ? t(known) : t('Changes of type {type} are not undone.', { type: opType });
    if (!lines.includes(line)) lines.push(line);
  }
  const unread = unreadableLine(summary);
  return [...lines, ...(unread ? [unread] : [])];
};

// The rows an undo leaves where the caller cannot read, which core counts and
// never names (`skippedUnreadable`, S9-3), or ''.
const unreadableLine = (summary) => {
  const n = summary?.skippedUnreadable ?? 0;
  if (!(n > 0)) return '';
  return t(
    '{n, plural, one {# change in documents or lexicons you cannot open is not undone.} other {# changes in documents or lexicons you cannot open are not undone.}}',
    { n },
  );
};

const capitalized = (line) => `${line[0].toUpperCase()}${line.slice(1)}`;

/**
 * The toast after an undo: `{title, message, undid}`. Titled by what the call
 * did, which a write between the dry run and it may have changed: "Undone",
 * or "Nothing undone". A caller that knows why nothing was undone puts its
 * sentence in `summary.already` (a job another page undid first, S6-3).
 */
export const undoneToast = (summary, opts) => {
  if (summary?.already) {
    return { title: t('Nothing undone'), message: summary.already, undid: false };
  }
  const line = undoneLine(summary, opts);
  const { total, unlisted } = leftCounts(summary);
  const left = total ? leftLine(summary?.skipped, opts, unlisted) : '';
  const message = [
    line ? capitalized(t('{list}.', { list: line })) : '',
    // Said apart from what was undone, never "as they were" twice
    // (REV-RPF3B-7).
    left ? capitalized(t('{list} not undone.', { list: left })) : '',
    unreadableLine(summary),
  ]
    .filter(Boolean)
    .join(' ');
  return { title: line ? t('Undone') : t('Nothing undone'), message, undid: !!line };
};

/**
 * Whether History entry `entry` is a job's undo (its ref exactly `job:`, an
 * id with no slash, `/undo`, case-sensitive, as core's rule),
 * which core refuses to undo (422 job-undo-final): History offers no Undo on it.
 */
export const isJobUndo = (entry) => /^job:[^/]+\/undo$/.test(entry?.ref ?? '');

/** The sentence for an undo core refused, or failed to give. */
export const undoError = (err, fallback) => {
  const status = statusOf(err);
  if (status === 422 && err?.responseData?.code === 'job-undo-final') {
    return t('A job’s undo cannot be undone.');
  }
  if (status === 413) return t('Too many changes to undo. An undo takes at most 20,000.');
  if (status === 422) return t('A project’s deletion cannot be undone.');
  if (status === 404 || (status === 403 && err?.responseData?.unresolved)) {
    return t('This entry does not exist or cannot be opened.');
  }
  if (status === 403) return t('Only a maintainer can undo this entry.');
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
    return Number.isFinite(n) && n > 0
      ? t(
          'This job made {n, plural, one {# change} other {# changes}}. An undo takes at most 20,000, so this job is undone document by document, from each document’s Changes link on this page.',
          { n },
        )
      : t(
          'This job made more than 20,000 changes. An undo takes at most 20,000, so this job is undone document by document, from each document’s Changes link on this page.',
        );
  }
  if (status === 409) return t('This job has not ended. A job is undone once it has stopped.');
  if (status === 403 && !err?.responseData?.unresolved)
    return t('Only a maintainer can undo this job.');
  if (status === 404 || status === 403) return t('This job does not exist or cannot be opened.');
  return undoError(err, fallback);
};
