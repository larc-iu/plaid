import { Fragment, useState } from 'react';
import {
  BookOpen,
  Clock,
  ChevronDown,
  ChevronRight,
  Download,
  FolderOpen,
  MapPin,
  Quote,
} from 'lucide-react';
import { formatElapsed } from '../../hooks/useRunProgress.js';
import { AssistantMarkdown } from './AssistantMarkdown.jsx';
import { fencedLines, linkifyCitations } from './citations.js';
import { AttachmentChip } from './AttachmentChip.jsx';
import { PlanCard } from './PlanCard.jsx';
import { stagedLine } from './planChanges.js';
import { homeOnly, namedCitations } from './projectReach.js';
import { AssistantMark } from './PlaidMarks.jsx';
import { useExport } from './exportContext.js';
import { WorkTrace } from './WorkTrace.jsx';
import { t, tx } from '../../lib/i18n.js';

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
  const label = t('{n, plural, one {# cited example} other {# cited examples}}', {
    n: cited.length,
  });
  // The web page export is read with no script: the same fold, as markup.
  if (useExport())
    return (
      <details className="mt-2">
        <summary className="flex w-fit cursor-pointer list-none items-center gap-1 rounded px-1 py-0.5 text-xs text-muted-foreground">
          <ChevronRight className="plaid-export-chevron h-3 w-3" />
          <Quote className="h-3 w-3" />
          {label}
        </summary>
        {cited.map((c) => (
          <ExampleCard key={c.key} c={c} projectId={c.projectId ?? projectId} />
        ))}
      </details>
    );
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
        {label}
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

// Hover text for the place line above a message. The line is where the reader
// was when they sent it, not what they have open now. What a screen calls the
// place: a `lexicon` is a vocabulary on screen, and a kind the message does
// not name is said without a noun.
const placeTitle = (where) =>
  t(
    'When you sent this message, you were in {kind, select, document {the document “{name}”} lexicon {the vocabulary “{name}”} other {“{name}”}}.',
    { kind: where.kind || 'other', name: where.name },
  );

// Hover text for the projects line above a message: what the assistant could
// read from that message on.
const reachTitle = (projects, homeName) => {
  const names = (projects || []).map((p) => t('“{name}”', { name: p.name || p.id }));
  if (names.length) {
    return t('From this message on, the assistant could also read {names}.', {
      names: names.join(', '),
    });
  }
  return homeName
    ? t('From this message on, the assistant could read only “{name}”.', { name: homeName })
    : t('From this message on, the assistant could read only this project.');
};

export const Turn = ({
  item,
  projectId,
  adapter,
  onFocusHere,
  // The conversation's stored rounds (rounds.js), which a step opens to.
  rounds = null,
  // The conversation was deleted, so its rounds went with it.
  roundsGone = false,
  // The turn landed in this tab while it was watched: its work stays open.
  traceOpen = false,
  // A stop the line under the conversation stands in for: its work is drawn,
  // its own line is not.
  hideLine = false,
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
  applying,
  onApprove,
  onDiscard,
  onOpenPlan,
  // A job card on this reply: the session's client the app's card starts the
  // job with, and how the page tells the service the card ended.
  client = null,
  // The conversation the card is in, which a job started from it remembers.
  conversationId = null,
  onSettleJob = null,
  // The project a plan on this reply writes in, when the conversation reads
  // others at this turn (PlanCard `planProject`).
  planProject = null,
  // Drawn for someone other than its owner: a plan offers no decision.
  readOnly = false,
  // Saves a file this reply made for the user. Absent where the viewer cannot
  // read the owner's store, and then the file is only named.
  onDownloadFile = null,
  // An error item's kind in words, drawn before its line (the admin
  // Assistant tab names why each turn ended).
  errorKind = null,
}) => {
  const shownFiles = useExport()?.fileBody ?? null;
  if (item.kind === 'user') {
    return (
      <div className="flex flex-col items-end gap-1">
        {/* Where this one was asked from, shown only where that changed. The
            panel stays open across a whole session, so an old thread can hold
            questions asked from several documents, and the answers only make
            sense against the place each question came from. The model is told
            the same thing, on the same terms. */}
        {movedHere && item.where?.name && (
          <div
            className="flex max-w-full items-center gap-1 text-xs text-muted-foreground"
            title={placeTitle(item.where)}
          >
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
          <div
            className="flex max-w-full items-center gap-1 text-xs text-muted-foreground"
            title={reachTitle(item.projects, homeName)}
          >
            <FolderOpen className="h-3 w-3 shrink-0" />
            <span className={NAMES}>
              {item.projects?.length > 0
                ? tx('With {names}', {
                    names: (
                      <>
                        {item.projects.map((p, k) => (
                          <Fragment key={p.id ?? k}>
                            {k > 0 && ', '}
                            <bdi>{p.name || p.id}</bdi>
                          </Fragment>
                        ))}
                      </>
                    ),
                  })
                : homeName
                  ? tx('<bdi>{name}</bdi> only', { name: homeName, bdi: (c) => <bdi>{c}</bdi> })
                  : homeOnly(null)}
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
    // What the turn did and wrote before it ended, above the line saying so.
    // The reasoning of the model call under way, kept in a round of its own
    // (`replyRound`), shows as a Thinking row above the text it had written.
    const work =
      item.steps?.length > 0 || item.replyRound ? (
        <WorkTrace
          steps={item.steps || []}
          summary={item.steps?.length > 0 ? item.stepsSummary : t('No steps')}
          partial={item.partial}
          rounds={rounds}
          gone={roundsGone}
          firstRound={item.steps?.[0]?.round ?? item.replyRound}
          replyRound={item.replyThought ? item.replyRound : null}
          open={traceOpen}
        />
      ) : item.partial ? (
        <div dir="auto" className="text-muted-foreground [&_*]:text-muted-foreground">
          <AssistantMarkdown>{item.partial}</AssistantMarkdown>
        </div>
      ) : null;
    const kind = errorKind ? <span className="mr-2 font-medium">{errorKind}</span> : null;
    const line = hideLine ? null : item.stopped ? (
      <div className="rounded-lg border border-dashed px-3 py-2 text-sm text-muted-foreground">
        {kind}
        {item.text}
      </div>
    ) : (
      <div
        role="alert"
        className="rounded-lg border border-destructive/40 bg-destructive/10 px-3 py-2 text-sm text-destructive"
      >
        {kind}
        {item.text}
      </div>
    );
    if (!work) return line;
    return (
      <div className="flex gap-3">
        <AssistantMark ring className="mt-1 h-7 w-7 shrink-0" />
        <div className="flex min-w-0 flex-1 flex-col gap-2">
          {work}
          {line}
        </div>
      </div>
    );
  }
  return (
    <div className="flex gap-3" onClick={focusInstead(adapter, onFocusHere)}>
      <AssistantMark ring className="mt-1 h-7 w-7 shrink-0" />
      <div className="flex min-w-0 flex-1 flex-col gap-2">
        {fromAnotherModel && (
          <div className="text-xs text-muted-foreground">
            {tx('Answered by <span>{model}</span>', {
              model: item.model,
              span: (c) => <span className="font-medium text-foreground">{c}</span>,
            })}
          </div>
        )}
        {/* `partial`: the text of a last call that failed after the plan was
            staged (`failed`), whose line is the reply. */}
        {(item.steps?.length > 0 || item.replyRound) && (
          <WorkTrace
            steps={item.steps || []}
            summary={item.steps?.length > 0 ? item.stepsSummary : t('No steps')}
            partial={item.partial}
            rounds={rounds}
            gone={roundsGone}
            firstRound={item.steps?.[0]?.round ?? item.replyRound}
            replyRound={item.replyThought ? item.replyRound : null}
            open={traceOpen}
          />
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
            <span className="tabular-nums">
              {t('Answered in {time}', { time: formatElapsed(item.elapsedMs) })}
            </span>
          </div>
        )}
        {item.contextNote && (
          <div className="flex items-center gap-1 text-xs text-muted-foreground">
            <BookOpen className="h-3 w-3 shrink-0" />
            {item.contextNote}
          </div>
        )}
        {/* What this reply fetched and kept with the conversation (a PDF from
            the web), or made for the user to download (a cleaned table), which
            later replies read as they read an attachment. */}
        {item.files?.length > 0 && (
          <div className="flex flex-wrap gap-1.5">
            {item.files.map((f) =>
              f.made && onDownloadFile ? (
                <button
                  key={f.id}
                  type="button"
                  onClick={(e) => {
                    e.stopPropagation();
                    onDownloadFile(f);
                  }}
                  title={t('Download {name}', { name: f.name })}
                  aria-label={t('Download {name}', { name: f.name })}
                  className="max-w-full rounded-full"
                >
                  <AttachmentChip
                    file={f}
                    icon={Download}
                    title={null}
                    className="hover:bg-muted"
                  />
                </button>
              ) : f.source ? (
                <a key={f.id} href={f.source} target="_blank" rel="noreferrer" title={f.source}>
                  <AttachmentChip file={f} title={null} className="hover:bg-muted" />
                </a>
              ) : (
                <AttachmentChip key={f.id} file={f} />
              ),
            )}
          </div>
        )}
        {/* The web page export shows a table the reply made, small enough. */}
        {shownFiles && item.files?.map((f) => <Fragment key={f.id}>{shownFiles(f)}</Fragment>)}
        {item.unavailableProjects?.length > 0 && (
          <div className="flex items-center gap-1 text-xs text-muted-foreground">
            <FolderOpen className="h-3 w-3 shrink-0" />
            <span className={NAMES}>
              {item.unavailableProjects.map((p, k) => (
                <Fragment key={p.id ?? k}>
                  {k > 0 && ' '}
                  {tx('<bdi>{name}</bdi> could not be opened.', {
                    name: p.name || p.id,
                    bdi: (c) => <bdi>{c}</bdi>,
                  })}
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
          !item.plan &&
          !(item.job && adapter.JobCard) && (
            <div className="text-sm italic text-muted-foreground">
              {t('(The assistant sent no text.)')}
            </div>
          )
        )}
        {/* What this turn staged, from the plan alone, right above its card.
            A job card stages nothing and has no line. */}
        {item.plan && stagedLine(item.plan) && (
          <div data-testid="staged-line" className="text-xs text-muted-foreground">
            {stagedLine(item.plan)}
          </div>
        )}
        {item.plan && (
          <PlanCard
            key={item.plan.id}
            plan={item.plan}
            status={item.status}
            written={item.written}
            outcome={item.outcome}
            notes={item.applyNotes}
            unwritten={item.unwritten}
            unknown={!!item.unknown}
            reason={item.reason || null}
            recordedAsHuman={item.asHuman}
            recordedAsUnverified={!!item.asUnverified}
            recordedAsContribution={!!item.contributed}
            dismissed={!!item.dismissed}
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
            readOnly={readOnly}
          />
        )}
        {item.job && adapter.JobCard && (
          <adapter.JobCard
            key={item.job.id}
            card={item.job}
            projectId={projectId}
            client={client}
            conversationId={conversationId}
            readOnly={readOnly || !onSettleJob}
            busy={busy}
            onSettle={onSettleJob}
          />
        )}
      </div>
    </div>
  );
};
