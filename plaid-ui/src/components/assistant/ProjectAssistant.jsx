import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { Bot, Send, RotateCcw, Check, X, Loader2, Plus, Trash2, Maximize2 } from 'lucide-react';
import { Link, useSearchParams } from 'react-router-dom';
import { assistantsAmong } from './useAssistantAvailable.js';
import { Button } from '../ui/button.jsx';
import { Textarea } from '../ui/textarea.jsx';
import { Badge } from '../ui/badge.jsx';
import { cn } from '../../lib/utils.js';
import { notifyError } from '../../lib/notify.js';
import { humanizeError } from '../../lib/errors.js';
import { AssistantMarkdown } from './AssistantMarkdown.jsx';
import { rewindForRetry } from './resume.js';
import { AssistantPicker, ConversationRow, ExportMenu } from './ConversationList.jsx';
import { Turn } from './Turn.jsx';
import {
  attachJob,
  buildMeta,
  convKey,
  jobFor,
  metaKey,
  metaPrefix,
  newConversation,
  persistConv,
  previousModel,
  readConv,
  settle,
  startApply,
  startTurn,
  stopJob,
  upsert,
  serviceCache,
  lastOpen,
  jobListeners,
} from './jobs.js';

// The Assistant tab: a chat with whatever `assist` service(s) the operator
// runs (see ../../../../../plaid-agent), laid out like any chat app: past
// conversations on the left, the active one on the right.
//
// The record is the conversation. It lives in the user's key/value store
// (client.userData) under `igt:assistant:<project>:...`: one small `meta`
// entry per conversation for the sidebar, with `pending` while work is under
// way, and one `conv` entry with the model-facing transcript (`messages`,
// tool calls and results included) and what the person sees (`display`).
// Conversations are private to the user and follow them across devices.
//
// Who writes it: this tab appends the user's message and marks the
// conversation pending, then submits a request naming the conversation. The
// service loads the record, works, and writes the outcome back BEFORE
// reporting the request done. So the reply lands whether or not this page is
// still open; the request stream only carries progress, and its end is the
// cue to read the record again. A tab that comes back to a pending
// conversation rejoins the request by id (the id is minted here and stored in
// `pending` before submitting) and reads the record when that ends; if the
// request is gone (the server restarted, or it expired), the record is
// settled here instead.
//
// The URL names the conversation (`?tab=assistant&conversation=<id>`): the
// sidebar's rows are links to it, so a conversation can be shared, opened in
// a new tab, and backed out of. No conversation in the URL is a new one.
//
// The assistant never writes during a turn; a turn that would change data
// comes back with a plan, shown as a list of concrete changes with Approve /
// Discard. Approving submits the plan's id back; the service applies it under
// the user's own account (it delegates, so Plaid mints the user a short-lived
// token per request) and settles the plan in the record.

export const ProjectAssistant = ({
  projectId,
  projectName,
  client,
  userId,
  canWrite,
  contributor = false,
  adapter,
  // 'tab' is the whole screen; 'panel' is the same conversation docked beside
  // a document, with the chrome the tab owns left out (see DocumentAssistant).
  variant = 'tab',
  documentId = null,
  documentName = null,
  onApplied,
  // What the user pointed at in the editor, as {ref, label}. It rides on the
  // next message and then clears: nothing is attached that was not chosen.
  focus = null,
  onClearFocus,
  // Told where a citation into the OPEN document points, so the editor beside
  // the panel can scroll there. Returns true when it handled it, and the link
  // is left alone otherwise.
  onFocusHere,
}) => {
  const panel = variant === 'panel';
  // Each document remembers its own thread, so opening the panel on one
  // document never resumes a conversation about another.
  const openKey = panel && documentId ? `${projectId}:${documentId}` : projectId;
  // The listener below is mounted once, so it reaches the caller's latest
  // handler through a ref rather than re-subscribing on every render.
  const onAppliedRef = useRef(onApplied);
  onAppliedRef.current = onApplied;
  // Everything the record layer needs, in one object: which app's keys to
  // write under, whose store, and which project.
  const store = useMemo(
    () => ({ client, userId, app: adapter.app, projectId }),
    [client, userId, adapter.app, projectId],
  );
  // --- services ---------------------------------------------------------
  const [services, setServices] = useState([]);
  const [discovering, setDiscovering] = useState(true);
  const [choice, setChoice] = useState(null);

  // --- conversations ----------------------------------------------------
  const [convs, setConvs] = useState([]); // sidebar metas, newest first
  const [loadingList, setLoadingList] = useState(true);
  const [active, setActive] = useState(newConversation); // {id, messages, display, draft?}
  const [opening, setOpening] = useState(null); // id being fetched
  // Which conversation is open. The tab keeps it in the URL, so a link to one
  // is shareable. The panel keeps it in state instead: it lives on a document
  // route, whose URL is the document's and not the assistant's.
  const [searchParams, setSearchParams] = useSearchParams();
  const [panelConv, setPanelConv] = useState(null);
  const urlConv = panel ? panelConv : searchParams.get('conversation');
  const setUrlConv = useCallback(
    (id, options) => {
      if (panel) {
        setPanelConv(id);
        return;
      }
      setSearchParams((prev) => {
        const next = new URLSearchParams(prev);
        if (id) next.set('conversation', id);
        else next.delete('conversation');
        return next;
      }, options);
    },
    [setSearchParams, panel],
  );
  const urlConvRef = useRef(urlConv);
  urlConvRef.current = urlConv;
  const setUrlConvRef = useRef(setUrlConv);
  setUrlConvRef.current = setUrlConv;

  // --- the job in flight for the shown conversation ----------------------
  const [input, setInput] = useState('');
  const [busy, setBusy] = useState(null); // null | 'turn' | 'apply'
  const [progress, setProgress] = useState('');
  const [liveSteps, setLiveSteps] = useState([]); // progress messages so far
  const [partial, setPartial] = useState(''); // the reply so far, while it is written
  const [stopping, setStopping] = useState(false);
  const bottomRef = useRef(null);
  const inputRef = useRef(null);
  const openSeq = useRef(0); // the latest open() request, so a stale read is ignored
  const activeRef = useRef(active);
  activeRef.current = active;
  const convsRef = useRef(convs);
  convsRef.current = convs;

  // Only ONLINE assist services OF THIS APP can take a turn: a conversation's
  // record is namespaced by `adapter.app`, the same value the service
  // advertises, so another app's assistant could not find one of ours.
  const assistants = useMemo(() => assistantsAmong(services, adapter.app), [services, adapter.app]);
  // A conversation keeps the assistant it started with: its earlier answers
  // were that model's, and swapping models halfway through a thread makes the
  // whole thread hard to read. So the picker is offered while a conversation
  // is still new, and again only if the assistant it started with has gone
  // offline, where the alternative is not being able to go on at all.
  const activeMeta = convs.find((m) => m.id === active?.id) || null;
  const pinned = activeMeta?.serviceId
    ? (assistants.find((s) => s.serviceId === activeMeta.serviceId) ?? null)
    : null;
  const service = pinned ?? assistants.find((s) => s.serviceId === choice) ?? assistants[0] ?? null;
  const canChoose = !pinned && assistants.length > 1;
  // The conversation's own assistant is offline, so a reply now would come
  // from a different one. Say so rather than switching quietly.
  const wentOffline = !!activeMeta?.serviceId && !pinned;
  const model = service?.extras?.model;

  const discover = useCallback(async () => {
    try {
      const found = (await client.messages.discoverServices(projectId)) || [];
      serviceCache.set(projectId, found);
      setServices(found);
    } catch (e) {
      console.error('[Assistant] discovery failed', e);
      if (!serviceCache.has(projectId)) setServices([]);
    } finally {
      setDiscovering(false);
    }
  }, [client, projectId]);

  const refresh = () => {
    setDiscovering(true);
    discover();
  };

  // Show what we already know about this project while re-checking, so
  // switching tabs does not blank the assistant picker every time.
  useEffect(() => {
    const cached = serviceCache.get(projectId);
    setServices(cached || []);
    setDiscovering(!cached);
    discover();
  }, [discover, projectId]);

  // --- persistence ---------------------------------------------------------
  const loadList = useCallback(async () => {
    const { client, userId, app, projectId } = store;
    if (!userId) return [];
    setLoadingList(true);
    try {
      const entries = await client.userData.list(userId, {
        prefix: metaPrefix(app, projectId),
        includeValues: true,
      });
      const metas = (entries || [])
        .map((e) => e.value)
        .filter((m) => m && m.id)
        .sort((a, b) => (b.updatedAt || '').localeCompare(a.updatedAt || ''));
      setConvs(metas);
      return metas;
    } catch (e) {
      console.error('[Assistant] could not load conversations', e);
      notifyError(humanizeError(e, 'Past conversations could not be loaded.'));
      return [];
    } finally {
      setLoadingList(false);
    }
  }, [store]);

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
        if (meta) setConvs(upsert(meta));
        if (meta?.pending?.requestId && !jobFor(id)) {
          attachJob({ store, conv, meta });
        }
      } catch (e) {
        if (seq === openSeq.current) {
          notifyError(humanizeError(e, 'That conversation could not be opened.'));
          // A link to a conversation that is gone: back to a new one.
          if (urlConvRef.current === id) setUrlConvRef.current(null, { replace: true });
        }
      } finally {
        if (seq === openSeq.current) setOpening(null);
      }
    },
    [store],
  );
  const openRef = useRef(open);
  openRef.current = open;

  // The URL names the conversation: opening one from the sidebar, a shared
  // link, and the browser's back button all arrive here. No conversation in
  // the URL is a new one.
  useEffect(() => {
    if (urlConv) {
      if (urlConv !== activeRef.current?.id) openRef.current(urlConv);
    } else if (activeRef.current && !activeRef.current.draft) {
      openSeq.current++;
      setActive(newConversation());
    }
  }, [urlConv]);

  // On mount: a new conversation, the way a chat app opens; the sidebar has
  // the rest. Within one page session, coming back to the tab returns to the
  // conversation that was open when it was left (the tab links drop the
  // conversation from the URL, so it is put back).
  useEffect(() => {
    const remembered = lastOpen.get(openKey);
    loadList().then((metas) => {
      if (urlConvRef.current) return;
      // Only a conversation that still exists (it may have been deleted meanwhile).
      if (remembered && (jobFor(remembered) || metas.some((m) => m.id === remembered))) {
        setUrlConvRef.current(remembered, { replace: true });
        return;
      }
      // Opening the panel on a document that has been discussed before picks
      // that thread back up. A conversation about ANOTHER document never
      // opens here: it would answer about the wrong text.
      if (panel && documentId) {
        const mine = metas.find((m) => m.about?.documentId === documentId);
        if (mine) setUrlConvRef.current(mine.id, { replace: true });
      }
    });
    return () => {
      const a = activeRef.current;
      if (a && !a.draft) lastOpen.set(openKey, a.id);
      else lastOpen.delete(openKey);
    };
  }, [loadList, openKey, panel, documentId]);

  // Reflect jobs as they progress and finish, for whichever conversation is
  // shown; a finished job always refreshes the sidebar entry.
  useEffect(() => {
    const onJob = (j) => {
      if (j.done) setConvs(upsert(j.result.meta));
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
  }, []);

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
  const update = useCallback(
    (fn) => {
      const next = fn(activeRef.current);
      activeRef.current = next;
      setActive(next);
      const meta = buildMeta(
        convsRef.current.find((m) => m.id === next.id),
        next,
        null,
      );
      setConvs(upsert(meta));
      persistConv(store, next, meta);
    },
    [store],
  );

  const remove = async (id) => {
    const j = jobFor(id);
    if (j) {
      notifyError(
        j.done
          ? 'That conversation is still being saved.'
          : j.kind === 'apply'
            ? 'That conversation is still applying changes.'
            : 'That conversation is still waiting for an answer.',
      );
      return;
    }
    try {
      // Both keys, or neither: a transcript left behind without its sidebar
      // entry could never be reached again.
      await Promise.all([
        client.userData.delete(userId, convKey(adapter.app, projectId, id)),
        client.userData.delete(userId, metaKey(adapter.app, projectId, id)),
      ]);
      setConvs((prev) => prev.filter((m) => m.id !== id));
      if (activeRef.current?.id === id) {
        openSeq.current++;
        setActive(newConversation());
        setUrlConv(null, { replace: true });
      }
    } catch (e) {
      notifyError(humanizeError(e, 'The conversation could not be deleted.'));
    }
  };

  const startNew = () => {
    openSeq.current++;
    // Already sitting in an untouched new conversation: nothing to start.
    if (!activeRef.current?.draft || activeRef.current.display.length) {
      setActive(newConversation());
      setInput('');
    }
    if (urlConvRef.current) setUrlConv(null);
    inputRef.current?.focus();
  };

  // --- turns -----------------------------------------------------------------
  useEffect(() => {
    bottomRef.current?.scrollIntoView({ block: 'end' });
  }, [active?.display.length, busy, progress, partial]);

  const canSend = !!service && !busy;

  const send = (textOverride) => {
    const typed = (textOverride ?? input).trim();
    if (!typed || !canSend) return;
    // The chip is the reference the question is about, said the way the
    // assistant addresses one. A question that already names it is left alone.
    const text = focus && !typed.includes(focus.ref) ? `${focus.ref}: ${typed}` : typed;
    setInput('');
    onClearFocus?.();
    // Sending is what turns a draft into a saved conversation, so the flag
    // does not travel with it.
    const base = activeRef.current ?? newConversation();
    const conv = {
      id: base.id,
      messages: [...base.messages, { role: 'user', content: text }],
      display: [...base.display, { kind: 'user', text }],
    };
    const prevMeta = convsRef.current.find((m) => m.id === conv.id);
    openSeq.current++; // sending settles which conversation is open
    activeRef.current = conv;
    setActive(conv);
    if (urlConvRef.current !== conv.id) setUrlConv(conv.id, { replace: true });
    setConvs(upsert(buildMeta(prevMeta, conv, service)));
    showJob(startTurn({ store, service, conv, prevMeta, documentId, documentName }));
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
  const stopTurn = () => stopJob(client, projectId, jobFor(activeRef.current?.id));

  const approve = (plan, { asHuman = false } = {}) => {
    const conv = activeRef.current;
    if (!conv || !canSend) return;
    showJob(
      startApply({
        store,
        service,
        conv,
        prevMeta: convsRef.current.find((m) => m.id === conv.id),
        plan,
        asHuman,
        contributedBy: contributor ? userId : null,
      }),
    );
  };

  const discard = (index) =>
    update((c) =>
      settle(c, index, 'discarded', '(note) The user discarded the plan; nothing was changed.'),
    );

  const onKeyDown = (e) => {
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
  // The sidebar lists the saved conversations, with an unsent one at the top
  // so a new conversation is a real place to be rather than a blank screen.
  const rows = active?.draft
    ? [{ id: active.id, title: 'New conversation', draft: true }, ...convs]
    : convs;
  const pendingPlan = display.some((d) => d.plan && d.status === null);
  // Nothing is running for this conversation, so anything left mid-flight in
  // it was lost rather than in progress.
  const idle = !busy && !jobFor(active?.id);
  const lastKind = display.at(-1)?.kind;
  const canRetryTurn = idle && (lastKind === 'user' || lastKind === 'error');
  const applyingPlanId = busy === 'apply' ? jobFor(active?.id)?.planId || null : null;

  return (
    <div
      className={cn('flex gap-4', panel ? 'h-full min-h-0' : 'h-[calc(100vh-15rem)] min-h-[32rem]')}
    >
      {/* --- sidebar --------------------------------------------------- */}
      {/* Not rendered in a panel rather than hidden with CSS: hiding it still
          built every conversation row, and the panel's whole point is to be
          small. */}
      {!panel && (
        <aside className="flex w-64 shrink-0 flex-col rounded-lg border bg-card">
          <div className="flex items-center justify-between border-b px-3 py-2">
            <span className="text-sm font-medium">Conversations</span>
            <Button
              type="button"
              variant="ghost"
              size="sm"
              onClick={startNew}
              title="New conversation"
            >
              <Plus className="h-4 w-4" />
            </Button>
          </div>
          <div className="flex-1 overflow-y-auto p-1.5">
            {loadingList && !rows.length ? (
              <div className="px-2 py-3 text-xs text-muted-foreground">Loading…</div>
            ) : (
              rows.map((m) => (
                <div
                  key={m.id}
                  className={cn(
                    'group flex items-start gap-2 rounded-md px-2 py-1.5 text-sm',
                    active?.id === m.id ? 'bg-accent text-accent-foreground' : 'hover:bg-muted',
                  )}
                >
                  {m.draft ? (
                    <div className="min-w-0 flex-1 text-left">
                      <ConversationRow m={m} opening={opening} />
                    </div>
                  ) : (
                    <Link
                      to={adapter.convHref(projectId, m.id)}
                      className="min-w-0 flex-1 text-left"
                    >
                      <ConversationRow m={m} opening={opening} />
                    </Link>
                  )}
                  {!m.draft && (
                    <button
                      type="button"
                      onClick={() => remove(m.id)}
                      title="Delete conversation"
                      className="mt-0.5 rounded p-0.5 text-muted-foreground opacity-0 hover:text-destructive focus:opacity-100 group-hover:opacity-100"
                    >
                      <Trash2 className="h-3.5 w-3.5" />
                    </button>
                  )}
                </div>
              ))
            )}
          </div>
          <p className="border-t px-3 py-2 text-[11px] text-muted-foreground">
            Conversations are private to you and saved to your account.
          </p>
        </aside>
      )}

      {/* --- chat --------------------------------------------------------- */}
      <section
        className={cn(
          'flex min-w-0 flex-1 flex-col bg-card',
          panel ? 'min-h-0' : 'rounded-lg border',
        )}
      >
        <header className="flex flex-wrap items-center gap-2 border-b px-3 py-2 text-sm">
          <Bot className="h-4 w-4 shrink-0 text-muted-foreground" />
          {discovering && !services.length ? (
            <span className="text-muted-foreground">Looking for an assistant…</span>
          ) : !service ? (
            <span className="text-muted-foreground">
              No assistant is online for this project. An operator can start one with{' '}
              <code className="rounded bg-muted px-1">{adapter.command} --model …</code>.
            </span>
          ) : panel ? (
            // Which assistant answers is settled at the start of a
            // conversation and then stays put, so the panel offers the choice
            // exactly where it shows the answer: the model's name IS the
            // picker while the thread is new, and plain text once it is not.
            canChoose ? (
              <AssistantPicker
                assistants={assistants}
                value={service.serviceId}
                onChange={setChoice}
                disabled={!!busy}
                compact
              />
            ) : (
              <span className="min-w-0 truncate text-muted-foreground" title={service.serviceName}>
                {model || service.serviceName}
              </span>
            )
          ) : (
            <>
              <span className="font-medium">{service.serviceName}</span>
              {model && !service.serviceName?.includes(model) && (
                <Badge variant="secondary">{model}</Badge>
              )}
              {!canWrite && (
                <span className="text-xs text-muted-foreground">
                  Read-only access: plans cannot be applied.
                </span>
              )}
            </>
          )}
          <div className="ml-auto flex items-center gap-1">
            {panel && (
              <>
                <Button
                  type="button"
                  variant="ghost"
                  size="sm"
                  onClick={startNew}
                  title="New conversation"
                >
                  <Plus className="h-4 w-4" />
                </Button>
                {!active?.draft && (
                  <Link
                    to={adapter.convHref(projectId, active.id)}
                    title="Open in Assistant"
                    className="rounded p-1.5 text-muted-foreground hover:bg-muted hover:text-foreground"
                  >
                    <Maximize2 className="h-4 w-4" />
                  </Link>
                )}
              </>
            )}
            {!panel && display.length > 0 && (
              <ExportMenu
                conv={active}
                meta={activeMeta}
                projectId={projectId}
                projectName={projectName}
                adapter={adapter}
              />
            )}
            <Button
              type="button"
              variant="ghost"
              size="sm"
              onClick={refresh}
              disabled={discovering}
              title="Refresh assistants"
            >
              <RotateCcw className={cn('h-4 w-4', discovering && 'animate-spin')} />
            </Button>
          </div>
        </header>

        <div className={cn('flex-1 overflow-y-auto', panel ? 'px-3 py-3' : 'px-4 py-4')}>
          <div className="mx-auto flex max-w-3xl flex-col gap-5">
            {display.length === 0 && !busy && (
              <div
                className={cn(
                  'flex flex-col items-center gap-4 text-center',
                  panel ? 'mt-4' : 'mt-10',
                )}
              >
                {!panel && (
                  <div className="flex h-12 w-12 items-center justify-center rounded-full bg-muted">
                    <Bot className="h-6 w-6 text-muted-foreground" />
                  </div>
                )}
                <div className="max-w-md text-sm text-muted-foreground">
                  {panel ? (
                    <>
                      Ask about {documentName || 'this document'}, or about the rest of the project.
                    </>
                  ) : (
                    <>
                      {adapter.intro} The assistant reads the project and answers with evidence.
                      Anything that would change data comes back as a plan for you to approve.
                    </>
                  )}
                </div>
                {/* Which assistant answers is settled here, at the start, and
                    then stays put for the rest of the conversation. */}
                {!panel && canChoose && (
                  <AssistantPicker
                    assistants={assistants}
                    value={service?.serviceId}
                    onChange={setChoice}
                    disabled={!!busy}
                  />
                )}
                {!panel && (
                  <div className="flex flex-wrap justify-center gap-2">
                    {adapter.examples.map((ex) => (
                      <button
                        key={ex}
                        type="button"
                        disabled={!canSend}
                        onClick={() => send(ex)}
                        className="rounded-full border px-3 py-1 text-xs text-muted-foreground hover:bg-muted hover:text-foreground disabled:opacity-50"
                      >
                        {ex}
                      </button>
                    ))}
                  </div>
                )}
              </div>
            )}
            {display.map((d, i) => (
              <Turn
                key={i}
                item={d}
                projectId={projectId}
                adapter={adapter}
                onFocusHere={onFocusHere}
                results={results}
                fromAnotherModel={
                  !!d.model && !!previousModel(display, i) && d.model !== previousModel(display, i)
                }
                canWrite={canWrite}
                contributor={contributor}
                busy={!!busy}
                interrupted={!!d.interrupted}
                applying={!!d.plan && applyingPlanId === d.plan.id}
                onApprove={(opts) => approve(d.plan, opts)}
                onDiscard={() => discard(i)}
              />
            ))}
            {canRetryTurn && (
              <div className="flex items-center gap-3 rounded-lg border border-dashed px-3 py-2 text-sm text-muted-foreground">
                <span className="flex-1">
                  {lastKind === 'error'
                    ? 'That turn did not finish.'
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
                    <div className="mt-1 flex h-7 w-7 shrink-0 items-center justify-center rounded-full bg-muted">
                      <Bot className="h-4 w-4 text-muted-foreground" />
                    </div>
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

        <div className={cn('border-t', panel ? 'px-3 py-2' : 'px-4 py-3')}>
          {/* The conversation's own assistant is gone. Rather than answer in a
              different voice without saying so, name the replacement, and let
              the user choose it where there is more than one. */}
          {wentOffline && service && (
            <div className="mx-auto mb-2 flex max-w-3xl flex-wrap items-center gap-2 text-xs text-muted-foreground">
              <span>
                The assistant this conversation started with is offline. Replies now come from{' '}
                <span className="font-medium text-foreground">{service.serviceName}</span>.
              </span>
              {canChoose && (
                <AssistantPicker
                  assistants={assistants}
                  value={service.serviceId}
                  onChange={setChoice}
                  disabled={!!busy}
                />
              )}
            </div>
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
          <div className="mx-auto flex max-w-3xl items-end gap-2 rounded-xl border bg-background p-2 focus-within:ring-1 focus-within:ring-ring">
            <Textarea
              ref={inputRef}
              value={input}
              onChange={(e) => setInput(e.target.value)}
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
    </div>
  );
};
