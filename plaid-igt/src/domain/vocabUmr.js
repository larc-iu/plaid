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
