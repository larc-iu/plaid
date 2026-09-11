import { Fragment, useLayoutEffect, useRef, useState } from 'react';
import { Bot, ChevronDown, ChevronRight, Wrench, ExternalLink } from 'lucide-react';
import { cn } from '@ui/lib/utils';
import { AssistantMarkdown } from '@ui/components/assistant/AssistantMarkdown.jsx';
import {
  centeredScrollLeft,
  citationHighlights,
  citationRows,
  citationTitle,
  linkifyCitations,
  sentenceHref,
} from './citations.js';
import { PlanCard } from './PlanCard.jsx';

// One turn of a conversation as drawn: the reply with its citations, the
// example cards a citation opens, and the tool trace behind an answer.
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

// Reply text with its citations: block cards in place, links inline, and the
// inline-only citations' cards after the text. A citation the service could not
// resolve is flattened to its plain reference rather than shown as markup.
export const CitedMarkdown = ({ text, citations, projectId }) => {
  const byKey = new Map((citations || []).map((c) => [c.key, c]));
  const segments = [];
  const shown = new Set();
  let buf = [];
  const flush = () => {
    if (buf.length) segments.push({ md: buf.join('\n') });
    buf = [];
  };
  for (const line of (text || '').split('\n')) {
    const key = line.trim();
    if (byKey.has(key)) {
      flush();
      segments.push({ card: byKey.get(key) });
      shown.add(key);
    } else {
      buf.push(line);
    }
  }
  flush();
  const inline = [];
  const linkify = (md) =>
    linkifyCitations(md, byKey, {
      projectId,
      onCited: (m, c) => {
        if (!shown.has(m) && !inline.includes(c)) inline.push(c);
      },
    });
  return (
    <div>
      {segments.map((seg, i) =>
        seg.card ? (
          <ExampleCard key={i} c={seg.card} projectId={projectId} />
        ) : (
          <AssistantMarkdown key={i}>{linkify(seg.md)}</AssistantMarkdown>
        ),
      )}
      {inline.length > 0 && (
        <div className="mt-2">
          <div className="text-xs font-medium text-muted-foreground">Cited examples</div>
          {inline.map((c) => (
            <ExampleCard key={c.key} c={c} projectId={projectId} />
          ))}
        </div>
      )}
    </div>
  );
};

export const Turn = ({
  item,
  projectId,
  results,
  fromAnotherModel,
  canWrite,
  contributor,
  busy,
  interrupted,
  applying,
  onApprove,
  onDiscard,
}) => {
  if (item.kind === 'user') {
    return (
      <div className="flex justify-end">
        <div className="max-w-[85%] whitespace-pre-wrap rounded-2xl rounded-br-sm bg-primary px-4 py-2 text-sm text-primary-foreground">
          {item.text}
        </div>
      </div>
    );
  }
  if (item.kind === 'error') {
    return item.stopped ? (
      <div className="rounded-lg border border-dashed px-3 py-2 text-sm text-muted-foreground">
        {item.text}
      </div>
    ) : (
      <div
        role="alert"
        className="rounded-lg border border-destructive/40 bg-destructive/10 px-3 py-2 text-sm text-destructive"
      >
        {item.text}
      </div>
    );
  }
  return (
    <div className="flex gap-3">
      <div className="mt-1 flex h-7 w-7 shrink-0 items-center justify-center rounded-full bg-muted">
        <Bot className="h-4 w-4 text-muted-foreground" />
      </div>
      <div className="flex min-w-0 flex-1 flex-col gap-2">
        {fromAnotherModel && (
          <div className="text-xs text-muted-foreground">
            Answered by <span className="font-medium text-foreground">{item.model}</span>
          </div>
        )}
        {item.stepsSummary && item.steps?.length > 0 && (
          <ToolTrace steps={item.steps} summary={item.stepsSummary} results={results} />
        )}
        {item.text ? (
          <CitedMarkdown text={item.text} citations={item.citations} projectId={projectId} />
        ) : (
          !item.plan && (
            <div className="text-sm italic text-muted-foreground">
              (The assistant sent no text.)
            </div>
          )
        )}
        {item.plan && (
          <PlanCard
            plan={item.plan}
            status={item.status}
            recordedAsHuman={item.asHuman}
            interrupted={interrupted}
            applying={applying}
            projectId={projectId}
            canWrite={canWrite}
            contributor={contributor}
            busy={busy}
            onApprove={onApprove}
            onDiscard={onDiscard}
          />
        )}
      </div>
    </div>
  );
};

// What the assistant did before answering: the service's one-line summary,
// expandable to its steps, each expandable to what that tool returned. A step
// names the tool call it came from, and `results` maps that to the tool's
// output in the transcript, so nothing is stored twice (and a result the size
// cap dropped reads as dropped here too).
export const ToolTrace = ({ steps, summary, results }) => {
  const [open, setOpen] = useState(false);
  const [shown, setShown] = useState(null);
  return (
    <div className="text-xs text-muted-foreground">
      <button
        type="button"
        onClick={() => setOpen((o) => !o)}
        className="flex items-center gap-1 rounded px-1 py-0.5 hover:bg-muted hover:text-foreground"
      >
        {open ? <ChevronDown className="h-3 w-3" /> : <ChevronRight className="h-3 w-3" />}
        <Wrench className="h-3 w-3" />
        {summary}
      </button>
      {open && (
        <ol className="mt-1 flex flex-col gap-0.5 border-l pl-3">
          {steps.map((s, i) => {
            const result = results.get(s.id) ?? '';
            return (
              <li key={s.id || i}>
                <button
                  type="button"
                  onClick={() => setShown(shown === i ? null : i)}
                  className={cn(
                    'flex w-full items-start gap-1 rounded px-1 py-0.5 text-left hover:bg-muted hover:text-foreground',
                    result.startsWith('Error') && 'text-destructive',
                  )}
                  title={s.name}
                >
                  {shown === i ? (
                    <ChevronDown className="mt-0.5 h-3 w-3 shrink-0" />
                  ) : (
                    <ChevronRight className="mt-0.5 h-3 w-3 shrink-0" />
                  )}
                  <span>{s.label}</span>
                </button>
                {shown === i && (
                  <pre className="my-1 max-h-72 overflow-auto whitespace-pre-wrap rounded bg-muted p-2 font-mono text-[11px] leading-4 text-foreground">
                    {result || '(no output)'}
                  </pre>
                )}
              </li>
            );
          })}
        </ol>
      )}
    </div>
  );
};
