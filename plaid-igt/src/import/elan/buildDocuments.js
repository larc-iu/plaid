// Parsed .eaf files + a tier mapping → importable document models. Pure.
//
// The hard part of ELAN import is that EAF HAS NO TEXT. There is no baseline
// string anywhere in the file: the text lives distributed across annotations,
// and everything below the utterance is a reference to a parent annotation
// rather than a character range. So the baseline is SYNTHESIZED here by joining
// the utterance values with newlines, and every offset below it is re-derived:
//
//   utterance  → one sentence token over its slice of the synthesized body
//   words      → aligned inside that slice (../align.js, via alignWords), the
//                same problem the CLDF and FLEx importers already solve
//   morphemes  → no alignment needed; a Plaid morpheme shares its word's whole
//                extent and carries metadata.form
//
// Newline as the joiner is deliberate: it is what the .flextext exporter reads
// as a paragraph break, and it keeps one utterance per line so the synthesized
// body is legible in the baseline editor.
//
// UTTERANCE ORDER is by start time, stably, so a multi-speaker file interleaves
// correctly instead of emitting all of one speaker and then all of the next.
// EAF allows unaligned annotations (a time slot with no TIME_VALUE), and those
// have no place in a time ordering, so they keep their document order and
// follow the timed ones.
//
// TIME goes back to seconds: EAF stores milliseconds, Plaid's alignment layer
// stores seconds in metadata.timeBegin/timeEnd.

import {
  makeCpIndexer,
  matchesAt,
  alignWords,
  alignSurfaces,
  cutsAWord,
  composeOnEdges,
  placingSpelling,
} from '../align.js';
import { ROLES, nodeLabel, groupRoles, groupValues } from './schema.js';
import { readAffixMarkers } from '../../domain/affixMarkers.js';
import { joinPhrase } from '../flex/flextextParser.js';
import { fieldWorksFieldNames, parseElanFlexTierName, parseFlexTierName } from './tierNaming.js';
import { chainOrder } from './readEaf.js';
import { ELAN_FIELD_NAMES_PROPERTY } from '../../domain/elanFieldNames.js';
import { MEDIA_FILE_FIELD } from '../../domain/igtConfig.js';
import { mayOverlap } from '../../domain/alignmentTimes.js';
import { nameKey, sameName } from '@ui/lib/nameKey.js';

// A value that is only punctuation (or symbols), as FLEx's punctuation is.
const PUNCTUATION = /^[\p{P}\p{S}]+$/u;

/** EAF milliseconds → Plaid seconds. */
const toSeconds = (ms) => Math.round(ms) / 1000;

// HEADER properties ELAN maintains for itself. They are not annotation and a
// user would only ever see them as noise in the document metadata panel.
// So is the exporter's record of which field a tier is.
const INTERNAL_PROPERTIES = new Set(['lastUsedAnnotationId', 'URN', ELAN_FIELD_NAMES_PROPERTY]);

/**
 * Strip a leading Leipzig joint from a morph form and read a morph type off it.
 *
 * Interlinear morph tiers write attachment markers into the form ("-s", "=lo"),
 * including the ones our own .eaf exporter emits. The marker is display-only in
 * Plaid, so it comes off here. Only "=" implies anything storable: it says a
 * clitic boundary is present, which inverts the exporter's joiner rule exactly,
 * so a round trip reproduces the same joint. "-" says a boundary exists but not
 * what sits on either side, so it asserts no type. Same reasoning, and the same
 * outcome, as the CLDF importer.
 */
export function readMorphForm(value) {
  const raw = String(value ?? '');
  const m = /^\s*([-=])(.*)$/.exec(raw);
  if (!m) return { form: raw.trim(), morphType: null };
  return { form: m[2].trim(), morphType: m[1] === '=' ? 'enclitic' : null };
}

/**
 * Place an ordered list of multi-word strings inside a slice of the body.
 *
 * NOT alignWords: that one walks whitespace-delimited runs and hands back one
 * run per form, which is right for words and wrong here, where a segment is
 * usually several words ("los perros"). Segments partition their utterance in
 * order, so a forward scan from a cursor is enough, case-folded through
 * matchesAt for the same reasons the word matcher folds.
 *
 * A segment whose text is not in the utterance at all gets a null span: its
 * time is real but no character range can be claimed for it truthfully.
 */
export function alignSegments(body, begin, end, texts) {
  const spans = [];
  let cursor = begin;
  for (const text of texts) {
    const form = String(text ?? '').trim();
    if (!form) {
      spans.push(null);
      continue;
    }
    let found = null;
    for (let at = cursor; at < end; at += 1) {
      const past = matchesAt(body, at, form);
      if (past && past <= end) {
        found = { beginU16: at, endU16: past };
        break;
      }
    }
    spans.push(found);
    if (found) cursor = found.endU16;
  }
  return spans;
}

/** The last path segment of a media URL, or '' when there is none. */
const mediaBasename = (eaf) => {
  const ref = eaf?.media?.[0]?.relativeUrl || eaf?.media?.[0]?.url || '';
  return String(ref).split(/[\\/]/).pop() || '';
};

/**
 * A file name as matching compares it: case-folded, and in one Unicode
 * normalization, since macOS writes `ó` as `o` plus a combining accent where
 * Windows (and so FieldWorks and most .eaf files) writes one character.
 */
export const matchKey = (name) => nameKey(name).toLowerCase();

/** A file name without its extension, as matchKey compares it. */
const stem = (name) =>
  matchKey(
    String(name || '')
      .split(/[\\/]/)
      .pop()
      .replace(/\.[^.]*$/, ''),
  );

/**
 * Pair picked media files with the .eaf files that reference them.
 *
 * The .eaf names its recording in MEDIA_DESCRIPTOR, so that name is the key: a
 * file called `oni-lifestory-ah-c.mp4` belongs to `oni-lifestory-ah.eaf`
 * because the .eaf says so, not because the names look alike.
 *
 * The extension is not part of that: `oni-lifestory-ah-c.mp3` is still the
 * recording the .eaf names, whether it was converted here (a video too large
 * to upload becomes audio) or outside Plaid before it arrived. Failing both, a
 * media file whose stem matches the .eaf's OWN name is taken as its recording,
 * which is the other convention corpora follow.
 *
 * Each file is claimed once, so two .eafs cannot take the same recording.
 * With `shared`, a file goes to every entry that names it instead: FLEx texts
 * cut from one long session are each timed against the whole recording.
 *
 * @returns {{byFile: Map<string, File>, unmatched: File[], missing: string[]}}
 *   missing = the media names .eaf files reference but nothing supplied, each
 *   once.
 */
export function matchMediaFiles(eafs, mediaFiles, { shared = false } = {}) {
  const pool = [...(mediaFiles || [])];
  const taken = new Set();
  const byFile = new Map();
  const missing = [];
  const claim = (predicate) => pool.find((f, i) => (shared || !taken.has(i)) && predicate(f, i));
  for (const eaf of eafs || []) {
    const referenced = mediaBasename(eaf);
    const pick =
      (referenced && claim((f) => matchKey(f.name) === matchKey(referenced))) ||
      (referenced && claim((f) => stem(f.name) === stem(referenced))) ||
      claim((f) => stem(f.name) === stem(eaf.fileName));
    if (pick) {
      taken.add(pool.indexOf(pick));
      byFile.set(eaf.fileName, pick);
    } else if (referenced && !missing.some((m) => matchKey(m) === matchKey(referenced))) {
      missing.push(referenced);
    }
  }
  return {
    byFile,
    unmatched: pool.filter((_, i) => !taken.has(i)),
    missing,
  };
}

/**
 * Default target name for a field/orthography node: the tier's name, except a
 * word's text in another writing system from ELAN's FLEx import
 * (`A_word-txt-dis-Latn-AF`), which is named by that writing system as the
 * FLEx importer names an orthography.
 */
export const defaultFieldName = (node) => {
  const flex = parseElanFlexTierName(nodeLabel(node));
  if (flex?.level === 'word' && flex.itemType === 'txt' && flex.ws) return nameKey(flex.ws);
  return nameKey(nodeLabel(node));
};

/** Resolve the mapping to role → the schema nodes holding it. */
function resolveMapping(nodes, roles) {
  const byRole = new Map();
  for (const node of nodes) {
    const role = roles[node.key] ?? ROLES.OFF;
    if (role === ROLES.OFF) continue;
    if (!byRole.has(role)) byRole.set(role, []);
    byRole.get(role).push(node);
  }
  return { byRole };
}

/**
 * Tiers of one parsed file occupying any of the given schema nodes. A role can
 * hold SEVERAL nodes: a corpus may give each speaker a whole tier tree of their
 * own, named by prefix (`W-Spch`, `K-Spch`) rather than by `@participant`.
 * Children are found by ANNOTATION_REF from a specific parent, so pooling the
 * tiers of one role cannot mix two speakers up.
 */
const tiersOfNodes = (eaf, nodeList) => {
  const ids = new Set(nodeList.flatMap((n) => n.tierIds));
  return eaf.tiers.filter((t) => ids.has(t.id));
};

/**
 * The speaker each utterance tier with no PARTICIPANT names, when the
 * utterance role holds several tiers: a corpus that gives each speaker a tier
 * tree of its own names them by prefix (`W-Spch`, `K-Spch`). The parts of the
 * name every such tier shares (`Spch`) are the tier's type, and what is left
 * is the speaker (`W`). A name with nothing left is the speaker whole. One
 * tier alone is one voice, and names none. A map of tier id to speaker.
 */
function tierSpeakers(tiers) {
  const unnamed = tiers.filter((t) => !t.participant);
  if (tiers.length < 2 || !unnamed.length) return new Map();
  const parts = unnamed.map((t) => t.id.split(/[-_@.\s]+/).filter(Boolean));
  const shared =
    unnamed.length < 2
      ? new Set()
      : new Set(parts[0].filter((part) => parts.every((ps) => ps.includes(part))));
  return new Map(
    unnamed.map((t, i) => {
      const left = parts[i].filter((part) => !shared.has(part)).join('-');
      return [t.id, left || t.id];
    }),
  );
}

/**
 * The segments whose times may be kept: two may overlap in time only when
 * both have a speaker and the speakers differ (alignmentTimes.js), so of an
 * overlap that is not cross-talk the later one loses its time, and a warning
 * says which. `utterances[i]` is the number of the utterance segment i is in.
 */
export function keepTimeRule(alignments, utterances, warnings) {
  const asToken = (a) => ({ metadata: { speaker: a.speaker ?? '' } });
  const order = alignments
    .map((a, i) => i)
    .sort((i, j) => alignments[i].timeBegin - alignments[j].timeBegin || i - j);
  const kept = [];
  const dropped = new Set();
  for (const i of order) {
    const a = alignments[i];
    const clash = kept.find(
      (k) =>
        alignments[k].timeBegin < a.timeEnd &&
        alignments[k].timeEnd > a.timeBegin &&
        !mayOverlap(asToken(alignments[k]), asToken(a)),
    );
    if (clash === undefined) {
      kept.push(i);
      continue;
    }
    dropped.add(i);
    const why = a.speaker ? 'with the same speaker' : 'with no speaker to tell them apart';
    const [n, m] = [utterances[i], utterances[clash]];
    warnings.push(
      n === m
        ? `Utterance ${n}: two of its time segments overlap ${why}. The later one's time is not imported.`
        : `Utterance ${n} overlaps utterance ${m} in time ${why}. Its time is not imported.`,
    );
  }
  return alignments.filter((a, i) => !dropped.has(i));
}

/**
 * Utterances in reading order. The aligned ones go by start time. An
 * unaligned one has no time, but TIME_ORDER still places its slot among the
 * others (`slotIndex`), so it follows the aligned utterance whose start slot
 * comes last before its own, and one with no such utterance leads. That keeps
 * a document part way through alignment in its own order, even where two
 * speakers overlap and the times alone disagree with TIME_ORDER. One with no
 * slot at all (a reference annotation) comes last. Ties keep tier order.
 */
function orderUtterances(utterances) {
  const cmp = (x, y) => (x < y ? -1 : x > y ? 1 : 0);
  const timed = utterances
    .filter((u) => u.ann.beginMs != null)
    .sort(
      (a, b) =>
        cmp(a.ann.beginMs, b.ann.beginMs) ||
        cmp(a.ann.slotIndex ?? Infinity, b.ann.slotIndex ?? Infinity),
    );
  const placed = utterances.filter((u) => u.ann.beginMs == null && u.ann.slotIndex != null);
  const loose = utterances.filter((u) => u.ann.beginMs == null && u.ann.slotIndex == null);
  const after = new Map([[null, []], ...timed.map((u) => [u, []])]);
  for (const u of placed) {
    let anchor = null;
    for (const t of timed) {
      const at = t.ann.slotIndex ?? Infinity;
      if (at < u.ann.slotIndex && (anchor === null || at > anchor.ann.slotIndex)) anchor = t;
    }
    after.get(anchor).push(u);
  }
  const bySlot = (list) => list.sort((a, b) => a.ann.slotIndex - b.ann.slotIndex);
  return [
    ...bySlot(after.get(null)),
    ...timed.flatMap((t) => [t, ...bySlot(after.get(t))]),
    ...loose,
  ];
}

/**
 * Build importable documents from files that share one tier tree.
 *
 * @param files  parsed .eaf objects (readEaf output)
 * @param nodes  the agreed schema (schema.js tierSchema, one shared shape)
 * @param roles  {nodeKey: ROLES.*}
 * @param options {fieldNames: {nodeKey: string}, mediaByFile, recordMediaName: boolean}
 *   recordMediaName (default true) records each recording's file name in a
 *   Media file metadata field.
 * @returns {{documents, schema, stats, warnings}}
 */
export function buildElanDocuments(files, nodes, roles, options = {}) {
  return {
    ...buildGroup(files, nodes, roles, options),
    warnings: batchWarnings(files, options.mediaByFile || null),
  };
}

/**
 * Build a whole batch, whose files may fall into several tier trees: each
 * group is built on its own tree under the mapping chosen on the rows
 * (schema.js compareSchemas, groupRoles), and the results are put together as
 * one build over the files in the order they were chosen.
 *
 * @param comparison  compareSchemas output, consistent
 * @param roles  {rowKey: ROLES.*}
 * @param options  as buildElanDocuments, with fieldNames filed by row key
 */
export function buildElanBatch(comparison, roles, options = {}) {
  const parts = comparison.groups.map((group) => ({
    group,
    built: buildGroup(group.files, group.nodes, groupRoles(group, roles), {
      ...options,
      fieldNames: groupValues(group, options.fieldNames || {}),
    }),
  }));
  const order = new Map(comparison.files.map((f, i) => [f, i]));
  const documents = parts
    .flatMap(({ group, built }) => built.documents.map((doc, i) => ({ doc, file: group.files[i] })))
    .sort((a, b) => order.get(a.file) - order.get(b.file))
    .map(({ doc }) => doc);
  // One field per scope and name, where the largest group's tree puts it, with
  // the writing system any group's tier name declares.
  const mergeFields = (list) => {
    const byName = new Map();
    for (const f of list) {
      const key = `${f.scope}:${f.name}`;
      const kept = byName.get(key);
      if (!kept) byName.set(key, { ...f });
      else if (!kept.lang && f.lang) kept.lang = f.lang;
    }
    return [...byName.values()];
  };
  const unique = (list, keyOf) => [...new Map(list.map((x) => [keyOf(x), x])).values()];
  const schemas = parts.map((p) => p.built.schema);
  const stats = parts.map((p) => p.built.stats);
  const sum = (key) => stats.reduce((n, s) => n + s[key], 0);
  const skipped = new Map();
  for (const s of stats.flatMap((x) => x.skipped)) {
    const prev = skipped.get(s.label) || { label: s.label, values: 0, tiers: new Set() };
    prev.values += s.values;
    for (const t of s.tiers) prev.tiers.add(t);
    skipped.set(s.label, prev);
  }
  return {
    documents,
    schema: {
      baselineLang: schemas[0]?.baselineLang ?? null,
      fields: mergeFields(schemas.flatMap((s) => s.fields)),
      orthographies: [...new Set(schemas.flatMap((s) => s.orthographies))],
      documentMetadata: unique(
        schemas.flatMap((s) => s.documentMetadata),
        (m) => m.name,
      ),
    },
    stats: {
      files: sum('files'),
      sentences: sum('sentences'),
      words: sum('words'),
      morphemes: sum('morphemes'),
      alignments: sum('alignments'),
      speakers: [...new Set(stats.flatMap((s) => s.speakers))].sort(),
      skipped: [...skipped.values()]
        .map((x) => ({ label: x.label, values: x.values, tiers: [...x.tiers].sort() }))
        .sort((a, b) => b.values - a.values),
    },
    warnings: batchWarnings(comparison.files, options.mediaByFile || null),
  };
}

// What is said once for a whole batch rather than once per document.
function batchWarnings(files, mediaByFile) {
  const warnings = [];
  // ANNOTATOR is per-tier in EAF and Plaid has nowhere per-tier to put it, so it
  // is not imported. Saying so beats dropping a curation record in silence.
  const annotators = [
    ...new Set(files.flatMap((f) => f.tiers.map((t) => t.annotator).filter(Boolean))),
  ].sort();
  if (annotators.length) {
    warnings.push(
      `The .eaf files name an annotator on some tiers (${annotators.join(', ')}). ELAN records that per tier, which has no equivalent here, so it is not imported.`,
    );
  }

  // Only the recordings nobody supplied: one that was picked rides along with
  // its document (mediaFile) and needs no warning.
  const unsupplied = files.filter((f) => f.media.length && !mediaByFile?.get(f.fileName));
  if (unsupplied.length) {
    warnings.push(
      (files.length === 1
        ? 'This file names a recording that was not chosen. The document is imported without media'
        : `${unsupplied.length} of ${files.length} files name a recording that was not chosen. Those documents are imported without media`) +
        ', which can be attached on the Media tab afterwards.',
    );
  }
  return warnings;
}

function buildGroup(files, nodes, roles, options = {}) {
  const fieldNames = options.fieldNames || {};
  const mediaByFile = options.mediaByFile || null;
  // The recording's original file name goes in a Media file metadata field
  // unless the person turns that off.
  const recordMediaName = options.recordMediaName !== false;
  const { byRole } = resolveMapping(nodes, roles);

  const utteranceNodes = byRole.get(ROLES.UTTERANCE) || [];
  if (!utteranceNodes.length) throw new Error('No tier is mapped to the sentences.');
  const alignmentNodes = byRole.get(ROLES.ALIGNMENT) || [];
  const wordNodes = byRole.get(ROLES.WORD) || [];
  const morphNodes = byRole.get(ROLES.MORPHEME) || [];
  const sentFieldNodes = byRole.get(ROLES.SENTENCE_FIELD) || [];
  const wordFieldNodes = byRole.get(ROLES.WORD_FIELD) || [];
  const morphFieldNodes = byRole.get(ROLES.MORPH_FIELD) || [];
  const orthographyNodes = byRole.get(ROLES.ORTHOGRAPHY) || [];
  const morphTypeNodes = byRole.get(ROLES.MORPH_TYPE) || [];
  const fromFlexViaElan = utteranceNodes.every(
    (node) => parseElanFlexTierName(nodeLabel(node))?.level === 'phrase',
  );
  const textFromWords = fromFlexViaElan && wordNodes.length > 0;
  // A field below another field (validateRoles, anchorOf) is reached from its
  // sentence, word or morpheme through the tiers between: the path of nodes
  // from just below the anchor down to the field itself.
  const nodeByKey = new Map(nodes.map((n) => [n.key, n]));
  const pathCache = new Map();
  const pathTo = (anchorTier, node) => {
    const cacheKey = `${anchorTier.id}\u0000${node.key}`;
    if (pathCache.has(cacheKey)) return pathCache.get(cacheKey);
    const path = [node];
    let cur = node.parentKey ? nodeByKey.get(node.parentKey) : null;
    while (cur && !cur.tierIds.includes(anchorTier.id) && path.length < 50) {
      path.unshift(cur);
      cur = cur.parentKey ? nodeByKey.get(cur.parentKey) : null;
    }
    // Not below this tier at all: look for it directly, which finds nothing.
    const found = cur ? path : [node];
    pathCache.set(cacheKey, found);
    return found;
  };
  // A field nobody named is called what the review screen would have offered:
  // the FLEx importer's name for a FieldWorks-shaped tier, else the tier's.
  const fieldWorksNames = fieldWorksFieldNames(
    [...sentFieldNodes, ...wordFieldNodes, ...morphFieldNodes].map((node) => ({
      key: node.key,
      name: defaultFieldName(node),
    })),
  );
  const nameOf = (node) =>
    nameKey(fieldNames[node.key] || fieldWorksNames[node.key] || defaultFieldName(node)).trim();

  const documents = [];
  const stats = {
    files: files.length,
    sentences: 0,
    words: 0,
    morphemes: 0,
    alignments: 0,
    speakers: new Set(),
  };

  // What the mapping leaves behind. A tier with no role is silently dropped
  // otherwise: the counts above only describe what IS imported, so a corpus can
  // lose a whole second speaker or an entire gesture stream and still look like
  // a clean import. Counted here so the review screen can say so out loud.
  const skipped = new Map();
  for (const eaf of files) {
    for (const tier of eaf.tiers) {
      const node = nodes.find((n) => n.tierIds?.includes(tier.id));
      const key = node ? node.key : null;
      if (key && (roles[key] ?? ROLES.OFF) !== ROLES.OFF) continue;
      const filled = tier.annotations.filter((a) => String(a.value ?? '').trim()).length;
      if (!filled) continue;
      const label = node ? nodeLabel(node) : tier.baseName || tier.id;
      const prev = skipped.get(label) || { label, values: 0, tiers: new Set() };
      prev.values += filled;
      prev.tiers.add(tier.id);
      skipped.set(label, prev);
    }
  }

  for (const eaf of files) {
    const docWarnings = [];

    // Both indexes are built ONCE per file. tierOfAnnotation used to be rebuilt
    // inside the per-utterance loop, which re-scanned every annotation in the
    // document for every utterance in it.
    const tierOfAnnotation = new Map();
    for (const tier of eaf.tiers) {
      for (const ann of tier.annotations) tierOfAnnotation.set(ann.id, tier);
    }
    // Index every annotation's children by parent id.
    const childrenByParent = new Map();
    for (const tier of eaf.tiers) {
      for (const ann of tier.annotations) {
        if (!ann.ref) continue;
        if (!childrenByParent.has(ann.ref)) childrenByParent.set(ann.ref, []);
        childrenByParent.get(ann.ref).push({ ann, tier });
      }
    }
    // Children of one annotation, on the tiers of the given nodes.
    //
    // EAF records parentage TWO different ways and the stereotype decides which.
    // Symbolic_Subdivision and Symbolic_Association children are REF_ANNOTATIONs
    // that name their parent. Time_Subdivision and Included_In children are
    // ALIGNABLE_ANNOTATIONs with no ANNOTATION_REF at all: they belong to the
    // annotation whose time interval contains them, on the tier that declares it
    // as parent. Real corpora use the time-aligned form for words as often as
    // the symbolic one, so getting this wrong loses every word in the file.
    const containedIn = (parentAnn, parentTier, node) => {
      if (parentAnn.beginMs === null || parentAnn.endMs === null) return [];
      const out = [];
      for (const tier of tiersOfNodes(eaf, [node])) {
        if (tier.parentRef && tier.parentRef !== parentTier.id) continue;
        for (const ann of tier.annotations) {
          if (ann.beginMs === null || ann.endMs === null) continue;
          if (ann.beginMs >= parentAnn.beginMs && ann.endMs <= parentAnn.endMs) out.push(ann);
        }
      }
      return out.sort((a, b) => a.beginMs - b.beginMs);
    };
    const childrenOn = (parentAnn, parentTier, nodeList) => {
      if (!nodeList || !nodeList.length) return [];
      const out = [];
      for (const node of nodeList) {
        if (node.alignable && node.stereotype) {
          out.push(...containedIn(parentAnn, parentTier, node));
        } else {
          const ids = new Set(node.tierIds);
          const kids = (childrenByParent.get(parentAnn.id) || [])
            .filter((c) => ids.has(c.tier.id))
            .map((c) => c.ann);
          out.push(...chainOrder(kids));
        }
      }
      return out;
    };
    // A Symbolic_Association holds at most one child per parent; anything more
    // is a subdivision being used as a field, so the first value wins and the
    // rest are reported rather than silently concatenated.
    const fieldValueOn = (parentAnn, parentTier, node) => {
      let ann = parentAnn;
      let tier = parentTier;
      for (const step of pathTo(parentTier, node).slice(0, -1)) {
        ann = childrenOn(ann, tier, [step])[0];
        if (!ann) return '';
        tier = tierOfAnnotation.get(ann.id) ?? tier;
      }
      const found = childrenOn(ann, tier, [node]);
      if (found.length > 1) {
        docWarnings.push(
          `${nodeLabel(node)} has ${found.length} annotations under one parent. The first is kept.`,
        );
      }
      return found[0]?.value?.trim() ?? '';
    };

    // One phrase's text and its words, from the word tier. A word with no
    // text of its own is FLEx's punctuation, whose characters ELAN's import
    // writes on the word's text tier in another writing system: it goes into
    // the text as punctuation and is not a word. Word spans are where the
    // join put each word, found in order, so nothing is matched.
    const rebuildFromWords = (uttAnn, uttTier) => {
      const pieces = [];
      const words = [];
      let unplaced = 0;
      for (const w of childrenOn(uttAnn, uttTier, wordNodes)) {
        const form = String(w.value ?? '')
          .replace(/\s+/g, ' ')
          .trim();
        if (form) {
          pieces.push({ kind: 'word', text: form });
          words.push({ ann: w, form });
          continue;
        }
        const punct = (childrenByParent.get(w.id) || [])
          .filter(({ tier }) => {
            const item = parseElanFlexTierName(tier.baseName || tier.id);
            return item?.level === 'word' && (item.itemType === 'txt' || item.itemType === 'punct');
          })
          .map(({ ann }) => String(ann.value ?? '').trim())
          .find((v) => PUNCTUATION.test(v));
        if (punct) pieces.push({ kind: 'punct', text: punct });
        else unplaced += 1;
      }
      const text = joinPhrase(pieces).trimEnd();
      const at = [];
      let cursor = 0;
      for (const piece of pieces) {
        const found = text.indexOf(piece.text, cursor);
        if (piece.kind === 'word') at.push(found);
        cursor = found + piece.text.length;
      }
      return {
        text,
        words: words.map(({ ann, form }, i) => ({ ann, at: at[i], length: form.length })),
        unplaced,
      };
    };

    // --- collect the utterances, in the order TIME_ORDER places them -------
    // A text from ELAN's FLEx import is written from its words (textFromWords),
    // as FLEx writes a phrase and as the .flextext importer rebuilds one. Its
    // phrase line is another spelling of the same text: it leaves out the
    // words an analysis adds ("[0]" for a zero argument, which carries that
    // argument's annotations) and joins what the words split ("jama" for
    // "ja-ma"), so no word could be placed in it faithfully.
    const utterances = [];
    let blankUtterances = 0;
    let unplacedWords = 0;
    const utteranceTiers = tiersOfNodes(eaf, utteranceNodes);
    const speakerOfTier = tierSpeakers(utteranceTiers);
    for (const tier of utteranceTiers) {
      for (const ann of tier.annotations) {
        const rebuilt = textFromWords ? rebuildFromWords(ann, tier) : null;
        if (rebuilt) unplacedWords += rebuilt.unplaced;
        // A blank annotation is a placeholder ELAN users leave behind. It has
        // no transcription to anchor a sentence to, and keeping one would put a
        // zero-width token in the sentence partition (which the server refuses)
        // or a sentence holding nothing but the newline joining its neighbours.
        if (!(rebuilt ? rebuilt.text : String(ann.value ?? '').trim())) {
          blankUtterances += 1;
          continue;
        }
        const speaker = tier.participant || speakerOfTier.get(tier.id) || null;
        utterances.push({ ann, tier, speaker, rebuilt });
      }
    }
    if (blankUtterances) {
      docWarnings.push(
        `Skipped ${blankUtterances} empty annotation${blankUtterances === 1 ? '' : 's'} on the utterance tier.`,
      );
    }
    if (unplacedWords) {
      docWarnings.push(
        `Skipped ${unplacedWords} empty word${unplacedWords === 1 ? '' : 's'} that ${unplacedWords === 1 ? 'is' : 'are'} not punctuation.`,
      );
    }

    // --- synthesize the baseline -------------------------------------------
    // Word forms: the mapped tier, whitespace collapsed as the utterance's
    // is, so a word holding a tab or a line break is still found in the text.
    const formsOf = (anns) =>
      anns.map((a) =>
        String(a.value ?? '')
          .replace(/\s+/g, ' ')
          .trim(),
      );
    const pieces = [];
    let bodyU16 = '';
    for (const u of orderUtterances(utterances)) {
      let text = u.rebuilt
        ? u.rebuilt.text
        : String(u.ann.value ?? '')
            .replace(/\s+/g, ' ')
            .trim();
      // A word that begins or ends inside a character of the utterance (a
      // tone mark that is a word of its own) is found in it only decomposed
      // (placingSpelling), and the piece is then read decomposed throughout.
      let decomposed = false;
      if (!u.rebuilt && wordNodes.length && text) {
        const spelled = placingSpelling(
          text,
          formsOf(childrenOn(u.ann, u.tier, wordNodes)),
          (t, forms) => {
            const exact = alignSurfaces(t, 0, t.length, forms);
            return exact && !cutsAWord(t, exact.spans) ? exact.spans : null;
          },
        );
        ({ text, decomposed } = spelled);
      }
      const beginU16 = bodyU16.length;
      bodyU16 += text;
      pieces.push({ ...u, text, decomposed, beginU16, endU16: bodyU16.length });
      bodyU16 += '\n';
    }
    // As the piece is spelled: decomposed where it was read so.
    const spelledAs = (piece, s) => (piece.decomposed ? String(s ?? '').normalize('NFD') : s);
    const body = bodyU16.replace(/\n$/, '');
    const toCp = makeCpIndexer(body);
    // The sentence layer PARTITIONS the text, so the sentence tokens have to
    // tile [0, len) exactly. Each sentence therefore absorbs the newline that
    // joins it to the next one, and the last runs to the end of the body. The
    // piece's own endU16 stays the text-only extent, which is what words and
    // alignments are placed against.
    pieces.forEach((piece, i) => {
      piece.sentEndU16 = i + 1 < pieces.length ? pieces[i + 1].beginU16 : body.length;
    });

    // --- sentences, words, morphemes ---------------------------------------
    const sentences = [];
    const words = [];
    const alignments = [];
    // The utterance each segment is in, by number, for the time rule's warnings.
    const alignmentUtterances = [];
    const pushAlignment = (si, a) => {
      alignments.push(a);
      alignmentUtterances.push(si + 1);
    };

    pieces.forEach((piece, si) => {
      const fields = {};
      for (const node of sentFieldNodes) {
        const v = fieldValueOn(piece.ann, piece.tier, node);
        if (v) fields[nameOf(node)] = v;
      }
      sentences.push({ begin: toCp(piece.beginU16), end: toCp(piece.sentEndU16), fields });
      if (piece.speaker) stats.speakers.add(piece.speaker);

      // Time alignment: a dedicated tier when one is mapped, else the utterance
      // itself. Segments carry their own times but no text position, so they
      // are placed inside the utterance the same way words are.
      if (!alignmentNodes.length) {
        if (piece.ann.beginMs !== null && piece.ann.endMs !== null && piece.text) {
          pushAlignment(si, {
            begin: toCp(piece.beginU16),
            end: toCp(piece.endU16),
            timeBegin: toSeconds(piece.ann.beginMs),
            timeEnd: toSeconds(piece.ann.endMs),
            speaker: piece.speaker,
          });
        }
      } else {
        // Included_In / Time_Subdivision children are alignable annotations, so
        // they hold no ANNOTATION_REF: they belong to the utterance whose time
        // interval contains them, on the tier that declares it as parent.
        const segments = childrenOn(piece.ann, piece.tier, alignmentNodes);
        const spans = alignSegments(
          body,
          piece.beginU16,
          piece.endU16,
          segments.map((s) => spelledAs(piece, s.value)),
        );
        let placed = 0;
        segments.forEach((seg, i) => {
          const span = spans[i];
          if (!span || span.beginU16 >= span.endU16) return;
          placed += 1;
          pushAlignment(si, {
            begin: toCp(span.beginU16),
            end: toCp(span.endU16),
            timeBegin: toSeconds(seg.beginMs),
            timeEnd: toSeconds(seg.endMs),
            speaker: piece.speaker,
          });
        });
        if (placed < segments.length) {
          docWarnings.push(
            `Utterance ${si + 1}: ${segments.length - placed} of ${segments.length} time segments do not appear in its text.`,
          );
        }
        // A segment tier that shares no text with the utterance (an independent
        // transcription rather than a subdivision of this one) leaves the
        // utterance unaligned, so fall back to its own coarser time span rather
        // than losing the alignment altogether.
        if (placed === 0 && piece.ann.beginMs !== null && piece.ann.endMs !== null && piece.text) {
          pushAlignment(si, {
            begin: toCp(piece.beginU16),
            end: toCp(piece.endU16),
            timeBegin: toSeconds(piece.ann.beginMs),
            timeEnd: toSeconds(piece.ann.endMs),
            speaker: piece.speaker,
          });
        }
      }

      if (!piece.text) return;

      // Word forms: the mapped tier, or a whitespace split of the utterance
      // when the corpus has no word tier at all (very common: a transcription
      // and a translation, nothing else).
      let wordSpans;
      let wordAnns = [];
      if (piece.rebuilt) {
        wordAnns = piece.rebuilt.words.map((w) => w.ann);
        wordSpans = piece.rebuilt.words.map((w) => ({
          beginU16: piece.beginU16 + w.at,
          endU16: piece.beginU16 + w.at + w.length,
        }));
      } else if (wordNodes.length) {
        wordAnns = childrenOn(piece.ann, piece.tier, wordNodes);
        const forms = formsOf(wordAnns).map((f) => spelledAs(piece, f));
        // Our own export writes each word as it stands in the text, so a word
        // that holds a space ("West Bengal") is placed where its text is. When
        // the forms are not all there in order, or would cut a word of the
        // text in two, the words are aligned run by run instead.
        const exact = alignSurfaces(body, piece.beginU16, piece.endU16, forms);
        const aligned =
          exact && !cutsAWord(body, exact.spans)
            ? exact
            : alignWords(body, piece.beginU16, piece.endU16, forms);
        wordSpans = aligned.spans;
        for (const w of aligned.warnings) {
          docWarnings.push(`Utterance ${si + 1}: ${w}`);
        }
        // A Plaid word token is a RANGE over the baseline, not a form of its
        // own, and the matcher case-folds. So when the word tier spells a word
        // differently from the transcription it sits in, the transcription
        // wins and the word tier's spelling is gone. Say so: the alternative is
        // that "Oranje" becomes "oranje" and nothing anywhere mentions it.
        // Only worth saying when the alignment was otherwise clean. Once
        // alignWords has fallen back to position, every word after the first
        // discrepancy is sitting on the wrong text and would be reported here
        // as a respelling, which is both noise and a misdescription of what
        // happened. That case already has its own warning.
        if (!aligned.warnings.length) {
          const respelled = [];
          aligned.spans.forEach((span, wi) => {
            if (!span) return;
            const inText = body.slice(span.beginU16, span.endU16);
            const onTier = forms[wi];
            if (onTier && inText && !sameName(inText, onTier)) {
              respelled.push(`${nameKey(onTier)} → ${nameKey(inText)}`);
            }
          });
          if (respelled.length) {
            docWarnings.push(
              `Utterance ${si + 1}: the word tier spells ${respelled.length} word${respelled.length === 1 ? '' : 's'} differently from the text, and the text wins (${respelled.slice(0, 4).join(', ')}${respelled.length > 4 ? ', …' : ''}).`,
            );
          }
        }
      } else {
        wordSpans = [];
        const re = /\S+/g;
        let m;
        while ((m = re.exec(piece.text)) !== null) {
          wordSpans.push({
            beginU16: piece.beginU16 + m.index,
            endU16: piece.beginU16 + m.index + m[0].length,
          });
        }
      }

      wordSpans.forEach((span, wi) => {
        if (!span || span.beginU16 >= span.endU16) return;
        const ann = wordAnns[wi] ?? null;
        const annTier = ann ? (tierOfAnnotation.get(ann.id) ?? piece.tier) : piece.tier;
        const wordFields = {};
        if (ann) {
          for (const node of wordFieldNodes) {
            const v = fieldValueOn(ann, annTier, node);
            if (v) wordFields[nameOf(node)] = v;
          }
          // Orthography values ride in token metadata under the orthog: prefix,
          // the convention the editor and the other importers share.
          for (const node of orthographyNodes) {
            const v = fieldValueOn(ann, annTier, node);
            if (v) wordFields[`orthog:${nameOf(node)}`] = v;
          }
        }
        const morphAnns = ann ? childrenOn(ann, annTier, morphNodes) : [];
        const read = morphAnns.map((mAnn) => {
          const mTier = tierOfAnnotation.get(mAnn.id) ?? annTier;
          // A morph type tier names the type (FLEx's own words, "suffix"),
          // and the markers that type writes come off the form. Without one,
          // or with a type FLEx does not have, the markers say what they can.
          const named = morphTypeNodes.map((node) => fieldValueOn(mAnn, mTier, node)).find(Boolean);
          // Only on a morph with a form: a blank template morph is not made an
          // analysis by the type written beside it.
          const raw = String(mAnn.value ?? '').trim();
          const typed = named && raw ? readAffixMarkers(named, raw) : null;
          const { form, morphType } = typed?.morphType ? typed : readMorphForm(mAnn.value);
          const mFields = {};
          for (const node of morphFieldNodes) {
            const v = fieldValueOn(mAnn, mTier, node);
            if (v) mFields[nameOf(node)] = v;
          }
          return { form, morphType, fields: mFields };
        });
        // A template-made corpus (FieldWorks writes one) carries a morph
        // annotation under every word whether or not anyone has segmented it.
        // One that says nothing at all is dropped, so the word reads as
        // unanalyzed and shows its own text where its morpheme goes. A word's
        // only morpheme with a gloss and no form keeps the gloss, and its null
        // form falls back to the word. Among several, a blank form stays
        // blank: the word's text would be wrong there.
        const kept = read.filter((m) => m.form || m.morphType || Object.keys(m.fields).length);
        // One morph that is only the word again, with no type and no values,
        // is no segmentation: our own export writes one for every word nobody
        // segmented, and an unsegmented word has no morpheme of its own.
        const [only] = kept;
        const bare =
          kept.length === 1 &&
          !only.morphType &&
          !Object.keys(only.fields).length &&
          sameName(only.form, body.slice(span.beginU16, span.endU16));
        let morphemes = kept;
        if (bare) morphemes = [];
        else if (kept.length === 1 && !only.form) morphemes = [{ ...only, form: null }];
        words.push({
          begin: toCp(span.beginU16),
          end: toCp(span.endU16),
          sentenceIndex: si,
          fields: wordFields,
          morphemes,
        });
        stats.morphemes += morphemes.length;
      });
    });

    // ELAN's FLEx import has no recording to align to and gives each phrase
    // a stretch of whole seconds instead. Times like that are placeholders,
    // and a document aligned to them would play the wrong stretch of any
    // recording attached later, so they are left out. The test is narrow on
    // purpose, all of: sentences from a tier that import named, no recording
    // named or chosen, and every time on a whole second. Any other file keeps
    // its times, including one whose recording was never linked.
    if (
      alignments.length &&
      fromFlexViaElan &&
      !eaf.media.length &&
      !mediaByFile?.get(eaf.fileName)
    ) {
      const times = eaf.tiers.flatMap((t) =>
        t.annotations.flatMap((a) => [a.beginMs, a.endMs]).filter((ms) => ms != null),
      );
      if (times.length && times.every((ms) => ms % 1000 === 0)) {
        docWarnings.push(
          'The file names no recording and its times all fall on whole seconds, so they are placeholders and no time alignment is imported.',
        );
        alignments.length = 0;
      }
    }

    stats.sentences += sentences.length;
    stats.words += words.length;
    stats.alignments += alignments.length;

    // Document metadata: the HEADER properties, minus the one that is the name
    // and minus ELAN's own bookkeeping, which means nothing outside ELAN.
    const metadata = {};
    for (const [key, value] of Object.entries(eaf.properties || {})) {
      if (key === 'documentName' || INTERNAL_PROPERTIES.has(key) || !value) continue;
      metadata[key] = value;
    }
    if (recordMediaName && eaf.media.length) {
      const name = eaf.media[0].relativeUrl || eaf.media[0].url;
      if (name) metadata[MEDIA_FILE_FIELD] = String(name).split('/').pop();
    }

    // Composed as the server stores it with these tokens on it: an utterance
    // read decomposed keeps only the character a word edge falls inside so.
    const kept = keepTimeRule(alignments, alignmentUtterances, docWarnings);
    const composed = composeOnEdges(
      body,
      [...sentences, ...words, ...kept].flatMap((t) => [t.begin, t.end]),
    );
    const moved = (t) => ({ ...t, begin: composed.at(t.begin), end: composed.at(t.end) });
    documents.push({
      id: eaf.fileName,
      name: eaf.documentName,
      metadata,
      body: composed.body,
      tokenEdges: composed.tokenEdges,
      sentences: sentences.map(moved),
      words: words.map(moved),
      alignments: kept.map(moved),
      // The File the user picked for this .eaf, when they picked one (see
      // matchMediaFiles). The CLDF importer carries media as bytes because its
      // zip already holds them in memory; here the file is on disk and a
      // recording can be hundreds of megabytes, so the File itself rides along
      // and the upload streams it.
      mediaFile: mediaByFile?.get(eaf.fileName) ?? null,
      warnings: docWarnings,
    });
  }

  // Two files naming the same document both keep that name, as Plaid allows.

  // `lang` is the writing system the tier's name declares, when it declares
  // one: a corpus prepared for FieldWorks says so (`Translation-gls-nl`), and
  // a field created from that tier can record it instead of being read back
  // out of its name later.
  const fieldsOf = (list, scope) =>
    list.map((node) => ({
      name: nameOf(node),
      scope,
      lang: parseFlexTierName(nodeLabel(node))?.ws ?? null,
    }));
  // Two nodes may deliberately carry the same field name (one tier per speaker),
  // and the project needs that span layer once, not twice.
  const dedupeFields = (list) => {
    const seen = new Set();
    return list.filter((f) => {
      const key = `${f.scope}:${f.name}`;
      if (seen.has(key)) return false;
      seen.add(key);
      return true;
    });
  };
  return {
    documents,
    schema: {
      // The writing system the transcription tier's name declares, when it
      // does (`Transcription-txt-oni`): the language documented.
      baselineLang: parseFlexTierName(nodeLabel(utteranceNodes[0]))?.ws ?? null,
      fields: dedupeFields([
        ...fieldsOf(sentFieldNodes, 'Sentence'),
        ...fieldsOf(wordFieldNodes, 'Word'),
        ...fieldsOf(morphFieldNodes, 'Morpheme'),
      ]),
      orthographies: [...new Set(orthographyNodes.map(nameOf))],
      documentMetadata: [...new Set(documents.flatMap((d) => Object.keys(d.metadata)))].map(
        (name) => ({ name }),
      ),
    },
    stats: {
      ...stats,
      speakers: [...stats.speakers].sort(),
      skipped: [...skipped.values()]
        .map((x) => ({ label: x.label, values: x.values, tiers: [...x.tiers].sort() }))
        .sort((a, b) => b.values - a.values),
    },
  };
}
