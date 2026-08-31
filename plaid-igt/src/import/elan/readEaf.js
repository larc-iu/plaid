// Read one ELAN annotation file (.eaf) into a neutral IR. Pure: text in,
// structures out, no DOM (saxes, like the FLEx parser, so the same code runs
// in the browser and in node without a DOM shim).
//
// EAF is stand-off: TIME_ORDER holds every anchor, tiers hold annotations that
// either point at two time slots (ALIGNABLE_ANNOTATION) or at a parent
// annotation (REF_ANNOTATION). Resolving both here means nothing downstream has
// to know the wire format.
//
// TIER NAMES AND PARTICIPANTS. ELAN's convention is `basename@participant`, and
// a top tier is very often named after the speaker alone ("Ana"). Neither is
// stable across the files of one corpus, so every tier also gets a `baseName`
// with the participant normalized out:
//
//   id "mb@Ana", participant "Ana"  → "mb"     (the usual dependent tier)
//   id "Ana",    participant "Ana"  → ""       (a speaker-named top tier)
//   id "ref",    no participant     → "ref"
//
// That is what makes two files by different speakers compare as the same
// structure (see schema.js). The tier TYPE carries the rest of the meaning:
// LINGUISTIC_TYPE is, in the spec's own words, "a definition of a type of tier".

import { SaxesParser } from 'saxes';

export class EafError extends Error {
  constructor(message) {
    super(message);
    this.name = 'EafError';
  }
}

/** The four EAF stereotypes, plus null for an unconstrained (top) tier. */
export const STEREOTYPES = Object.freeze({
  TIME_SUBDIVISION: 'Time_Subdivision',
  SYMBOLIC_SUBDIVISION: 'Symbolic_Subdivision',
  SYMBOLIC_ASSOCIATION: 'Symbolic_Association',
  INCLUDED_IN: 'Included_In',
});

/** Is this stereotype carried by ALIGNABLE_ANNOTATIONs? */
export const isAlignableStereotype = (s) =>
  s == null || s === STEREOTYPES.TIME_SUBDIVISION || s === STEREOTYPES.INCLUDED_IN;

/**
 * A tier's name with its participant normalized out. Exported for the schema
 * comparison and for the mapping UI's labels.
 */
export function baseTierName(id, participant) {
  const tierId = String(id ?? '');
  const who = String(participant ?? '').trim();
  if (who) {
    if (tierId === who) return '';
    if (tierId.endsWith(`@${who}`)) return tierId.slice(0, -(who.length + 1));
  }
  const at = tierId.lastIndexOf('@');
  return at > 0 ? tierId.slice(0, at) : tierId;
}

/**
 * Parse an .eaf document.
 *
 * @param {string} xmlText
 * @param {string} fileName  for error messages and the document name
 * @returns {{
 *   fileName: string,
 *   documentName: string,
 *   properties: Record<string,string>,
 *   media: Array<{url: string, relativeUrl: string, mimeType: string}>,
 *   linguisticTypes: Record<string, {constraint: string|null, timeAlignable: boolean}>,
 *   tiers: Array<{id, baseName, participant, typeRef, parentRef, annotator, annotations}>,
 * }}
 */
export function readEaf(xmlText, fileName = 'file.eaf') {
  const parser = new SaxesParser({ xmlns: false });
  const timeSlots = new Map(); // id → ms | null
  const linguisticTypes = {};
  const properties = {};
  const media = [];
  const tiers = [];

  let currentTier = null;
  let currentAnnotation = null;
  let textBuffer = null; // non-null while inside a value-bearing element
  let propertyName = null;
  let sawRoot = false;

  const num = (v) => {
    if (v === undefined || v === null || v === '') return null;
    const n = Number(v);
    return Number.isFinite(n) ? n : null;
  };

  parser.on('error', (err) => {
    throw new EafError(`${fileName} is not well-formed XML: ${err.message}`);
  });

  parser.on('opentag', (node) => {
    const a = node.attributes;
    switch (node.name) {
      case 'ANNOTATION_DOCUMENT':
        sawRoot = true;
        break;
      case 'TIME_SLOT':
        timeSlots.set(a.TIME_SLOT_ID, num(a.TIME_VALUE));
        break;
      case 'MEDIA_DESCRIPTOR':
        media.push({
          url: a.MEDIA_URL ?? '',
          relativeUrl: a.RELATIVE_MEDIA_URL ?? '',
          mimeType: a.MIME_TYPE ?? '',
        });
        break;
      case 'PROPERTY':
        propertyName = a.NAME ?? '';
        textBuffer = '';
        break;
      case 'LINGUISTIC_TYPE':
        linguisticTypes[a.LINGUISTIC_TYPE_ID] = {
          // CONSTRAINTS is authoritative over TIME_ALIGNABLE per the spec.
          constraint: a.CONSTRAINTS ?? null,
          timeAlignable: a.TIME_ALIGNABLE === 'true',
        };
        break;
      case 'TIER':
        currentTier = {
          id: a.TIER_ID ?? '',
          participant: (a.PARTICIPANT ?? '').trim(),
          annotator: (a.ANNOTATOR ?? '').trim(),
          typeRef: a.LINGUISTIC_TYPE_REF ?? '',
          parentRef: a.PARENT_REF ?? null,
          annotations: [],
        };
        currentTier.baseName = baseTierName(currentTier.id, currentTier.participant);
        tiers.push(currentTier);
        break;
      case 'ALIGNABLE_ANNOTATION':
        currentAnnotation = {
          id: a.ANNOTATION_ID ?? '',
          kind: 'alignable',
          value: '',
          slot1: a.TIME_SLOT_REF1 ?? null,
          slot2: a.TIME_SLOT_REF2 ?? null,
          ref: null,
          previous: null,
        };
        currentTier?.annotations.push(currentAnnotation);
        break;
      case 'REF_ANNOTATION':
        currentAnnotation = {
          id: a.ANNOTATION_ID ?? '',
          kind: 'ref',
          value: '',
          slot1: null,
          slot2: null,
          ref: a.ANNOTATION_REF ?? null,
          previous: a.PREVIOUS_ANNOTATION ?? null,
        };
        currentTier?.annotations.push(currentAnnotation);
        break;
      case 'ANNOTATION_VALUE':
        textBuffer = '';
        break;
      default:
        break;
    }
  });

  parser.on('text', (t) => {
    if (textBuffer !== null) textBuffer += t;
  });

  parser.on('closetag', (node) => {
    switch (node.name) {
      case 'ANNOTATION_VALUE':
        if (currentAnnotation) currentAnnotation.value = textBuffer ?? '';
        textBuffer = null;
        break;
      case 'PROPERTY':
        if (propertyName) properties[propertyName] = (textBuffer ?? '').trim();
        propertyName = null;
        textBuffer = null;
        break;
      case 'ALIGNABLE_ANNOTATION':
      case 'REF_ANNOTATION':
        currentAnnotation = null;
        break;
      case 'TIER':
        currentTier = null;
        break;
      default:
        break;
    }
  });

  try {
    parser.write(xmlText).close();
  } catch (err) {
    if (err instanceof EafError) throw err;
    throw new EafError(`${fileName} could not be parsed: ${err?.message ?? err}`);
  }
  if (!sawRoot) {
    throw new EafError(`${fileName} is not an ELAN file (no ANNOTATION_DOCUMENT element).`);
  }

  // Resolve time slots now that TIME_ORDER has certainly been seen. A slot with
  // no TIME_VALUE is an unaligned anchor, which EAF allows on purpose, so the
  // annotation keeps its place in the tier and simply has no time.
  for (const tier of tiers) {
    for (const ann of tier.annotations) {
      ann.beginMs = ann.slot1 ? (timeSlots.get(ann.slot1) ?? null) : null;
      ann.endMs = ann.slot2 ? (timeSlots.get(ann.slot2) ?? null) : null;
      delete ann.slot1;
      delete ann.slot2;
    }
  }

  const stem = String(fileName)
    .split('/')
    .pop()
    .replace(/\.eaf$/i, '');
  return {
    fileName,
    // Our own exporter records the original document name; otherwise the
    // filename is the only name an .eaf carries.
    documentName: properties.documentName || stem || 'Imported text',
    properties,
    media,
    linguisticTypes,
    tiers,
  };
}

/** The stereotype governing a tier, or null for an unconstrained top tier. */
export const stereotypeOf = (eaf, tier) => eaf.linguisticTypes?.[tier.typeRef]?.constraint ?? null;

/** Every annotation in the file, keyed by ANNOTATION_ID. */
export function annotationIndex(eaf) {
  const byId = new Map();
  for (const tier of eaf.tiers) {
    for (const ann of tier.annotations) byId.set(ann.id, { ann, tier });
  }
  return byId;
}

/**
 * Order a set of sibling REF_ANNOTATIONs by their PREVIOUS_ANNOTATION chain.
 * Symbolic_Subdivision children are an ordered sequence and the chain is how
 * EAF records that order, but real files are not always complete, so a broken
 * or absent chain falls back to document order rather than dropping anything.
 */
export function chainOrder(annotations) {
  const items = [...annotations];
  if (items.length < 2) return items;
  const byId = new Map(items.map((a) => [a.id, a]));
  const heads = items.filter((a) => !a.previous || !byId.has(a.previous));
  if (heads.length !== 1) return items;
  const nextOf = new Map();
  for (const a of items) {
    if (a.previous && byId.has(a.previous)) {
      // A fork means the chain is not a simple sequence; give up on it.
      if (nextOf.has(a.previous)) return items;
      nextOf.set(a.previous, a);
    }
  }
  const ordered = [];
  const seen = new Set();
  let cur = heads[0];
  while (cur && !seen.has(cur.id)) {
    ordered.push(cur);
    seen.add(cur.id);
    cur = nextOf.get(cur.id);
  }
  return ordered.length === items.length ? ordered : items;
}
