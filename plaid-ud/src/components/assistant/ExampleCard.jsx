import { useLayoutEffect, useMemo, useRef, useState } from 'react';
import { ExternalLink } from 'lucide-react';
import { cn } from '@ui/lib/utils';
import { centeredScrollLeft } from '@ui/components/assistant/citations.js';
import { citationTitle, sentenceHref } from './adapter.js';
import { layout } from './depTree.js';

// A cited sentence as UD draws it, as a tree or as its CoNLL-U rows. The model
// says which one with view= on its cite tag, and the reader can switch: the
// model's choice is a starting point, not a decision taken away from them.
//
// A tree opens on the relations the citation named, over the whole sentence.
// All of them at once is the switch under it.
//
// There was a third view, a grid of the two or three columns the model named
// in fields=. It was the CoNLL-U table minus some columns, chosen by the model
// for a reader who could not choose differently, so it went (Luke's call).

const VIEWS = [
  { id: 'tree', label: 'Tree' },
  { id: 'table', label: 'CoNLL-U' },
];

const DepTree = ({ c, tree }) => {
  if (!tree.words.length) return null;
  // What a long sentence has to be scrolled to: the words the citation marked,
  // and the head each of their relations comes from. Taken from the marks
  // rather than from what is drawn, so revealing the rest does not move it.
  const marked = new Set();
  tree.words.forEach((w, i) => w.focus && marked.add(i));
  tree.arcs.forEach((a) => {
    if (tree.words[a.to]?.focus && a.from !== undefined) marked.add(a.from);
  });
  return (
    <svg
      width={tree.width}
      height={tree.height}
      viewBox={`0 0 ${tree.width} ${tree.height}`}
      className="font-mono"
      role="img"
      aria-label={`Dependency tree for sentence ${c.sentence}`}
    >
      {tree.arcs.map((a, i) => (
        <g key={i} className="text-muted-foreground">
          <path d={a.d} fill="none" stroke="currentColor" strokeWidth="1" opacity="0.7" />
          {/* The arrowhead sits on the dependent: which way a relation points
              is most of what a tree says. */}
          <path
            d={`M ${a.tipX - 3} ${tree.baseY - 5} L ${a.tipX} ${tree.baseY} L ${a.tipX + 3} ${tree.baseY - 5} Z`}
            fill="currentColor"
            opacity="0.7"
          />
          {a.deprel && (
            <text
              x={a.labelX}
              y={a.labelY}
              textAnchor="middle"
              fontSize="9"
              fill="currentColor"
              className="text-primary"
            >
              {a.deprel}
            </text>
          )}
        </g>
      ))}
      {tree.words.map((w, i) => (
        <text
          key={i}
          x={w.x}
          y={tree.baseY + 12}
          textAnchor="middle"
          fontSize="11"
          fill="currentColor"
          data-cited={marked.has(i) ? '' : undefined}
          className={cn(w.focus ? 'font-bold text-primary' : 'text-foreground')}
        >
          {w.form}
        </text>
      ))}
    </svg>
  );
};

const Table = ({ c, columns, scroller }) => (
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
        {(c.rows || []).map((r, i) => (
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
);

export const ExampleCard = ({ c, projectId }) => {
  const columns = c.columns || [];
  // The model's choice opens the card; the switch is the reader's.
  // A conversation from before a view was retired still carries its name.
  const [view, setView] = useState(VIEWS.some((v) => v.id === c.view) ? c.view : 'table');
  // The relations the citation named, until the reader asks for the rest.
  const [allArcs, setAllArcs] = useState(false);
  const scroller = useRef(null);
  const tree = useMemo(
    () => layout(c.rows || [], { maxHeight: 150, all: allArcs }),
    [c.rows, allArcs],
  );

  // A sentence nobody has parsed has no tree to draw, so that view is not
  // offered rather than offered and empty.
  const hasTree = (c.rows || []).some((r) => !r.token && r.head !== '' && r.head != null);
  const shown = view === 'tree' && !hasTree ? 'table' : view;
  const offered = VIEWS.filter((v) => v.id !== 'tree' || hasTree);

  // A wide table or a long sentence scrolls inside the card, so bring the
  // cited rows and the cited relations into view: centre them before the card
  // is painted (only the card scrolls, never the page).
  useLayoutEffect(() => {
    const box = scroller.current;
    if (!box || box.scrollWidth <= box.clientWidth) return;
    const marks = [...box.querySelectorAll('[data-cited]')].map((m) => m.getBoundingClientRect());
    if (!marks.length) return;
    const outer = box.getBoundingClientRect();
    const left = Math.min(...marks.map((r) => r.left)) - outer.left + box.scrollLeft;
    const right = Math.max(...marks.map((r) => r.right)) - outer.left + box.scrollLeft;
    box.scrollLeft = centeredScrollLeft(left, right, box.clientWidth, box.scrollWidth);
  }, [c, shown]);

  return (
    <div className="my-3 rounded-lg border bg-muted/30 px-3 py-2 text-sm">
      <div className="mb-1.5 flex items-start gap-2 text-xs">
        <a
          href={sentenceHref('', projectId, c)}
          target="_blank"
          rel="noopener noreferrer"
          className="inline-flex min-w-0 items-center gap-1.5 font-medium text-foreground hover:underline"
          title="Open this sentence in the editor"
        >
          <ExternalLink className="h-3.5 w-3.5 shrink-0 text-muted-foreground" />
          <span className="truncate">{citationTitle(c)}</span>
        </a>
        <div
          className={cn(
            'ml-auto flex shrink-0 rounded border bg-background',
            // One view is not a switch.
            offered.length < 2 && 'hidden',
          )}
        >
          {offered.map((v) => (
            <button
              key={v.id}
              type="button"
              onClick={() => setView(v.id)}
              aria-pressed={shown === v.id}
              className={cn(
                'px-1.5 py-0.5 text-[11px] first:rounded-l last:rounded-r',
                shown === v.id
                  ? 'bg-primary/15 font-medium text-foreground'
                  : 'text-muted-foreground hover:bg-muted',
              )}
            >
              {v.label}
            </button>
          ))}
        </div>
      </div>
      <div className="py-0.5">{c.text}</div>
      {shown === 'tree' ? (
        <div className="mt-1.5">
          <div ref={scroller} className="overflow-x-auto">
            <DepTree c={c} tree={tree} />
          </div>
          {tree.hidden > 0 && (
            <div className="mt-1 flex justify-end">
              <button
                type="button"
                onClick={() => setAllArcs((on) => !on)}
                aria-pressed={allArcs}
                className={cn(
                  'rounded border px-1.5 py-0.5 text-[11px]',
                  allArcs
                    ? 'bg-primary/15 font-medium text-foreground'
                    : 'bg-background text-muted-foreground hover:bg-muted',
                )}
              >
                All relations
              </button>
            </div>
          )}
        </div>
      ) : (
        columns.length > 0 && <Table c={c} columns={columns} scroller={scroller} />
      )}
    </div>
  );
};
