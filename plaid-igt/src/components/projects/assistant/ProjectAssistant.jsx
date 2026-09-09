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
import { Link, useSearchParams } from 'react-router-dom';
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
import { notifySuccess, notifyError, notifyWarning, humanizeError } from '@/utils/feedback';
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
import { rewindForRetry } from './resume.js';
import {
  ROWS_COLLAPSED,
  changeHref,
  changeRef,
  changeTitle,
  collapseGroups,
  groupRows,
  planRows,
} from './planChanges.js';

// The Assistant tab: a chat with whatever `assist` service(s) the operator
// runs (see ../../../../../plaid-igt-agent), laid out like any chat app: past
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

// A stream, not a deadline: the service keeps its own budget per turn.
const REQUEST_TIMEOUT_MS = 12 * 60 * 60 * 1000;
const TITLE_MAX = 60;

// Said when the page gives up waiting on a request the service is still
// running. The conversation record is where the answer lands, so it is there
// to be picked up.
const LOST_CONTACT =
  'Lost contact with the assistant. It is still working. Reload to pick it back up.';

const metaKey = (projectId, id) => `igt:assistant:${projectId}:meta:${id}`;
const convKey = (projectId, id) => `igt:assistant:${projectId}:conv:${id}`;
const metaPrefix = (projectId) => `igt:assistant:${projectId}:meta:`;
const convHref = (projectId, id) => `/projects/${projectId}?tab=assistant&conversation=${id}`;

// A UUID: request ids must be one (the server checks), and conversation ids
// share the generator.
const newId = () =>
  typeof crypto !== 'undefined' && crypto.randomUUID
    ? crypto.randomUUID()
    : 'xxxxxxxx-xxxx-4xxx-yxxx-xxxxxxxxxxxx'.replace(/[xy]/g, (c) => {
        const r = (Math.random() * 16) | 0;
        return (c === 'x' ? r : (r & 0x3) | 0x8).toString(16);
      });

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
// A request's stream can run for minutes, and meanwhile the user may switch
// tabs (which unmounts this component) or a dev reload may remount it. So a
// job runs here, at module level, and the component only subscribes to
// whatever is in flight for the conversation it shows. A job is {id (the
// conversation), projectId, serviceId, kind: 'turn' | 'apply', requestId,
// planId, conv, prevMeta, controller, progress, steps, stopping, stopped,
// error, outcome, done, result}. At most one job runs per conversation: the
// composer and the plan's buttons are disabled while one is in flight. A job
// stays in the registry until the record is read back and any settling write
// has landed, so a conversation reopened in that window serves the finished
// copy, and deleting it cannot race the write.
//
// The registry lives on globalThis rather than in this module's scope, so a
// hot update of this file in development (which re-evaluates the module
// while a job may be running) finds the same maps instead of empty ones.
const registry = (globalThis.__igtAssistantJobs ??= {
  serviceCache: new Map(), // project id -> services, so a remount need not blank the picker
  saveQueues: new Map(), // conversation id -> Promise (writes in order)
  jobs: new Map(), // conversation id -> job in flight
  jobListeners: new Set(), // mounted components
  lastOpen: new Map(), // project id -> the conversation shown when the tab was last left
});
const { serviceCache, saveQueues, jobs, jobListeners, lastOpen } = registry;

const jobFor = (id) => (id ? jobs.get(id) || null : null);
const notifyJob = (j) => jobListeners.forEach((fn) => fn(j));

const upsert = (meta) => (prev) => [meta, ...prev.filter((m) => m.id !== meta.id)];

// The sidebar entry after a write. `pending` names the request under way, if
// any: {kind, requestId, serviceId, planId, asHuman, contributedBy, startedAt}.
const buildMeta = (prev, conv, service, pending = null) => {
  const firstUser = conv.display.find((d) => d.kind === 'user');
  return {
    id: conv.id,
    title: prev?.title || (firstUser ? titleFrom(firstUser.text) : 'New conversation'),
    createdAt: prev?.createdAt || new Date().toISOString(),
    updatedAt: new Date().toISOString(),
    serviceId: service?.serviceId || prev?.serviceId || null,
    model: service?.extras?.model || prev?.model || null,
    turns: conv.display.filter((d) => d.kind === 'user').length,
    pending,
  };
};

// Write a conversation (transcript + sidebar entry, or the entry alone).
// Writes for one conversation run one after another so a slow earlier PUT
// cannot land on top of a newer one.
const persistConv = (client, userId, projectId, conv, meta, { metaOnly = false } = {}) => {
  if (!userId) return Promise.resolve();
  const prev = saveQueues.get(conv.id) || Promise.resolve();
  const next = prev
    .then(async () => {
      if (!metaOnly) {
        await client.userData.put(userId, convKey(projectId, conv.id), {
          messages: conv.messages,
          display: conv.display,
        });
      }
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

// The record as the server has it. Read after any write of ours has landed.
const readConv = async (client, userId, projectId, id) => {
  await (saveQueues.get(id) || Promise.resolve());
  const [c, m] = await Promise.all([
    client.userData.get(userId, convKey(projectId, id)),
    client.userData.get(userId, metaKey(projectId, id)),
  ]);
  const v = c?.value || {};
  return {
    conv: { id, messages: v.messages || [], display: v.display || [] },
    meta: m?.value || null,
  };
};

// A plan's outcome decided here (a discard): the status on its card, plus a
// note in the model transcript (user role) so the next turn knows.
const settle = (conv, index, status, note) => ({
  ...conv,
  messages: note ? [...conv.messages, { role: 'user', content: note }] : conv.messages,
  display: conv.display.map((d, i) => (i === index ? { ...d, status } : d)),
});

// The user's message leaves the model transcript when its turn ends without
// an answer, so a retry does not send it twice; it stays on screen.
const dropUnanswered = (conv) =>
  conv.messages.at(-1)?.role === 'user' ? conv.messages.slice(0, -1) : conv.messages;

// A progress event carries the reply text written so far (`text`), whole
// each time; the step list keeps only what the assistant did between them.
const progressOf = (j) => (p) => {
  const msg = p?.message || '';
  j.progress = msg;
  if (typeof p?.text === 'string') j.partial = p.text;
  if (
    msg &&
    !/^(Thinking|Done|Planning|Planned|Applying|Writing)/.test(msg) &&
    j.steps[j.steps.length - 1] !== msg
  ) {
    j.steps = [...j.steps, msg];
  }
  notifyJob(j);
};

// Run a request stream to its end, recording how it ended on the job.
const watch = async (j, run) => {
  try {
    j.outcome = await run();
  } catch (e) {
    if (e?.name === 'AbortError') j.stopped = true;
    else {
      j.error = e;
      if (e?.status !== 404) console.error('[Assistant] request failed', e);
    }
  }
};

// However a job's stream ended, the record is the outcome: the service wrote
// it before finishing. Read it back; if it still says this request is under
// way, the service never got to write (it or the server went away, or the
// request expired unseen), so settle it here.
//
// Unless the error says the request is STILL OUT THERE (a dropped connection,
// a timeout). Then the service is working and will write the record itself,
// and settling it as failed would both lose the answer when it lands and stop
// the next page from rejoining. Leave it pending and say so.
const finishJob = async (j, client, userId, projectId, service) => {
  let conv;
  let meta;
  try {
    ({ conv, meta } = await readConv(client, userId, projectId, j.id));
  } catch (e) {
    console.error('[Assistant] could not read the conversation back', e);
    conv = j.conv;
    meta = buildMeta(j.prevMeta, conv, service);
  }
  const stillOut = j.error?.pending === true;
  if (stillOut && j.kind === 'turn') notifyWarning(LOST_CONTACT, 'Assistant');
  if (!stillOut && meta?.pending?.requestId === j.requestId) {
    if (j.kind === 'turn') {
      if (j.stopped) {
        conv = {
          ...conv,
          messages: dropUnanswered(conv),
          display: [...conv.display, { kind: 'error', stopped: true, text: 'Stopped.' }],
        };
      } else if (j.error && j.error.status !== 404) {
        conv = {
          ...conv,
          messages: dropUnanswered(conv),
          display: [
            ...conv.display,
            { kind: 'error', text: humanizeError(j.error, 'The assistant could not answer.') },
          ],
        };
      }
      // Else the request is simply gone: the message stays unanswered and the
      // tab offers to send it again.
    } else {
      conv = {
        ...conv,
        display: conv.display.map((d) =>
          d.plan?.id === j.planId && d.status === null ? { ...d, interrupted: true } : d,
        ),
      };
    }
    meta = buildMeta(meta, conv, service, null);
    await persistConv(client, userId, projectId, conv, meta);
  }
  j.done = true;
  j.result = { conv, meta };
  notifyJob(j);
  jobs.delete(j.id);
  notifyJob(j);
  return j.result;
};

const newJob = (fields) => ({
  controller: new AbortController(),
  steps: [],
  partial: '',

  stopping: false,
  stopped: false,
  error: null,
  outcome: null,
  done: false,
  result: null,
  ...fields,
});

// Run one turn for `conv`, whose last message is the user's.
const startTurn = ({ client, userId, projectId, service, conv, prevMeta }) => {
  const requestId = newId();
  const j = newJob({
    id: conv.id,
    projectId,
    serviceId: service.serviceId,
    kind: 'turn',
    requestId,
    planId: null,
    conv,
    prevMeta,
    progress: 'Thinking…',
  });
  jobs.set(conv.id, j);
  const meta = buildMeta(prevMeta, conv, service, {
    kind: 'turn',
    requestId,
    serviceId: service.serviceId,
    startedAt: new Date().toISOString(),
  });
  j.promise = (async () => {
    // The record first: the service reads the message from it, and a tab
    // that comes back finds the request there.
    await persistConv(client, userId, projectId, conv, meta);
    await watch(j, () =>
      client.messages.requestService(
        projectId,
        service.serviceId,
        { projectId, conversationId: conv.id },
        REQUEST_TIMEOUT_MS,
        progressOf(j),
        j.controller.signal,
        { requestId },
      ),
    );
    return finishJob(j, client, userId, projectId, service);
  })();
  return j;
};

const applyToasts = (j, summary) => {
  // We stopped waiting, the service did not stop working. Nothing has failed
  // and nothing needs approving again, so say what actually happened.
  if (j.error?.pending) {
    notifyWarning(LOST_CONTACT, 'Assistant');
  } else if (j.error && j.error.status !== 404) {
    notifyError(
      humanizeError(j.error, 'The changes could not be applied.') +
        ' Approving again is safe: a plan that was already applied is not written twice.',
      'Not applied',
    );
  } else if (j.outcome && !j.outcome.duplicate) {
    notifySuccess(j.outcome.message || `Applied ${summary}.`, 'Changes applied');
  }
};

// Apply `plan` from `conv`. What a plan writes is recorded as verified (made
// by the assistant, confirmed by the approver) unless the user asks for it to
// count as human-made; a contributor's approval records it as their own
// unreviewed work (`contributedBy`, provenance convention). The service
// refuses a second application of the same plan (a retried request, a double
// click), so a failure leaves the plan undecided and approving again is safe.
const startApply = ({
  client,
  userId,
  projectId,
  service,
  conv,
  prevMeta,
  plan,
  asHuman,
  contributedBy = null,
}) => {
  const requestId = newId();
  const j = newJob({
    id: conv.id,
    projectId,
    serviceId: service.serviceId,
    kind: 'apply',
    requestId,
    planId: plan.id,
    conv,
    prevMeta,
    progress: 'Applying changes…',
  });
  jobs.set(conv.id, j);
  // The attempt is recorded before it is made, so a tab that comes back
  // knows a plan was approved and rejoins, or offers to apply again.
  const meta = buildMeta(prevMeta, conv, service, {
    kind: 'apply',
    requestId,
    serviceId: service.serviceId,
    planId: plan.id,
    asHuman,
    contributedBy,
    startedAt: new Date().toISOString(),
  });
  j.promise = (async () => {
    await persistConv(client, userId, projectId, conv, meta, { metaOnly: true });
    await watch(j, () =>
      client.messages.requestService(
        projectId,
        service.serviceId,
        {
          projectId,
          conversationId: conv.id,
          approve: { planId: plan.id, asHuman, contributedBy },
        },
        REQUEST_TIMEOUT_MS,
        progressOf(j),
        undefined,
        { requestId },
      ),
    );
    applyToasts(j, plan.summary);
    return finishJob(j, client, userId, projectId, service);
  })();
  return j;
};

// Rejoin the request a conversation's record says is under way (it was
// submitted from a page that is gone). The record gets the outcome either
// way; this is for showing progress and refreshing when it lands.
const attachJob = ({ client, userId, projectId, conv, meta }) => {
  const p = meta.pending;
  const j = newJob({
    id: conv.id,
    projectId,
    serviceId: p.serviceId || null,
    kind: p.kind === 'apply' ? 'apply' : 'turn',
    requestId: p.requestId,
    planId: p.planId || null,
    conv,
    prevMeta: meta,
    progress: p.kind === 'apply' ? 'Applying changes…' : 'Thinking…',
  });
  jobs.set(conv.id, j);
  j.promise = (async () => {
    await watch(j, () =>
      client.messages.attachServiceRequest(
        projectId,
        p.requestId,
        REQUEST_TIMEOUT_MS,
        progressOf(j),
        j.controller.signal,
      ),
    );
    if (j.kind === 'apply') {
      const plan = conv.display.find((d) => d.plan?.id === j.planId)?.plan;
      applyToasts(j, plan?.summary || 'the changes');
    }
    return finishJob(j, client, userId, projectId, null);
  })();
  return j;
};

// Ask the service to stop a turn. It stops between steps and settles the
// record; if the request is already gone, end our side and settle here.
const stopJob = async (client, projectId, j) => {
  if (!j || j.kind !== 'turn' || j.stopping || j.done) return;
  j.stopping = true;
  j.progress = 'Stopping…';
  notifyJob(j);
  try {
    await client.messages.cancelServiceRequest(projectId, j.requestId);
  } catch (e) {
    if (e?.status === 404) j.controller.abort();
    // 409: it just finished; the stream delivers the result.
  }
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

export const ProjectAssistant = ({
  projectId,
  projectName,
  client,
  userId,
  canWrite,
  contributor = false,
}) => {
  // --- services ---------------------------------------------------------
  const [services, setServices] = useState([]);
  const [discovering, setDiscovering] = useState(true);
  const [choice, setChoice] = useState(null);

  // --- conversations ----------------------------------------------------
  const [convs, setConvs] = useState([]); // sidebar metas, newest first
  const [loadingList, setLoadingList] = useState(true);
  const [active, setActive] = useState(newConversation); // {id, messages, display, draft?}
  const [opening, setOpening] = useState(null); // id being fetched
  // Which conversation the URL names, if any.
  const [searchParams, setSearchParams] = useSearchParams();
  const urlConv = searchParams.get('conversation');
  const setUrlConv = useCallback(
    (id, options) =>
      setSearchParams((prev) => {
        const next = new URLSearchParams(prev);
        if (id) next.set('conversation', id);
        else next.delete('conversation');
        return next;
      }, options),
    [setSearchParams],
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
        const { conv, meta } = await readConv(client, userId, projectId, id);
        // A later click (or "+") won the race: its choice stands.
        if (seq !== openSeq.current) return;
        setActive(conv);
        // The record is newer than the list (a reply may have landed since).
        if (meta) setConvs(upsert(meta));
        if (meta?.pending?.requestId && !jobFor(id)) {
          attachJob({ client, userId, projectId, conv, meta });
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
    [client, userId, projectId],
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
    const remembered = lastOpen.get(projectId);
    loadList().then((metas) => {
      // Only a conversation that still exists (it may have been deleted meanwhile).
      if (
        !urlConvRef.current &&
        remembered &&
        (jobFor(remembered) || metas.some((m) => m.id === remembered))
      ) {
        setUrlConvRef.current(remembered, { replace: true });
      }
    });
    return () => {
      const a = activeRef.current;
      if (a && !a.draft) lastOpen.set(projectId, a.id);
      else lastOpen.delete(projectId);
    };
  }, [loadList, projectId]);

  // Reflect jobs as they progress and finish, for whichever conversation is
  // shown; a finished job always refreshes the sidebar entry.
  useEffect(() => {
    const onJob = (j) => {
      if (j.done) setConvs(upsert(j.result.meta));
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
      persistConv(client, userId, projectId, next, meta);
    },
    [client, userId, projectId],
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
        client.userData.delete(userId, convKey(projectId, id)),
        client.userData.delete(userId, metaKey(projectId, id)),
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
    const prevMeta = convsRef.current.find((m) => m.id === conv.id);
    openSeq.current++; // sending settles which conversation is open
    activeRef.current = conv;
    setActive(conv);
    if (urlConvRef.current !== conv.id) setUrlConv(conv.id, { replace: true });
    setConvs(upsert(buildMeta(prevMeta, conv, service)));
    showJob(startTurn({ client, userId, projectId, service, conv, prevMeta }));
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
        client,
        userId,
        projectId,
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
                {m.draft ? (
                  <div className="min-w-0 flex-1 text-left">
                    <ConversationRow m={m} opening={opening} />
                  </div>
                ) : (
                  <Link to={convHref(projectId, m.id)} className="min-w-0 flex-1 text-left">
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

// One sidebar entry: the title, when it was last written, which model, and
// whether work was left unfinished.
const ConversationRow = ({ m, opening }) => (
  <>
    <div className="flex items-center gap-1.5">
      <MessageSquare className="h-3.5 w-3.5 shrink-0 text-muted-foreground" />
      <span className={cn('truncate', m.draft && 'italic')}>{m.title || 'Untitled'}</span>
    </div>
    <div className="pl-5 text-[11px] text-muted-foreground">
      {m.draft
        ? 'Nothing sent yet'
        : (opening === m.id ? 'Opening…' : timeAgo(m.updatedAt)) +
          (m.model ? ` · ${m.model.split('/').pop()}` : '') +
          (m.pending && !jobFor(m.id) ? ' · unfinished' : '')}
    </div>
  </>
);

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

// A proposed plan: what it does in one line, every change as a row under the
// document or lexicon it lands in, and the decision. Once settled it stays in
// the transcript as a record.
const PlanCard = ({
  plan,
  status,
  recordedAsHuman,
  interrupted,
  applying,
  canWrite,
  busy,
  onApprove,
  onDiscard,
  contributor = false,
  projectId,
}) => {
  const allRows = useMemo(() => planRows(plan), [plan]);
  const groups = useMemo(() => groupRows(allRows, projectId), [allRows, projectId]);
  const [expanded, setExpanded] = useState(allRows.length <= ROWS_COLLAPSED);
  const [asHuman, setAsHuman] = useState(!!recordedAsHuman);
  const humanId = `plan-human-${plan.id}`;
  const shown = expanded ? { groups, hidden: 0 } : collapseGroups(groups);
  const undecided = status === null;
  // The record says the plan was approved but the request that applied it is
  // gone, so whether the changes landed is unknown. The same buttons as an
  // undecided plan: applying again is safe, since the service refuses to
  // write the same plan twice.
  const lost = undecided && interrupted && !applying;
  return (
    <div
      className={cn(
        'rounded-lg border px-3 py-2 text-sm',
        undecided && 'border-primary/40 bg-primary/5',
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
        {applying && (
          <Badge variant="secondary" className="ml-auto">
            <Loader2 className="mr-1 h-3 w-3 animate-spin" /> Applying…
          </Badge>
        )}
        {lost && (
          <Badge variant="outline" className="ml-auto">
            Not finished
          </Badge>
        )}
      </div>
      {lost && (
        <p className="mt-2 text-xs text-muted-foreground">
          Applying did not finish. Applying again is safe: a plan that was already applied is not
          written twice.
        </p>
      )}
      <div className="mt-1 max-h-80 overflow-auto">
        <table className="w-full border-collapse text-xs leading-5">
          <tbody>
            {shown.groups.map((g) => (
              <Fragment key={g.key}>
                <tr>
                  <th
                    colSpan={2}
                    scope="colgroup"
                    className="pt-2 text-left font-medium text-foreground"
                  >
                    {g.href ? (
                      <a
                        href={g.href}
                        target="_blank"
                        rel="noopener noreferrer"
                        className="hover:underline"
                      >
                        {g.title}
                      </a>
                    ) : (
                      g.title
                    )}
                    <span className="ml-1.5 font-normal text-muted-foreground">
                      {g.rows.length}
                    </span>
                  </th>
                </tr>
                {g.rows.map((r) => (
                  <ChangeRow key={r.index} row={r} projectId={projectId} />
                ))}
              </Fragment>
            ))}
          </tbody>
        </table>
      </div>
      {shown.hidden > 0 && (
        <button
          type="button"
          onClick={() => setExpanded(true)}
          className="mt-1 flex items-center gap-1 text-xs text-muted-foreground hover:text-foreground"
        >
          <ChevronDown className="h-3 w-3" /> Show all {allRows.length}
        </button>
      )}
      {undecided && (
        <div className="mt-2 flex items-center gap-2">
          {canWrite ? (
            <Button type="button" size="sm" onClick={() => onApprove({ asHuman })} disabled={busy}>
              {lost ? (
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
          {canWrite && !contributor && (
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

// One change: where it lands, as a link into the editor (the word itself,
// with its reference; a sentence by number; a lexicon entry by form), and
// what changes.
const ChangeRow = ({ row, projectId }) => {
  const w = row.where;
  const href = changeHref(projectId, w);
  const title = changeTitle(w);
  let place = null;
  if (w?.kind === 'token') {
    const isSentence = !w.word;
    place = (
      <>
        <a
          href={href}
          target="_blank"
          rel="noopener noreferrer"
          title={title}
          className="font-medium text-foreground hover:underline"
        >
          {isSentence ? `Sentence ${w.sentence}` : w.surface}
        </a>
        <span className="ml-1.5 text-muted-foreground">
          {isSentence ? w.surface : changeRef(w)}
        </span>
      </>
    );
  } else if (w?.kind === 'entry') {
    place = href ? (
      <a
        href={href}
        target="_blank"
        rel="noopener noreferrer"
        title={title}
        className="font-medium text-foreground hover:underline"
      >
        {w.form}
      </a>
    ) : (
      <span className="font-medium">{w.form}</span>
    );
  }
  return (
    <tr className="align-top">
      <td className="w-px whitespace-nowrap py-0.5 pr-4">
        <span className="inline-block max-w-[18rem] truncate align-bottom">{place}</span>
      </td>
      <td className="py-0.5">{row.change ?? row.label}</td>
    </tr>
  );
};
