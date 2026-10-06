import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { replyLanded } from './replyLanded.js';
import { RotateCcw, Check, X, Loader2, PanelRightClose } from 'lucide-react';
import { Link } from 'react-router-dom';
import { Button } from '../ui/button.jsx';
import { cn } from '../../lib/utils.js';
import { notifyError, notifyWarning } from '../../lib/notify.js';
import { humanizeError } from '../../lib/errors.js';
import { AssistantComposer } from './AssistantComposer.jsx';
import { AssistantMarkdown } from './AssistantMarkdown.jsx';
import { hidesStopped, retryNote, rewindForRetry, stoppedIn } from './resume.js';
import { itemTime } from './itemTime.js';
import {
  atProjectCap,
  couldNotOpen,
  lastProjects,
  notServedThere,
  projectsToSend,
  servedThere,
} from './projectReach.js';
import {
  MAX_FILES,
  readAttachment,
  refOf,
  refuse,
  sweepOrphanFiles,
  uploadAttachments,
  valueBudget,
} from './attachments.js';
import { assertAdapter } from './adapterContract.js';
import { AssistantMark } from './PlaidMarks.jsx';
import { DisclosureButton, DisclosureNotice } from './AssistantDisclosure.jsx';
import { latestUsage, totalSpend } from './usage.js';
import { UsageMeter } from './UsageMeter.jsx';
import { RetryLine } from './RetryLine.jsx';
import { toolResults, turnContext } from './transcript.js';
import { Turn } from './Turn.jsx';
import { formatElapsed } from '../../hooks/useRunProgress.js';
import { useAssistantChoice } from './useAssistantChoice.js';
import { useConversationList } from './useConversationList.js';
import { useResumeConversation } from './useResumeConversation.js';
import {
  attachJob,
  buildMeta,
  changesTheView,
  jobFor,
  newConversation,
  persistConv,
  readConv,
  recordAhead,
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
// The foot of it is AssistantComposer: the box a message is typed into, the `@`
// list over it, and everything said just above it. It owns the keyboard, this
// owns the message.
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

export const AssistantChat = ({
  projectId,
  // What to call the project, on a message that reads it alone.
  projectName = null,
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
  // the URL; the panel keeps it in state. A surface that tracks neither still
  // gets called: deleting the open conversation and following a link to one
  // that is gone both clear it.
  conversationId = null,
  onConversationId = () => {},
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
  // Who is answering, named the way this surface names it. It is the one render
  // prop the header calls only where an assistant is online, so the bag's
  // `service` is never null inside it.
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
  // A send or retry reading the record before it writes: a second press in
  // that moment is the same send, not another one.
  const sendingRef = useRef(false);

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
  // How many projects the answering assistant reads at once, home included. An
  // assistant that says nothing reads one, and then the conversation reads one.
  const maxProjects = service?.extras?.maxProjects || null;
  // The operator's own statement about this assistant, when they gave one.
  const disclosure = service?.extras?.disclosure?.trim() || null;

  // --- the job in flight for the shown conversation ----------------------
  const [input, setInput] = useState('');
  // The files picked for the message being typed, each holding its own text
  // until the message is sent. Nothing of them is stored before that: a file
  // picked and then thought better of leaves nothing behind, and the parts are
  // written under the conversation the message actually joins.
  const [attachments, setAttachments] = useState([]);
  const [attaching, setAttaching] = useState(false); // reading or storing one
  // The other projects the reader added to this conversation, held with the
  // conversation they were added to. Until the reader changes them, they are
  // whatever the conversation's last message carried, so opening a thread
  // brings its projects back and a new one starts with none.
  const [reachEdit, setReachEdit] = useState({ convId: null, projects: [] });
  // Each other project's name as the project list gives it now, read when a
  // conversation that reads some is opened. A chip shows it and the next
  // message carries it, while the messages already sent keep the names they
  // were sent with. A project that is gone keeps its chip under its last name,
  // and the reply then says it could not be opened.
  const [liveNames, setLiveNames] = useState(() => new Map());
  const edited = reachEdit.convId === active?.id;
  const reach = (
    !maxProjects ? [] : edited ? reachEdit.projects : lastProjects(active?.display)
  ).map((p) => {
    const now = liveNames.get(p.id);
    return now && now !== p.name ? { ...p, name: now } : p;
  });
  const namesWanted = !!maxProjects && lastProjects(active?.display).length > 0;
  useEffect(() => {
    if (!namesWanted) return undefined;
    let alive = true;
    client.projects
      .list()
      .then((all) => {
        if (!alive) return;
        setLiveNames(
          new Map((all || []).filter((p) => p?.id && p.name).map((p) => [p.id, p.name])),
        );
      })
      .catch((e) => console.warn('[Assistant] could not read the project names', e));
    return () => {
      alive = false;
    };
  }, [client, active?.id, namesWanted]);
  const reachRef = useRef(reach);
  reachRef.current = reach;
  // The assistant answering now and how many projects it reads, for an
  // answer that arrives after the reader chose another one.
  const serviceIdRef = useRef(null);
  serviceIdRef.current = service?.serviceId ?? null;
  const serviceNameRef = useRef(null);
  serviceNameRef.current = service?.serviceName ?? null;
  const maxProjectsRef = useRef(maxProjects);
  maxProjectsRef.current = maxProjects;
  // Chips the reader added were checked against the assistant answering at
  // the time. When another one takes over in the same conversation (chosen in
  // a new thread, or standing in for one that went offline), each is checked
  // again against it, and one it does not run on is taken off and said so.
  const checkedWith = useRef({ convId: undefined, serviceId: null });
  const answeringId = service?.serviceId ?? null;
  useEffect(() => {
    const convId = active?.id;
    const was = checkedWith.current;
    if (!answeringId) return;
    checkedWith.current = { convId, serviceId: answeringId };
    if (was.convId !== convId || !was.serviceId || was.serviceId === answeringId) return;
    // Chips brought back from the record went with the conversation's own
    // assistant, and are checked by the service on every turn.
    if (!edited) return;
    const toCheck = reachRef.current;
    if (!toCheck.length) return;
    Promise.all(
      toCheck.map((p) =>
        client.messages
          .discoverServices(p.id)
          .then((found) => servedThere(found, answeringId))
          .catch(() => false),
      ),
    ).then((served) => {
      if (activeRef.current?.id !== convId || serviceIdRef.current !== answeringId) return;
      const gone = toCheck.filter((_p, k) => !served[k]);
      if (!gone.length) return;
      for (const p of gone) notifyError(notServedThere(serviceNameRef.current, p.name));
      const ids = new Set(gone.map((p) => p.id));
      setReachEdit((prev) => {
        const now =
          prev.convId === convId ? prev.projects : lastProjects(activeRef.current?.display);
        return { convId, projects: now.filter((p) => !ids.has(p.id)) };
      });
    });
    // `edited` is read as it stands when the assistant changes, not a reason
    // to check again.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [answeringId, active?.id, client]);
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
  // When the job on screen was requested, so a turn rejoined after a reload
  // shows how long it has really been going.
  const [startedAt, setStartedAt] = useState(null);
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
    const t0 = startedAt ?? Date.now();
    setElapsedMs(Math.max(0, Date.now() - t0));
    const id = setInterval(() => setElapsedMs(Math.max(0, Date.now() - t0)), 500);
    return () => clearInterval(id);
  }, [busy, startedAt]);

  // Reflect a job on screen. It does NOT clear the stop record: this runs on
  // every progress event, including the one `stopJob` fires the instant the
  // reader presses Stop, so clearing here wiped what had just been recorded.
  // A new piece of work clears it (see send and approve).
  const showJob = (j) => {
    setBusy(j.kind);
    setStartedAt(j.startedAt ?? null);
    setProgress(j.progress);
    setLiveSteps(j.steps);
    setPartial(j.partial || '');
    setStopping(!!j.stopping);
  };
  const clearJob = () => {
    setBusy(null);
    setStartedAt(null);
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
          notifyError(humanizeError(e, 'Failed to open that conversation.'));
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
      // (the document beside this panel) is now stale (see changesTheView).
      if (changesTheView(j)) onAppliedRef.current?.();
      if (activeRef.current?.id !== j.id) return;
      if (j.done) {
        activeRef.current = j.result.conv;
        setActive(j.result.conv);
        clearJob();
        // A message that could not be saved was not sent. It comes back to
        // the composer, unless the record kept it after all (then the tab
        // offers to send it again) or something new has been typed since.
        if (j.unsent && (j.declined || j.result.conv.display.at(-1)?.kind !== 'user')) {
          setInput((typed) => typed || j.unsent);
        }
        // An answer that landed late (after the page stopped waiting for it)
        // arrives while the reader may be typing somewhere else.
        if (!j.late) inputRef.current?.focus();
      } else {
        // The message went after what had landed meanwhile (`startTurn`).
        if (j.rebased && activeRef.current !== j.conv) {
          activeRef.current = j.conv;
          setActive(j.conv);
        }
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
  //
  // `fn` answers null when it has nothing to change. Made again on the record
  // as stored when another write landed first, and that copy is shown.
  const update = (fn) => {
    const next = fn(activeRef.current);
    if (!next) return;
    activeRef.current = next;
    setActive(next);
    const meta = buildMeta(
      store,
      list.rows.find((m) => m.id === next.id),
      next,
      null,
    );
    applyMeta(meta);
    persistConv(store, next, meta, {
      rebase: (fresh) => {
        const c = fn(fresh.conv);
        return c && { conv: c, meta: buildMeta(store, fresh.meta, c, null) };
      },
    }).then((written) => {
      const shown = written?.declined ? written.fresh : written;
      if (!shown || activeRef.current !== next || shown.conv === next) return;
      activeRef.current = shown.conv;
      setActive(shown.conv);
      if (shown.meta) applyMeta(shown.meta);
    });
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

  const canSend = !!service && !busy && !attaching;

  // `files` is given on a RETRY, where the message is sent again with the
  // references its first attempt carried: those parts are already stored, so
  // nothing is written for them a second time. A retry sends the OLD message,
  // so the composer (text, files, chip) is the reader's next one and is left
  // as it is.
  const send = async (textOverride, files = null, projects = null) => {
    const retry = files !== null;
    const typed = (textOverride ?? input).trim();
    if (!typed || !canSend || sendingRef.current) return;
    sendingRef.current = true;
    try {
      await sendNow(typed, retry, files, projects);
    } finally {
      sendingRef.current = false;
    }
  };
  const sendNow = async (typed, retry, files, projects) => {
    setStopped(null);
    // The chip is the reference the question is about, said the way the
    // assistant addresses one. A question that already names it is left alone.
    const text = !retry && focus && !typed.includes(focus.ref) ? `${focus.ref}: ${typed}` : typed;
    // Sending is what turns a draft into a saved conversation, so the flag
    // does not travel with it.
    let base = activeRef.current ?? newConversation();
    // The record may hold an answer this page never saw (it gave up waiting,
    // and the service wrote it later). The message goes after it, rather than
    // writing the page's older copy over it. A retry has read it already.
    if (!retry) {
      const ahead = await recordAhead(
        store,
        base,
        list.rows.find((m) => m.id === base.id),
      );
      if (activeRef.current?.id !== base.id) return;
      if (ahead) {
        base = ahead.conv;
        activeRef.current = ahead.conv;
        setActive(ahead.conv);
        applyMeta(ahead.meta);
        // A turn is under way there (asked in another tab): it is followed
        // here, and the message waits in the composer.
        if (ahead.meta?.pending?.requestId) {
          if (!jobFor(base.id)) {
            attachJob({ store, conv: base, meta: ahead.meta, docked: !toastOnApply });
          }
          return;
        }
      }
    }
    const pending = retry ? [] : attachments;
    if (pending.length) {
      // The files before anything else: a file that cannot be stored stops the
      // send, and the composer is left exactly as it was, with the file still
      // on it, so pressing Enter again is the whole of the retry.
      setAttaching(true);
      try {
        await uploadAttachments(store, base.id, pending);
      } catch (e) {
        notifyError(humanizeError(e, 'Failed to attach the file. Nothing was sent.'));
        return;
      } finally {
        setAttaching(false);
      }
      // The reader moved to another conversation while the file was being
      // stored. Its parts are under the conversation they were meant for, and
      // sending this message into a different thread would point it at them.
      if (activeRef.current?.id !== base.id) return;
    }
    if (!retry) {
      setInput('');
      setAttachments([]);
      onClearFocus?.();
    }
    // The display item carries the place as data, for the chip on the message.
    // The model's copy is stamped by the service, which owns every word the
    // model reads, and only when the place has changed since the last turn.
    const sent = files || pending.map(refOf);
    // The other projects this message reads. The service reads them off the
    // last user message and nowhere else, so a retry carries its own again.
    const joined = retry ? projects || [] : projectsToSend(reach, projectId);
    const conv = {
      id: base.id,
      // The versions of the record the message is written over.
      rev: base.rev,
      messages: [...base.messages, { role: 'user', content: text }],
      display: [
        ...base.display,
        {
          kind: 'user',
          text,
          createdAt: itemTime(),
          // Sent again with Retry, below the attempt that did not finish.
          ...(retry ? { retry: true } : {}),
          ...(where ? { where } : {}),
          ...(sent.length ? { files: sent } : {}),
          ...(joined.length ? { projects: joined } : {}),
        },
      ],
    };
    const prevMeta = list.rows.find((m) => m.id === conv.id);
    openSeq.current++; // sending settles which conversation is open
    activeRef.current = conv;
    setActive(conv);
    if (convIdRef.current !== conv.id) setConvId(conv.id, { replace: true });
    applyMeta(buildMeta(store, prevMeta, conv, service));
    showJob(startTurn({ store, service, conv, prevMeta, where }));
  };

  // Files picked, dropped or pasted. They are READ here and stored nowhere:
  // the text is held with the message being typed until it is sent, so a file
  // added and then removed leaves nothing behind anywhere.
  const addFiles = async (picked) => {
    const chosen = Array.from(picked || []);
    if (!chosen.length) return;
    setAttaching(true);
    try {
      const budget = await valueBudget(client);
      const read = [];
      for (const file of chosen) {
        if (attachments.length + read.length >= MAX_FILES) {
          notifyWarning(`A message carries at most ${MAX_FILES} files. ${file.name} was left out.`);
          break;
        }
        const no = refuse(file);
        if (no) {
          notifyError(no);
          continue;
        }
        // One at a time, in the order they were picked: the note the service
        // writes lists them in this order too. A file that cannot be read is
        // said so by name and the rest are still attached.
        try {
          read.push(await readAttachment(file, budget));
        } catch (e) {
          notifyError(humanizeError(e, `Failed to read ${file.name}.`));
        }
      }
      if (read.length) setAttachments((prev) => [...prev, ...read]);
    } catch (e) {
      notifyError(humanizeError(e, 'Failed to read that file.'));
    } finally {
      setAttaching(false);
    }
  };

  // A chip's remove button goes with the chip, so the caret goes back to the
  // message box rather than falling to the page.
  const removeAttachment = (id) => {
    setAttachments((prev) => prev.filter((a) => a.id !== id));
    inputRef.current?.focus();
  };

  // A project joins only where the assistant answering this conversation runs
  // too. That is asked here, before the chip appears: a read, and no write, so
  // there is nothing to show before the answer. Answers true when it joined,
  // and otherwise the line that says why not, which the list shows.
  const addProject = async (p) => {
    const at = activeRef.current?.id;
    let found;
    try {
      found = await client.messages.discoverServices(p.id);
    } catch {
      return couldNotOpen([p]);
    }
    // Asked of the assistant answering NOW: the reader may have chosen
    // another one while this was being looked up.
    if (!servedThere(found, serviceIdRef.current)) {
      return notServedThere(serviceNameRef.current, p.name);
    }
    // The reader moved to another conversation while this was asked.
    if (activeRef.current?.id !== at) return false;
    setReachEdit((prev) => {
      const now = prev.convId === at ? prev.projects : lastProjects(activeRef.current?.display);
      if (now.some((q) => q.id === p.id) || atProjectCap(now, maxProjectsRef.current)) return prev;
      return { convId: at, projects: [...now, { id: p.id, name: p.name }] };
    });
    return true;
  };

  const removeProject = (id) => {
    setReachEdit({ convId: active?.id, projects: reach.filter((p) => p.id !== id) });
    inputRef.current?.focus();
  };

  // Files left behind by a send that stored them and then could not write the
  // record, which is the only way one is made. Once per project, and only once
  // the list has really been READ: a failed listing looks exactly like a user
  // with no conversations, and this would take that for "none of these are
  // live" and delete every file it found.
  useEffect(() => {
    if (!list.loaded || !userId) return;
    const live = list.rows.filter((m) => m.projectId === projectId).map((m) => m.id);
    sweepOrphanFiles(store, live).catch((e) => {
      console.warn('[Assistant] could not sweep abandoned attachments', e);
    });
  }, [list.loaded, list.rows, store, userId, projectId]);

  // Send the user's last message again, whether the turn was lost (its
  // request went away with the server or the service), failed or was stopped.
  // The attempt stays in the conversation above the message sent again.
  //
  // The record is read first. An answer the service wrote after this page
  // stopped waiting for it (a server restart lost the request, not the turn)
  // is shown instead of asking again, and is never written over.
  const retryTurn = async () => {
    let conv = activeRef.current;
    if (!conv || !canSend || sendingRef.current) return;
    sendingRef.current = true;
    let ahead;
    try {
      ahead = await recordAhead(
        store,
        conv,
        list.rows.find((m) => m.id === conv.id),
      );
    } finally {
      sendingRef.current = false;
    }
    if (activeRef.current?.id !== conv.id) return;
    if (ahead) {
      conv = ahead.conv;
      activeRef.current = conv;
      setActive(conv);
      applyMeta(ahead.meta);
      if (ahead.meta?.pending?.requestId) {
        if (!jobFor(conv.id)) {
          attachJob({ store, conv, meta: ahead.meta, docked: !toastOnApply });
        }
        return;
      }
      const last = conv.display.at(-1)?.kind;
      if (last !== 'user' && last !== 'error') return;
    }
    const rewound = rewindForRetry(conv, {
      stopped: !ahead && !!stoppedIn(stopped, conv.id),
    });
    if (!rewound) return;
    activeRef.current = rewound.conv;
    send(rewound.text, rewound.files, rewound.projects);
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
        docked: !toastOnApply,
      }),
    );
  };

  // Found by its plan's id, on whichever copy the write is made (the record
  // as stored, when another write landed first). An undecided plan is settled
  // as discarded. An out-of-date one keeps that verdict (the record of an
  // approval that was refused) and is marked dismissed. A plan decided
  // meanwhile is left as it is.
  const discard = (index) => {
    const planId = activeRef.current?.display[index]?.plan?.id;
    update((c) => {
      const i = c.display.findIndex((d) => d.plan?.id === planId);
      const d = c.display[i];
      if (!d) return null;
      if (d.status === 'stale') {
        if (d.dismissed) return null;
        const display = [...c.display];
        display[i] = { ...d, dismissed: true, dismissedAt: itemTime() };
        return { ...c, display };
      }
      if (d.status != null) return null;
      return settle(c, i, 'discarded', '(note) The user discarded the plan; nothing was changed.');
    });
  };

  const display = active?.display || [];
  // A reply that lands is said once to a screen reader, from a region that is
  // always there. Opening a conversation says nothing: only a turn this panel
  // was waiting on.
  const [landed, setLanded] = useState('');
  const turnSeen = useRef({ busy: null, id: null, length: 0 });
  useEffect(() => {
    const id = active?.id ?? null;
    const items = active?.display || [];
    if (busy) setLanded('');
    else if (replyLanded(turnSeen.current, { busy, id, display: items })) setLanded('Reply ready');
    turnSeen.current = { busy, id, length: items.length };
  }, [busy, active?.id, active?.display]);
  // A step's output, looked up by the tool call it belongs to.
  const results = useMemo(() => toolResults(active?.messages), [active?.messages]);
  // A list of conversations puts an unsent one at the top, so a new
  // conversation is a real place to be rather than a blank screen. It belongs
  // to the project on screen, like every other row: nothing in a list of
  // conversations is from nowhere.
  const rows = active?.draft
    ? [{ id: active.id, projectId, title: 'New conversation', draft: true }, ...list.rows]
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
    hrefFor: (m) => adapter.convHref(m.projectId, m.id),
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
    // The assistant answering, which is null until one is online. renderIdentity
    // is the one place it is a service for certain, because the header calls it
    // in the branch where there is one.
    service,
    busy: !!busy,
    canSend,
    send,
  };

  return (
    <>
      {renderSidebar?.(chrome)}
      <section
        className={cn(
          'flex min-h-0 min-w-0 flex-1 flex-col bg-card',
          !compact && 'rounded-lg border',
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
            <span className="text-muted-foreground">
              No assistant is online for this project. An operator can start one with{' '}
              <code className="rounded bg-muted px-1">{adapter.command} --model …</code>.
            </span>
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
            <DisclosureButton text={disclosure} />
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
            {display.length === 0 && !busy && <DisclosureNotice text={disclosure} />}
            {display.length === 0 && !busy && renderEmpty?.(chrome)}
            {display.map((d, i) =>
              canRetryTurn && hidesStopped(display, i) ? null : (
                <Turn
                  key={i}
                  item={d}
                  projectId={projectId}
                  adapter={adapter}
                  onFocusHere={subject?.onFocusHere}
                  results={results}
                  {...turnContext(display, i)}
                  homeName={projectName}
                  canWrite={canWrite}
                  contributor={contributor}
                  busy={!!busy}
                  interrupted={!!d.interrupted}
                  applying={!!d.plan && applyingPlanId === d.plan.id}
                  onApprove={(opts) => approve(d.plan, opts)}
                  onDiscard={() => discard(i)}
                  onOpenPlan={() =>
                    client.events?.record?.('plan.opened', {
                      projectId,
                      targetId: d.plan.id,
                      data: { conversation: active?.id ?? null },
                    })
                  }
                />
              ),
            )}
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
              <RetryLine
                note={retryNote(display, stoppedHere)}
                onRetry={retryTurn}
                disabled={!canSend}
              />
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
                  <span role="status" className="animate-pulse">
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
            <span role="status" className="sr-only">
              {landed}
            </span>
          </div>
        </div>

        <AssistantComposer
          client={client}
          projectId={projectId}
          choice={choice}
          text={input}
          setText={setInput}
          inputRef={inputRef}
          canSend={canSend}
          pendingPlan={pendingPlan}
          usage={usage}
          focus={focus}
          onClearFocus={onClearFocus}
          mentionOffer={subject?.mentions}
          attachments={attachments}
          onAttach={addFiles}
          onRemoveAttachment={removeAttachment}
          attaching={attaching}
          projects={reach}
          maxProjects={maxProjects}
          onAddProject={addProject}
          onRemoveProject={removeProject}
          onSend={send}
          compact={compact}
        />
      </section>
    </>
  );
};
