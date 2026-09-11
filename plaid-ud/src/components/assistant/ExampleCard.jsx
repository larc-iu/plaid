import { useLayoutEffect, useRef } from 'react';
import { ExternalLink } from 'lucide-react';
import { cn } from '@ui/lib/utils';
import { centeredScrollLeft } from '@ui/components/assistant/citations.js';
import { citationTitle, sentenceHref } from './adapter.js';

// A cited sentence as UD draws it: the CoNLL-U table, one row per line, with
// the words the model named filled in. A multi-word token's range row is
// tinted rather than filled, the way the annotation editor shows it.
export const ExampleCard = ({ c, projectId }) => {
  const columns = c.columns || [];
  const rows = c.rows || [];
  const scroller = useRef(null);

  // A wide table scrolls inside the card, so bring the cited rows into view:
  // centre them before the card is painted (only the card scrolls, never the
  // page).
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
      <div className="py-0.5">{c.text}</div>
      {columns.length > 0 && (
        <div ref={scroller} className="mt-1.5 overflow-x-auto">
          <table className="border-separate border-spacing-0 whitespace-nowrap font-mono text-xs">
            <thead>
              <tr>
                {columns.map((col) => (
                  <th
                    key={col}
                    scope="col"
                    className="px-1.5 text-left align-bottom text-[11px] font-normal leading-5 text-muted-foreground"
                  >
                    {col}
                  </th>
                ))}
              </tr>
            </thead>
            <tbody>
              {rows.map((r, i) => (
                <tr key={i}>
                  {columns.map((col, j) => (
                    <td
                      key={col}
                      data-cited={r.focus && j === 0 ? '' : undefined}
                      className={cn(
                        'px-1.5 align-top leading-5',
                        r.token && 'text-muted-foreground',
                        r.focus && (r.token ? 'bg-primary/10' : 'bg-primary/15'),
                        r.focus && j === 0 && 'rounded-l',
                        r.focus && j === columns.length - 1 && 'rounded-r',
                      )}
                    >
                      {r[col]}
                    </td>
                  ))}
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      )}
    </div>
  );
};
