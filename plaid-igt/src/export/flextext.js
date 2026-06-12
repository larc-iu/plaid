// FLEx interlinear XML (.flextext) serialization. Structure verified against
// FieldWorks' FlexInterlinear.xsd:
//
//   <document version="2">
//     <interlinear-text>                          (1..n per document)
//       <item type="title|source|comment">
//       <paragraphs><paragraph><phrases>
//         <phrase>
//           <item type="segnum">
//           <words>
//             <word><item type="txt">…<morphemes><morph type="…"><item …/></morph></morphemes></word>
//             <word><item type="punct">…</word>
//           </words>
//           <item type="gls|lit|note">            (trailing translations)
//         </phrase>
//       </phrases></paragraph></paragraphs>
//       <languages><language lang vernacular?/>
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

function phraseXml(indent, sentence, segnum, options) {
  const lines = [`${indent}<phrase>`];
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
  lines.push(`${indent}  <paragraphs>`);
  let segnum = 0;
  for (const run of paragraphRuns(igtDoc)) {
    lines.push(`${indent}    <paragraph>`, `${indent}      <phrases>`);
    for (const sentence of run) {
      segnum += 1;
      lines.push(...phraseXml(`${indent}        `, sentence, segnum, options));
    }
    lines.push(`${indent}      </phrases>`, `${indent}    </paragraph>`);
  }
  lines.push(`${indent}  </paragraphs>`);
  lines.push(...languagesXml(`${indent}  `, options));
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
