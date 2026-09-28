// A vocabulary entry's UMR roleset, which plaid-umr reads off the entry and
// this app is where you write.
//
// The vocabulary is the cross-app place a project keeps its own rolesets: a
// UMR concept picker offers the bundled frame file of the project's language,
// then the entries of the vocabularies the project links, and an entry stands
// for the roleset `metadata.umr.roleset` names, described by
// `metadata.umr.args` the way a frame file describes one
// (`{ARG0: 'leaver', ARG1: 'thing left'}`). See plaid-umr's
// `src/domain/vocabLexicon.js`, which is the reader.
//
// Why it is edited HERE, in another app's namespace: the vocabulary screens
// are this app's, a vocabulary is cross-project and cross-app, and only four
// languages have a bundled frame file (English, Chinese, Arabic, Portuguese),
// so for most projects the vocabulary is the ONLY place a roleset can come
// from. A UMR-only entries screen would have meant a second copy of this
// editor, its list and its sense tree.

const UMR_NAMESPACE = 'umr';

/** The `umr` object of an entry's metadata, always an object. */
const readUmr = (metadata) => {
  const umr = metadata?.[UMR_NAMESPACE];
  return umr && typeof umr === 'object' && !Array.isArray(umr) ? umr : {};
};

/** The roleset an entry stands for, or '' when it stands for its own form. */
export const readRoleset = (metadata) => {
  const value = readUmr(metadata).roleset;
  return typeof value === 'string' ? value.trim() : '';
};

// What a UMR concept cannot hold, as plaid-umr's `conceptProblem`
// (`src/domain/format/penman.js`) has it: the characters PENMAN cannot carry
// in a concept. plaid-umr's `test/pickers.test.js` holds the two together.
const NOT_IN_ROLESET = /[\s():#"]/u;

/** Why `name` cannot be a roleset, or null when it can. */
export const rolesetProblem = (name) => {
  const text = String(name ?? '').trim();
  return NOT_IN_ROLESET.test(text)
    ? `A roleset cannot hold spaces, brackets, colons, quotes or #: ${text}`
    : null;
};

/**
 * The roleset's arguments as an ordered list of `{key, description}`, ARG0
 * first. Sorted by number rather than by string, so ARG10 follows ARG9.
 */
export const readArgs = (metadata) => {
  const args = readUmr(metadata).args;
  if (!args || typeof args !== 'object' || Array.isArray(args)) return [];
  return Object.entries(args)
    .filter(([k]) => ARG_KEY.test(k))
    .sort((a, b) => Number(a[0].slice(3)) - Number(b[0].slice(3)))
    .map(([key, description]) => ({
      key: key.toUpperCase(),
      description: String(description ?? ''),
    }));
};

const ARG_KEY = /^ARG\d+$/i;

/** Why `key` is not a usable argument name, or null when it is. */
export const argKeyProblem = (key) => {
  const k = String(key ?? '').trim();
  if (!k) return 'An argument needs a name.';
  return ARG_KEY.test(k) ? null : `An argument is named ARG0, ARG1 and so on: ${k}`;
};

/**
 * Each argument row's problem, or null: a name that is not an ARG, or one an
 * earlier row already has. Names compare as they are written, upper case.
 */
export const argRowProblems = (rows) => {
  const seen = new Set();
  return (rows || []).map((row) => {
    const bad = argKeyProblem(row.key);
    if (bad) return bad;
    const key = String(row.key).trim().toUpperCase();
    if (seen.has(key)) return `${key} is named twice.`;
    seen.add(key);
    return null;
  });
};

/**
 * The argument rows as they are written to the entry. A row with a problem
 * is not written as it stands: it keeps what it held when it was read
 * (`base`, a `{key, description}` pair), or is left out when it is new. So
 * a name half retyped, `ARG2` to `ARG` on its way to `ARG3`, never takes the
 * argument out of the entry, and two rows given one name never fold into one.
 */
export const argsToWrite = (rows) => {
  const problems = argRowProblems(rows);
  const good = (rows || []).filter((_, i) => !problems[i]);
  const named = new Set(good.map((r) => String(r.key).trim().toUpperCase()));
  const kept = (rows || [])
    .filter((r, i) => problems[i] && r.base && !named.has(String(r.base.key).toUpperCase()))
    .map((r) => r.base);
  return [
    ...good.map(({ key, description }) => ({ key: String(key).trim(), description })),
    ...kept,
  ];
};

/**
 * The next free argument name for a list, so adding a row does not collide
 * with one already there.
 */
export const nextArgKey = (args) => {
  const used = new Set((args || []).map((a) => String(a.key || '').toUpperCase()));
  for (let i = 0; i < 100; i += 1) if (!used.has(`ARG${i}`)) return `ARG${i}`;
  return 'ARG0';
};

/**
 * The entry's editable metadata with its `umr` object set from `roleset` and
 * `args`. An entry with neither loses the key entirely rather than keeping an
 * empty object: `cleanMeta` drops a blank string but not `{}`, and a stored
 * `umr: {}` would make every such entry look like it had been given a roleset
 * and taken back.
 *
 * Anything else already under `umr` is kept. The namespace belongs to another
 * app and this editor knows two of its keys, so it must not be the reason a
 * third goes missing.
 */
export const writeUmr = (fields, { roleset, args }) => {
  const rest = { ...readUmr(fields) };
  delete rest.roleset;
  delete rest.args;
  const name = String(roleset ?? '').trim();
  const pairs = (args || [])
    .filter((a) => String(a.key || '').trim() && !argKeyProblem(a.key))
    .map((a) => [String(a.key).toUpperCase(), String(a.description ?? '').trim()]);
  const next = {
    ...rest,
    ...(name ? { roleset: name } : {}),
    ...(pairs.length ? { args: Object.fromEntries(pairs) } : {}),
  };
  const out = { ...fields };
  if (Object.keys(next).length) out[UMR_NAMESPACE] = next;
  else delete out[UMR_NAMESPACE];
  return out;
};

/**
 * Is this vocabulary linked to a project set up for UMR? A UMR project is
 * known by its LAYERS: `createUmrProject` flags the node token layer
 * `config.umr.nodes` and writes no project-level config at all, so a project
 * that has never had a language or a gloss-line mapping set still counts.
 *
 * `projects.list()` carries each project's vocabs and its layer tree, so this
 * asks the call the screen already makes.
 */
export const linksUmrProject = (projects, vocabularyId) =>
  (projects || []).some(
    (p) =>
      (p?.vocabs || []).some((v) => v?.id === vocabularyId) &&
      (p?.textLayers || []).some((tl) =>
        (tl?.tokenLayers || []).some((t) => t?.config?.[UMR_NAMESPACE]?.nodes === true),
      ),
  );
