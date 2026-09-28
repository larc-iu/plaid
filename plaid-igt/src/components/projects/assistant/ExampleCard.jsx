import { Fragment, useLayoutEffect, useRef } from 'react';
import { ExternalLink } from 'lucide-react';
import { cn } from '@ui/lib/utils';
import { detectDirection } from '@ui/domain/textDirection.js';
import { centeredPastPinned } from '@ui/components/assistant/citations.js';
import { citationHighlights, citationRows, citationTitle, sentenceHref } from './cite.js';

// A cited sentence as IGT draws it: the interlinear table, with the words the
// model named filled in and a word cited for its morphemes tinted around them.
// A morpheme row's cell for a word whose morphemes the citation names: drawn
// morpheme by morpheme, so the named ones stand out inside the word.
const MorphemeCell = ({ parts, joiners, marked }) =>
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
  // The card has no document to ask, so the sentence itself is the evidence.
  // `dir` goes on the TABLE, which reverses its columns, and not on the
  // scroller around it: that box stays LTR so the centering below keeps
  // measuring `scrollLeft` the one way every browser agrees on.
  const dir = detectDirection(c.text || words.map((w) => w.form).join(' '));

  // A long sentence scrolls inside the card, so bring what is cited into view:
  // centre the highlighted columns before the card is painted (only the card
  // scrolls, never the page). The row labels stay put at the table's start
  // (sticky), so the centring is over the part of the box they leave free:
  // at the left of an LTR table, at the right of an RTL one.
  useLayoutEffect(() => {
    const box = scroller.current;
    if (!box || box.scrollWidth <= box.clientWidth) return;
    const marks = [...box.querySelectorAll('[data-cited]')].map((m) => m.getBoundingClientRect());
    if (!marks.length) return;
    const outer = box.getBoundingClientRect();
    const left = Math.min(...marks.map((r) => r.left)) - outer.left + box.scrollLeft;
    const right = Math.max(...marks.map((r) => r.right)) - outer.left + box.scrollLeft;
    const label = box.querySelector('th')?.getBoundingClientRect().width || 0;
    box.scrollLeft = centeredPastPinned(
      left,
      right,
      box.clientWidth,
      box.scrollWidth,
      label,
      dir === 'rtl',
    );
  }, [c, dir]);

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
      {!words.length && (
        <div className="py-0.5" dir="auto">
          {c.text}
        </div>
      )}
      <div ref={scroller} className="overflow-x-auto">
        <table dir={dir} className="border-separate border-spacing-0 whitespace-nowrap">
          <tbody>
            {rows.map((r, i) => (
              <tr key={i}>
                <th
                  scope="row"
                  // Sticky, so the labels stay in view while the words scroll
                  // under them. Opaque: the card's own tint laid over the
                  // panel's colour, or the words would show through.
                  className="sticky start-0 z-10 bg-card bg-[linear-gradient(hsl(var(--muted)/0.3),hsl(var(--muted)/0.3))] pe-3 text-start align-top text-[11px] font-normal leading-5 text-muted-foreground"
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
                        r.kind === 'morphemes' && 'text-xs',
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
        <div key={f.field} className="mt-2 italic" dir="auto">
          <span className="not-italic text-xs text-muted-foreground">{f.field}: </span>
          {f.value}
        </div>
      ))}
    </div>
  );
};
