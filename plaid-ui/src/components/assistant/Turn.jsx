import { Fragment, useState } from 'react';
import {
  BookOpen,
  Clock,
  ChevronDown,
  ChevronRight,
  FolderOpen,
  MapPin,
  Quote,
  Wrench,
} from 'lucide-react';
import { cn } from '../../lib/utils.js';
import { formatElapsed } from '../../hooks/useRunProgress.js';
import { AssistantMarkdown } from './AssistantMarkdown.jsx';
import { fencedLines, linkifyCitations } from './citations.js';
import { AttachmentChip } from './AttachmentChip.jsx';
import { PlanCard } from './PlanCard.jsx';
import { homeOnly, namedCitations } from './projectReach.js';
import { AssistantMark } from './PlaidMarks.jsx';

// One turn of a conversation as drawn: the reply with its citations, the
// example cards a citation opens, the plan it proposed, and the tool trace
// behind the answer. What a citation is called, where it links and how its card
// looks are the app's (`adapter`, see plaid-igt's assistant/adapter.js).

// A plain left click on a link into the document BESIDE the panel scrolls it
// there rather than opening a second browser tab. ONE delegated handler over
// the whole turn catches every link in it: the example card's, each inline
// citation's (which markdown builds and we never see), and each row of a plan,
// which used to be the odd one out and always opened a new tab. A modified
// click is left to the browser, so cmd-, middle- and shift-click still do what
// they do everywhere else, and a link this app cannot place is left alone.
const focusInstead = (adapter, onFocusHere) => (e) => {
  if (!onFocusHere || e.metaKey || e.ctrlKey || e.shiftKey || e.altKey || e.button !== 0) return;
  const a = e.target.closest?.('a[href]');
  if (!a) return;
  const at = adapter.parseCitationHref?.(a.getAttribute('href'));
  if (at && onFocusHere(at)) e.preventDefault();
};

// Reply text with its citations: block cards in place, links inline, and the
// inline-only citations' cards after the text. A citation the service could not
// resolve is flattened to its plain reference rather than shown as markup.
export const CitedMarkdown = ({ text, citations, projectId, adapter }) => {
  const { ExampleCard } = adapter;
  const byKey = new Map((citations || []).map((c) => [c.key, c]));
  const segments = [];
  const shown = new Set();
  let buf = [];
  const flush = () => {
    if (buf.length) segments.push({ md: buf.join('\n') });
    buf = [];
  };
  const lines = (text || '').split('\n');
  // A line inside a fenced block is code, whatever it holds.
  const fenced = fencedLines(lines);
  for (const [i, line] of lines.entries()) {
    const key = line.trim();
    if (byKey.has(key) && !fenced[i]) {
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
  return (
    <div>
      {segments.map((seg, i) =>
        seg.card ? (
          <ExampleCard key={i} c={seg.card} projectId={seg.card.projectId ?? projectId} />
        ) : (
          <AssistantMarkdown key={i}>{linkify(seg.md)}</AssistantMarkdown>
        ),
      )}
      {inline.length > 0 && (
        <CitedExamples cited={inline} projectId={projectId} adapter={adapter} />
      )}
    </div>
  );
};

// The cards for citations the reply only linked inline. Collapsed by default,
// the way the tool trace is: an answer that cites a dozen examples is mostly
// its own footnotes otherwise, and every one of them is already in the text
// above as a link the reader can follow. A citation the model put on its own
// line is drawn as a card in place, and that card is NOT part of this list.
// Only the repeat at the bottom folds away.
const CitedExamples = ({ cited, projectId, adapter }) => {
  const { ExampleCard } = adapter;
  const [open, setOpen] = useState(false);
  return (
    <div className="mt-2">
      {/* The muted, small type is the button's own and not the container's: a
          card sets its own colors but inherits what it does not set. */}
      <button
        type="button"
        onClick={() => setOpen((o) => !o)}
        aria-expanded={open}
        className="flex items-center gap-1 rounded px-1 py-0.5 text-xs text-muted-foreground hover:bg-muted hover:text-foreground"
      >
        {open ? <ChevronDown className="h-3 w-3" /> : <ChevronRight className="h-3 w-3" />}
        <Quote className="h-3 w-3" />
        {cited.length === 1 ? '1 cited example' : `${cited.length} cited examples`}
      </button>
      {open &&
        cited.map((c) => <ExampleCard key={c.key} c={c} projectId={c.projectId ?? projectId} />)}
    </div>
  );
};

// A line naming projects or a place. Each name is data in its own script, so
// it is isolated in a <bdi>: two right-to-left names in a row are otherwise
// read as one run, second name first. A name with no spaces in it wraps
// rather than running off the message. The words are the export's
// (`withProjects` and `couldNotOpen` in projectReach.js).
const NAMES = 'min-w-0 [overflow-wrap:anywhere]';

export const Turn = ({
  item,
  projectId,
  adapter,
  onFocusHere,
  results,
  fromAnotherModel,
  movedHere,
  reachChanged = false,
  // The name of the project the conversation lives in, for the line on a
  // message that reads it alone.
  homeName = null,
  // The other projects' names as of this turn (`projectNamesAt`), so a
  // citation into one of them is titled with it.
  citeNames = null,
  canWrite,
  contributor,
  busy,
  interrupted,
  applying,
  onApprove,
  onDiscard,
  onOpenPlan,
  // The project a plan on this reply writes in, when the conversation reads
  // others at this turn (PlanCard `planProject`).
  planProject = null,
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
          <div className="flex max-w-full items-center gap-1 text-xs text-muted-foreground">
            <MapPin className="h-3 w-3 shrink-0" />
            <span className={NAMES}>
              <bdi>{item.where.name}</bdi>
            </span>
          </div>
        )}
        {/* The other projects this one reads, shown only where the set
            changed, on the same terms as the place above. Where the reader
            removed them all, the home project is named alone. */}
        {reachChanged && (
          <div className="flex max-w-full items-center gap-1 text-xs text-muted-foreground">
            <FolderOpen className="h-3 w-3 shrink-0" />
            <span className={NAMES}>
              {item.projects?.length > 0 ? (
                <>
                  With{' '}
                  {item.projects.map((p, k) => (
                    <Fragment key={p.id ?? k}>
                      {k > 0 && ', '}
                      <bdi>{p.name || p.id}</bdi>
                    </Fragment>
                  ))}
                </>
              ) : homeName ? (
                <>
                  <bdi>{homeName}</bdi> only
                </>
              ) : (
                homeOnly(null)
              )}
            </span>
          </div>
        )}
        <div
          dir="auto"
          className="max-w-[85%] whitespace-pre-wrap rounded-2xl rounded-br-sm bg-primary px-4 py-2 text-sm text-primary-foreground"
        >
          {item.text}
        </div>
        {/* What was attached to this question. It stays on the message for the
            rest of the thread, because the answers below it are about a file
            whose name is the only thing left saying so. */}
        {item.files?.length > 0 && (
          <div className="flex max-w-[85%] flex-wrap justify-end gap-1.5">
            {item.files.map((f) => (
              <AttachmentChip key={f.id} file={f} />
            ))}
          </div>
        )}
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
    <div className="flex gap-3" onClick={focusInstead(adapter, onFocusHere)}>
      <AssistantMark ring className="mt-1 h-7 w-7 shrink-0" />
      <div className="flex min-w-0 flex-1 flex-col gap-2">
        {fromAnotherModel && (
          <div className="text-xs text-muted-foreground">
            Answered by <span className="font-medium text-foreground">{item.model}</span>
          </div>
        )}
        {item.stepsSummary && item.steps?.length > 0 && (
          <ToolTrace steps={item.steps} summary={item.stepsSummary} results={results} />
        )}
        {/* What the turn was GIVEN, as against what it did: how much of the
            project's guidelines were in the prompt. Its own line and not part
            of the trace, because a turn that called no tool has no trace and
            this still has to show. */}
        {/* How long the reply took, which the clock showed while it was
            written and which is wanted after. */}
        {typeof item.elapsedMs === 'number' && (
          <div className="flex items-center gap-1 text-xs text-muted-foreground">
            <Clock className="h-3 w-3 shrink-0" />
            <span className="tabular-nums">Answered in {formatElapsed(item.elapsedMs)}</span>
          </div>
        )}
        {item.contextNote && (
          <div className="flex items-center gap-1 text-xs text-muted-foreground">
            <BookOpen className="h-3 w-3 shrink-0" />
            {item.contextNote}
          </div>
        )}
        {/* What this reply fetched and kept with the conversation (a PDF from
            the web), which later replies read as they read an attachment. */}
        {item.files?.length > 0 && (
          <div className="flex flex-wrap gap-1.5">
            {item.files.map((f) =>
              f.source ? (
                <a key={f.id} href={f.source} target="_blank" rel="noreferrer" title={f.source}>
                  <AttachmentChip file={f} className="hover:bg-muted" />
                </a>
              ) : (
                <AttachmentChip key={f.id} file={f} />
              ),
            )}
          </div>
        )}
        {item.unavailableProjects?.length > 0 && (
          <div className="flex items-center gap-1 text-xs text-muted-foreground">
            <FolderOpen className="h-3 w-3 shrink-0" />
            <span className={NAMES}>
              {item.unavailableProjects.map((p, k) => (
                <Fragment key={p.id ?? k}>
                  {k > 0 && ' '}
                  <bdi>{p.name || p.id}</bdi> could not be opened.
                </Fragment>
              ))}
            </span>
          </div>
        )}
        {item.text ? (
          <CitedMarkdown
            text={item.text}
            citations={namedCitations(item.citations, projectId, citeNames)}
            projectId={projectId}
            adapter={adapter}
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
            written={item.written}
            outcome={item.outcome}
            notes={item.applyNotes}
            unwritten={item.unwritten}
            unknown={!!item.unknown}
            recordedAsHuman={item.asHuman}
            dismissed={!!item.dismissed}
            interrupted={interrupted}
            applying={applying}
            projectId={projectId}
            adapter={adapter}
            canWrite={canWrite}
            contributor={contributor}
            busy={busy}
            onApprove={onApprove}
            onDiscard={onDiscard}
            onOpen={onOpenPlan}
            planProject={planProject}
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
const ToolTrace = ({ steps, summary, results }) => {
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
