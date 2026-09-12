import { useState } from 'react';
import { ChevronDown, ChevronRight, MapPin, Wrench } from 'lucide-react';
import { cn } from '../../lib/utils.js';
import { AssistantMarkdown } from './AssistantMarkdown.jsx';
import { linkifyCitations } from './citations.js';
import { PlanCard } from './PlanCard.jsx';
import { AssistantMark } from './PlaidMarks.jsx';

// One turn of a conversation as drawn: the reply with its citations, the
// example cards a citation opens, and the tool trace behind an answer.
// What a citation is called, where it links and how its card looks are the
// app's (`adapter`, see plaid-igt's assistant/adapter.js).
// Reply text with its citations: block cards in place, links inline, and the
// inline-only citations' cards after the text. A citation the service could not
// resolve is flattened to its plain reference rather than shown as markup.
export const CitedMarkdown = ({ text, citations, projectId, adapter, onFocusHere }) => {
  const { ExampleCard } = adapter;
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
    linkifyCitations(adapter, md, byKey, {
      projectId,
      onCited: (m, c) => {
        if (!shown.has(m) && !inline.includes(c)) inline.push(c);
      },
    });
  // A citation into the document beside this panel scrolls it rather than
  // opening a second browser tab. One delegated handler catches the card's own
  // link and every inline one, which markdown builds and we never see.
  const onClick = (e) => {
    if (!onFocusHere || e.metaKey || e.ctrlKey || e.shiftKey || e.button !== 0) return;
    const a = e.target.closest?.('a[href]');
    if (!a) return;
    const at = adapter.parseCitationHref?.(a.getAttribute('href'));
    if (at && onFocusHere(at)) e.preventDefault();
  };

  return (
    <div onClick={onClick}>
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
  adapter,
  onFocusHere,
  results,
  fromAnotherModel,
  movedHere,
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
      <div className="flex flex-col items-end gap-1">
        {/* Where this one was asked from, shown only where that changed. The
            panel stays open across a whole session, so an old thread can hold
            questions asked from several documents, and the answers only make
            sense against the place each question came from. The model is told
            the same thing, on the same terms. */}
        {movedHere && item.where?.name && (
          <div className="flex items-center gap-1 text-xs text-muted-foreground">
            <MapPin className="h-3 w-3" />
            {item.where.name}
          </div>
        )}
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
      <AssistantMark className="mt-1 h-7 w-7 shrink-0" />
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
          <CitedMarkdown
            text={item.text}
            citations={item.citations}
            projectId={projectId}
            adapter={adapter}
            onFocusHere={onFocusHere}
          />
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
            adapter={adapter}
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
