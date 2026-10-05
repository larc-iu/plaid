// The tier SCHEMA of a set of .eaf files, and the consistency gate that a batch
// import has to pass. Pure.
//
// WHY A GATE. Importing a corpus means answering "which tier is the gloss?"
// once, not once per file, so every file in the batch must read the same way:
// a tier name has to become the same thing wherever it appears. A batch that
// does not is refused outright with a report of exactly where the files
// disagree (see compareSchemas). Accepting a majority and silently skipping the
// rest would produce a half-imported corpus that looks complete, which is
// worse than an error.
//
// The gate compares MAPPINGS, not trees. Files exported from one FLEx project
// at different times differ in tree shape (a phrase-text tier present or not,
// a paragraph tier above it or not), and every tier below a moved one sits at
// a new path. A colleague's 23 such files split ten ways, each importing
// cleanly on its own. So each tree shape is a GROUP, its roles are suggested
// on its own tree, and the groups are joined into one mapping table by what
// their tiers become. A tier only some files have is a row only some files
// fill, which loses nothing. A tier that becomes different things in
// different files is the disagreement the gate refuses.
//
// WHAT "THE SAME TREE" MEANS, for a group. Not the same TIER_IDs: ELAN names
// tiers `basename@participant`, and a top tier is often just the speaker's name, so
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

import { stereotypeOf, isAlignableStereotype } from './readEaf.js';
import { parseElanFlexTierName } from './tierNaming.js';

/** Roles a schema node can be mapped onto in an IGT project. */
export const ROLES = Object.freeze({
  OFF: 'off',
  UTTERANCE: 'utterance',
  ALIGNMENT: 'alignment',
  WORD: 'word',
  MORPHEME: 'morpheme',
  MORPH_TYPE: 'morphType',
  SENTENCE_FIELD: 'sentenceField',
  WORD_FIELD: 'wordField',
  MORPH_FIELD: 'morphField',
  ORTHOGRAPHY: 'orthography',
});

export const NAMED_ROLES = new Set([
  ROLES.SENTENCE_FIELD,
  ROLES.WORD_FIELD,
  ROLES.MORPH_FIELD,
  ROLES.ORTHOGRAPHY,
]);

/** The scope a field role writes to, for looking a name up among the project's. */
export const SCOPE_OF_ROLE = {
  [ROLES.SENTENCE_FIELD]: 'Sentence',
  [ROLES.WORD_FIELD]: 'Word',
  [ROLES.MORPH_FIELD]: 'Morpheme',
};

const nodeKey = (parentKey, baseName, typeRef) =>
  `${parentKey ? `${parentKey}/` : ''}${baseName}:${typeRef}`;

/**
 * The schema of one parsed .eaf: one node per distinct tier position, with the
 * tiers (one per participant) that occupy it.
 *
 * @returns {Array<{key, baseName, typeRef, stereotype, parentKey, depth,
 *                  alignable, participants: string[], tierIds: string[],
 *                  annotationCount: number, filledCount: number}>}
 *   filledCount is the annotations that hold any text.
 */
export function tierSchema(eaf, canonical = null) {
  const byId = new Map(eaf.tiers.map((t) => [t.id, t]));
  const keyCache = new Map();
  // `canonical` folds a near-miss group onto one agreed name, which is how the
  // user says "these two spellings are the same tier". It is applied before
  // anything else looks at a name, so identity, keys and the tree all follow.
  const nameOf = (tier) => (canonical && canonical.get(foldName(tier.baseName))) || tier.baseName;

  // A tier's key is its path from the root, so position in the tree is part of
  // identity. Cycles cannot occur in a valid file but must not hang us.
  const keyOf = (tier, seen = new Set()) => {
    if (keyCache.has(tier.id)) return keyCache.get(tier.id);
    if (seen.has(tier.id)) return nodeKey(null, nameOf(tier), tier.typeRef);
    seen.add(tier.id);
    const parent = tier.parentRef ? byId.get(tier.parentRef) : null;
    const key = nodeKey(parent ? keyOf(parent, seen) : null, nameOf(tier), tier.typeRef);
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
        baseName: nameOf(tier),
        typeRef: tier.typeRef,
        stereotype,
        alignable: isAlignableStereotype(stereotype),
        parentKey: parent ? keyOf(parent) : null,
        depth: 0,
        participants: [],
        tierIds: [],
        annotationCount: 0,
        filledCount: 0,
      };
      nodes.set(key, node);
    }
    if (tier.participant && !node.participants.includes(tier.participant)) {
      node.participants.push(tier.participant);
    }
    node.tierIds.push(tier.id);
    node.annotationCount += tier.annotations.length;
    node.filledCount += tier.annotations.filter((a) => String(a.value ?? '').trim()).length;
  }

  return orderTree([...nodes.values()]);
}

/**
 * Nodes in tree order with their depth set, for the mapping UI: parents before
 * children, siblings in the order given. Sets `depth` on each node.
 */
function orderTree(list) {
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
  // Parents before children, so the UI reads as a tree, and siblings in the
  // file's order, which is the order the fields of the new project take.
  const children = new Map();
  const roots = [];
  for (const node of list) {
    if (node.parentKey && byKey.has(node.parentKey)) {
      if (!children.has(node.parentKey)) children.set(node.parentKey, []);
      children.get(node.parentKey).push(node);
    } else roots.push(node);
  }
  const ordered = new Set();
  const visit = (node) => {
    if (ordered.has(node)) return;
    ordered.add(node);
    for (const child of children.get(node.key) ?? []) visit(child);
  };
  roots.forEach(visit);
  // A cycle (an invalid file) has no root to reach it from.
  list.forEach(visit);
  return [...ordered];
}

/**
 * Groups of tier names that are NOT equal but read as though they were.
 *
 * Tier identity here is exact string equality, because that is what EAF itself
 * uses: TIER_ID carries an xsd:key and is case- and byte-sensitive, so "Phrase"
 * and "phrase" are two tiers and no amount of guessing should merge them.
 *
 * The danger is the other direction. A corpus that MEANT one tier but spelled
 * it two ways gets two rows in the mapping table that a reader cannot tell
 * apart, and whichever one is left unmapped is dropped. So names that fold
 * together are reported as near misses and the import will not proceed until
 * the user says they really are distinct.
 */

// The form a person reads a tier name as: canonical Unicode, no invisibles,
// runs of whitespace flattened, case ignored.
const foldName = (name) =>
  String(name ?? '')
    .normalize('NFC')
    .replace(/[\u200B-\u200D\u2060\uFEFF]/g, '')
    .replace(/\s+/g, ' ')
    .trim()
    .toLowerCase();

/** How two names that fold alike actually differ, in the user's words. */
function differenceKind(a, b) {
  const strip = (x) => String(x).replace(/[\u200B-\u200D\u2060\uFEFF]/g, '');
  if (strip(a) !== a || strip(b) !== b) return 'invisible characters';
  // Equal once normalized, but not before: the same letters spelled two ways.
  if (a.normalize('NFC') === b.normalize('NFC')) return 'Unicode spelling';
  if (a.toLowerCase() === b.toLowerCase()) return 'capitalization';
  if (a.replace(/\s+/g, ' ').trim() === b.replace(/\s+/g, ' ').trim()) return 'spacing';
  return 'capitalization and spacing';
}

/**
 * Near-miss groups among a schema's tier names.
 *
 * @returns {Array<{names: string[], differsBy: string}>}
 */
function nearMisses(nodes) {
  const byFolded = new Map();
  for (const node of nodes) {
    const folded = foldName(node.baseName);
    if (!folded) continue;
    if (!byFolded.has(folded)) byFolded.set(folded, []);
    byFolded.get(folded).push(node);
  }
  return [...byFolded.values()]
    .filter((group) => new Set(group.map((n) => n.baseName)).size > 1)
    .map((group) => {
      const names = [...new Set(group.map(nodeLabel))].sort();
      // Renaming only merges tiers that agree on everything else identity is
      // made of. Two tiers of different LINGUISTIC_TYPEs, or at different
      // places in the tree, stay separate however they are spelled, and
      // offering to merge them would silently do nothing and leave two rows
      // reading alike, which is the thing this whole check exists to prevent.
      const mergeable =
        new Set(group.map((n) => `${n.typeRef}\u0000${n.parentKey ?? ''}`)).size === 1;
      return {
        fold: foldName(names[0]),
        names,
        differsBy: differenceKind(names[0], names[1]),
        mergeable,
      };
    });
}

/** A stable string identifying a schema, for grouping files. */
export const signatureOf = (nodes) =>
  nodes
    .map((n) => `${n.key}|${n.stereotype ?? ''}`)
    .sort()
    .join('\n');

/** A human label for a node: the base name, or the speaker-tier placeholder. */
export const nodeLabel = (node) => node.baseName || '(speaker tier)';

// The roles that give a document its shape. A group has at most one tier in
// each as suggested, so across groups these rows join by role alone, whatever
// the tier is called.
const SPINE = [ROLES.UTTERANCE, ROLES.WORD, ROLES.MORPHEME];

// What a node is across groups: its role for the spine, else its role and
// name. A tier left out joins only a tier of the same name AND type, since
// nothing about it says what it is.
const identityOf = (node, role) => {
  if (SPINE.includes(role)) return role;
  if (role === ROLES.OFF) return `${role}\u0000${node.baseName}\u0000${node.typeRef}`;
  return `${role}\u0000${node.baseName}`;
};

/**
 * Join the groups' nodes into one list of ROWS, the mapping table's. The
 * largest group's nodes are rows as they are. A node of another group joins
 * the one row with its identity (identityOf), or, when there is none or more
 * than one, becomes a row of its own under the row its parent joined. Each
 * group gets `rowOf`, its node keys to row keys.
 *
 * A row holds every tier of every file that joined it, and `fileCount` counts
 * those files. `aliases` are other names a spine row goes by.
 */
function joinGroups(groups) {
  const rows = new Map();
  const byIdentity = new Map();
  const suggested = {};
  groups.forEach((group, gi) => {
    group.rowOf = new Map();
    const joined = new Set();
    for (const node of group.nodes) {
      const role = group.roles[node.key] ?? ROLES.OFF;
      const id = identityOf(node, role);
      const matches = byIdentity.get(id) ?? [];
      let row = gi > 0 && matches.length === 1 ? rows.get(matches[0]) : null;
      // Two nodes of one group are two rows, however alike they read.
      if (row && joined.has(row.key)) row = null;
      if (row) {
        for (const id of node.tierIds) {
          if (!row.tierIds.includes(id)) row.tierIds.push(id);
        }
        for (const p of node.participants) {
          if (!row.participants.includes(p)) row.participants.push(p);
        }
        row.annotationCount += node.annotationCount;
        row.filledCount += node.filledCount;
        if (node.baseName !== row.baseName && !row.aliases.includes(node.baseName)) {
          row.aliases.push(node.baseName);
        }
      } else {
        const key = rows.has(node.key) ? `${gi}\u0000${node.key}` : node.key;
        row = {
          ...node,
          key,
          parentKey: node.parentKey ? (group.rowOf.get(node.parentKey) ?? null) : null,
          tierIds: [...node.tierIds],
          participants: [...node.participants],
          aliases: [],
          fileCount: 0,
        };
        rows.set(key, row);
        byIdentity.set(id, [...matches, key]);
        suggested[key] = role;
      }
      row.fileCount += group.files.length;
      joined.add(row.key);
      group.rowOf.set(node.key, row.key);
    }
  });
  return { rows: orderTree([...rows.values()]), suggested };
}

const fileNames = (group) => group.files.map((f) => f.fileName);

// Whether a group's text is written from its words under these roles, as
// buildElanDocuments decides it (textFromWords): a FLEx phrase tier is the
// sentences and some tier is the words.
const writtenFromWords = (group, roles) => {
  const sentences = group.nodes.filter((n) => roles[n.key] === ROLES.UTTERANCE);
  return (
    Object.values(roles).includes(ROLES.WORD) &&
    sentences.every((n) => parseElanFlexTierName(nodeLabel(n))?.level === 'phrase')
  );
};

/**
 * Where the groups disagree about what a tier is.
 *
 * A tier name that becomes one thing in some files and another in others is
 * the batch the gate exists to refuse: one answer in the mapping table would
 * be wrong for some of the files. Leaving a tier out is not becoming something
 * (a segment-number tier is left out where a phrase tier carries the text and
 * is the sentences where none does).
 *
 * The sentence, word and morpheme rows join whatever their tiers are called,
 * and a name that differs there decides what the text is. That is allowed only
 * for the sentences of a text made in FLEx, whose text is written from its
 * words (buildElanDocuments' textFromWords), so the sentence tier's own text is
 * never read.
 *
 * @returns {Array<{tier: string, variants: Array<{role, files}>} |
 *                 {role, variants: Array<{name, files}>, nearMiss: boolean}>}
 */
function disagreements(groups) {
  const out = [];
  const rolesByName = new Map();
  for (const group of groups) {
    for (const node of group.nodes) {
      const role = group.roles[node.key] ?? ROLES.OFF;
      if (role === ROLES.OFF) continue;
      const name = nodeLabel(node);
      if (!rolesByName.has(name)) rolesByName.set(name, new Map());
      const byRole = rolesByName.get(name);
      byRole.set(role, [...(byRole.get(role) ?? []), ...fileNames(group)]);
    }
  }
  for (const [tier, byRole] of rolesByName) {
    if (byRole.size < 2) continue;
    out.push({ tier, variants: [...byRole].map(([role, files]) => ({ role, files })) });
  }

  const textFromWords = groups.every((group) => writtenFromWords(group, group.roles));
  for (const role of SPINE) {
    if (role === ROLES.UTTERANCE && textFromWords) continue;
    const byName = new Map();
    for (const group of groups) {
      for (const node of group.nodes) {
        if (group.roles[node.key] !== role) continue;
        const name = nodeLabel(node);
        byName.set(name, [...(byName.get(name) ?? []), ...fileNames(group)]);
      }
    }
    if (byName.size < 2) continue;
    out.push({
      role,
      variants: [...byName].map(([name, files]) => ({ name, files })),
      nearMiss: new Set([...byName.keys()].map(foldName)).size === 1,
    });
  }
  return out;
}

/**
 * Group parsed files by schema, join the groups into one mapping table, and
 * report whether the batch may proceed.
 *
 * Each group's roles are suggested on its own tree (suggestRoles), and the
 * rows (`nodes`) carry those suggestions as `suggested`. A batch is consistent
 * unless a tier name becomes different things in different files, which
 * `differences` names (see disagreements). A mapping chosen on the rows is
 * each group's through groupRoles, and a batch is validated and built group by
 * group (validateBatch, buildElanBatch), since a field is found through its own
 * file's tree.
 *
 * @returns {{consistent, files, nodes, suggested, groups, differences, nearMisses}}
 */
export function compareSchemas(files, canonical = null) {
  const groups = new Map();
  for (const eaf of files) {
    const nodes = tierSchema(eaf, canonical);
    const signature = signatureOf(nodes);
    if (!groups.has(signature)) groups.set(signature, { signature, nodes, files: [] });
    const group = groups.get(signature);
    group.files.push(eaf);
    // A node holds the tiers of EVERY file that shares this schema, not just
    // the first one's. Two files with the same tiers under different speakers
    // (`Sentence@Ada`, `Sentence@Bo`) have the same schema, since a
    // participant is normalized out of a tier's name, but not the same tier
    // ids, and the import finds a file's tiers by those ids. Reading them off
    // one file left every other file in the batch importing as an empty
    // document. The counts add up for the same reason: what the mapping table
    // shows is what the batch holds.
    if (group.nodes !== nodes) {
      const byKey = new Map(group.nodes.map((n) => [n.key, n]));
      for (const node of nodes) {
        const kept = byKey.get(node.key);
        if (!kept) continue;
        for (const id of node.tierIds) if (!kept.tierIds.includes(id)) kept.tierIds.push(id);
        for (const p of node.participants) {
          if (!kept.participants.includes(p)) kept.participants.push(p);
        }
        kept.annotationCount += node.annotationCount;
        kept.filledCount += node.filledCount;
      }
    }
  }
  const list = [...groups.values()].sort((a, b) => b.files.length - a.files.length);
  for (const group of list) group.roles = suggestRoles(group.nodes);
  // Across every group, not just the largest: a name misspelled in one file is
  // exactly what splits a batch in two, and that pair is the one worth showing.
  const misses = nearMisses(list.flatMap((g) => g.nodes));
  const { rows, suggested } = joinGroups(list);
  const differences = list.length > 1 ? disagreements(list) : [];
  return {
    consistent: differences.length === 0,
    files,
    nodes: rows,
    suggested,
    groups: list,
    differences,
    nearMisses: misses,
  };
}

/** A mapping chosen on the rows, as one group's own: its node keys to roles. */
export const groupRoles = (group, roles) =>
  Object.fromEntries(group.nodes.map((n) => [n.key, roles[group.rowOf.get(n.key)] ?? ROLES.OFF]));

/** Values filed under row keys (field names), filed under one group's node keys. */
export const groupValues = (group, values) =>
  Object.fromEntries(
    group.nodes
      .filter((n) => values[group.rowOf.get(n.key)] !== undefined)
      .map((n) => [n.key, values[group.rowOf.get(n.key)]]),
  );

/**
 * validateRoles over every group of a batch, each problem said once.
 *
 * Sentence tiers named differently in different files were joined only
 * because the text is written from the words (disagreements). A mapping that
 * drops the words would read each file's own sentence tier instead, which in
 * some files holds only segment numbers.
 */
export function validateBatch(comparison, roles) {
  const problems = new Set();
  const sentenceNames = new Set();
  let fromWords = true;
  for (const group of comparison.groups) {
    const own = groupRoles(group, roles);
    for (const p of validateRoles(group.nodes, own)) problems.add(p);
    for (const n of group.nodes)
      if (own[n.key] === ROLES.UTTERANCE) sentenceNames.add(nodeLabel(n));
    fromWords = fromWords && writtenFromWords(group, own);
  }
  if (sentenceNames.size > 1 && !fromWords) {
    problems.add(
      'The sentence tier has a different name in some files, so the sentences are written from the words. Choose a tier for Words.',
    );
  }
  return [...problems];
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
  const childrenOf = (key) => nodes.filter((n) => n.parentKey === key);
  const isSubdivision = (n) =>
    n.stereotype === 'Symbolic_Subdivision' || n.stereotype === 'Time_Subdivision';

  // A top-level tier with no text holds no sentences. ELAN's own FLEx import
  // writes one (a paragraph tier of blank, time-aligned annotations) with the
  // phrases Included_In it, and taking it gave a document of nothing. Such a
  // tier stands aside for its time-aligned children that do hold text.
  const tops = nodes.filter((n) => !n.parentKey && n.alignable);
  const withText = tops.flatMap((n) =>
    n.filledCount > 0
      ? [n]
      : childrenOf(n.key).filter((c) => c.alignable && c.stereotype && c.filledCount > 0),
  );
  // A batch in which no tier holds any annotation at all, such as our own
  // export of documents that have no text yet, still has a sentence tier: the
  // empty one. Its documents come back empty, as they were. A tier of blank
  // annotations is not empty in this sense, and still stands aside.
  const candidates = withText.length ? withText : tops.filter((n) => n.annotationCount === 0);
  const roots = rankRoots(candidates);
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
      if (morph) {
        roles[morph.key] = ROLES.MORPHEME;
        // ELAN's FLEx import gives the morph type a tier of its own.
        for (const child of childrenOf(morph.key)) {
          if (parseElanFlexTierName(child.baseName)?.itemType === 'type') {
            roles[child.key] = ROLES.MORPH_TYPE;
          }
        }
      }
    }
    // Any alignable child the word did not claim carries finer time. That is
    // Included_In as well as Time_Subdivision: both hold real times, and
    // Included_In is what our own exporter writes for its segment tier.
    for (const child of childrenOf(utterance.key)) {
      if (roles[child.key] !== ROLES.OFF) continue;
      if (child.alignable && child.stereotype) roles[child.key] = ROLES.ALIGNMENT;
    }
  }

  // Everything still unassigned becomes a field at the scope of the sentence,
  // word or morpheme it hangs from (anchorOf), except an orthography, which a
  // name has to claim explicitly.
  const scopeOfAnchor = (node) => {
    const anchorRole = roles[anchorOf(nodes, node)?.key];
    if (anchorRole === ROLES.UTTERANCE) return ROLES.SENTENCE_FIELD;
    if (anchorRole === ROLES.WORD) return ROLES.WORD_FIELD;
    if (anchorRole === ROLES.MORPHEME) return ROLES.MORPH_FIELD;
    return null;
  };
  for (const node of nodes) {
    if (roles[node.key] !== ROLES.OFF) continue;
    const flex = parseElanFlexTierName(node.baseName);
    // A segment number is the sentence's position, which the document keeps.
    if (flex?.level === 'phrase' && flex.itemType === 'segnum') continue;
    const scope = scopeOfAnchor(node);
    const spelling = flex?.level === 'word' && flex.itemType === 'txt';
    if ((spelling || hintFor(node) === ROLES.ORTHOGRAPHY) && scope === ROLES.WORD_FIELD) {
      roles[node.key] = ROLES.ORTHOGRAPHY;
      continue;
    }
    roles[node.key] = scope ?? ROLES.OFF;
  }
  return roles;
}

/**
 * The sentence, word or morpheme tier a tier hangs from: its parent, or, up a
 * chain of Symbolic_Association tiers, the first ancestor that is not one. A
 * field may sit below another field: the analysis tiers added to a FLEx text
 * in ELAN hang from its segment-number tier, not from the phrase, and they
 * still say something about the phrase. Null for a root.
 */
function anchorOf(nodes, node) {
  const byKey = new Map(nodes.map((n) => [n.key, n]));
  let cur = node.parentKey ? byKey.get(node.parentKey) : null;
  let guard = 0;
  while (cur && cur.stereotype === 'Symbolic_Association' && guard++ < 50) {
    cur = cur.parentKey ? byKey.get(cur.parentKey) : null;
  }
  return cur ?? null;
}

export function validateRoles(nodes, roles) {
  const problems = [];
  const of = (role) => nodes.filter((n) => roles[n.key] === role);
  if (of(ROLES.UTTERANCE).length === 0) {
    problems.push('Choose which tier holds the sentences. Every import needs one.');
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
      problems.push(`"${nodeLabel(node)}" is words, so its parent tier must be sentences.`);
    }
  }
  for (const node of of(ROLES.MORPHEME)) {
    if (roleOfParent(node) !== ROLES.WORD) {
      problems.push(`"${nodeLabel(node)}" is morphemes, so its parent tier must be words.`);
    }
  }
  for (const node of of(ROLES.MORPH_TYPE)) {
    if (roleOfParent(node) !== ROLES.MORPHEME) {
      problems.push(
        `"${nodeLabel(node)}" is morpheme types, so its parent tier must be morphemes.`,
      );
    }
  }
  for (const node of of(ROLES.UTTERANCE)) {
    if (node.annotationCount > 0 && node.filledCount === 0) {
      problems.push(
        `"${nodeLabel(node)}" holds no text. Choose the tier that holds the sentences.`,
      );
    }
  }
  // A field is read off the sentence, word or morpheme it hangs from, so one
  // under anything else would import nothing and say nothing.
  const needs = [
    [ROLES.SENTENCE_FIELD, ROLES.UTTERANCE, 'a sentence field', 'sentences'],
    [ROLES.WORD_FIELD, ROLES.WORD, 'a word field', 'words'],
    [ROLES.ORTHOGRAPHY, ROLES.WORD, 'an orthography', 'words'],
    [ROLES.MORPH_FIELD, ROLES.MORPHEME, 'a morpheme field', 'morphemes'],
  ];
  for (const [role, anchorRole, what, under] of needs) {
    for (const node of of(role)) {
      if (roles[anchorOf(nodes, node)?.key] !== anchorRole) {
        problems.push(`"${nodeLabel(node)}" is ${what}, so it must sit under the ${under}.`);
      }
    }
  }
  return problems;
}
