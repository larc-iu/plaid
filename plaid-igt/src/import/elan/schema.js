// The tier SCHEMA of a set of .eaf files, and the consistency gate that a batch
// import has to pass. Pure.
//
// WHY A GATE. Importing a corpus means answering "which tier is the gloss?"
// once, not once per file, so every file in the batch must have the same tier
// structure. A batch that does not is refused outright with a report of exactly
// where the files disagree (see compareSchemas). Accepting a majority and
// silently skipping the rest would produce a half-imported corpus that looks
// complete, which is worse than an error.
//
// WHAT "THE SAME STRUCTURE" MEANS. Not the same TIER_IDs: ELAN names tiers
// `basename@participant`, and a top tier is often just the speaker's name, so
// two files recorded with different speakers have no tier names in common while
// being structurally identical. A schema NODE is therefore
//
//     (base name with the participant normalized out, linguistic type, parent node)
//
// keyed by its whole path from the root, so `mb@Ana` and `mb@Bo` collapse to one
// node and a tier can only match a tier in the same position of the tree. The
// linguistic type is part of the key because EAF's LINGUISTIC_TYPE is precisely
// "a definition of a type of tier"; the base name is part of it because one type
// is routinely shared by several tiers that mean different things (our own
// exporter gives every Symbolic_Association tier the same type).

import { baseTierName, stereotypeOf, isAlignableStereotype } from './readEaf.js';

/** Roles a schema node can be mapped onto in an IGT project. */
export const ROLES = Object.freeze({
  OFF: 'off',
  UTTERANCE: 'utterance',
  ALIGNMENT: 'alignment',
  WORD: 'word',
  MORPHEME: 'morpheme',
  SENTENCE_FIELD: 'sentenceField',
  WORD_FIELD: 'wordField',
  MORPH_FIELD: 'morphField',
  ORTHOGRAPHY: 'orthography',
});

const nodeKey = (parentKey, baseName, typeRef) =>
  `${parentKey ? `${parentKey}/` : ''}${baseName}:${typeRef}`;

/**
 * The schema of one parsed .eaf: one node per distinct tier position, with the
 * tiers (one per participant) that occupy it.
 *
 * @returns {Array<{key, baseName, typeRef, stereotype, parentKey, depth,
 *                  alignable, participants: string[], tierIds: string[],
 *                  annotationCount: number}>}
 */
export function tierSchema(eaf) {
  const byId = new Map(eaf.tiers.map((t) => [t.id, t]));
  const keyCache = new Map();

  // A tier's key is its path from the root, so position in the tree is part of
  // identity. Cycles cannot occur in a valid file but must not hang us.
  const keyOf = (tier, seen = new Set()) => {
    if (keyCache.has(tier.id)) return keyCache.get(tier.id);
    if (seen.has(tier.id)) return nodeKey(null, tier.baseName, tier.typeRef);
    seen.add(tier.id);
    const parent = tier.parentRef ? byId.get(tier.parentRef) : null;
    const key = nodeKey(parent ? keyOf(parent, seen) : null, tier.baseName, tier.typeRef);
    keyCache.set(tier.id, key);
    return key;
  };

  const nodes = new Map();
  for (const tier of eaf.tiers) {
    const key = keyOf(tier);
    const parent = tier.parentRef ? byId.get(tier.parentRef) : null;
    let node = nodes.get(key);
    if (!node) {
      const stereotype = stereotypeOf(eaf, tier);
      node = {
        key,
        baseName: tier.baseName,
        typeRef: tier.typeRef,
        stereotype,
        alignable: isAlignableStereotype(stereotype),
        parentKey: parent ? keyOf(parent) : null,
        depth: 0,
        participants: [],
        tierIds: [],
        annotationCount: 0,
      };
      nodes.set(key, node);
    }
    if (tier.participant && !node.participants.includes(tier.participant)) {
      node.participants.push(tier.participant);
    }
    node.tierIds.push(tier.id);
    node.annotationCount += tier.annotations.length;
  }

  // Depth, for indenting the mapping UI.
  const list = [...nodes.values()];
  const byKey = new Map(list.map((n) => [n.key, n]));
  for (const node of list) {
    let depth = 0;
    let cur = node.parentKey ? byKey.get(node.parentKey) : null;
    while (cur && depth < 50) {
      depth += 1;
      cur = cur.parentKey ? byKey.get(cur.parentKey) : null;
    }
    node.depth = depth;
  }
  // Parents before children, then by name, so the UI reads as a tree.
  return list.sort((a, b) => a.key.localeCompare(b.key));
}

/**
 * Groups of nodes whose base names differ ONLY in case ("Phrase" / "phrase").
 *
 * TIER_ID is case-sensitive in EAF, so this is a legal file and the two tiers
 * stay distinct everywhere here. But it is nearly always a mistake in the
 * corpus, and two rows a reader cannot tell apart is a bad way to ask someone
 * to map tiers, so it is reported rather than quietly tolerated.
 */
export function caseCollisions(nodes) {
  const byFolded = new Map();
  for (const node of nodes) {
    const folded = node.baseName.toLowerCase();
    if (!byFolded.has(folded)) byFolded.set(folded, []);
    byFolded.get(folded).push(node);
  }
  return [...byFolded.values()]
    .filter((group) => new Set(group.map((n) => n.baseName)).size > 1)
    .map((group) => group.map(nodeLabel).sort());
}

/** A stable string identifying a schema, for grouping files. */
export const signatureOf = (nodes) =>
  nodes
    .map((n) => `${n.key}|${n.stereotype ?? ''}`)
    .sort()
    .join('\n');

/** A human label for a node: the base name, or the speaker-tier placeholder. */
export const nodeLabel = (node) => node.baseName || '(speaker tier)';

/**
 * Group parsed files by schema and report whether the batch may proceed.
 *
 * A batch is consistent only when every file has the same schema. When it does
 * not, `differences` names the nodes that separate each minority group from the
 * largest one, in the words the user sees in the mapping table.
 *
 * @returns {{consistent, nodes, groups, differences}}
 */
export function compareSchemas(files) {
  const groups = new Map();
  for (const eaf of files) {
    const nodes = tierSchema(eaf);
    const signature = signatureOf(nodes);
    if (!groups.has(signature)) groups.set(signature, { signature, nodes, files: [] });
    groups.get(signature).files.push(eaf);
  }
  const list = [...groups.values()].sort((a, b) => b.files.length - a.files.length);
  if (list.length <= 1) {
    const nodes = list[0]?.nodes ?? [];
    return {
      consistent: true,
      nodes,
      groups: list,
      differences: [],
      caseCollisions: caseCollisions(nodes),
    };
  }

  // Describe every minority group against the largest one.
  const [main, ...rest] = list;
  const mainKeys = new Set(main.nodes.map((n) => n.key));
  const differences = rest.map((group) => {
    const keys = new Set(group.nodes.map((n) => n.key));
    const missing = main.nodes.filter((n) => !keys.has(n.key)).map(nodeLabel);
    const extra = group.nodes.filter((n) => !mainKeys.has(n.key)).map(nodeLabel);
    // "missing Phrase, extra phrase" is a baffling thing to read. Name it for
    // what it is, since a case-only difference between files is the likeliest
    // way a batch fails this gate by accident.
    const folded = new Set(extra.map((n) => n.toLowerCase()));
    const caseOnly = missing.filter((n) => folded.has(n.toLowerCase()));
    return { files: group.files.map((f) => f.fileName), missing, extra, caseOnly };
  });
  return {
    consistent: false,
    nodes: main.nodes,
    groups: list,
    differences,
    caseCollisions: caseCollisions(main.nodes),
  };
}

// ---- role suggestion -------------------------------------------------------

// Tier-name conventions that recur across ELAN corpora (Toolbox/Shoebox
// lineage, and what ELAN's own interlinearization produces). Matched on the
// normalized base name, case-insensitively, as a fallback AFTER the structural
// rules — position in the tier tree is far more reliable than a name.
const NAME_HINTS = [
  [/^(mb|morph|morphemes?|mor)$/i, ROLES.MORPHEME],
  [/^(ge|gl|gloss(es)?|gls|eng)$/i, ROLES.MORPH_FIELD],
  [/^(ps|pos|category|msa)$/i, ROLES.WORD_FIELD],
  [/^(ft|tr|translations?|free|fte?)$/i, ROLES.SENTENCE_FIELD],
  [/^(wd|w|words?|tx|t|text)$/i, ROLES.WORD],
  [/^(ipa|phon(etic)?|ortho\w*)$/i, ROLES.ORTHOGRAPHY],
  [/^(note|notes|comment)$/i, ROLES.SENTENCE_FIELD],
];

const hintFor = (node) => NAME_HINTS.find(([re]) => re.test(node.baseName))?.[1] ?? null;

// Names that a transcription tier goes by, and names that say a tier is
// certainly NOT the transcription. Only used to break ties between equally
// plausible root tiers: a file whose tiers all hold one annotation gives the
// annotation count nothing to say, and picking alphabetically got the Abui
// sample's `gloss` tier instead of its `transcription` tier.
const TRANSCRIPTION_NAME =
  /^(transcription|utterance|phrase|sentence|speech|spch|text|tx|t|ref|default|words?|wd)$/i;
const NOT_TRANSCRIPTION_NAME =
  /^(gloss(es)?|ge|gl|translations?|ft|tr|note|notes|comment|ipa|phon(etic)?|gesture\w*)$/i;

// Ranked best-first: a transcription-ish name wins, a gloss-ish name loses, and
// the annotation count decides among equals.
const nameScore = (name, weight) =>
  (TRANSCRIPTION_NAME.test(name) ? weight : 0) - (NOT_TRANSCRIPTION_NAME.test(name) ? weight : 0);

// The tier's own name counts double, but its LINGUISTIC_TYPE counts too: the
// type is the file's schema-level declaration of what kind of tier this is, and
// it breaks ties the name cannot. In the Abui fixture three roots are all
// named plausibly (`Phrase`, `phrase`, `transcription`) and all hold one
// annotation, so without the type the winner came down to sort order and the
// filler tier won.
const rankRoots = (roots) =>
  roots
    .map((n) => ({ n, score: nameScore(n.baseName, 2) + nameScore(n.typeRef, 1) }))
    .sort((a, b) => b.score - a.score || b.n.annotationCount - a.n.annotationCount)
    .map((x) => x.n);

/**
 * Pre-fill the mapping from the tier tree. Structure decides first: the best
 * top-level alignable node is the utterance, the subdivision beneath it is the
 * word and the one under that is the morpheme, and an alignable subdivision the
 * word did not claim is finer time alignment. Names break ties and choose
 * between the three field scopes.
 *
 * A word tier may be EITHER stereotype. Symbolic_Subdivision is what our own
 * exporter writes, but real corpora routinely give each word its own time with
 * Time_Subdivision (the Poio sample does), and treating those as alignment
 * collapsed the whole interlinear hierarchy beneath them.
 *
 * Every root that looks like an utterance is taken, not just the first: a
 * corpus may give each speaker a whole tier tree of their own, named by prefix
 * (`W-Spch`, `K-Spch`) rather than by `@participant`, and dropping the others
 * would silently discard a speaker.
 */
export function suggestRoles(nodes) {
  const roles = {};
  for (const n of nodes) roles[n.key] = ROLES.OFF;
  const byKey = new Map(nodes.map((n) => [n.key, n]));
  const childrenOf = (key) => nodes.filter((n) => n.parentKey === key);
  const isSubdivision = (n) =>
    n.stereotype === 'Symbolic_Subdivision' || n.stereotype === 'Time_Subdivision';

  const roots = rankRoots(nodes.filter((n) => !n.parentKey && n.alignable));
  if (!roots.length) return roles;

  // EXACTLY ONE utterance tier is ever suggested. Mapping several is supported
  // (a corpus may give each speaker a whole tier tree named by prefix rather
  // than by @participant), but that is a decision the user makes in the mapping
  // table, never a guess made here. An earlier version took every sibling root
  // of the same shape. Across twelve real files that rule never once found a
  // second speaker, and it did merge two unrelated tiers into one utterance
  // stream: an Abui fixture's `Phrase` and `phrase`, which differ only in case.
  // Guessing that two tiers are the same voice is not ours to do.
  const utterances = [roots[0]];

  for (const utterance of utterances) {
    roles[utterance.key] = ROLES.UTTERANCE;
    const subdivisions = childrenOf(utterance.key).filter(isSubdivision);
    const word =
      subdivisions.find((n) => hintFor(n) === ROLES.WORD) ??
      subdivisions.slice().sort((a, b) => b.annotationCount - a.annotationCount)[0] ??
      null;
    if (word) {
      roles[word.key] = ROLES.WORD;
      const morphCandidates = childrenOf(word.key).filter(isSubdivision);
      const morph =
        morphCandidates.find((n) => hintFor(n) === ROLES.MORPHEME) ?? morphCandidates[0] ?? null;
      if (morph) roles[morph.key] = ROLES.MORPHEME;
    }
    // Any alignable child the word did not claim carries finer time. That is
    // Included_In as well as Time_Subdivision: both hold real times, and
    // Included_In is what our own exporter writes for its segment tier.
    for (const child of childrenOf(utterance.key)) {
      if (roles[child.key] !== ROLES.OFF) continue;
      if (child.alignable && child.stereotype) roles[child.key] = ROLES.ALIGNMENT;
    }
  }

  // Everything still unassigned becomes a field at the scope of its parent,
  // except an orthography, which a name hint has to claim explicitly.
  const scopeOfParent = (node) => {
    const parent = node.parentKey ? byKey.get(node.parentKey) : null;
    if (!parent) return null;
    const parentRole = roles[parent.key];
    if (parentRole === ROLES.UTTERANCE) return ROLES.SENTENCE_FIELD;
    if (parentRole === ROLES.WORD) return ROLES.WORD_FIELD;
    if (parentRole === ROLES.MORPHEME) return ROLES.MORPH_FIELD;
    return null;
  };
  for (const node of nodes) {
    if (roles[node.key] !== ROLES.OFF) continue;
    const hint = hintFor(node);
    if (hint === ROLES.ORTHOGRAPHY && scopeOfParent(node) === ROLES.WORD_FIELD) {
      roles[node.key] = ROLES.ORTHOGRAPHY;
      continue;
    }
    roles[node.key] = scopeOfParent(node) ?? ROLES.OFF;
  }
  return roles;
}

export function validateRoles(nodes, roles) {
  const problems = [];
  const of = (role) => nodes.filter((n) => roles[n.key] === role);
  if (of(ROLES.UTTERANCE).length === 0) {
    problems.push('Choose which tier holds the utterances. Every import needs at least one.');
  }
  if (of(ROLES.MORPHEME).length && !of(ROLES.WORD).length) {
    problems.push('A morpheme tier needs a word tier above it.');
  }
  // Each word/morpheme tier has to sit under something that was mapped, or its
  // annotations have no parent to attach to.
  const byKey = new Map(nodes.map((n) => [n.key, n]));
  const roleOfParent = (node) =>
    node.parentKey ? roles[byKey.get(node.parentKey)?.key] : undefined;
  for (const node of of(ROLES.WORD)) {
    if (roleOfParent(node) !== ROLES.UTTERANCE) {
      problems.push(`"${nodeLabel(node)}" is words, so its parent tier must be utterances.`);
    }
  }
  for (const node of of(ROLES.MORPHEME)) {
    if (roleOfParent(node) !== ROLES.WORD) {
      problems.push(`"${nodeLabel(node)}" is morphemes, so its parent tier must be words.`);
    }
  }
  return problems;
}
