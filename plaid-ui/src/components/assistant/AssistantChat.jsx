import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { Send, RotateCcw, Check, X, Loader2, PanelRightClose } from 'lucide-react';
import { Link } from 'react-router-dom';
import { Button } from '../ui/button.jsx';
import { Textarea } from '../ui/textarea.jsx';
import { cn } from '../../lib/utils.js';
import { notifyError } from '../../lib/notify.js';
import { humanizeError } from '../../lib/errors.js';
import { AssistantMarkdown } from './AssistantMarkdown.jsx';
import { rewindForRetry, stoppedIn } from './resume.js';
import { assertAdapter } from './adapterContract.js';
import { AssistantMark } from './PlaidMarks.jsx';
import { NEARLY_FULL, fullness, latestUsage, totalSpend, usageLabel, usageTitle } from './usage.js';
import { AssistantPicker } from './ConversationList.jsx';
import { Turn } from './Turn.jsx';
import { MentionList } from './MentionList.jsx';
import { formatElapsed } from '../../hooks/useRunProgress.js';
import { useAssistantChoice } from './useAssistantChoice.js';
import { useConversationList } from './useConversationList.js';
import { useMentions } from './useMentions.js';
import { useResumeConversation } from './useResumeConversation.js';
import {
  attachJob,
  buildMeta,
  jobFor,
  newConversation,
  persistConv,
  movedHere,
  previousModel,
  readConv,
  settle,
  startApply,
  startTurn,
  stopJob,
  jobListeners,
  jobs,
} from './jobs.js';

// A chat with whatever `assist` service(s) the operator runs (see
// ../../../../plaid-agent): the transcript, the composer, the plans it comes
// back with, and the work in flight for any of it.
//
// This is the half that is the same wherever the assistant appears. What the
// surface around it puts there -- a rail of past conversations, an export menu,
// a history popover, a way to hide it -- comes in as the four render props
// below, each handed the same bag of what the chat knows. AssistantTab and
// AssistantPanel are the two surfaces.
//
// The record is the conversation. It lives in the user's key/value store
// (client.userData) under `igt:assistant:<project>:...`: one small `meta`
// entry per conversation for the sidebar, with `pending` while work is under
// way, and one `conv` entry with the model-facing transcript (`messages`,
// tool calls and results included) and what the person sees (`display`).
// Conversations are private to the user and follow them across devices.
//
// Who writes it: this appends the user's message and marks the conversation
// pending, then submits a request naming the conversation. The service loads
// the record, works, and writes the outcome back BEFORE reporting the request
// done. So the reply lands whether or not this page is still open; the request
// stream only carries progress, and its end is the cue to read the record
// again. A page that comes back to a pending conversation rejoins the request
// by id (the id is minted here and stored in `pending` before submitting) and
// reads the record when that ends; if the request is gone (the server
// restarted, or it expired), the record is settled here instead.
//
// The assistant never writes during a turn; a turn that would change data
// comes back with a plan, shown as a list of concrete changes with Approve /
// Discard. Approving submits the plan's id back; the service applies it under
// the user's own account (it delegates, so Plaid mints the user a short-lived
// token per request) and settles the plan in the record.

// How full the conversation is, in the header beside the model that fills it.
// A bar as well as a number: the number answers "how full" and the bar answers
// "should I care", which is the question someone glancing at it is asking.
const UsageMeter = ({ usage, spend }) => {
  const label = usageLabel(usage);
  if (!label) return null;
  const f = fullness(usage);
  return (
    <span
      className="flex shrink-0 items-center gap-1.5 text-xs text-muted-foreground"
      title={usageTitle(usage, spend)}
    >
      {f !== null && (
        <span className="h-1.5 w-8 overflow-hidden rounded-full bg-muted">
          <span
            className={cn(
              'block h-full rounded-full',
              f >= NEARLY_FULL ? 'bg-amber-500' : 'bg-primary/50',
            )}
            style={{ width: `${Math.max(2, Math.round(f * 100))}%` }}
          />
        </span>
      )}
      {label}
    </span>
  );
};

export const AssistantChat = ({
  projectId,
  client,
  userId,
  canWrite,
  contributor = false,
  adapter,
  // What the screen behind the chat is showing, exactly as it published it
  // (see subject.js). Null where the surface is about the project at large.
  // Its callbacks (onApplied, onFocusHere, mentions) travel with it.
  subject = null,
  // Which conversation is open, and how to open another. The tab keeps this in
  // the URL; the panel keeps it in state.
  conversationId = null,
  onConversationId,
  // Come back to the project's most recent thread rather than opening new (see
  // useResumeConversation).
  resumeNewest = false,
  // Whether a plan that lands says so in a toast. The docked panel does not
  // need one: its plan card is on screen beside the document, where it turns
  // green and says "Applied" in place, under the reader's eyes.
  toastOnApply = true,
  // What the user pointed at in the editor, as {ref, label}. It rides on the
  // next message and then clears: nothing is attached that was not chosen.
  focus = null,
  onClearFocus,
  // Put the chat away. Rendered as the last thing in the header, where the
  // surface that can be put away asks for it.
  onHide = null,
  // A narrow column: tighter padding, and no card border of its own because
  // the dock around it draws one.
  compact = false,
  // What this surface puts around the chat. Each is handed the same bag: the
  // open conversation and its sidebar entry, what a list of conversations
  // needs, which assistant answers, and how to start or send one.
  renderSidebar = null,
  renderIdentity = null,
  renderActions = null,
  renderEmpty = null,
}) => {
  // Both surfaces come through here, so this is the one place the app's adapter
  // has to be whole. Development only, and at render rather than in an effect:
  // a missing member shows up as a blank or a crash further down, and the
  // sooner it is named the shorter the hunt.
  if (import.meta.env.DEV) assertAdapter(adapter);
  // Where the reader is, in the shape the SERVICE takes, and the one that
  // travels with each turn. A screen that is about the project at large
  // publishes no kind, and then a turn names no place. What the RECORD stores
  // as where the conversation began is derived from this once, in jobs.js.
  const subjectKind = subject?.kind || null;
  const subjectId = subject?.id || null;
  const subjectName = subjectKind ? subject?.name || null : null;
  const where = useMemo(
    () =>
      subjectKind && subjectId ? { kind: subjectKind, id: subjectId, name: subjectName } : null,
    [subjectKind, subjectId, subjectName],
  );
  // The listener below is mounted once, so it reaches the caller's latest
  // handler through a ref rather than re-subscribing on every render.
  const onApplied = subject?.onApplied;
  const onAppliedRef = useRef(onApplied);
  onAppliedRef.current = onApplied;

  // Which conversation is open. Everything below reaches it through the refs,
  // because the effects that decide it are mounted once (see the TDZ note in
  // subject.js: everything a hook here names has to be declared above it).
  const convId = conversationId;
  const setConvId = onConversationId;
  const convIdRef = useRef(convId);
  convIdRef.current = convId;
  const setConvIdRef = useRef(setConvId);
  setConvIdRef.current = setConvId;

  const [active, setActive] = useState(newConversation); // {id, messages, display, draft?}
  const [opening, setOpening] = useState(null); // id being fetched
  const activeRef = useRef(active);
  activeRef.current = active;
  const openSeq = useRef(0); // the latest open() request, so a stale read is ignored

  const list = useConversationList({
    client,
    userId,
    app: adapter.app,
    projectId,
    onRemoved: (id) => {
      if (activeRef.current?.id !== id) return;
      openSeq.current++;
      setActive(newConversation());
      setConvIdRef.current(null, { replace: true });
    },
  });
  const { store } = list;
  const activeMeta = list.rows.find((m) => m.id === active?.id) || null;
  const choice = useAssistantChoice({ client, projectId, app: adapter.app, meta: activeMeta });
  const { service } = choice;

  // --- the job in flight for the shown conversation ----------------------
  const [input, setInput] = useState('');
  const [busy, setBusy] = useState(null); // null | 'turn' | 'apply'
  const [progress, setProgress] = useState('');
  const [liveSteps, setLiveSteps] = useState([]); // progress messages so far
  const [partial, setPartial] = useState(''); // the reply so far, while it is written
  const [stopping, setStopping] = useState(false);
  // The turn the reader stopped by hand and what it had already got through,
  // as {convId, steps}: the banner that follows says so rather than reporting a
  // failure that did not happen, and the steps stay on screen. Held WITH its
  // conversation, see `stoppedIn` in resume.js.
  const [stopped, setStopped] = useState(null);
  // How long the current turn has been going. A turn that sits on "Writing…"
  // for eleven minutes is indistinguishable from a dead one without this.
  const [elapsedMs, setElapsedMs] = useState(0);
  const bottomRef = useRef(null);
  const inputRef = useRef(null);
  // The listener below is mounted once, so the project it compares against
  // travels by ref.
  const projectIdRef = useRef(projectId);
  projectIdRef.current = projectId;
  // Bumped whenever a job in another project reports, so the count below is
  // recomputed. The jobs themselves live outside React.
  const [elsewhereTick, setElsewhereTick] = useState(0);

  // Half-second tick, the same cadence and format the service runs use.
  useEffect(() => {
    if (!busy) return undefined;
    const t0 = Date.now();
    setElapsedMs(0);
    const id = setInterval(() => setElapsedMs(Date.now() - t0), 500);
    return () => clearInterval(id);
  }, [busy]);

  // Reflect a job on screen. It does NOT clear the stop record: this runs on
  // every progress event, including the one `stopJob` fires the instant the
  // reader presses Stop, so clearing here wiped what had just been recorded.
  // A new piece of work clears it (see send and approve).
  const showJob = (j) => {
    setBusy(j.kind);
    setProgress(j.progress);
    setLiveSteps(j.steps);
    setPartial(j.partial || '');
    setStopping(!!j.stopping);
  };
  const clearJob = () => {
    setBusy(null);
    setProgress('');
    setLiveSteps([]);
    setPartial('');
    setStopping(false);
  };

  // Open a saved conversation. Work its record says is under way, with
  // nothing here following it, is rejoined: the record gets the outcome
  // either way, this shows it landing.
  const applyMeta = list.applyMeta;
  const open = useCallback(
    async (id) => {
      if (activeRef.current?.id === id) return;
      const seq = ++openSeq.current;
      const j = jobFor(id);
      if (j) {
        setActive(j.done ? j.result.conv : j.conv);
        return;
      }
      setOpening(id);
      try {
        const { conv, meta } = await readConv(store, id);
        // A later click (or "+") won the race: its choice stands.
        if (seq !== openSeq.current) return;
        setActive(conv);
        // The record is newer than the list (a reply may have landed since).
        if (meta) applyMeta(meta);
        if (meta?.pending?.requestId && !jobFor(id)) {
          attachJob({ store, conv, meta, docked: !toastOnApply });
        }
      } catch (e) {
        if (seq === openSeq.current) {
          notifyError(humanizeError(e, 'That conversation could not be opened.'));
          // A link to a conversation that is gone: back to a new one.
          if (convIdRef.current === id) setConvIdRef.current(null, { replace: true });
        }
      } finally {
        if (seq === openSeq.current) setOpening(null);
      }
    },
    [store, applyMeta, toastOnApply],
  );
  const openRef = useRef(open);
  openRef.current = open;

  // Opening one from a list, a shared link, and the browser's back button all
  // arrive here. Nothing open is a new conversation.
  useEffect(() => {
    if (convId) {
      if (convId !== activeRef.current?.id) openRef.current(convId);
    } else if (activeRef.current && !activeRef.current.draft) {
      openSeq.current++;
      setActive(newConversation());
    }
  }, [convId]);

  useResumeConversation({
    projectId,
    conversationId: convId,
    onConversationId: setConvId,
    reload: list.reload,
    resumeNewest,
    onNothingOpen: () => {
      if (activeRef.current && !activeRef.current.draft) setActive(newConversation());
    },
    openConversationId: () => {
      const a = activeRef.current;
      return a && !a.draft ? a.id : null;
    },
  });

  // Reflect jobs as they progress and finish, for whichever conversation is
  // shown; a finished job always refreshes the sidebar entry.
  useEffect(() => {
    const onJob = (j) => {
      // A job outlives the screen it was started from and the registry is
      // global, so once the panel stopped being unmounted on a navigation, a
      // job in ANOTHER project began arriving here while it runs. Its sidebar
      // row belongs to that project's list and its writes did not touch
      // anything on screen in this one. Counted, so the way back to it can be
      // offered, and otherwise left alone.
      if (j.projectId !== projectIdRef.current) {
        setElsewhereTick((n) => n + 1);
        return;
      }
      if (j.done) applyMeta(j.result.meta);
      // A plan that landed changed the project, so whatever is showing it
      // (the document beside this panel) is now stale.
      if (j.done && j.kind === 'apply' && !j.error) onAppliedRef.current?.();
      if (activeRef.current?.id !== j.id) return;
      if (j.done) {
        activeRef.current = j.result.conv;
        setActive(j.result.conv);
        clearJob();
        inputRef.current?.focus();
      } else {
        showJob(j);
      }
    };
    jobListeners.add(onJob);
    return () => jobListeners.delete(onJob);
  }, [applyMeta]);

  // Switching conversations: pick up a job in flight for the new one.
  useEffect(() => {
    const j = jobFor(active?.id);
    if (j && !j.done) showJob(j);
    else if (busy) clearJob();
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [active?.id]);

  // Apply `fn` to the active conversation and persist the result. No service
  // is involved (discarding a plan is the user's own doing), so the
  // conversation keeps the assistant already recorded against it.
  const update = (fn) => {
    const next = fn(activeRef.current);
    activeRef.current = next;
    setActive(next);
    const meta = buildMeta(
      list.rows.find((m) => m.id === next.id),
      next,
      null,
    );
    applyMeta(meta);
    persistConv(store, next, meta);
  };

  const startNew = () => {
    openSeq.current++;
    // Already sitting in an untouched new conversation: nothing to start.
    if (!activeRef.current?.draft || activeRef.current.display.length) {
      setActive(newConversation());
      setInput('');
    }
    if (convIdRef.current) setConvId(null);
    inputRef.current?.focus();
  };

  // --- turns -----------------------------------------------------------------
  useEffect(() => {
    bottomRef.current?.scrollIntoView({ block: 'end' });
  }, [active?.display.length, busy, progress, partial]);

  // Turns still running in another project. Navigating never stops one (the
  // record gets the outcome either way), and a reader who walked away from a
  // question should not have to remember which project they asked it in.
  const elsewhere = useMemo(() => {
    void elsewhereTick;
    return [...jobs.values()].filter((j) => !j.done && j.projectId && j.projectId !== projectId);
  }, [elsewhereTick, projectId]);

  // How full this thread is, from the newest reply that reported it.
  const usage = useMemo(() => latestUsage(active?.display), [active?.display]);
  const spend = useMemo(() => totalSpend(active?.display), [active?.display]);
  const nearlyFull = (fullness(usage) ?? 0) >= NEARLY_FULL;

  const canSend = !!service && !busy;

  const send = (textOverride) => {
    const typed = (textOverride ?? input).trim();
    if (!typed || !canSend) return;
    setStopped(null);
    // The chip is the reference the question is about, said the way the
    // assistant addresses one. A question that already names it is left alone.
    const text = focus && !typed.includes(focus.ref) ? `${focus.ref}: ${typed}` : typed;
    setInput('');
    onClearFocus?.();
    // Sending is what turns a draft into a saved conversation, so the flag
    // does not travel with it.
    const base = activeRef.current ?? newConversation();
    // The display item carries the place as data, for the chip on the message.
    // The model's copy is stamped by the service, which owns every word the
    // model reads, and only when the place has changed since the last turn.
    const conv = {
      id: base.id,
      messages: [...base.messages, { role: 'user', content: text }],
      display: [...base.display, { kind: 'user', text, ...(where ? { where } : {}) }],
    };
    const prevMeta = list.rows.find((m) => m.id === conv.id);
    openSeq.current++; // sending settles which conversation is open
    activeRef.current = conv;
    setActive(conv);
    if (convIdRef.current !== conv.id) setConvId(conv.id, { replace: true });
    applyMeta(buildMeta(prevMeta, conv, service));
    showJob(startTurn({ store, service, conv, prevMeta, where }));
  };

  // Send the user's last message again, whether the turn was lost (its
  // request went away with the server or the service) or failed. Both rewind
  // the same way, to just before the user's item.
  const retryTurn = () => {
    const conv = activeRef.current;
    if (!conv || !canSend) return;
    const rewound = rewindForRetry(conv);
    if (!rewound) return;
    activeRef.current = rewound.conv;
    send(rewound.text);
  };

  // Stop a turn: the service is asked to stop, and does so between steps.
  // Only turns can be stopped: an apply's writes are already under way, and
  // abandoning one would hide what landed.
  const stopTurn = () => {
    // Remember that the silence after this was asked for. Without it the retry
    // banner below tells the user "No answer came back for this message", which
    // blames the model for the user's own click.
    setStopped({ convId: activeRef.current?.id ?? null, steps: liveSteps });
    return stopJob(client, projectId, jobFor(activeRef.current?.id));
  };

  const approve = (plan, { asHuman = false } = {}) => {
    const conv = activeRef.current;
    if (!conv || !canSend) return;
    setStopped(null);
    showJob(
      startApply({
        store,
        service,
        conv,
        prevMeta: list.rows.find((m) => m.id === conv.id),
        plan,
        asHuman,
        contributedBy: contributor ? userId : null,
        docked: !toastOnApply,
      }),
    );
  };

  const discard = (index) =>
    update((c) =>
      settle(c, index, 'discarded', '(note) The user discarded the plan; nothing was changed.'),
    );

  const mentions = useMentions({
    client,
    projectId,
    enabled: canSend,
    text: input,
    setText: setInput,
    inputRef,
    offer: subject?.mentions,
  });

  const onKeyDown = (e) => {
    if (mentions.handleKeyDown(e)) return;
    if (e.key === 'Enter' && !e.shiftKey) {
      e.preventDefault();
      send();
    }
  };

  const display = active?.display || [];
  // A step's output, looked up by the tool call it belongs to. The transcript
  // is where it is stored, so the trace does not carry a second copy.
  const results = useMemo(
    () =>
      new Map(
        (active?.messages || [])
          .filter((m) => m.role === 'tool' && m.toolCallId)
          .map((m) => [m.toolCallId, String(m.content ?? '')]),
      ),
    [active?.messages],
  );
  // A list of conversations puts an unsent one at the top, so a new
  // conversation is a real place to be rather than a blank screen.
  const rows = active?.draft
    ? [{ id: active.id, title: 'New conversation', draft: true }, ...list.rows]
    : list.rows;
  // What either surface needs to draw that list: the rail in the tab, the
  // header's popover in the panel.
  const listProps = {
    rows,
    activeId: active?.id,
    projectId,
    projectNames: list.projectNames,
    opening,
    loading: list.loading,
    hrefFor: (m) => adapter.convHref(m.projectId || projectId, m.id),
    onDelete: list.remove,
  };
  const pendingPlan = display.some((d) => d.plan && d.status === null);
  // Nothing is running for this conversation, so anything left mid-flight in
  // it was lost rather than in progress.
  const idle = !busy && !jobFor(active?.id);
  const lastKind = display.at(-1)?.kind;
  const canRetryTurn = idle && (lastKind === 'user' || lastKind === 'error');
  const stoppedHere = stoppedIn(stopped, active?.id);
  const applyingPlanId = busy === 'apply' ? jobFor(active?.id)?.planId || null : null;
  // What the surface's own chrome is drawn from.
  const chrome = {
    conversation: active,
    meta: activeMeta,
    listProps,
    allProjects: list.allProjects,
    setAllProjects: list.setAllProjects,
    startNew,
    choice,
    busy: !!busy,
    canSend,
    send,
  };

  return (
    <>
      {renderSidebar?.(chrome)}
      <section
        className={cn(
          'flex min-w-0 flex-1 flex-col bg-card',
          compact ? 'min-h-0' : 'rounded-lg border',
        )}
      >
        {/* `min-h-14` matches the app header's own height, so the two bars
            line up where the dock sits beside it. Unconditional rather than a
            flag: a slightly taller bar costs nothing where there is nothing to
            line up with. */}
        <header className="flex min-h-14 flex-wrap items-center gap-2 border-b px-3 py-2 text-sm">
          <AssistantMark className="h-4 w-4 shrink-0" />
          {choice.discovering && !choice.services.length ? (
            <span className="text-muted-foreground">Looking for an assistant…</span>
          ) : !service ? (
            choice.stranded.length ? (
              // One IS online. It just predates `extras.app`, so it cannot be
              // told which app a conversation belongs to. Saying none is online
              // sent operators to start a second, which collides on the service
              // id and 409s.
              <span className="text-muted-foreground">
                {choice.stranded.length === 1
                  ? 'An assistant is'
                  : `${choice.stranded.length} assistants are`}{' '}
                running from before this version. Restart{' '}
                {choice.stranded.length === 1 ? 'it' : 'them'} with{' '}
                <code className="rounded bg-muted px-1">{adapter.command} --model …</code>.
              </span>
            ) : (
              <span className="text-muted-foreground">
                No assistant is online for this project. An operator can start one with{' '}
                <code className="rounded bg-muted px-1">{adapter.command} --model …</code>.
              </span>
            )
          ) : (
            renderIdentity?.(chrome)
          )}
          <div className="ml-auto flex items-center gap-2">
            {elsewhere.length > 0 && (
              <Link
                to={adapter.convHref(elsewhere[0].projectId, elsewhere[0].id)}
                className="flex shrink-0 items-center gap-1 text-xs text-muted-foreground hover:text-foreground"
                title="Go to the turn still running"
              >
                <Loader2 className="h-3 w-3 animate-spin" />
                {elsewhere.length === 1
                  ? '1 running elsewhere'
                  : `${elsewhere.length} running elsewhere`}
              </Link>
            )}
            <UsageMeter usage={usage} spend={spend} />
            {renderActions?.(chrome)}
            <Button
              type="button"
              variant="ghost"
              size="sm"
              onClick={choice.refresh}
              disabled={choice.discovering}
              title="Refresh assistants"
            >
              <RotateCcw className={cn('h-4 w-4', choice.discovering && 'animate-spin')} />
            </Button>
            {onHide && (
              <Button
                type="button"
                variant="ghost"
                size="sm"
                onClick={onHide}
                title="Hide the assistant"
              >
                <PanelRightClose className="h-4 w-4" />
              </Button>
            )}
          </div>
        </header>

        <div className={cn('flex-1 overflow-y-auto', compact ? 'px-3 py-3' : 'px-4 py-4')}>
          <div className="mx-auto flex max-w-3xl flex-col gap-5">
            {display.length === 0 && !busy && renderEmpty?.(chrome)}
            {display.map((d, i) => (
              <Turn
                key={i}
                item={d}
                projectId={projectId}
                adapter={adapter}
                onFocusHere={subject?.onFocusHere}
                results={results}
                fromAnotherModel={
                  !!d.model && !!previousModel(display, i) && d.model !== previousModel(display, i)
                }
                movedHere={movedHere(display, i)}
                canWrite={canWrite}
                contributor={contributor}
                busy={!!busy}
                interrupted={!!d.interrupted}
                applying={!!d.plan && applyingPlanId === d.plan.id}
                onApprove={(opts) => approve(d.plan, opts)}
                onDiscard={() => discard(i)}
              />
            ))}
            {canRetryTurn && stoppedHere && stoppedHere.steps.length > 0 && (
              <div className="flex flex-col gap-1 text-sm text-muted-foreground">
                {stoppedHere.steps.map((m, i) => (
                  <div key={i} className="flex items-center gap-2 pl-6 text-xs">
                    <Check className="h-3 w-3" /> {m}
                  </div>
                ))}
              </div>
            )}
            {canRetryTurn && (
              <div className="flex items-center gap-3 rounded-lg border border-dashed px-3 py-2 text-sm text-muted-foreground">
                <span className="flex-1">
                  {lastKind === 'error'
                    ? 'That turn did not finish.'
                    : stoppedHere
                      ? 'You stopped this turn.'
                      : 'No answer came back for this message.'}
                </span>
                <Button
                  type="button"
                  size="sm"
                  variant="outline"
                  onClick={retryTurn}
                  disabled={!canSend}
                >
                  <RotateCcw className="h-4 w-4" /> Retry
                </Button>
              </div>
            )}
            {/* What the turn has done so far, then the reply as it is being
                written, then what it is doing now: the same order the turn
                happened in, so the text lands under the steps it followed. */}
            {busy && (
              <div className="flex flex-col gap-3">
                {liveSteps.length > 0 && (
                  <div className="flex flex-col gap-1 text-sm text-muted-foreground">
                    {liveSteps.map((m, i) => (
                      <div key={i} className="flex items-center gap-2 pl-6 text-xs">
                        <Check className="h-3 w-3" /> {m}
                      </div>
                    ))}
                  </div>
                )}
                {busy === 'turn' && partial && (
                  <div className="flex gap-3">
                    <AssistantMark ring className="mt-1 h-7 w-7 shrink-0" />
                    <div className="min-w-0 flex-1">
                      <AssistantMarkdown>{partial}</AssistantMarkdown>
                    </div>
                  </div>
                )}
                <div className="flex items-center gap-2 text-sm text-muted-foreground">
                  <Loader2 className="h-4 w-4 animate-spin" />
                  <span className="animate-pulse">
                    {progress || (busy === 'apply' ? 'Applying changes…' : 'Thinking…')}
                  </span>
                  {/* The only moving part when the service goes quiet, and the
                    difference between "this is slow" and "this is dead". */}
                  <span className="tabular-nums text-xs">{formatElapsed(elapsedMs)}</span>
                  {busy === 'turn' && (
                    <Button
                      type="button"
                      size="sm"
                      variant="ghost"
                      onClick={stopTurn}
                      disabled={stopping}
                      className="h-6 px-2 text-xs"
                    >
                      <X className="h-3 w-3" /> {stopping ? 'Stopping…' : 'Stop'}
                    </Button>
                  )}
                </div>
              </div>
            )}
            <div ref={bottomRef} />
          </div>
        </div>

        <div className={cn('border-t', compact ? 'px-3 py-2' : 'px-4 py-3')}>
          {/* The conversation's own assistant is gone. Rather than answer in a
              different voice without saying so, name the replacement, and let
              the user choose it where there is more than one. */}
          {choice.wentOffline && service && (
            <div className="mx-auto mb-2 flex max-w-3xl flex-wrap items-center gap-2 text-xs text-muted-foreground">
              <span>
                The assistant this conversation started with is offline. Replies now come from{' '}
                <span className="font-medium text-foreground">{service.serviceName}</span>.
              </span>
              {choice.canChoose && (
                <AssistantPicker
                  assistants={choice.assistants}
                  stranded={choice.stranded}
                  value={service.serviceId}
                  onChange={choice.choose}
                  disabled={!!busy}
                />
              )}
            </div>
          )}
          {/* Nothing manages the window for the reader, so a thread that runs
              long eventually fails a turn outright. Said here, where the next
              message is about to be typed, and with the remedy named: the new
              conversation button is a few pixels away in the header. */}
          {nearlyFull && (
            <p className="mx-auto mb-2 max-w-3xl text-xs text-amber-600 dark:text-amber-500">
              This conversation is {Math.round(fullness(usage) * 100)}% full. Start a new one before
              it stops fitting.
            </p>
          )}
          {focus && (
            <div className="mx-auto mb-2 flex max-w-3xl items-center gap-1">
              <span className="inline-flex items-center gap-1.5 rounded-full border bg-muted/50 py-1 pl-2.5 pr-1 text-xs">
                <span className="font-medium">{focus.label}</span>
                <span className="text-muted-foreground">{focus.ref}</span>
                <button
                  type="button"
                  onClick={() => onClearFocus?.()}
                  title="Remove"
                  className="rounded-full p-0.5 text-muted-foreground hover:bg-muted hover:text-foreground"
                >
                  <X className="h-3 w-3" />
                </button>
              </span>
            </div>
          )}
          {/* `relative`, because the `@` list hangs off the top of this box
              rather than off the caret: measuring a character position inside a
              textarea needs a mirror element and breaks on wrap and on resize,
              and the composer is never far from the caret anyway. */}
          <div className="relative mx-auto flex max-w-3xl items-end gap-2 rounded-xl border bg-background p-2 focus-within:ring-1 focus-within:ring-ring">
            {mentions.open && (
              <MentionList
                groups={mentions.groups}
                activeValue={mentions.activeValue}
                onPick={mentions.pick}
                onHover={mentions.setActiveValue}
                loading={mentions.loading}
              />
            )}
            <Textarea
              ref={inputRef}
              value={input}
              onChange={(e) => {
                setInput(e.target.value);
                mentions.noteCaret(e.target.selectionStart);
              }}
              onKeyUp={mentions.trackCaret}
              onSelect={mentions.trackCaret}
              onKeyDown={onKeyDown}
              placeholder={
                !service
                  ? 'No assistant online'
                  : pendingPlan
                    ? 'Approve or discard the plan above, or keep talking'
                    : 'Message the assistant… (Enter to send, Shift+Enter for a new line)'
              }
              disabled={!canSend}
              rows={2}
              className="min-h-[2.5rem] flex-1 resize-none border-0 bg-transparent p-1 shadow-none focus-visible:ring-0"
            />
            <Button
              type="button"
              size="sm"
              onClick={() => send()}
              disabled={!canSend || !input.trim()}
              title="Send"
            >
              <Send className="h-4 w-4" />
            </Button>
          </div>
        </div>
      </section>
    </>
  );
};
