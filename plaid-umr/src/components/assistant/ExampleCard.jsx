import { useState } from 'react';
import { ExternalLink } from 'lucide-react';
import { cn } from '@ui/lib/utils';
import { citationTitle, sentenceHref } from './adapter.js';

// A cited sentence as UMR draws it: its graph in PENMAN, or the words with the
// gloss lines under them. The model says which one with view= on its cite tag,
// and the reader can switch: the model's choice is a starting point, not a
// decision taken away from them.
//
// No canvas. The canvas is the editor's, it needs the whole document model to
// lay a graph out, and a reader who wants it has the link in the header.

const VIEWS = [
  { id: 'graph', label: 'Graph' },
  { id: 'words', label: 'Words' },
];

// The graph with the cited nodes picked out. Marking is per LINE: a variable
// is written once where its node is defined, so the line it opens is the line
// the reader's eye should land on.
const Graph = ({ penman, focus }) => {
  const marked = new Set(focus || []);
  return (
    <pre className="mt-1.5 overflow-x-auto whitespace-pre rounded bg-background/60 p-2 font-mono text-xs leading-5">
      {penman.split('\n').map((line, i) => {
        const cited = [...marked].some((v) => line.includes(`(${v} /`));
        return (
          <div
            key={i}
            data-cited={cited ? '' : undefined}
            className={cn('px-1', cited && 'rounded bg-primary/15 font-medium')}
          >
            {line}
          </div>
        );
      })}
    </pre>
  );
};

// The words with their numbers, and the gloss lines that line up with them.
// A line with a different number of items is a sentence-level one, so it is
// written out under the table rather than forced into a column.
const Words = ({ c }) => {
  const words = c.words || [];
  const perWord = (c.lines || []).filter((l) => (l.items || []).length === words.length);
  const loose = (c.lines || []).filter((l) => (l.items || []).length !== words.length);
  return (
    <div className="mt-1.5 overflow-x-auto">
      <table className="border-separate border-spacing-0 whitespace-nowrap text-xs">
        <tbody>
          <tr>
            {words.map((w) => (
              <td key={w.index} className="px-1.5 text-[11px] leading-5 text-muted-foreground">
                {w.index}
              </td>
            ))}
          </tr>
          <tr>
            {words.map((w) => (
              <td key={w.index} className="px-1.5 align-top leading-5">
                {w.text}
              </td>
            ))}
          </tr>
          {perWord.map((line) => (
            <tr key={line.header}>
              {line.items.map((item, i) => (
                <td
                  key={i}
                  className="px-1.5 align-top leading-5 text-muted-foreground"
                  title={line.header}
                >
                  {item}
                </td>
              ))}
            </tr>
          ))}
        </tbody>
      </table>
      {loose.map((line) => (
        <div key={line.header} className="mt-1 text-xs text-muted-foreground">
          {line.header}: {line.items.join(' ')}
        </div>
      ))}
    </div>
  );
};

export const ExampleCard = ({ c, projectId }) => {
  // The model's choice opens the card; the switch is the reader's.
  const [view, setView] = useState(VIEWS.some((v) => v.id === c.view) ? c.view : 'graph');

  // A sentence nobody has annotated has no graph to show, so that view is not
  // offered rather than offered and empty.
  const hasGraph = !!c.penman;
  const shown = view === 'graph' && !hasGraph ? 'words' : view;
  const offered = VIEWS.filter((v) => v.id !== 'graph' || hasGraph);

  return (
    <div className="my-3 rounded-lg border bg-muted/30 px-3 py-2 text-sm">
      <div className="mb-1.5 flex items-start gap-2 text-xs">
        <a
          href={sentenceHref('', projectId, c)}
          target="_blank"
          rel="noopener noreferrer"
          className="inline-flex min-w-0 items-center gap-1.5 font-medium text-foreground hover:underline"
          title="Open this document in the editor"
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
      {shown === 'graph' ? <Graph penman={c.penman} focus={c.focus} /> : <Words c={c} />}
    </div>
  );
};
