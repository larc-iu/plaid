// FLEx interlinear XML (.flextext) serialization. Structure verified against
// FieldWorks' FlexInterlinear.xsd:
//
//   <document version="2">
//     <interlinear-text>                          (1..n per document)
//       <item type="title|source|comment">
//       <paragraphs><paragraph><phrases>
//         <phrase media-file? begin-time-offset? end-time-offset? speaker?>
//           <item type="segnum">
//           <words>
//             <word><item type="txt">…<morphemes><morph type="…"><item …/></morph></morphemes></word>
//             <word><item type="punct">…</word>
//           </words>
//           <item type="gls|lit|note">            (trailing translations)
//         </phrase>
//       </phrases></paragraph></paragraphs>
//       <languages><language lang vernacular?/>
//       <media-files><media guid location/>          (when timed + media)
//     </interlinear-text>
//   </document>
//
// Every <item> carries type + lang. <morph type> takes exactly the FLEx
// MoMorphType names — our metadata.morphType inventory (FLEX_MORPH_TYPES)
// maps 1:1; the attribute is omitted when absent/invalid. GUIDs are always
// omitted (FLEx creates fresh objects on import). Affix markers are NEVER
// written into txt items — FLEx re-derives them from the morph type.
// Missing/empty values omit the <item> entirely; odd configs must degrade,
// not throw.
//
// options (from the export preset):
//   langs: { baseline, analysis, orthographies: {name→tag}, fieldOverrides: {field→tag} }
//   fieldMap: { sentence: {field→'gls'|'lit'|'note'}, word: {field→'gls'|'pos'},
//               morpheme: {field→'gls'|'msa'} }   (unmapped fields are omitted)
//   citationForms: bool   — emit <item type="cf"> from morpheme.vocabItem.form

import { FLEX_MORPH_TYPES } from '../domain/affixMarkers.js';
import { morphFormOf } from '../domain/igtExport.js';

const xmlEscape = (s) => String(s ?? '')
  .replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;')
  .replace(/"/g, '&quot;').replace(/'/g, '&apos;');

// ---- lang resolution -------------------------------------------------------

const baselineLang = (options) => options?.langs?.baseline || 'und';
const analysisLang = (options) => options?.langs?.analysis || 'en';
const fieldLang = (options, field) =>
  options?.langs?.fieldOverrides?.[field] || analysisLang(options);

// ---- element builders (each returns [] or [lines]) -------------------------

const item = (indent, type, lang, value) => {
  if (value == null || value === '') return [];
  return [`${indent}<item type="${xmlEscape(type)}" lang="${xmlEscape(lang)}">${xmlEscape(value)}</item>`];
};

function morphXml(indent, m, options) {
  const morphType = m?.metadata?.morphType;
  const typeAttr = FLEX_MORPH_TYPES.includes(morphType)
    ? ` type="${xmlEscape(morphType)}"` : '';
  const lines = [`${indent}<morph${typeAttr}>`];
  lines.push(...item(`${indent}  `, 'txt', baselineLang(options), morphFormOf(m)));
  if (options?.citationForms && m?.vocabItem?.form) {
    lines.push(...item(`${indent}  `, 'cf', baselineLang(options), m.vocabItem.form));
  }
  for (const [field, type] of Object.entries(options?.fieldMap?.morpheme || {})) {
    if (type !== 'gls' && type !== 'msa') continue;
    lines.push(...item(`${indent}  `, type, fieldLang(options, field), m?.annotations?.[field]?.value));
  }
  lines.push(`${indent}</morph>`);
  return lines;
}

function wordXml(indent, token, options) {
  const lines = [`${indent}<word>`];
  lines.push(...item(`${indent}  `, 'txt', baselineLang(options), token.content));
  // Alternate orthographies are alternate vernacular writing systems: extra
  // txt items in their own lang — the exact inverse of the .fwbackup import.
  for (const [name, tag] of Object.entries(options?.langs?.orthographies || {})) {
    if (!tag) continue;
    lines.push(...item(`${indent}  `, 'txt', tag, token.orthographies?.[name]));
  }
  for (const [field, type] of Object.entries(options?.fieldMap?.word || {})) {
    if (type !== 'gls' && type !== 'pos') continue;
    lines.push(...item(`${indent}  `, type, fieldLang(options, field), token.annotations?.[field]?.value));
  }
  const morphemes = token.morphemes || [];
  if (morphemes.length) {
    lines.push(`${indent}  <morphemes>`);
    for (const m of morphemes) lines.push(...morphXml(`${indent}    `, m, options));
    lines.push(`${indent}  </morphemes>`);
  }
  lines.push(`${indent}</word>`);
  return lines;
}

function punctWordXml(indent, content, options) {
  const trimmed = String(content ?? '').trim();
  if (trimmed === '') return [];
  return [
    `${indent}<word>`,
    ...item(`${indent}  `, 'punct', baselineLang(options), trimmed),
    `${indent}</word>`,
  ];
}

// ---- time alignment --------------------------------------------------------
// flextext can express alignment only at phrase granularity (begin/end-time-
// offset attributes, FLEx's ELAN interop). We emit timings only where they are
// truthful: a sentence gets offsets when exactly one alignment token matches
// its extent (preferring an exact match, falling back to a unique containing
// token). Anything else — partial overlaps, ambiguity — is skipped; we never
// invent alignment. Times are stored in seconds (metadata.timeBegin/timeEnd);
// FLEx/ELAN expect integer milliseconds.

const hasValidTimes = (t) => {
  const { timeBegin, timeEnd } = t?.metadata ?? {};
  return Number.isFinite(timeBegin) && Number.isFinite(timeEnd) && timeEnd >= timeBegin;
};

// The single alignment token an analysis phrase inherits from: an exact extent
// match, else a unique token whose extent contains the sentence. Null when
// there's no unique match (partial overlap, ambiguity) — we never invent
// alignment. Shared by the timing and speaker projections so both stay
// truthful in exactly the same cases.
function coveringAlignment(sentence, tokens) {
  const exact = tokens.filter((t) => t.begin === sentence.begin && t.end === sentence.end);
  const candidates = exact.length
    ? exact
    : tokens.filter((t) => t.begin <= sentence.begin && t.end >= sentence.end);
  return candidates.length === 1 ? candidates[0] : null;
}

/** {beginMs, endMs} for a sentence, or null when no unique truthful match. */
export function phraseTimingFor(sentence, validTokens) {
  const t = coveringAlignment(sentence, validTokens);
  if (!t) return null;
  const { timeBegin, timeEnd } = t.metadata;
  return { beginMs: Math.round(timeBegin * 1000), endMs: Math.round(timeEnd * 1000) };
}

// Speaker (diarization) for a sentence, or null. Same strict unique-match rule
// as timing, but resolved over ALL alignment tokens (a speaker is independent
// of whether the segment carries valid times). FLEx has no per-phrase speaker
// in its glossing model proper — `speaker` is an ELAN-interop phrase attribute
// alongside the time offsets — so a phrase that straddles a speaker change just
// gets no speaker rather than a wrong one.
export function phraseSpeakerFor(sentence, tokens) {
  const s = coveringAlignment(sentence, tokens)?.metadata?.speaker;
  return (typeof s === 'string' && s.trim() !== '') ? s.trim() : null;
}

function phraseXml(indent, sentence, segnum, options, timing = null, mediaGuid = null, speaker = null) {
  const timeAttrs = timing
    ? `${mediaGuid ? ` media-file="${xmlEscape(mediaGuid)}"` : ''}`
      + ` begin-time-offset="${timing.beginMs}" end-time-offset="${timing.endMs}"`
    : '';
  const speakerAttr = speaker ? ` speaker="${xmlEscape(speaker)}"` : '';
  const lines = [`${indent}<phrase${timeAttrs}${speakerAttr}>`];
  lines.push(...item(`${indent}  `, 'segnum', analysisLang(options), String(segnum)));
  lines.push(`${indent}  <words>`);
  const pieces = sentence.pieces
    || (sentence.tokens || []).map((t) => ({ type: 'token', ...t }));
  for (const piece of pieces) {
    if (piece.type === 'token') lines.push(...wordXml(`${indent}    `, piece, options));
    else lines.push(...punctWordXml(`${indent}    `, piece.content, options));
  }
  lines.push(`${indent}  </words>`);
  for (const [field, type] of Object.entries(options?.fieldMap?.sentence || {})) {
    if (type !== 'gls' && type !== 'lit' && type !== 'note') continue;
    lines.push(...item(`${indent}  `, type, fieldLang(options, field), sentence.annotations?.[field]?.value));
  }
  lines.push(`${indent}</phrase>`);
  return lines;
}

// Group sentences into paragraphs: a new paragraph starts wherever the
// baseline text between two consecutive sentences contains a newline.
// Fallback (no body available): one paragraph for everything.
function paragraphRuns(igtDoc) {
  const sentences = igtDoc.sortedSentences || [];
  if (!sentences.length) return [];
  const chars = [...(igtDoc.body ?? '')];
  const runs = [[sentences[0]]];
  for (let i = 1; i < sentences.length; i++) {
    const between = chars.slice(sentences[i - 1].end, sentences[i].begin).join('');
    if (between.includes('\n')) runs.push([]);
    runs[runs.length - 1].push(sentences[i]);
  }
  return runs;
}

function languagesXml(indent, options) {
  const seen = new Set();
  const lines = [`${indent}<languages>`];
  const add = (tag, vernacular) => {
    if (!tag || seen.has(tag)) return;
    seen.add(tag);
    lines.push(`${indent}  <language lang="${xmlEscape(tag)}"${vernacular ? ' vernacular="true"' : ''}/>`);
  };
  add(baselineLang(options), true);
  for (const tag of Object.values(options?.langs?.orthographies || {})) add(tag, true);
  add(analysisLang(options), false);
  for (const tag of Object.values(options?.langs?.fieldOverrides || {})) add(tag, false);
  lines.push(`${indent}</languages>`);
  return lines;
}

// The <media location> hint. The server's mediaUrl is the bare endpoint path
// (/api/v1/documents/<id>/media — no filename), so when its last segment
// carries no extension we fall back to the document name: a placeholder the
// user can name their media file after when placing it next to the .flextext
// (FLEx prompts to locate missing media on import either way).
const mediaLocationOf = (docData) => {
  const path = String(docData.mediaUrl).split(/[?#]/)[0];
  const base = path.split('/').filter((s) => s !== '').at(-1) ?? '';
  return base.includes('.') ? base : (docData.name || base || 'media');
};

export function interlinearTextXml(igtDoc, options, indent = '  ') {
  const docData = igtDoc.document || {};
  const lines = [`${indent}<interlinear-text>`];
  lines.push(...item(`${indent}  `, 'title', baselineLang(options), docData.name));
  // Configured document metadata rides along as source/comment items.
  for (const [key, value] of Object.entries(docData.metadata || {})) {
    if (value == null || value === '') continue;
    if (/source/i.test(key)) lines.push(...item(`${indent}  `, 'source', analysisLang(options), value));
    else lines.push(...item(`${indent}  `, 'comment', analysisLang(options), `${key}: ${value}`));
  }
  const validAlignment = (igtDoc.alignmentTokens || []).filter(hasValidTimes);
  const mediaGuid = docData.mediaUrl ? docData.id : null;
  let anyTimed = false;
  lines.push(`${indent}  <paragraphs>`);
  let segnum = 0;
  for (const run of paragraphRuns(igtDoc)) {
    lines.push(`${indent}    <paragraph>`, `${indent}      <phrases>`);
    for (const sentence of run) {
      segnum += 1;
      const timing = validAlignment.length ? phraseTimingFor(sentence, validAlignment) : null;
      if (timing) anyTimed = true;
      const speaker = phraseSpeakerFor(sentence, igtDoc.alignmentTokens || []);
      lines.push(...phraseXml(`${indent}        `, sentence, segnum, options, timing, mediaGuid, speaker));
    }
    lines.push(`${indent}      </phrases>`, `${indent}    </paragraph>`);
  }
  lines.push(`${indent}  </paragraphs>`);
  lines.push(...languagesXml(`${indent}  `, options));
  if (mediaGuid && anyTimed) {
    lines.push(`${indent}  <media-files>`);
    lines.push(`${indent}    <media guid="${xmlEscape(mediaGuid)}" location="${xmlEscape(mediaLocationOf(docData))}"/>`);
    lines.push(`${indent}  </media-files>`);
  }
  lines.push(`${indent}</interlinear-text>`);
  return lines.join('\n');
}

/** One or more documents as a complete .flextext file. */
export function buildFlextextDocument(igtDocs, options) {
  const texts = igtDocs.map((d) => interlinearTextXml(d, options));
  return [
    '<?xml version="1.0" encoding="UTF-8"?>',
    '<document version="2" exportSource="plaid-igt">',
    ...texts,
    '</document>',
    '',
  ].join('\n');
}
