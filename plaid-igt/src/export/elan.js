// ELAN Annotation Format (.eaf) serialization, schema version 2.8. Structure
// verified against the EAF 2.8 specification (The Language Archive, MPI-PL):
//
//   <ANNOTATION_DOCUMENT AUTHOR DATE VERSION FORMAT>
//     <HEADER TIME_UNITS="milliseconds"><MEDIA_DESCRIPTOR MEDIA_URL MIME_TYPE/>
//     <TIME_ORDER><TIME_SLOT TIME_SLOT_ID TIME_VALUE?/>          (ordered)
//     <TIER TIER_ID LINGUISTIC_TYPE_REF PARENT_REF? PARTICIPANT?>
//       <ANNOTATION><ALIGNABLE_ANNOTATION TIME_SLOT_REF1/2>      (top, Included_In)
//       <ANNOTATION><REF_ANNOTATION ANNOTATION_REF PREVIOUS_ANNOTATION?>
//     <LINGUISTIC_TYPE LINGUISTIC_TYPE_ID CONSTRAINTS? TIME_ALIGNABLE/>
//     <CONSTRAINT STEREOTYPE DESCRIPTION/>                       (all four, as ELAN writes)
//   </ANNOTATION_DOCUMENT>
//
// TIER TREE. ELAN is a forest of tiers where one root per branch carries the
// time and everything else hangs off it by stereotype. IGT maps on directly:
//
//   Sentence   top level, alignable    sentence tokens
//     Segment  Included_In             alignment tokens inside that sentence
//     Word     Symbolic_Subdivision    word tokens, chained by PREVIOUS_ANNOTATION
//       <orthography>  Symbolic_Association
//       <word field>   Symbolic_Association
//       Morph    Symbolic_Subdivision  morphemes, chained
//         <morph field> Symbolic_Association
//     <sentence field> Symbolic_Association
//
// WHY SENTENCES ARE THE ROOT, not the alignment layer: sentences always exist
// and always partition the baseline, while alignment tokens are an independent
// partition that is frequently absent. A sentence's interval is [min timeBegin,
// max timeEnd] over the alignment tokens WHOLLY INSIDE it, which is truthful in
// every configuration and non-overlapping by construction (the alignment layer
// is server-enforced :non-overlapping and createAlignment refuses temporal
// inversions, so text order tracks time order). An alignment token straddling a
// sentence boundary belongs to no sentence: it is dropped and its sentences stay
// unaligned, rather than being given a time that isn't theirs.
//
// UNALIGNED DOCUMENTS still export. TIME_VALUE is optional on TIME_SLOT
// precisely so partially aligned annotations can exist (EAF 2.8 §2.4.1), so a
// sentence with no contained alignment gets two value-less slots. The file is
// valid and editable, and ELAN can be used to align it afterwards.
//
// The Segment tier is emitted only when it carries information the Sentence
// tier does not, i.e. when some sentence contains two or more alignment tokens.
// At 1:1 it would be an exact duplicate of its parent.
//
// Punctuation between words is NOT emitted on the Word tier: ELAN has no
// equivalent of FLEx's <item type="punct">, so it would be indistinguishable
// from a word in tier counts and searches.
//
// Pure functions: no DOM, no client, no Date (timestamps passed in).

import { morphFormOf } from '../domain/igtExport.js';
import { morphemeJoiner } from '../domain/affixMarkers.js';
import { xmlEscape, phraseSpeakerFor } from './flextext.js';

const EAF_VERSION = '2.8';
const SCHEMA_URL = 'http://www.mpi.nl/tools/elan/EAFv2.8.xsd';

// The four predefined stereotypes. ELAN writes all of them into every document
// whether or not they are used, and so do we.
const CONSTRAINTS = [
  [
    'Time_Subdivision',
    "Time subdivision of parent annotation's time interval, no time gaps allowed within this interval",
  ],
  [
    'Symbolic_Subdivision',
    'Symbolic subdivision of a parent annotation. Annotations refering to the same parent are ordered',
  ],
  ['Symbolic_Association', '1-1 association with a parent annotation'],
  [
    'Included_In',
    "Time alignable annotations within the parent annotation's time interval, gaps are allowed",
  ],
];

// Linguistic types (EAF's "tier types"): one per stereotype, shared by every
// tier of that shape and by every speaker's copy of it.
const TYPE_SENTENCE = 'Sentence';
const TYPE_SEGMENT = 'Segment';
const TYPE_WORD = 'Word';
const TYPE_MORPH = 'Morph';
const TYPE_ASSOCIATION = 'Annotation';

const LINGUISTIC_TYPES = [
  { id: TYPE_SENTENCE, constraint: null, alignable: true },
  { id: TYPE_SEGMENT, constraint: 'Included_In', alignable: true },
  { id: TYPE_WORD, constraint: 'Symbolic_Subdivision', alignable: false },
  { id: TYPE_MORPH, constraint: 'Symbolic_Subdivision', alignable: false },
  { id: TYPE_ASSOCIATION, constraint: 'Symbolic_Association', alignable: false },
];

/** Default tier names for the four structural tiers. */
export const DEFAULT_TIER_NAMES = Object.freeze({
  sentence: 'Sentence',
  segment: 'Segment',
  word: 'Word',
  morph: 'Morph',
});

// ---- helpers ---------------------------------------------------------------

const attr = (name, value) =>
  value === null || value === undefined || value === '' ? '' : ` ${name}="${xmlEscape(value)}"`;

const hasValidTimes = (t) => {
  const { timeBegin, timeEnd } = t?.metadata ?? {};
  return Number.isFinite(timeBegin) && Number.isFinite(timeEnd) && timeEnd >= timeBegin;
};

/**
 * The alignment tokens lying WHOLLY inside a sentence, in text order. A token
 * straddling the boundary matches no sentence by design (see the header note).
 */
export function containedAlignments(sentence, tokens) {
  return (tokens || [])
    .filter((t) => t.begin >= sentence.begin && t.end <= sentence.end)
    .sort((a, b) => a.begin - b.begin);
}

/**
 * The speaker a sentence's tiers are filed under, or null. Resolved the same way
 * as its timing, so the two never disagree: the unique speaker among the
 * alignment tokens INSIDE the sentence, falling back to the strict covering-token
 * rule the .flextext export uses when the sentence contains none (an alignment
 * wider than the sentence). Contained segments that disagree yield no speaker
 * rather than an arbitrary one.
 */
export function sentenceSpeaker(sentence, tokens) {
  const inside = containedAlignments(sentence, tokens);
  if (inside.length) {
    const named = new Set(
      inside
        .map((t) => t.metadata?.speaker)
        .filter((sp) => typeof sp === 'string' && sp.trim() !== '')
        .map((sp) => sp.trim()),
    );
    return named.size === 1 ? [...named][0] : null;
  }
  return phraseSpeakerFor(sentence, tokens);
}

/**
 * {beginMs, endMs} for a sentence: the span of the alignment tokens inside it,
 * or null when it contains none. Milliseconds, since ELAN assumes them.
 */
export function sentenceTiming(sentence, validTokens) {
  const inside = containedAlignments(sentence, validTokens);
  if (!inside.length) return null;
  return {
    beginMs: Math.round(Math.min(...inside.map((t) => t.metadata.timeBegin)) * 1000),
    endMs: Math.round(Math.max(...inside.map((t) => t.metadata.timeEnd)) * 1000),
  };
}

// A name allocator: TIER_ID is subject to an xsd:key, so a field named "Word"
// must not collide with the structural Word tier.
const nameAllocator = () => {
  const used = new Set();
  return (candidate, fallback) => {
    const base = String(candidate ?? '').trim() || fallback;
    let name = base;
    for (let i = 2; used.has(name); i++) name = `${base}-${i}`;
    used.add(name);
    return name;
  };
};

// Per-morpheme display form. Non-initial morphemes carry the boundary marker on
// their leading edge ("perro", "-s"), the FLEx/ELAN morph-tier convention;
// markers are display-only and never stored (see domain/affixMarkers.js).
const morphText = (morphemes, i, withMarkers) => {
  const form = morphFormOf(morphemes[i]);
  if (!withMarkers || i === 0) return form;
  const typeOf = (m) => m?.morphType ?? m?.metadata?.morphType;
  return morphemeJoiner(typeOf(morphemes[i - 1]), typeOf(morphemes[i])) + form;
};

// MIME_TYPE is required on MEDIA_DESCRIPTOR. When the caller has the served
// content type we use it; otherwise it is guessed from the filename extension,
// falling back to audio/x-wav (ELAN re-detects the real type when it opens the
// media, so the attribute is a hint rather than a contract).
const MIME_BY_EXT = {
  wav: 'audio/x-wav',
  mp3: 'audio/mpeg',
  m4a: 'audio/mp4',
  aac: 'audio/aac',
  ogg: 'audio/ogg',
  flac: 'audio/flac',
  weba: 'audio/webm',
  mp4: 'video/mp4',
  webm: 'video/webm',
  mov: 'video/quicktime',
  avi: 'video/x-msvideo',
  mpg: 'video/mpeg',
};
const mimeFor = (mediaType, location) => {
  if (mediaType) return mediaType;
  const ext = String(location ?? '')
    .split('.')
    .pop()
    .toLowerCase();
  return MIME_BY_EXT[ext] || 'audio/x-wav';
};

// The media file name to reference when the caller has not computed a relative
// href. Same reasoning as the .flextext exporter: the server's mediaUrl is a
// bare endpoint path with no filename, so when its last segment carries no
// extension we fall back to the document name, a placeholder to name the media
// after when placing it beside the .eaf.
const derivedMediaName = (docData) => {
  const path = String(docData.mediaUrl).split(/[?#]/)[0];
  const base =
    path
      .split('/')
      .filter((s) => s !== '')
      .at(-1) ?? '';
  return base.includes('.') ? base : docData.name || base || 'media';
};

// ---- model -----------------------------------------------------------------

/**
 * Walk the document once, minting every TIME_SLOT and ANNOTATION_ID up front.
 * Slots are allocated in text order (which is time order), so TIME_ORDER comes
 * out non-decreasing without a sort: for each sentence, its begin slot, then
 * each contained segment's begin/end, then its end slot. Boundary slots repeat
 * a value rather than sharing a slot. Included_In forbids slot sharing, and
 * EAF explicitly allows several slots with the same TIME_VALUE.
 */
function buildModel(igtDoc, options, nextAnn) {
  const body = igtDoc.body ?? '';
  const chars = [...body];
  const slice = (b, e) => chars.slice(b, e).join('');
  const alignmentTokens = igtDoc.alignmentTokens || [];
  const validAlignment = alignmentTokens.filter(hasValidTimes);
  const withMarkers = options?.affixMarkers !== false;
  const wantMorphs = options?.segmentMorphemes !== false;

  const timeSlots = [];
  const nextSlot = (value) => {
    const id = `ts${timeSlots.length + 1}`;
    timeSlots.push({ id, value });
    return id;
  };

  const sentences = (igtDoc.sortedSentences || []).map((sentence) => {
    const inside = containedAlignments(sentence, validAlignment);
    const timing = sentenceTiming(sentence, validAlignment);
    const beginSlot = nextSlot(timing ? timing.beginMs : null);
    const segments = inside.map((t) => ({
      annId: nextAnn(),
      beginSlot: nextSlot(Math.round(t.metadata.timeBegin * 1000)),
      endSlot: nextSlot(Math.round(t.metadata.timeEnd * 1000)),
      value: slice(t.begin, t.end),
    }));
    const endSlot = nextSlot(timing ? timing.endMs : null);

    const words = (sentence.tokens || []).map((token) => {
      const morphemes = wantMorphs ? token.morphemes || [] : [];
      return {
        annId: nextAnn(),
        value: token.content ?? '',
        orthographies: token.orthographies || {},
        annotations: token.annotations || {},
        morphs: morphemes.map((m, i) => ({
          annId: nextAnn(),
          value: morphText(morphemes, i, withMarkers),
          annotations: m.annotations || {},
        })),
      };
    });

    return {
      annId: nextAnn(),
      beginSlot,
      endSlot,
      value: slice(sentence.begin, sentence.end).trim(),
      speaker: sentenceSpeaker(sentence, alignmentTokens),
      segments,
      words,
      annotations: sentence.annotations || {},
    };
  });

  // The Segment tier earns its place only when it says something the Sentence
  // tier does not.
  const wantSegmentTier = sentences.some((s) => s.segments.length > 1);

  // One tier set per speaker when asked and speakers exist; otherwise one set.
  const speakers =
    options?.perSpeaker && sentences.some((s) => s.speaker)
      ? [...new Set(sentences.map((s) => s.speaker))]
      : [null];

  return { timeSlots, sentences, speakers, wantSegmentTier };
}

// ---- tier emission ---------------------------------------------------------

const alignable = (indent, annId, beginSlot, endSlot, value) => [
  `${indent}<ANNOTATION>`,
  `${indent}  <ALIGNABLE_ANNOTATION ANNOTATION_ID="${annId}" TIME_SLOT_REF1="${beginSlot}" TIME_SLOT_REF2="${endSlot}">`,
  `${indent}    <ANNOTATION_VALUE>${xmlEscape(value)}</ANNOTATION_VALUE>`,
  `${indent}  </ALIGNABLE_ANNOTATION>`,
  `${indent}</ANNOTATION>`,
];

const refAnnotation = (indent, annId, parentId, value, previousId = null) => [
  `${indent}<ANNOTATION>`,
  `${indent}  <REF_ANNOTATION ANNOTATION_ID="${annId}" ANNOTATION_REF="${parentId}"` +
    `${attr('PREVIOUS_ANNOTATION', previousId)}>`,
  `${indent}    <ANNOTATION_VALUE>${xmlEscape(value)}</ANNOTATION_VALUE>`,
  `${indent}  </REF_ANNOTATION>`,
  `${indent}</ANNOTATION>`,
];

const tier = (id, typeRef, { parent = null, participant = null, annotations = [] }) => {
  if (!annotations.length) return [];
  return [
    `  <TIER TIER_ID="${xmlEscape(id)}" LINGUISTIC_TYPE_REF="${xmlEscape(typeRef)}"` +
      `${attr('PARENT_REF', parent)}${attr('PARTICIPANT', participant)}>`,
    ...annotations,
    '  </TIER>',
  ];
};

/**
 * A Symbolic_Association tier: at most one child per parent, and a parent whose
 * value is empty simply gets none. `rows` is [{parentId, annId, value}].
 */
const associationTier = (id, parentTier, participant, rows) =>
  tier(id, TYPE_ASSOCIATION, {
    parent: parentTier,
    participant,
    annotations: rows.flatMap((r) => refAnnotation('    ', r.annId, r.parentId, r.value)),
  });

// ---- document --------------------------------------------------------------

/**
 * One IGT document as a complete .eaf file.
 *
 * options:
 *   orthographies / wordFields / morphFields / sentFields: tier selection,
 *       the same keys the plain-text preset uses (so intersectSelection applies)
 *   segmentMorphemes  bool: emit the Morph tier and its fields
 *   affixMarkers      bool: prefix non-initial morphs with their -/= joint
 *   perSpeaker        bool: one tier set per speaker, suffixed "@Speaker"
 *   tierNames         {sentence, segment, word, morph}: structural tier names
 *
 * context: { exportedAt, author, mediaHref, mediaType }
 */
export function buildEafDocument(igtDoc, options = {}, context = {}) {
  const { exportedAt, author = 'plaid-igt', mediaHref = null, mediaType = null } = context;
  const docData = igtDoc.document || {};
  // ANNOTATION_ID is xsd:ID, so ids must be NCNames, never built from tier or
  // field names, which are free text. One counter serves the whole document.
  let annSeq = 0;
  const nextAnn = () => `a${++annSeq}`;
  const model = buildModel(igtDoc, options, nextAnn);

  // Tier names are allocated once, before the speaker suffix, so every
  // speaker's copy of a tier is named consistently.
  const alloc = nameAllocator();
  const names = { ...DEFAULT_TIER_NAMES, ...(options.tierNames || {}) };
  const sentenceName = alloc(names.sentence, 'Sentence');
  const segmentName = model.wantSegmentTier ? alloc(names.segment, 'Segment') : null;
  const wordName = alloc(names.word, 'Word');
  const morphName = options.segmentMorphemes !== false ? alloc(names.morph, 'Morph') : null;
  const orthNames = new Map((options.orthographies || []).map((n) => [n, alloc(n, 'Orthography')]));
  const wordFieldNames = new Map((options.wordFields || []).map((n) => [n, alloc(n, 'WordField')]));
  const morphFieldNames = new Map(
    morphName ? (options.morphFields || []).map((n) => [n, alloc(n, 'MorphField')]) : [],
  );
  const sentFieldNames = new Map((options.sentFields || []).map((n) => [n, alloc(n, 'SentField')]));

  const lines = [];
  for (const speaker of model.speakers) {
    const suffix = speaker ? `@${speaker}` : '';
    const t = (base) => `${base}${suffix}`;
    const sentences =
      model.speakers.length === 1
        ? model.sentences
        : model.sentences.filter((s) => s.speaker === speaker);
    if (!sentences.length) continue;

    const words = sentences.flatMap((s) => s.words);
    const morphs = words.flatMap((w) => w.morphs);

    lines.push(
      ...tier(t(sentenceName), TYPE_SENTENCE, {
        participant: speaker,
        annotations: sentences.flatMap((s) =>
          alignable('    ', s.annId, s.beginSlot, s.endSlot, s.value),
        ),
      }),
    );

    if (segmentName) {
      lines.push(
        ...tier(t(segmentName), TYPE_SEGMENT, {
          parent: t(sentenceName),
          participant: speaker,
          annotations: sentences.flatMap((s) =>
            s.segments.flatMap((g) => alignable('    ', g.annId, g.beginSlot, g.endSlot, g.value)),
          ),
        }),
      );
    }

    // Symbolic_Subdivision children are an ordered chain per parent.
    lines.push(
      ...tier(t(wordName), TYPE_WORD, {
        parent: t(sentenceName),
        participant: speaker,
        annotations: sentences.flatMap((s) =>
          s.words.flatMap((w, i) =>
            refAnnotation('    ', w.annId, s.annId, w.value, i > 0 ? s.words[i - 1].annId : null),
          ),
        ),
      }),
    );

    for (const [field, tierName] of orthNames) {
      lines.push(
        ...associationTier(
          t(tierName),
          t(wordName),
          speaker,
          words
            .filter((w) => (w.orthographies?.[field] ?? '') !== '')
            .map((w) => ({ parentId: w.annId, annId: nextAnn(), value: w.orthographies[field] })),
        ),
      );
    }
    for (const [field, tierName] of wordFieldNames) {
      lines.push(
        ...associationTier(
          t(tierName),
          t(wordName),
          speaker,
          words
            .filter((w) => (w.annotations?.[field]?.value ?? '') !== '')
            .map((w) => ({
              parentId: w.annId,
              annId: nextAnn(),
              value: w.annotations[field].value,
            })),
        ),
      );
    }

    if (morphName) {
      lines.push(
        ...tier(t(morphName), TYPE_MORPH, {
          parent: t(wordName),
          participant: speaker,
          annotations: words.flatMap((w) =>
            w.morphs.flatMap((m, i) =>
              refAnnotation(
                '    ',
                m.annId,
                w.annId,
                m.value,
                i > 0 ? w.morphs[i - 1].annId : null,
              ),
            ),
          ),
        }),
      );
      for (const [field, tierName] of morphFieldNames) {
        lines.push(
          ...associationTier(
            t(tierName),
            t(morphName),
            speaker,
            morphs
              .filter((m) => (m.annotations?.[field]?.value ?? '') !== '')
              .map((m) => ({
                parentId: m.annId,
                annId: nextAnn(),
                value: m.annotations[field].value,
              })),
          ),
        );
      }
    }

    for (const [field, tierName] of sentFieldNames) {
      lines.push(
        ...associationTier(
          t(tierName),
          t(sentenceName),
          speaker,
          sentences
            .filter((s) => (s.annotations?.[field]?.value ?? '') !== '')
            .map((s) => ({
              parentId: s.annId,
              annId: nextAnn(),
              value: s.annotations[field].value,
            })),
        ),
      );
    }
  }

  const header = ['  <HEADER TIME_UNITS="milliseconds">'];
  if (docData.mediaUrl) {
    // MEDIA_URL is the bare name (ELAN's absolute-path slot, which is not
    // meaningful for an exported archive); RELATIVE_MEDIA_URL is the path that
    // actually resolves, computed by the caller for the layout it is building.
    const href = mediaHref || `./${derivedMediaName(docData)}`;
    const fileName = href.split('/').pop();
    header.push(
      `    <MEDIA_DESCRIPTOR MEDIA_URL="${xmlEscape(fileName)}"` +
        ` RELATIVE_MEDIA_URL="${xmlEscape(href)}"` +
        ` MIME_TYPE="${xmlEscape(mimeFor(mediaType, fileName))}"/>`,
    );
  }
  // Document name and configured metadata ride along as HEADER properties,
  // the only general-purpose key/value slot EAF offers.
  header.push(`    <PROPERTY NAME="documentName">${xmlEscape(docData.name ?? '')}</PROPERTY>`);
  for (const [key, value] of Object.entries(docData.metadata || {})) {
    if (value === null || value === undefined || value === '') continue;
    header.push(`    <PROPERTY NAME="${xmlEscape(key)}">${xmlEscape(value)}</PROPERTY>`);
  }
  header.push('  </HEADER>');

  return [
    '<?xml version="1.0" encoding="UTF-8"?>',
    `<ANNOTATION_DOCUMENT AUTHOR="${xmlEscape(author)}" DATE="${xmlEscape(exportedAt)}"` +
      ` FORMAT="${EAF_VERSION}" VERSION="${EAF_VERSION}"` +
      ' xmlns:xsi="http://www.w3.org/2001/XMLSchema-instance"' +
      ` xsi:noNamespaceSchemaLocation="${SCHEMA_URL}">`,
    ...header,
    '  <TIME_ORDER>',
    ...model.timeSlots.map(
      (s) =>
        `    <TIME_SLOT TIME_SLOT_ID="${s.id}"${s.value === null ? '' : ` TIME_VALUE="${s.value}"`}/>`,
    ),
    '  </TIME_ORDER>',
    ...lines,
    ...LINGUISTIC_TYPES.map(
      (t) =>
        `  <LINGUISTIC_TYPE LINGUISTIC_TYPE_ID="${t.id}" TIME_ALIGNABLE="${t.alignable}"` +
        `${attr('CONSTRAINTS', t.constraint)} GRAPHIC_REFERENCES="false"/>`,
    ),
    ...CONSTRAINTS.map(
      ([stereotype, description]) =>
        `  <CONSTRAINT STEREOTYPE="${stereotype}" DESCRIPTION="${xmlEscape(description)}"/>`,
    ),
    '</ANNOTATION_DOCUMENT>',
    '',
  ].join('\n');
}

/**
 * What the chosen options will and won't carry, reported BEFORE the export runs
 * (the same contract as cldfLossSummary). ELAN has a tier for everything, so
 * nothing is silently narrowed: the only losses are tiers left unselected and
 * the morpheme layer when segmentation is off.
 */
export function elanLossSummary(layers, options) {
  const tiers = [];
  const dropped = [];
  const label = (name, kind) => `${name} (${kind})`;
  const bucket = (available, selected, kind, force) => {
    for (const name of available || []) {
      if (!force && (selected || []).includes(name)) tiers.push(label(name, kind));
      else dropped.push(label(name, kind));
    }
  };
  bucket(layers?.orthographies, options?.orthographies, 'orthography');
  bucket(layers?.wordFields, options?.wordFields, 'word field');
  bucket(
    layers?.morphFields,
    options?.morphFields,
    'morpheme field',
    options?.segmentMorphemes === false,
  );
  bucket(layers?.sentFields, options?.sentFields, 'sentence field');
  return {
    tiers,
    dropped,
    morphemesDropped: !!layers?.hasMorphemes && options?.segmentMorphemes === false,
  };
}

/** A fresh preset's options: every tier selected, morphemes segmented. */
export const defaultElanOptions = (layers) => ({
  orthographies: [...(layers?.orthographies || [])],
  wordFields: [...(layers?.wordFields || [])],
  morphFields: [...(layers?.morphFields || [])],
  sentFields: [...(layers?.sentFields || [])],
  segmentMorphemes: true,
  affixMarkers: true,
  perSpeaker: true,
});
