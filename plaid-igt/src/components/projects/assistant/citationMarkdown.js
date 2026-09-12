// IGT's half of the conversation export: a cited sentence as an interlinear
// Markdown table. The rest of the export is shared
// (plaid-ui/src/components/assistant/exportMarkdown.js).
import { linkLabel, tableCell } from '@ui/components/assistant/citations.js';
import { citationHighlights, citationRows, citationTitle, sentenceHref } from './adapter.js';

// One cited sentence as a Markdown table: a column per word, a row per tier
// (words, morphemes, each field), then the sentence fields. What the citation
// names is bold: the word, or the morphemes named inside it.
export const citationToMarkdown = (c, { origin, projectId }) => {
  const words = c.words || [];
  const cited = citationHighlights(c);
  const [surface, ...rows] = citationRows(c);

  // A morpheme row of a word cited for its morphemes, rebuilt piece by piece
  // with the named ones bold; anything else is the cell as the grid shows it.
  const cell = (r, j) => {
    const w = words[j] || {};
    const marked = cited.get(w.index);
    const parts =
      marked instanceof Set &&
      (r.kind === 'morphemes' ? w.morphs : (w.lines || []).find((l) => l.field === r.label)?.parts);
    if (!parts) return r.cells[j];
    return parts
      .map((part, k) => (marked.has(k + 1) ? `**${part}**` : part))
      .reduce((acc, part, k) => (k ? acc + (w.joiners?.[k - 1] ?? '-') + part : part), '');
  };

  const out = [`**[${linkLabel(citationTitle(c))}](${sentenceHref(origin, projectId, c)})**`, ''];
  if (words.length) {
    out.push(
      `| | ${surface.cells
        .map((v, j) => (cited.has(words[j].index) ? `**${tableCell(v)}**` : tableCell(v)))
        .join(' | ')} |`,
    );
    out.push(`|---|${words.map(() => '---').join('|')}|`);
    rows.forEach((r) =>
      out.push(`| ${[r.label, ...r.cells.map((_, j) => cell(r, j))].map(tableCell).join(' | ')} |`),
    );
  } else {
    out.push(tableCell(c.text));
  }
  (c.fields || []).forEach((f) => out.push('', `*${tableCell(f.field)}:* ${tableCell(f.value)}`));
  return out.join('\n');
};
