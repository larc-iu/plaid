import { Fragment, useLayoutEffect, useRef } from 'react';
import { ExternalLink } from 'lucide-react';
import { cn } from '@ui/lib/utils';
import { centeredScrollLeft } from '@ui/components/assistant/citations.js';
import { citationHighlights, citationRows, citationTitle, sentenceHref } from './adapter.js';

// A cited sentence as IGT draws it: the interlinear table, with the words the
// model named filled in and a word cited for its morphemes tinted around them.
// A morpheme row's cell for a word whose morphemes the citation names: drawn
// morpheme by morpheme, so the named ones stand out inside the word.
export const MorphemeCell = ({ parts, joiners, marked }) =>
  parts.map((part, k) => (
    <Fragment key={k}>
      {k > 0 && (joiners[k - 1] ?? '-')}
      <span className={cn(marked.has(k + 1) && 'rounded-sm bg-primary/35 px-0.5')}>{part}</span>
    </Fragment>
  ));

export const ExampleCard = ({ c, projectId }) => {
  const words = c.words || [];
  const rows = words.length ? citationRows(c) : [];
  const highlights = citationHighlights(c);
  const scroller = useRef(null);

  // A long sentence scrolls inside the card, so bring what is cited into view:
  // centre the highlighted columns before the card is painted (only the card
  // scrolls, never the page).
  useLayoutEffect(() => {
    const box = scroller.current;
    if (!box || box.scrollWidth <= box.clientWidth) return;
    const marks = [...box.querySelectorAll('[data-cited]')].map((m) => m.getBoundingClientRect());
    if (!marks.length) return;
    const outer = box.getBoundingClientRect();
    const left = Math.min(...marks.map((r) => r.left)) - outer.left + box.scrollLeft;
    const right = Math.max(...marks.map((r) => r.right)) - outer.left + box.scrollLeft;
    box.scrollLeft = centeredScrollLeft(left, right, box.clientWidth, box.scrollWidth);
  }, [c]);

  return (
    <div className="my-3 rounded-lg border bg-muted/30 px-3 py-2 text-sm">
      <div className="mb-1.5 text-xs">
        <a
          href={sentenceHref('', projectId, c)}
          target="_blank"
          rel="noopener noreferrer"
          className="inline-flex items-center gap-1.5 font-medium text-foreground hover:underline"
          title="Open this sentence in the editor"
        >
          <ExternalLink className="h-3.5 w-3.5 text-muted-foreground" />
          {citationTitle(c)}
        </a>
      </div>
      {!words.length && <div className="py-0.5">{c.text}</div>}
      <div ref={scroller} className="overflow-x-auto">
        <table className="border-separate border-spacing-0 whitespace-nowrap">
          <tbody>
            {rows.map((r, i) => (
              <tr key={i}>
                <th
                  scope="row"
                  className="pr-3 text-left align-top text-[11px] font-normal leading-5 text-muted-foreground"
                >
                  {r.label}
                </th>
                {r.cells.map((v, j) => {
                  const w = words[j] || {};
                  const cited = highlights.get(w.index);
                  const morphemes = cited instanceof Set ? cited : null;
                  // Pieces exist exactly where the service sent them (the
                  // morpheme rows of a word cited for its morphemes).
                  const parts =
                    morphemes &&
                    (r.kind === 'morphemes'
                      ? w.morphs
                      : (w.lines || []).find((l) => l.field === r.label)?.parts);
                  return (
                    <td
                      key={j}
                      data-cited={cited && i === 0 ? '' : undefined}
                      className={cn(
                        'px-1.5 align-top leading-5',
                        r.kind === 'surface' && 'font-medium',
                        r.kind === 'morphemes' && 'font-mono text-xs',
                        r.kind !== 'surface' && r.kind !== 'morphemes' && 'text-xs',
                        // A word cited whole is filled; one cited for its
                        // morphemes is tinted, with the morphemes filled.
                        cited && (morphemes ? 'bg-primary/10' : 'bg-primary/15'),
                        cited && i === 0 && 'rounded-t',
                        cited && i === rows.length - 1 && 'rounded-b',
                      )}
                    >
                      {parts ? (
                        <MorphemeCell parts={parts} joiners={w.joiners || []} marked={morphemes} />
                      ) : (
                        v
                      )}
                    </td>
                  );
                })}
              </tr>
            ))}
          </tbody>
        </table>
      </div>
      {(c.fields || []).map((f) => (
        <div key={f.field} className="mt-2 italic">
          <span className="not-italic text-xs text-muted-foreground">{f.field}: </span>
          {f.value}
        </div>
      ))}
    </div>
  );
};
