// Whole-document plain-text serialization with a configurable tier selection.
// Generalizes domain/igtExport.js (whose fixed copy formats stay untouched):
// the wizard picks which orthographies / word fields / morpheme fields /
// sentence fields to emit, whether to segment morphemes, number sentences,
// and include a document header.
//
// Pure functions — no DOM, no client.

import { morphFormOf, joinMorphemeTexts } from '../domain/igtExport.js';

const cpLen = (s) => [...(s ?? '')].length;

/**
 * selection: { orthographies: [name], wordFields: [name], morphFields: [name],
 *              sentFields: [name], segmentMorphemes: bool,
 *              numberSentences: bool, includeHeader: bool }
 *
 * Returns the ordered tier lines for one sentence:
 *   [{ kind: 'cells', label, cells: [string] } | { kind: 'free', label, text }]
 * Line 1 is the (optionally morpheme-segmented) word forms; then one cells
 * line per selected orthography, morpheme field, and word field (in that
 * order, matching the Copy-as-IGT tier convention); then one free line per
 * selected sentence field with a non-empty value.
 */
export function sentenceTierLines(sentence, selection) {
  const tokens = sentence?.tokens || [];
  const segment = selection?.segmentMorphemes !== false;

  const forms = tokens.map((t) => {
    const morphemes = t.morphemes || [];
    return segment && morphemes.length
      ? joinMorphemeTexts(morphemes, morphemes.map(morphFormOf))
      : (t.content ?? '');
  });
  const lines = [{ kind: 'cells', label: null, cells: forms }];

  for (const name of selection?.orthographies || []) {
    lines.push({
      kind: 'cells', label: name,
      cells: tokens.map((t) => t.orthographies?.[name] ?? ''),
    });
  }
  for (const name of selection?.morphFields || []) {
    lines.push({
      kind: 'cells', label: name,
      cells: tokens.map((t) => {
        const morphemes = t.morphemes || [];
        return morphemes.length
          ? joinMorphemeTexts(morphemes, morphemes.map((m) => m.annotations?.[name]?.value ?? ''))
          : '';
      }),
    });
  }
  for (const name of selection?.wordFields || []) {
    lines.push({
      kind: 'cells', label: name,
      cells: tokens.map((t) => t.annotations?.[name]?.value ?? ''),
    });
  }
  for (const name of selection?.sentFields || []) {
    const value = sentence?.annotations?.[name]?.value ?? '';
    if (value !== '') lines.push({ kind: 'free', label: name, text: value });
  }
  return lines;
}

/** One sentence as column-aligned plain text (code-point padding). */
export function formatSentencePlain(sentence, selection) {
  const lines = sentenceTierLines(sentence, selection);
  const cellLines = lines.filter((l) => l.kind === 'cells');
  const n = cellLines[0]?.cells.length ?? 0;
  const widths = Array.from({ length: n }, (_, i) =>
    Math.max(...cellLines.map((l) => cpLen(l.cells[i]))));
  const out = cellLines.map((l) =>
    l.cells.map((c, i) => c + ' '.repeat(widths[i] - cpLen(c))).join('  ').trimEnd());
  for (const l of lines) {
    if (l.kind === 'free') out.push(`${l.label}: ${l.text}`);
  }
  return out.join('\n');
}

/**
 * Whole document: optional header (name + configured metadata already
 * filtered into igtDoc.document.metadata), then each sentence in order,
 * blank-line separated, optionally "(n)"-numbered.
 */
export function serializeDocumentPlain(igtDoc, selection) {
  const parts = [];
  if (selection?.includeHeader !== false) {
    const docData = igtDoc.document || {};
    const header = [docData.name ?? ''];
    for (const [key, value] of Object.entries(docData.metadata || {})) {
      if (value != null && value !== '') header.push(`${key}: ${value}`);
    }
    parts.push(header.filter((l) => l !== '').join('\n'));
  }
  const number = selection?.numberSentences !== false;
  (igtDoc.sortedSentences || []).forEach((sentence, i) => {
    const body = formatSentencePlain(sentence, selection);
    parts.push(number ? `(${i + 1})\n${body}` : body);
  });
  return `${parts.join('\n\n')}\n`;
}
