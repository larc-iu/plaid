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

import { makeCpIndexer, matchesAt } from '../align.js';
// alignWords is the shared "ordered forms, no offsets" matcher. It currently
// lives with the CLDF importer that first needed it; it belongs in align.js
// beside its siblings and should move there when that file next settles.
import { alignWords } from '../cldf/buildDocuments.js';
import { ROLES, nodeLabel } from './schema.js';
import { chainOrder } from './readEaf.js';

/** EAF milliseconds → Plaid seconds. */
const toSeconds = (ms) => Math.round(ms) / 1000;

// HEADER properties ELAN maintains for itself. They are not annotation and a
// user would only ever see them as noise in the document metadata panel.
const INTERNAL_PROPERTIES = new Set(['lastUsedAnnotationId', 'URN']);

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

/** Default target name for a field/orthography node. */
export const defaultFieldName = (node) => nodeLabel(node);

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
 * Build importable documents.
 *
 * @param files  parsed .eaf objects (readEaf output)
 * @param nodes  the agreed schema (schema.js tierSchema, one shared shape)
 * @param roles  {nodeKey: ROLES.*}
 * @param options {fieldNames: {nodeKey: string}}
 * @returns {{documents, schema, stats, warnings}}
 */
export function buildElanDocuments(files, nodes, roles, options = {}) {
  const fieldNames = options.fieldNames || {};
  const nameOf = (node) => (fieldNames[node.key] || defaultFieldName(node)).trim();
  const { byRole } = resolveMapping(nodes, roles);
  const warnings = [];

  const utteranceNodes = byRole.get(ROLES.UTTERANCE) || [];
  if (!utteranceNodes.length) throw new Error('No tier is mapped to the utterances.');
  const alignmentNodes = byRole.get(ROLES.ALIGNMENT) || [];
  const wordNodes = byRole.get(ROLES.WORD) || [];
  const morphNodes = byRole.get(ROLES.MORPHEME) || [];
  const sentFieldNodes = byRole.get(ROLES.SENTENCE_FIELD) || [];
  const wordFieldNodes = byRole.get(ROLES.WORD_FIELD) || [];
  const morphFieldNodes = byRole.get(ROLES.MORPH_FIELD) || [];
  const orthographyNodes = byRole.get(ROLES.ORTHOGRAPHY) || [];

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

    // --- collect the utterances, ordered by time, then by document order ----
    const utterances = [];
    let blankUtterances = 0;
    for (const tier of tiersOfNodes(eaf, utteranceNodes)) {
      for (const ann of tier.annotations) {
        // A blank annotation is a placeholder ELAN users leave behind. It has
        // no transcription to anchor a sentence to, and keeping one would put a
        // zero-width token in the sentence partition (which the server refuses)
        // or a sentence holding nothing but the newline joining its neighbours.
        if (!String(ann.value ?? '').trim()) {
          blankUtterances += 1;
          continue;
        }
        utterances.push({ ann, tier, speaker: tier.participant || null });
      }
    }
    if (blankUtterances) {
      docWarnings.push(
        `Skipped ${blankUtterances} empty annotation${blankUtterances === 1 ? '' : 's'} on the utterance tier.`,
      );
    }
    utterances.sort((a, b) => (a.ann.beginMs ?? Infinity) - (b.ann.beginMs ?? Infinity));

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
      const found = childrenOn(parentAnn, parentTier, [node]);
      if (found.length > 1) {
        docWarnings.push(
          `${nodeLabel(node)} has ${found.length} annotations under one parent; kept the first.`,
        );
      }
      return found[0]?.value?.trim() ?? '';
    };

    // --- synthesize the baseline -------------------------------------------
    const pieces = [];
    let bodyU16 = '';
    for (const u of utterances) {
      const text = String(u.ann.value ?? '')
        .replace(/\s+/g, ' ')
        .trim();
      const beginU16 = bodyU16.length;
      bodyU16 += text;
      pieces.push({ ...u, text, beginU16, endU16: bodyU16.length });
      bodyU16 += '\n';
    }
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
          alignments.push({
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
          segments.map((s) => s.value),
        );
        let placed = 0;
        segments.forEach((seg, i) => {
          const span = spans[i];
          if (!span || span.beginU16 >= span.endU16) return;
          placed += 1;
          alignments.push({
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
          alignments.push({
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
      if (wordNodes.length) {
        wordAnns = childrenOn(piece.ann, piece.tier, wordNodes);
        const forms = wordAnns.map((a) => String(a.value ?? '').trim());
        const aligned = alignWords(body, piece.beginU16, piece.endU16, forms);
        wordSpans = aligned.spans;
        for (const w of aligned.warnings) {
          docWarnings.push(`Utterance ${si + 1}: ${w}`);
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
        const morphemes = morphAnns.map((mAnn) => {
          const { form, morphType } = readMorphForm(mAnn.value);
          const mFields = {};
          const mTier = tierOfAnnotation.get(mAnn.id) ?? annTier;
          for (const node of morphFieldNodes) {
            const v = fieldValueOn(mAnn, mTier, node);
            if (v) mFields[nameOf(node)] = v;
          }
          return { form, morphType, fields: mFields };
        });
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
    if (eaf.media.length) {
      const name = eaf.media[0].relativeUrl || eaf.media[0].url;
      if (name) metadata['Media file'] = String(name).split('/').pop();
    }

    documents.push({
      id: eaf.fileName,
      name: eaf.documentName,
      metadata,
      body,
      sentences,
      words,
      alignments,
      mediaBytes: null,
      mediaName: null,
      warnings: docWarnings,
    });
  }

  // Names collide when several files carry the same documentName; number them
  // so the project does not end up with five texts called "Untitled".
  const counts = new Map();
  for (const d of documents) counts.set(d.name, (counts.get(d.name) ?? 0) + 1);
  const seen = new Map();
  for (const d of documents) {
    if (counts.get(d.name) === 1) continue;
    const n = (seen.get(d.name) ?? 0) + 1;
    seen.set(d.name, n);
    d.name = `${d.name} (${n})`;
  }

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

  if (files.some((f) => f.media.length)) {
    warnings.push(
      'Media files are referenced by the .eaf files but are not imported. Attach them to each document afterwards.',
    );
  }

  const fieldsOf = (list, scope) => list.map((node) => ({ name: nameOf(node), scope }));
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
    warnings,
  };
}
