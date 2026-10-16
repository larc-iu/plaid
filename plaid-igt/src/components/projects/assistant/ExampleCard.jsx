import { Fragment, useLayoutEffect, useRef } from 'react';
import { ExternalLink } from 'lucide-react';
import { cn } from '@ui/lib/utils';
import { detectDirection } from '@ui/domain/textDirection.js';
import { centeredPastPinned } from '@ui/components/assistant/citations.js';
import { glossSmallCaps } from '@ui/domain/glossCase.js';
import { citationHighlights, citationRows, citationTitle, sentenceHref } from './cite.js';
import { snapPastPinned } from './snapPastPinned.js';

// A cited sentence as IGT draws it: the interlinear table, with the words the
// model named filled in and a word cited for its morphemes tinted around them.
// A gloss as the Analyze grid and the LaTeX export set it: each grammatical
// tag in small caps (glossSmallCaps). The grid sets every word and morpheme
// field this way, so the card does too. A morpheme row comes joined, with no
// morph types to tell a stem from an affix, so it is read as a word's value is.
// One piece of it is read beside the word's other pieces.
const GLOSS_KINDS = new Set(['word', 'morpheme']);
const Gloss = ({ value, reading }) =>
  glossSmallCaps(value, reading).map((p, k) =>
    p.smallCaps ? (
      <span key={k} className="plaid-sc">
        {p.text}
      </span>
    ) : (
      p.text
    ),
  );

// A morpheme row's cell for a word whose morphemes the citation names: drawn
// morpheme by morpheme, so the named ones stand out inside the word.
const MorphemeCell = ({ parts, joiners, marked, gloss }) =>
  parts.map((part, k) => (
    <Fragment key={k}>
      {k > 0 && (joiners[k - 1] ?? '-')}
      <span className={cn(marked.has(k + 1) && 'rounded-sm bg-highlight px-0.5')}>
        {gloss ? (
          <Gloss value={part} reading={{ beside: parts.filter((_, j) => j !== k) }} />
        ) : (
          part
        )}
      </span>
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
  const dir = detectDirection(c.text || words.map((w) => w.surface).join(' '));

  // A long sentence scrolls inside the card, so bring what is cited into view:
  // centre the highlighted columns before the card is painted (only the card
  // scrolls, never the page). The row labels stay put at the table's start
  // (sticky), so the centring is over the part of the box they leave free:
  // at the left of an LTR table, at the right of an RTL one.
  useLayoutEffect(() => {
    const box = scroller.current;
    if (!box || box.scrollWidth <= box.clientWidth) return;
    const marks = [...box.querySelectorAll('[data-cited]')].map((m) => m.getBoundingClientRect());
    if (!marks.length) {
      // Nothing to centre on: open where the sentence starts. The scroller
      // is LTR, so an RTL table's start is its far right, and scrollLeft 0
      // showed the sentence's END.
      if (dir === 'rtl') box.scrollLeft = box.scrollWidth - box.clientWidth;
      return;
    }
    const outer = box.getBoundingClientRect();
    const left = Math.min(...marks.map((r) => r.left)) - outer.left + box.scrollLeft;
    const right = Math.max(...marks.map((r) => r.right)) - outer.left + box.scrollLeft;
    const label = box.querySelector('th')?.getBoundingClientRect().width || 0;
    const rtl = dir === 'rtl';
    const centred = centeredPastPinned(left, right, box.clientWidth, box.scrollWidth, label, rtl);
    const columns = [...(box.querySelector('tr')?.querySelectorAll('td') || [])].map((td) => {
      const r = td.getBoundingClientRect();
      return {
        left: r.left - outer.left + box.scrollLeft,
        right: r.right - outer.left + box.scrollLeft,
      };
    });
    box.scrollLeft = snapPastPinned(centred, {
      columns,
      cited: { left, right },
      viewport: box.clientWidth,
      max: box.scrollWidth - box.clientWidth,
      pinned: label,
      rtl,
    });
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
        <div className="py-0.5 font-text" dir="auto">
          {c.text}
        </div>
      )}
      <div ref={scroller} className="overflow-x-auto">
        {/* A right-to-left table narrower than the card sits at its right
            edge, where the sentence starts. */}
        <table
          dir={dir}
          className={`border-separate border-spacing-0 whitespace-nowrap${dir === 'rtl' ? ' ml-auto' : ''}`}
        >
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
                  {/* Capped, since it stays in view: a long field name would
                      otherwise pin most of a narrow panel. The whole name is
                      the tooltip. */}
                  <span className="block max-w-[7rem] truncate" title={r.label || undefined}>
                    {r.label}
                  </span>
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
                        'px-1.5 align-top font-text leading-5',
                        r.kind === 'surface' && 'font-medium',
                        r.kind === 'morphemes' && 'text-xs',
                        r.kind !== 'surface' && r.kind !== 'morphemes' && 'text-xs',
                        // A word cited whole is filled; one cited for its
                        // morphemes is tinted, with the morphemes filled.
                        cited && (morphemes ? 'bg-highlight/50' : 'bg-highlight'),
                        cited && i === 0 && 'rounded-t',
                        cited && i === rows.length - 1 && 'rounded-b',
                      )}
                    >
                      {parts ? (
                        <MorphemeCell
                          parts={parts}
                          joiners={w.joiners || []}
                          marked={morphemes}
                          gloss={GLOSS_KINDS.has(r.kind)}
                        />
                      ) : GLOSS_KINDS.has(r.kind) ? (
                        <Gloss value={v} />
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
        <div key={f.field} className="mt-2 font-text italic" dir="auto">
          <span className="font-sans text-xs not-italic text-muted-foreground">{f.field}: </span>
          {f.value}
        </div>
      ))}
    </div>
  );
};
