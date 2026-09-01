import {
  Fragment,
  useCallback,
  useEffect,
  useLayoutEffect,
  useMemo,
  useRef,
  useState,
} from 'react';
import {
  Bot,
  Send,
  RotateCcw,
  Check,
  X,
  Loader2,
  Plus,
  Trash2,
  MessageSquare,
  ChevronDown,
  ChevronRight,
  Wrench,
  Download,
  Copy,
  FileDown,
  ExternalLink,
} from 'lucide-react';
import { TASKS, filterServicesByTask } from '@larc-iu/plaid-client';
import { Button } from '@/components/ui/button';
import { Textarea } from '@/components/ui/textarea';
import { Badge } from '@/components/ui/badge';
import {
  Select,
  SelectTrigger,
  SelectValue,
  SelectContent,
  SelectItem,
} from '@/components/ui/select';
import {
  DropdownMenu,
  DropdownMenuTrigger,
  DropdownMenuContent,
  DropdownMenuItem,
} from '@/components/ui/dropdown-menu';
import { cn } from '@/lib/utils';
import { notifySuccess, notifyError, humanizeError } from '@/utils/feedback';
import { SafeMarkdown } from '@/components/ui/markdown';
import { conversationToMarkdown, markdownFilename } from './exportMarkdown.js';
import {
  centeredScrollLeft,
  citationHighlights,
  citationRows,
  citationTitle,
  linkifyCitations,
  sentenceHref,
} from './citations.js';
import { applyingIndex, rewindForRetry, unansweredTurn } from './resume.js';
import { pruneConversation } from './prune.js';

// The Assistant tab: a chat with whatever `assist` service(s) the operator
// runs (see ../../../../../plaid-igt-agent), laid out like any chat app: past
// conversations on the left, the active one on the right.
//
// The browser owns the conversation. It keeps the model-facing transcript
// (`messages`, including the assistant's tool calls and their results, so a
// later turn can build on an earlier one) and sends the whole thing with
// every turn, so the service is stateless. Conversations are private to the
// user and follow them across devices: they live in the user's key/value
// store (client.userData) under `igt:assistant:<project>:...`, one small
// `meta` entry per conversation for the sidebar and one `conv` entry with
// the transcript, loaded on open.
//
// The assistant never writes during a turn; a turn that would change data
// comes back with a plan, shown as a list of concrete changes with Approve /
// Discard. Approving sends the plan back for the service to apply under the
// user's own account (the service delegates, so Plaid mints the user a
// short-lived token per request).

const TURN_TIMEOUT_MS = 30 * 60 * 1000;
const TITLE_MAX = 60;

const metaKey = (projectId, id) => `igt:assistant:${projectId}:meta:${id}`;
const convKey = (projectId, id) => `igt:assistant:${projectId}:conv:${id}`;
const metaPrefix = (projectId) => `igt:assistant:${projectId}:meta:`;

const newId = () =>
  typeof crypto !== 'undefined' && crypto.randomUUID
    ? crypto.randomUUID()
    : `${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 10)}`;

const titleFrom = (text) => {
  const t = text.replace(/\s+/g, ' ').trim();
  return t.length > TITLE_MAX ? `${t.slice(0, TITLE_MAX - 1)}…` : t;
};

const timeAgo = (iso) => {
  const t = Date.parse(iso);
  if (!t) return '';
  const s = Math.max(0, (Date.now() - t) / 1000);
  if (s < 60) return 'just now';
  if (s < 3600) return `${Math.floor(s / 60)}m ago`;
  if (s < 86400) return `${Math.floor(s / 3600)}h ago`;
  if (s < 7 * 86400) return `${Math.floor(s / 86400)}d ago`;
  return new Date(t).toLocaleDateString();
};

// --- work that outlives the component ------------------------------------------
// A turn, and applying an approved plan, can each take minutes, and meanwhile
// the user may switch tabs (which unmounts this component) or a dev reload may
// remount it. So both run here, at module level, persist their own outcome,
// and the component only subscribes to whatever is in flight for the
// conversation it shows. A job is {id, projectId, kind: 'turn' | 'apply',
// conv, progress, steps, done, result}.
const serviceCache = new Map(); // project id -> services, so a remount need not blank the picker
const saveQueues = new Map(); // conversation id -> Promise (writes in order)
const turns = new Map(); // conversation id -> turn in flight
const applies = new Map(); // conversation id -> plan application in flight
const jobListeners = new Set(); // mounted components

// At most one job runs per conversation: the composer and the plan's buttons
// are both disabled while one is in flight. A job stays in its registry until
// its final write lands, so a conversation reopened in that window serves the
// finished copy rather than a stale read, and deleting it cannot race the
// write.
const allJobs = () => [...turns.values(), ...applies.values()];
const jobFor = (id) => (id ? turns.get(id) || applies.get(id) || null : null);
const jobInProject = (projectId) => allJobs().find((j) => j.projectId === projectId) || null;
const convOf = (j) => (j.done ? j.result.conv : j.conv);

// A service dispatches requests inline on its single event-stream reader, so
// it handles exactly one at a time: a second request would sit unread until
// the first returned, with no progress in the meantime. Better to say so than
// to spin. Another online assistant is still free to take a turn.
const serviceBusy = (projectId, serviceId) =>
  allJobs().some((j) => j.projectId === projectId && j.serviceId === serviceId && !j.done);

const upsert = (meta) => (prev) => [meta, ...prev.filter((m) => m.id !== meta.id)];

const buildMeta = (prev, conv, service) => {
  const firstUser = conv.display.find((d) => d.kind === 'user');
  return {
    id: conv.id,
    title: prev?.title || (firstUser ? titleFrom(firstUser.text) : 'New conversation'),
    createdAt: prev?.createdAt || new Date().toISOString(),
    updatedAt: new Date().toISOString(),
    serviceId: service?.serviceId || prev?.serviceId || null,
    model: service?.extras?.model || prev?.model || null,
    turns: conv.display.filter((d) => d.kind === 'user').length,
    // Work was under way at the last write. With no job in flight for the
    // conversation this means it was interrupted, which the sidebar shows
    // without having to load every transcript.
    pending: unansweredTurn(conv) || applyingIndex(conv) >= 0,
  };
};

// Write a conversation (transcript + sidebar entry). Writes for one
// conversation run one after another so a slow earlier PUT cannot land on
// top of a newer one.
const persistConv = (client, userId, projectId, conv, meta) => {
  if (!userId) return Promise.resolve();
  const prev = saveQueues.get(conv.id) || Promise.resolve();
  const next = prev
    .then(async () => {
      await client.userData.put(userId, convKey(projectId, conv.id), {
        messages: conv.messages,
        display: conv.display,
      });
      await client.userData.put(userId, metaKey(projectId, conv.id), meta);
    })
    .catch((e) => {
      console.error('[Assistant] could not save the conversation', e);
      notifyError(humanizeError(e, 'The conversation could not be saved.'));
    })
    .finally(() => {
      // Nothing queued behind this one: stop holding the chain.
      if (saveQueues.get(conv.id) === next) saveQueues.delete(conv.id);
    });
  saveQueues.set(conv.id, next);
  return next;
};

const notifyJob = (j) => jobListeners.forEach((fn) => fn(j));

// A plan's outcome: the status shown on its card, plus a note in the model
// transcript (user role) so the next turn knows whether its proposal happened.
const settle = (conv, index, status, note) => ({
  ...conv,
  messages: note ? [...conv.messages, { role: 'user', content: note }] : conv.messages,
  display: conv.display.map((d, i) => (i === index ? { ...d, status } : d)),
});

// Run one turn for `conv`, whose last message is the user's. The outcome
// (the assistant's reply, or an error item) is persisted here, then handed to
// whichever component is mounted.
const startTurn = ({ client, userId, projectId, service, conv, prevMeta }) => {
  const t = {
    id: conv.id,
    projectId,
    serviceId: service.serviceId,
    kind: 'turn',
    // Lives on the job so Stop still works after a remount.
    controller: new AbortController(),
    conv,
    progress: 'Thinking…',
    steps: [],
    done: false,
    result: null,
  };
  turns.set(conv.id, t);
  t.promise = (async () => {
    let next;
    try {
      const result = await client.messages.requestService(
        projectId,
        service.serviceId,
        { projectId, messages: conv.messages },
        TURN_TIMEOUT_MS,
        (p) => {
          const msg = p?.message || '';
          t.progress = msg;
          if (
            msg &&
            !/^(Thinking|Done|Planning)/.test(msg) &&
            t.steps[t.steps.length - 1] !== msg
          ) {
            t.steps = [...t.steps, msg];
          }
          notifyJob(t);
        },
        t.controller.signal,
      );
      if (result?.kind !== 'turn') throw new Error('Unexpected reply from the assistant service');
      next = {
        ...conv,
        messages: [...conv.messages, ...(result.messages || [])],
        display: [
          ...conv.display,
          {
            kind: 'assistant',
            text: result.message || '',
            plan: result.plan || null,
            citations: result.citations || [],
            status: null,
            model: service?.extras?.model || null,
            // What the assistant did, described by the service (see
            // plaid-igt-agent/src/plaid_igt_agent/trace.py). Each step names
            // the tool call it belongs to, so its output is read back out of
            // the transcript rather than stored a second time.
            steps: result.steps || [],
            stepsSummary: result.stepsSummary || '',
          },
        ],
      };
      next = pruneConversation(next);
    } catch (e) {
      // A stop is the user's own doing, so it reads as a note rather than a
      // failure, but it settles the turn the same way.
      const stopped = e?.name === 'AbortError';
      if (!stopped) console.error('[Assistant] turn failed', e);
      next = {
        ...conv,
        // Drop the unanswered user turn from the model transcript so a retry
        // does not send it twice; keep it visible with what happened.
        messages: conv.messages.slice(0, -1),
        display: [
          ...conv.display,
          stopped
            ? { kind: 'error', stopped: true, text: 'Stopped.' }
            : { kind: 'error', text: humanizeError(e, 'The assistant could not answer.') },
        ],
      };
    }
    const meta = buildMeta(prevMeta, next, service);
    t.done = true;
    t.result = { conv: next, meta };
    notifyJob(t);
    await persistConv(client, userId, projectId, next, meta);
    turns.delete(conv.id);
    notifyJob(t);
    return t.result;
  })();
  return t;
};

// Apply the plan at `index` in `conv`. What a plan writes is recorded as
// verified (made by the assistant, confirmed by the approver) unless the user
// asks for it to count as human-made. The plan id lets the service refuse a
// second application of the same plan (a retried request, a double click), so
// a failure leaves the plan undecided and approving again is safe.
const startApply = ({
  client,
  userId,
  projectId,
  service,
  conv,
  prevMeta,
  index,
  plan,
  asHuman,
}) => {
  const j = {
    id: conv.id,
    projectId,
    serviceId: service.serviceId,
    kind: 'apply',
    conv,
    progress: 'Applying changes…',
    steps: [],
    done: false,
    result: null,
  };
  applies.set(conv.id, j);
  // Record the attempt before making it, so a reload mid-apply is
  // recognisable afterwards and offers a retry, instead of looking like a plan
  // the user never approved. `asHuman` rides along so a retry stamps
  // provenance the way the approver chose.
  const started = {
    ...conv,
    display: conv.display.map((d, i) => (i === index ? { ...d, status: 'applying', asHuman } : d)),
  };
  j.conv = started;
  persistConv(client, userId, projectId, started, buildMeta(prevMeta, started, service));
  j.promise = (async () => {
    let next;
    try {
      const res = await client.messages.requestService(
        projectId,
        service.serviceId,
        {
          projectId,
          approve: {
            id: plan.id,
            ops: plan.ops,
            label: `Assistant: ${plan.summary}`,
            asHuman,
            // Versions the plan was made against; the service refuses a plan
            // whose documents changed since (its offsets and ids may not fit).
            documents: plan.documents || [],
          },
        },
        TURN_TIMEOUT_MS,
        (p) => {
          j.progress = p?.message || '';
          notifyJob(j);
        },
      );
      const data = res?.data || res || {};
      next = settle(
        started,
        index,
        'applied',
        `(note) The plan was approved and applied: ${plan.summary}.` +
          (data.message && /;/.test(data.message) ? ` ${data.message}` : ''),
      );
      notifySuccess(data.message || `Applied ${plan.summary}.`, 'Changes applied');
    } catch (e) {
      console.error('[Assistant] apply failed', e);
      next = settle(started, index, null, null);
      notifyError(
        humanizeError(e, 'The changes could not be applied.') +
          ' Approving again is safe: a plan that was already applied is not written twice.',
        'Not applied',
      );
    }
    const meta = buildMeta(prevMeta, next, service);
    j.done = true;
    j.result = { conv: next, meta };
    notifyJob(j);
    await persistConv(client, userId, projectId, next, meta);
    applies.delete(conv.id);
    notifyJob(j);
    return j.result;
  })();
  return j;
};

// A conversation that has not been sent yet. It gets its id up front so it can
// sit in the sidebar like any other, and turns into a saved one the moment the
// first message goes out.
const newConversation = () => ({ id: newId(), messages: [], display: [], draft: true });

// The model that wrote the reply before this one. A conversation keeps the
// assistant it started with, but that one can go offline and another answer
// in its place, and then the transcript should say where each reply came from.
const previousModel = (display, i) => {
  for (let k = i - 1; k >= 0; k--) {
    if (display[k].kind === 'assistant') return display[k].model || null;
  }
  return null;
};

const EXAMPLES = [
  'Which words in this project are still unglossed?',
  'Are the glosses for the most common suffix consistent?',
  'Summarize the noun morphology you can see in the corpus.',
];

export const ProjectAssistant = ({ projectId, projectName, client, userId, canWrite }) => {
  // --- services ---------------------------------------------------------
  const [services, setServices] = useState([]);
  const [discovering, setDiscovering] = useState(true);
  const [choice, setChoice] = useState(null);

  // --- conversations ----------------------------------------------------
  const [convs, setConvs] = useState([]); // sidebar metas, newest first
  const [loadingList, setLoadingList] = useState(true);
  const [active, setActive] = useState(null); // {id, messages, display, draft?}
  const [opening, setOpening] = useState(null); // id being fetched

  // --- the turn in flight ------------------------------------------------
  const [input, setInput] = useState('');
  const [busy, setBusy] = useState(null); // null | 'turn' | 'apply'
  const [progress, setProgress] = useState('');
  const [liveSteps, setLiveSteps] = useState([]); // progress messages so far this turn
  const bottomRef = useRef(null);
  const inputRef = useRef(null);
  const openSeq = useRef(0); // the latest open() request, so a stale read is ignored
  const activeRef = useRef(active);
  activeRef.current = active;
  const convsRef = useRef(convs);
  convsRef.current = convs;

  // Only ONLINE assist services can take a turn.
  const assistants = useMemo(
    () => filterServicesByTask(services, TASKS.ASSIST).filter((s) => s.online !== false),
    [services],
  );
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
    if (!userId) return [];
    setLoadingList(true);
    try {
      const entries = await client.userData.list(userId, {
        prefix: metaPrefix(projectId),
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
  }, [client, userId, projectId]);

  // On mount: work still running for this project (we were unmounted mid-turn
  // or mid-apply) is shown first; otherwise the most recent conversation, the
  // way a chat app reopens where you left off, and a fresh one when there is
  // nothing to reopen. "+" starts a fresh one at any time.
  useEffect(() => {
    let cancelled = false;
    const seq = openSeq.current;
    const inFlight = jobInProject(projectId);
    setActive(inFlight ? convOf(inFlight) : newConversation());
    loadList().then(async (metas) => {
      if (cancelled || inFlight || !metas.length) return;
      try {
        const entry = await client.userData.get(userId, convKey(projectId, metas[0].id));
        const v = entry?.value || {};
        // A conversation the user opened, or a "+" they pressed, meanwhile
        // wins over reopening the last one.
        if (!cancelled && seq === openSeq.current) {
          setActive({ id: metas[0].id, messages: v.messages || [], display: v.display || [] });
        }
      } catch {
        /* the fresh conversation is fine */
      }
    });
    return () => {
      cancelled = true;
    };
  }, [loadList, projectId, client, userId]);

  // Reflect jobs as they progress and finish, for whichever conversation is
  // shown; a finished job always refreshes the sidebar entry.
  useEffect(() => {
    const onJob = (j) => {
      if (j.done) setConvs(upsert(j.result.meta));
      if (activeRef.current?.id !== j.id) return;
      if (j.done) {
        activeRef.current = j.result.conv;
        setActive(j.result.conv);
        setBusy(null);
        setProgress('');
        setLiveSteps([]);
        inputRef.current?.focus();
      } else {
        setBusy(j.kind);
        setProgress(j.progress);
        setLiveSteps(j.steps);
      }
    };
    jobListeners.add(onJob);
    return () => jobListeners.delete(onJob);
  }, []);

  // Switching conversations: pick up a job in flight for the new one.
  useEffect(() => {
    const j = jobFor(active?.id);
    if (j && !j.done) {
      setBusy(j.kind);
      setProgress(j.progress);
      setLiveSteps(j.steps);
    } else if (busy) {
      setBusy(null);
      setProgress('');
      setLiveSteps([]);
    }
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
      persistConv(client, userId, projectId, next, meta);
    },
    [client, userId, projectId],
  );

  const open = async (id) => {
    if (active?.id === id) return;
    const seq = ++openSeq.current;
    const j = jobFor(id);
    if (j) {
      setActive(convOf(j));
      return;
    }
    setOpening(id);
    try {
      const entry = await client.userData.get(userId, convKey(projectId, id));
      // A later click (or "+") won the race: its choice stands.
      if (seq !== openSeq.current) return;
      const v = entry?.value || {};
      setActive({ id, messages: v.messages || [], display: v.display || [] });
    } catch (e) {
      if (seq === openSeq.current) {
        notifyError(humanizeError(e, 'That conversation could not be opened.'));
      }
    } finally {
      if (seq === openSeq.current) setOpening(null);
    }
  };

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
        client.userData.delete(userId, convKey(projectId, id)),
        client.userData.delete(userId, metaKey(projectId, id)),
      ]);
      setConvs((prev) => prev.filter((m) => m.id !== id));
      if (activeRef.current?.id === id) setActive(newConversation());
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
    inputRef.current?.focus();
  };

  // --- turns -----------------------------------------------------------------
  useEffect(() => {
    bottomRef.current?.scrollIntoView({ block: 'end' });
  }, [active?.display.length, busy, progress]);

  // The chosen assistant takes one request at a time, so a job on another
  // conversation blocks the composer just as this conversation's own does.
  const occupied = !!service && serviceBusy(projectId, service.serviceId);
  const blockedByOther = occupied && !busy;
  const canSend = !!service && !busy && !occupied;

  const send = (textOverride) => {
    const text = (textOverride ?? input).trim();
    if (!text || !canSend) return;
    setInput('');
    // Sending is what turns a draft into a saved conversation, so the flag
    // does not travel with it.
    const base = activeRef.current ?? newConversation();
    const conv = {
      id: base.id,
      messages: [...base.messages, { role: 'user', content: text }],
      display: [...base.display, { kind: 'user', text }],
    };
    const meta = buildMeta(
      convsRef.current.find((m) => m.id === conv.id),
      conv,
      service,
    );
    openSeq.current++; // sending settles which conversation is open
    activeRef.current = conv;
    setActive(conv);
    setConvs(upsert(meta));
    persistConv(client, userId, projectId, conv, meta);
    setBusy('turn');
    setProgress('Thinking…');
    setLiveSteps([]);
    startTurn({ client, userId, projectId, service, conv, prevMeta: meta });
  };

  // Send the user's last message again, whether the turn was interrupted (the
  // page went away mid-turn) or failed. Both rewind the same way, to just
  // before the user's item.
  const retryTurn = () => {
    const conv = activeRef.current;
    if (!conv || !canSend) return;
    const rewound = rewindForRetry(conv);
    if (!rewound) return;
    activeRef.current = rewound.conv;
    send(rewound.text);
  };

  // Stop waiting on a turn. The service keeps working and its reply is
  // discarded, which is safe because a turn never writes. Only turns can be
  // stopped: an apply's writes are already under way, and abandoning one would
  // hide what landed.
  const stopTurn = () => turns.get(activeRef.current?.id)?.controller?.abort();

  const approve = (index, plan, { asHuman = false } = {}) => {
    const conv = activeRef.current;
    if (!conv || !canSend) return;
    setBusy('apply');
    setProgress('Applying changes…');
    setLiveSteps([]);
    startApply({
      client,
      userId,
      projectId,
      service,
      conv,
      prevMeta: convsRef.current.find((m) => m.id === conv.id),
      index,
      plan,
      asHuman,
    });
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
  // it was interrupted rather than in progress.
  const idle = !busy && !jobFor(active?.id);
  const lastKind = display.at(-1)?.kind;
  const canRetryTurn = idle && (lastKind === 'user' || lastKind === 'error');
  const stuckApply = idle ? applyingIndex(active) : -1;

  return (
    <div className="tw flex h-[calc(100vh-15rem)] min-h-[32rem] gap-4">
      {/* --- sidebar --------------------------------------------------- */}
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
                <button
                  type="button"
                  onClick={() => open(m.id)}
                  disabled={m.draft}
                  className="min-w-0 flex-1 text-left"
                >
                  <div className="flex items-center gap-1.5">
                    <MessageSquare className="h-3.5 w-3.5 shrink-0 text-muted-foreground" />
                    <span className={cn('truncate', m.draft && 'italic')}>
                      {m.title || 'Untitled'}
                    </span>
                  </div>
                  <div className="pl-5 text-[11px] text-muted-foreground">
                    {m.draft
                      ? 'Nothing sent yet'
                      : (opening === m.id ? 'Opening…' : timeAgo(m.updatedAt)) +
                        (m.model ? ` · ${m.model.split('/').pop()}` : '') +
                        (m.pending && !jobFor(m.id) ? ' · unfinished' : '')}
                  </div>
                </button>
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

      {/* --- chat --------------------------------------------------------- */}
      <section className="flex min-w-0 flex-1 flex-col rounded-lg border bg-card">
        <header className="flex flex-wrap items-center gap-2 border-b px-3 py-2 text-sm">
          <Bot className="h-4 w-4 text-muted-foreground" />
          {discovering && !services.length ? (
            <span className="text-muted-foreground">Looking for an assistant…</span>
          ) : !service ? (
            <span className="text-muted-foreground">
              No assistant is online for this project. An operator can start one with{' '}
              <code className="rounded bg-muted px-1">plaid-igt-agent --model …</code>.
            </span>
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
            {display.length > 0 && (
              <ExportMenu
                conv={active}
                meta={activeMeta}
                projectId={projectId}
                projectName={projectName}
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

        <div className="flex-1 overflow-y-auto px-4 py-4">
          <div className="mx-auto flex max-w-3xl flex-col gap-5">
            {display.length === 0 && !busy && (
              <div className="mt-10 flex flex-col items-center gap-4 text-center">
                <div className="flex h-12 w-12 items-center justify-center rounded-full bg-muted">
                  <Bot className="h-6 w-6 text-muted-foreground" />
                </div>
                <div className="max-w-md text-sm text-muted-foreground">
                  Ask about the corpus or the lexicon, or ask for changes. The assistant reads the
                  project and answers with evidence. Anything that would change data comes back as a
                  plan for you to approve.
                </div>
                {/* Which assistant answers is settled here, at the start, and
                    then stays put for the rest of the conversation. */}
                {canChoose && (
                  <AssistantPicker
                    assistants={assistants}
                    value={service?.serviceId}
                    onChange={setChoice}
                    disabled={!!busy}
                  />
                )}
                <div className="flex flex-wrap justify-center gap-2">
                  {EXAMPLES.map((ex) => (
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
              </div>
            )}
            {display.map((d, i) => (
              <Turn
                key={i}
                item={d}
                projectId={projectId}
                results={results}
                fromAnotherModel={
                  !!d.model && !!previousModel(display, i) && d.model !== previousModel(display, i)
                }
                canWrite={canWrite}
                busy={!!busy || blockedByOther}
                interrupted={i === stuckApply}
                onApprove={(opts) => approve(i, d.plan, opts)}
                onDiscard={() => discard(i)}
              />
            ))}
            {canRetryTurn && (
              <div className="flex items-center gap-3 rounded-lg border border-dashed px-3 py-2 text-sm text-muted-foreground">
                <span className="flex-1">
                  {lastKind === 'error'
                    ? 'That turn did not finish.'
                    : 'No answer came back for this message. The page was probably closed or reloaded while the assistant was working.'}
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
            {busy && (
              <div className="flex flex-col gap-1 text-sm text-muted-foreground">
                {liveSteps.map((m, i) => (
                  <div key={i} className="flex items-center gap-2 pl-6 text-xs">
                    <Check className="h-3 w-3" /> {m}
                  </div>
                ))}
                <div className="flex items-center gap-2">
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
                      className="h-6 px-2 text-xs"
                    >
                      <X className="h-3 w-3" /> Stop
                    </Button>
                  )}
                </div>
              </div>
            )}
            <div ref={bottomRef} />
          </div>
        </div>

        <div className="border-t px-4 py-3">
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
          <div className="mx-auto flex max-w-3xl items-end gap-2 rounded-xl border bg-background p-2 focus-within:ring-1 focus-within:ring-ring">
            <Textarea
              ref={inputRef}
              value={input}
              onChange={(e) => setInput(e.target.value)}
              onKeyDown={onKeyDown}
              placeholder={
                !service
                  ? 'No assistant online'
                  : blockedByOther
                    ? 'This assistant is busy with another conversation…'
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

// Which assistant a new conversation talks to. Shown only where there is a
// choice to make: more than one online, and a conversation not yet bound to
// one of them.
const AssistantPicker = ({ assistants, value, onChange, disabled }) => (
  <Select value={value} onValueChange={onChange} disabled={disabled}>
    <SelectTrigger className="h-8 w-auto min-w-48 gap-2" aria-label="Assistant">
      <SelectValue />
    </SelectTrigger>
    <SelectContent>
      {assistants.map((s) => (
        <SelectItem key={s.serviceId} value={s.serviceId}>
          {s.serviceName}
        </SelectItem>
      ))}
    </SelectContent>
  </Select>
);

// Standard chat markdown: GFM (tables, task lists, strikethrough) through the
// app's one renderer, styled with Tailwind Typography over the shared
// `md-body` defaults. Tables scroll sideways instead of breaking the column
// and links open in a new tab, both handled in markdown.css / lib/markdown.js
// rather than by per-element component overrides.
export const AssistantMarkdown = ({ children }) => (
  <SafeMarkdown className="prose prose-sm max-w-none leading-relaxed dark:prose-invert prose-p:my-3.5 prose-headings:mt-6 prose-headings:mb-2.5 prose-pre:my-3 prose-table:my-4 prose-ul:my-3 prose-ol:my-3 prose-li:my-1 prose-hr:my-5">
    {children}
  </SafeMarkdown>
);

// ---- export -----------------------------------------------------------------
// The conversation as Markdown: downloaded as a file, or copied.

const ExportMenu = ({ conv, meta, projectId, projectName }) => {
  const build = () =>
    conversationToMarkdown(conv, meta, {
      origin: `${window.location.origin}${window.location.pathname}`,
      projectId,
      projectName,
    });
  const download = () => {
    const blob = new Blob([build()], { type: 'text/markdown;charset=utf-8' });
    const url = URL.createObjectURL(blob);
    const a = document.createElement('a');
    a.href = url;
    a.download = markdownFilename(meta);
    document.body.appendChild(a);
    a.click();
    a.remove();
    setTimeout(() => URL.revokeObjectURL(url), 1000);
  };
  const copy = async () => {
    try {
      await navigator.clipboard.writeText(build());
      notifySuccess('The conversation was copied as Markdown.', 'Copied');
    } catch (e) {
      notifyError(humanizeError(e, 'Could not copy to the clipboard.'), 'Not copied');
    }
  };
  return (
    <DropdownMenu>
      <DropdownMenuTrigger asChild>
        <Button type="button" variant="ghost" size="sm" title="Export this conversation">
          <Download className="h-4 w-4" />
        </Button>
      </DropdownMenuTrigger>
      <DropdownMenuContent align="end">
        <DropdownMenuItem onSelect={download}>
          <FileDown className="mr-2 h-4 w-4" /> Download as Markdown
        </DropdownMenuItem>
        <DropdownMenuItem onSelect={copy}>
          <Copy className="mr-2 h-4 w-4" /> Copy as Markdown
        </DropdownMenuItem>
      </DropdownMenuContent>
    </DropdownMenu>
  );
};

// ---- sentence citations -----------------------------------------------------
// The model cites evidence as `<cite doc="Text 1" ref="s3"/>`; the service
// resolves each to interlinear data (see citations.js and citations.py). A
// citation alone on a line becomes an example card in place; one inside a
// sentence becomes a link, and its card is listed under the reply.

// A morpheme row's cell for a word whose morphemes the citation names: drawn
// morpheme by morpheme, so the named ones stand out inside the word.
const MorphemeCell = ({ parts, joiners, marked }) =>
  parts.map((part, k) => (
    <Fragment key={k}>
      {k > 0 && (joiners[k - 1] ?? '-')}
      <span className={cn(marked.has(k + 1) && 'rounded-sm bg-primary/35 px-0.5')}>{part}</span>
    </Fragment>
  ));

const ExampleCard = ({ c, projectId }) => {
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
const CitedMarkdown = ({ text, citations, projectId }) => {
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

const Turn = ({
  item,
  projectId,
  results,
  fromAnotherModel,
  canWrite,
  busy,
  interrupted,
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
            canWrite={canWrite}
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

// A proposed plan: what it does in one line, every change as a row, and the
// decision. Once settled it stays in the transcript as a record.
const PlanCard = ({
  plan,
  status,
  recordedAsHuman,
  interrupted,
  canWrite,
  busy,
  onApprove,
  onDiscard,
}) => {
  const labels = plan.labels || [];
  const [expanded, setExpanded] = useState(labels.length <= 12);
  const [asHuman, setAsHuman] = useState(!!recordedAsHuman);
  const humanId = `plan-human-${plan.id}`;
  const shown = expanded ? labels : labels.slice(0, 12);
  // 'applying' with nothing in flight means the page went away mid-apply, so
  // whether the changes landed is unknown. Offer the same buttons as an
  // undecided plan: re-approving is safe, since the service refuses to write
  // the same plan twice.
  const undecided = status === null || interrupted;
  return (
    <div
      className={cn(
        'rounded-lg border px-3 py-2 text-sm',
        (status === null || status === 'applying') && 'border-primary/40 bg-primary/5',
        status === 'applied' && 'border-green-600/40 bg-green-600/5',
        status === 'discarded' && 'opacity-60',
      )}
    >
      <div className="flex flex-wrap items-center gap-2">
        <span className="font-medium">Proposed changes</span>
        <span className="text-muted-foreground">{plan.summary}</span>
        {status === 'applied' && (
          <Badge variant="secondary" className="ml-auto">
            <Check className="mr-1 h-3 w-3" /> Applied
          </Badge>
        )}
        {status === 'discarded' && (
          <Badge variant="outline" className="ml-auto">
            Discarded
          </Badge>
        )}
        {status === 'applying' && !interrupted && (
          <Badge variant="secondary" className="ml-auto">
            <Loader2 className="mr-1 h-3 w-3 animate-spin" /> Applying…
          </Badge>
        )}
        {interrupted && (
          <Badge variant="outline" className="ml-auto">
            Interrupted
          </Badge>
        )}
      </div>
      {interrupted && (
        <p className="mt-2 text-xs text-muted-foreground">
          The page closed while these changes were being applied, so whether they landed is unknown.
          Applying again is safe: a plan that was already applied is not written twice.
        </p>
      )}
      <ol className="mt-2 max-h-72 list-decimal overflow-auto pl-5 font-mono text-xs leading-5">
        {shown.map((l, i) => (
          <li key={i}>{l}</li>
        ))}
      </ol>
      {labels.length > shown.length && (
        <button
          type="button"
          onClick={() => setExpanded(true)}
          className="mt-1 flex items-center gap-1 text-xs text-muted-foreground hover:text-foreground"
        >
          <ChevronDown className="h-3 w-3" /> Show all {labels.length}
        </button>
      )}
      {undecided && (
        <div className="mt-2 flex items-center gap-2">
          {canWrite ? (
            <Button type="button" size="sm" onClick={() => onApprove({ asHuman })} disabled={busy}>
              {interrupted ? (
                <>
                  <RotateCcw className="h-4 w-4" /> Apply again
                </>
              ) : (
                <>
                  <Check className="h-4 w-4" /> Approve and apply
                </>
              )}
            </Button>
          ) : (
            <span className="text-muted-foreground">Applying needs write access.</span>
          )}
          <Button type="button" size="sm" variant="outline" onClick={onDiscard} disabled={busy}>
            <X className="h-4 w-4" /> Discard
          </Button>
          {canWrite && (
            <label
              htmlFor={humanId}
              className="ml-auto flex cursor-pointer items-center gap-1.5 text-xs text-muted-foreground"
              title="By default the changes are recorded as made by the assistant and verified by you. Tick this to record them as if you had made them yourself (no machine provenance)."
            >
              <input
                id={humanId}
                type="checkbox"
                className="h-3.5 w-3.5"
                checked={asHuman}
                disabled={busy}
                onChange={(e) => setAsHuman(e.target.checked)}
              />
              Record as human-made
            </label>
          )}
        </div>
      )}
    </div>
  );
};
