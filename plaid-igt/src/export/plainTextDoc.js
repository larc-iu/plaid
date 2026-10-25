// Whole-document plain-text serialization with a configurable tier selection,
// laid out by the Copy as IGT tiers (domain/igtExport.js): the wizard picks which orthographies / word fields / morpheme fields /
// sentence fields to emit, whether to segment morphemes, number sentences,
// and include a document header.
//
// Pure functions — no DOM, no client.

import { tiers } from '../domain/igtExport.js';
// Shared strict alignment→sentence speaker projection (unique exact-or-contains
// match, else none) — the same one the .flextext export uses, so a sentence
// gets a speaker prefix in exactly the cases it gets a FLEx phrase speaker.
import { phraseSpeakerFor } from '../domain/sentenceSegments.js';
import { userMetadata } from '@ui/domain/textDirection.js';
import { displayWidth, padToWidth } from '@ui/lib/displayWidth.js';

/**
 * Which object line(s) a selection asks for. `wordLine` is 'segmented' (the
 * default), 'surface', or 'both'.
 *
 * 'both' is the classic four-line hand-in: the word as written, the word
 * segmented, the morpheme glosses, the free translation. There was no way to
 * get it before, because the toggle SWAPPED the object line rather than adding
 * one, so a segmented export never showed the original spelling anywhere.
 */
export const wordLineOf = (selection) => selection?.wordLine || 'segmented';

/**
 * True when the selection would print a gloss line segmented by hyphens over an
 * object line that has none. Leipzig rule 1 wants the two to correspond, so a
 * hand-in like `Eve / house-DAT` is malformed. The preset panel says so rather
 * than the export emitting it quietly.
 */
export const breaksMorphemeAlignment = (selection) =>
  wordLineOf(selection) === 'surface' && (selection?.morphFields || []).length > 0;

/**
 * The ordered tier lines for one sentence:
 *   [{ kind: 'cells', label, cells: [string] } | { kind: 'free', label, text }]
 * The word line(s) and one cells line per selected orthography, morpheme
 * field and word field, as Copy as IGT lays them out (igtExport.js tiers),
 * so text between words (punctuation) has a column of its own. Then one free
 * line per selected sentence field with a non-empty value.
 */
export function sentenceTierLines(sentence, selection) {
  const lines = tiers(sentence, {
    wordLine: wordLineOf(selection),
    orthographies: selection?.orthographies || [],
    morphFields: selection?.morphFields || [],
    wordFields: selection?.wordFields || [],
  }).map(({ label, cells }) => ({ kind: 'cells', label, cells }));
  for (const name of selection?.sentFields || []) {
    const value = sentence?.annotations?.[name]?.value ?? '';
    if (value !== '') lines.push({ kind: 'free', label: name, text: value });
  }
  return lines;
}

/** One sentence as column-aligned plain text, padded by display width. */
export function formatSentencePlain(sentence, selection) {
  const lines = sentenceTierLines(sentence, selection)
    // Drop a tier that has no values in THIS sentence (e.g. an enabled-but-
    // unused orthography), so it doesn't render as a run of blank lines. The
    // anchor word-forms line (index 0) is always kept.
    .filter(
      (l, i) => i === 0 || l.kind !== 'cells' || l.cells.some((c) => (c ?? '').trim() !== ''),
    );
  const cellLines = lines.filter((l) => l.kind === 'cells');
  const n = cellLines[0]?.cells.length ?? 0;
  const widths = Array.from({ length: n }, (_, i) =>
    Math.max(...cellLines.map((l) => displayWidth(l.cells[i]))),
  );
  const out = cellLines.map((l) =>
    l.cells
      .map((c, i) => padToWidth(c, widths[i]))
      .join('  ')
      .trimEnd(),
  );
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
    for (const [key, value] of Object.entries(userMetadata(docData.metadata))) {
      if (value != null && value !== '') header.push(`${key}: ${value}`);
    }
    parts.push(header.filter((l) => l !== '').join('\n'));
  }
  const number = selection?.numberSentences !== false;
  const showSpeakers = selection?.speakers !== false;
  const alignmentTokens = igtDoc.alignmentTokens || [];
  (igtDoc.sortedSentences || []).forEach((sentence, i) => {
    const body = formatSentencePlain(sentence, selection);
    const speaker = showSpeakers ? phraseSpeakerFor(sentence, alignmentTokens) : null;
    // Transcript-style prefix: "(n) Speaker" — either half is optional.
    const prefix = [number ? `(${i + 1})` : '', speaker || ''].filter((s) => s !== '').join(' ');
    parts.push(prefix ? `${prefix}\n${body}` : body);
  });
  return `${parts.join('\n\n')}\n`;
}
