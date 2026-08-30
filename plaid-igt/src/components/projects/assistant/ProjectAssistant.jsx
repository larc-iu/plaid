import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
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
import Markdown from 'react-markdown';
import remarkGfm from 'remark-gfm';
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
import { conversationToMarkdown, markdownFilename } from './exportMarkdown.js';
import { applyingIndex, rewindForRetry, unansweredTurn } from './resume.js';

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

// --- tool traces ------------------------------------------------------------
// A turn's new transcript messages hold the assistant's tool calls and the
// tools' replies. Fold them into a compact trace stored on the display item:
// what was called (humanized), with what, and what came back (truncated so a
// saved conversation stays small).
const RESULT_KEEP = 4000;

const parseArgs = (raw) => {
  try {
    const v = JSON.parse(raw || '{}');
    return v && typeof v === 'object' ? v : {};
  } catch {
    return {};
  }
};

const extractSteps = (messages) => {
  const results = new Map();
  for (const m of messages || []) {
    if (m.role === 'tool' && m.toolCallId) results.set(m.toolCallId, m.content ?? '');
  }
  const steps = [];
  for (const m of messages || []) {
    if (m.role !== 'assistant' || !m.toolCalls) continue;
    for (const c of m.toolCalls) {
      const result = String(results.get(c.id) ?? '');
      steps.push({
        name: c.function?.name || '?',
        args: parseArgs(c.function?.arguments),
        result:
          result.length > RESULT_KEEP
            ? `${result.slice(0, RESULT_KEEP)}\n… [${result.length - RESULT_KEEP} more characters]`
            : result,
        error: result.startsWith('Error'),
      });
    }
  }
  return steps;
};

const q = (v) => `“${String(v ?? '')}”`;
const where = (a) => (a.document ? ` in ${q(a.document)}` : '');

// One line per tool call, in the user's terms.
const describeStep = ({ name, args: a }) => {
  switch (name) {
    case 'project_overview':
      return 'Looked at the project overview';
    case 'read_document':
      return `Read ${q(a.document)}${
        a.from_sentence || a.to_sentence
          ? ` (sentences ${a.from_sentence || 1}${a.to_sentence ? `–${a.to_sentence}` : ' on'})`
          : ''
      }`;
    case 'search':
      return `Searched ${a.where && a.where !== 'baseline' ? a.where : 'the baseline'} for ${q(a.pattern)}${where(a)}`;
    case 'field_values':
      return `Counted ${a.field} values${where(a)}`;
    case 'read_lexicon':
      return `Read the lexicon${a.pattern ? ` for ${q(a.pattern)}` : ''}`;
    case 'concordance':
      return `Concordanced ${q(a.pattern)}${a.where && a.where !== 'morpheme' ? ` in ${a.where}` : ''}${where(a)}`;
    case 'analyses_of':
      return `Tallied the analyses of ${q(a.form)}${where(a)}`;
    case 'lexicon_entry':
      return `Looked up the entry ${q(a.entry_form || a.entry_id)}`;
    case 'check_consistency':
      return `Checked ${a.field} for consistency${where(a)}`;
    case 'recent_changes':
      return `Read the change history${where(a)}`;
    case 'plan_status':
      return 'Reviewed the plan so far';
    case 'set_document_metadata':
      return `Planned ${a.field} = ${q(a.value)} on document ${q(a.document)}`;
    case 'create_document':
      return `Planned a new document ${q(a.name)}`;
    case 'corpus_stats':
      return `Counted the corpus${a.by ? ` by ${a.by}` : ''}${where(a)}`;
    case 'frequency_list':
      return `Ranked ${a.what || 'wordform'}s by frequency${where(a)}`;
    case 'worklist':
      return `Listed ${a.kind || 'unglossed'} ${a.field ? `${a.field} ` : ''}work${where(a)}`;
    case 'check_lexicon':
      return 'Checked the lexicon';
    case 'check_integrity':
      return `Checked data integrity${where(a)}`;
    case 'sequence_search':
      return `Searched for a word sequence${where(a)}`;
    case 'replace_in_field':
      return `Planned replacing ${q(a.pattern)} → ${q(a.replacement)} in ${a.field}${where(a)}`;
    case 'respell_all':
      return `Planned respelling ${q(a.pattern)} → ${q(a.replacement)}${where(a)}`;
    case 'copy_to_orthography':
      return `Planned filling ${a.orthography} from ${a.source || 'the baseline'}${where(a)}`;
    case 'set_field_for_form':
      return `Planned ${a.field} = ${q(a.value)} on every ${q(a.form)}${where(a)}`;
    case 'set_analysis_for_form':
      return `Planned an analysis for every ${q(a.form)}${where(a)}`;
    case 'merge_entries':
      return `Planned merging ${q(a.remove_form || a.remove_id)} into ${q(a.keep_form || a.keep_id)}`;
    case 'delete_entry':
      return `Planned deleting the entry ${q(a.entry_form || a.entry_id)}`;
    case 'rename_entry':
      return `Planned renaming the entry ${q(a.entry_form || a.entry_id)} → ${q(a.new_form)}`;
    case 'rename_document':
      return `Planned renaming ${q(a.document)} → ${q(a.new_name)}`;
    case 'query_help':
      return 'Read the query language reference';
    case 'query':
      return 'Ran a query';
    case 'set_field':
      return `Planned ${a.field} = ${q(a.value)} on ${(a.refs || []).length} item(s)${where(a)}`;
    case 'set_analysis':
      return `Planned a new analysis for ${a.ref}${where(a)}`;
    case 'set_orthography':
      return `Planned ${a.orthography} = ${q(a.value)} on ${(a.refs || []).length} word(s)${where(a)}`;
    case 'respell':
      return `Planned respelling ${a.ref} → ${q(a.new_text)}${where(a)}`;
    case 'link_entry':
      return `Planned linking ${(a.refs || []).length} item(s) to ${q(a.entry_form || a.entry_id)}${where(a)}`;
    case 'unlink_entry':
      return `Planned unlinking ${(a.refs || []).length} item(s)${where(a)}`;
    case 'create_entry':
      return `Planned a new lexicon entry ${q(a.form)}`;
    case 'set_entry_field':
      return `Planned ${a.field} = ${q(a.value)} on entry ${q(a.entry_form || a.entry_id)}`;
    case 'discard_plan':
      return 'Discarded the plan so far';
    default:
      return name.replace(/_/g, ' ');
  }
};

const summarizeSteps = (steps) => {
  const docs = new Set(steps.filter((s) => s.name === 'read_document').map((s) => s.args.document));
  const searches = steps.filter((s) =>
    [
      'search',
      'field_values',
      'concordance',
      'analyses_of',
      'check_consistency',
      'corpus_stats',
      'frequency_list',
      'worklist',
      'check_lexicon',
      'check_integrity',
      'sequence_search',
      'query',
    ].includes(s.name),
  ).length;
  const planned = steps.filter((s) =>
    /^(set_|respell|link_|unlink_|create_|replace_|copy_to|merge_|delete_|rename_)/.test(s.name),
  ).length;
  const parts = [];
  if (docs.size) parts.push(`read ${docs.size} document${docs.size === 1 ? '' : 's'}`);
  if (searches) parts.push(`${searches} search${searches === 1 ? '' : 'es'}`);
  if (planned) parts.push(`${planned} planned change${planned === 1 ? '' : 's'}`);
  const head = parts.length
    ? parts.join(' · ')
    : `${steps.length} step${steps.length === 1 ? '' : 's'}`;
  return parts.length ? `${head} · ${steps.length} step${steps.length === 1 ? '' : 's'}` : head;
};

// --- work that outlives the component ------------------------------------------
// A turn, and applying an approved plan, can each take minutes, and meanwhile
// the user may switch tabs (which unmounts this component) or a dev reload may
// remount it. So both run here, at module level, persist their own outcome,
// and the component only subscribes to whatever is in flight for the
// conversation it shows. A job is {id, projectId, kind: 'turn' | 'apply',
// conv, progress, steps, done, result}.
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
            steps: extractSteps(result.messages),
          },
        ],
      };
    } catch (e) {
      console.error('[Assistant] turn failed', e);
      next = {
        ...conv,
        // Drop the failed user turn from the model transcript so a retry does
        // not send it twice; keep it visible with the error.
        messages: conv.messages.slice(0, -1),
        display: [
          ...conv.display,
          { kind: 'error', text: humanizeError(e, 'The assistant could not answer.') },
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
  const [active, setActive] = useState(null); // {id, messages, display} | null (a fresh chat)
  const [opening, setOpening] = useState(null); // id being fetched

  // --- the turn in flight ------------------------------------------------
  const [input, setInput] = useState('');
  const [busy, setBusy] = useState(null); // null | 'turn' | 'apply'
  const [progress, setProgress] = useState('');
  const [liveSteps, setLiveSteps] = useState([]); // progress messages so far this turn
  const bottomRef = useRef(null);
  const inputRef = useRef(null);
  const activeRef = useRef(active);
  activeRef.current = active;
  const convsRef = useRef(convs);
  convsRef.current = convs;

  // Only ONLINE assist services can take a turn.
  const assistants = useMemo(
    () => filterServicesByTask(services, TASKS.ASSIST).filter((s) => s.online !== false),
    [services],
  );
  const service =
    assistants.find((s) => s.serviceId === choice) ?? (assistants.length ? assistants[0] : null);
  const model = service?.extras?.model;

  const discover = useCallback(async () => {
    setDiscovering(true);
    try {
      setServices((await client.messages.discoverServices(projectId)) || []);
    } catch (e) {
      console.error('[Assistant] discovery failed', e);
      setServices([]);
    } finally {
      setDiscovering(false);
    }
  }, [client, projectId]);

  useEffect(() => {
    discover();
  }, [discover]);

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
  // way a chat app reopens where you left off. "+" starts a fresh one.
  useEffect(() => {
    let cancelled = false;
    const inFlight = jobInProject(projectId);
    setActive(inFlight ? convOf(inFlight) : null);
    loadList().then(async (metas) => {
      if (cancelled || inFlight || !metas.length) return;
      try {
        const entry = await client.userData.get(userId, convKey(projectId, metas[0].id));
        const v = entry?.value || {};
        if (!cancelled && !activeRef.current) {
          setActive({ id: metas[0].id, messages: v.messages || [], display: v.display || [] });
        }
      } catch {
        /* the empty state is fine */
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

  // Apply `fn` to the active conversation and persist the result.
  const update = useCallback(
    (fn) => {
      const next = fn(activeRef.current);
      activeRef.current = next;
      setActive(next);
      const meta = buildMeta(
        convsRef.current.find((m) => m.id === next.id),
        next,
        service,
      );
      setConvs(upsert(meta));
      persistConv(client, userId, projectId, next, meta);
    },
    [client, userId, projectId, service],
  );

  const open = async (id) => {
    if (active?.id === id) return;
    const j = jobFor(id);
    if (j) {
      setActive(convOf(j));
      return;
    }
    setOpening(id);
    try {
      const entry = await client.userData.get(userId, convKey(projectId, id));
      const v = entry?.value || {};
      setActive({ id, messages: v.messages || [], display: v.display || [] });
    } catch (e) {
      notifyError(humanizeError(e, 'That conversation could not be opened.'));
    } finally {
      setOpening(null);
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
      await Promise.allSettled([
        client.userData.delete(userId, convKey(projectId, id)),
        client.userData.delete(userId, metaKey(projectId, id)),
      ]);
      setConvs((prev) => prev.filter((m) => m.id !== id));
      if (activeRef.current?.id === id) setActive(null);
    } catch (e) {
      notifyError(humanizeError(e, 'The conversation could not be deleted.'));
    }
  };

  const startNew = () => {
    setActive(null);
    setInput('');
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
    const base = activeRef.current || { id: newId(), messages: [], display: [] };
    const conv = {
      ...base,
      messages: [...base.messages, { role: 'user', content: text }],
      display: [...base.display, { kind: 'user', text }],
    };
    const meta = buildMeta(
      convsRef.current.find((m) => m.id === conv.id),
      conv,
      service,
    );
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
          {loadingList ? (
            <div className="px-2 py-3 text-xs text-muted-foreground">Loading…</div>
          ) : convs.length === 0 ? (
            <div className="px-2 py-3 text-xs text-muted-foreground">
              No conversations yet. They are private to you and saved to your account.
            </div>
          ) : (
            convs.map((m) => (
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
                  className="min-w-0 flex-1 text-left"
                >
                  <div className="flex items-center gap-1.5">
                    <MessageSquare className="h-3.5 w-3.5 shrink-0 text-muted-foreground" />
                    <span className="truncate">{m.title || 'Untitled'}</span>
                  </div>
                  <div className="pl-5 text-[11px] text-muted-foreground">
                    {opening === m.id ? 'Opening…' : timeAgo(m.updatedAt)}
                    {m.model ? ` · ${m.model.split('/').pop()}` : ''}
                    {m.pending && !jobFor(m.id) ? ' · unfinished' : ''}
                  </div>
                </button>
                <button
                  type="button"
                  onClick={() => remove(m.id)}
                  title="Delete conversation"
                  className="mt-0.5 rounded p-0.5 text-muted-foreground opacity-0 hover:text-destructive focus:opacity-100 group-hover:opacity-100"
                >
                  <Trash2 className="h-3.5 w-3.5" />
                </button>
              </div>
            ))
          )}
        </div>
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
              <Select value={service.serviceId} onValueChange={setChoice} disabled={!!busy}>
                <SelectTrigger className="h-8 w-auto min-w-48 gap-2 border-none bg-transparent px-2 font-medium shadow-none">
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
                meta={convs.find((m) => m.id === active?.id) || null}
                projectId={projectId}
                projectName={projectName}
              />
            )}
            <Button
              type="button"
              variant="ghost"
              size="sm"
              onClick={discover}
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
                  project and answers with evidence; anything that would change data comes back as a
                  plan for you to approve.
                </div>
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
                </div>
              </div>
            )}
            <div ref={bottomRef} />
          </div>
        </div>

        <div className="border-t px-4 py-3">
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

// Standard chat markdown: GFM (tables, task lists, strikethrough) rendered
// with Tailwind Typography. Tables scroll sideways instead of breaking the
// column; links open in a new tab.
const mdComponents = {
  table: ({ node: _node, ...p }) => (
    <div className="overflow-x-auto">
      <table {...p} />
    </div>
  ),
  a: ({ node: _node, ...p }) => <a target="_blank" rel="noopener noreferrer" {...p} />,
};

export const AssistantMarkdown = ({ children }) => (
  <div className="prose prose-sm max-w-none leading-relaxed dark:prose-invert prose-p:my-3.5 prose-headings:mt-6 prose-headings:mb-2.5 prose-pre:my-3 prose-table:my-4 prose-ul:my-3 prose-ol:my-3 prose-li:my-1 prose-hr:my-5">
    <Markdown remarkPlugins={[remarkGfm]} components={mdComponents}>
      {children}
    </Markdown>
  </div>
);

// ---- export -----------------------------------------------------------------
// The conversation as Markdown: downloaded as a file, or copied.

const ExportMenu = ({ conv, meta, projectId, projectName }) => {
  const build = () =>
    conversationToMarkdown(conv, meta, {
      origin: `${window.location.origin}${window.location.pathname}`,
      projectId,
      projectName,
      summarizeSteps,
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
// The model cites evidence as `{{<document> sN}}` (or `sN.wM` for a word); the
// service resolves each to interlinear data (see citations.py). A citation
// alone on a line becomes an example card in place; one inside a sentence
// becomes a link, and its card is listed under the reply. Citations the
// service could not resolve stay as written.

// Braced citations, plus bare "s32.w16" references (the service resolves
// those only when the turn read a single document; unknown ones stay text).
const CITE_RE = /\{\{?\s*[^{}\n]+?\s+s\d+(?:\.w\d+)?\s*\}\}?|(?<![\w{.])s\d+(?:\.w\d+)?\b/g;

const sentenceHref = (projectId, c) =>
  `#/projects/${projectId}/documents/${c.documentId}?tab=analyze&focusSentence=${c.sentenceId}`;

// The rows of a cited sentence, in the Analyze grid's order (the service
// sends `tiers`; older stored citations without it fall back to the order
// the cells appear in). Rows nobody fills are left out.
export const citationRows = (c) => {
  const words = c.words || [];
  let tiers = c.tiers;
  if (!tiers) {
    tiers = [];
    words.forEach((w) =>
      (w.lines || []).forEach((l) => {
        if (!tiers.some((t) => t.name === l.field)) tiers.push({ name: l.field, kind: 'field' });
      }),
    );
    if (words.some((w) => w.seg)) tiers.unshift({ name: 'Morphemes', kind: 'morphemes' });
  }
  const rows = [{ label: '', kind: 'surface', cells: words.map((w) => w.surface) }];
  for (const t of tiers) {
    const cells =
      t.kind === 'morphemes'
        ? words.map((w) => w.seg || '')
        : words.map((w) => (w.lines || []).find((l) => l.field === t.name)?.value || '');
    if (cells.some(Boolean)) rows.push({ label: t.name, kind: t.kind, cells });
  }
  return rows;
};

export const citationTitle = (c) =>
  `${c.documentName}, sentence ${c.sentence}${c.word ? `, word ${c.word}` : ''}`;

const ExampleCard = ({ c, projectId }) => {
  const words = c.words || [];
  const rows = citationRows(c);
  return (
    <div className="my-3 rounded-lg border bg-muted/30 px-3 py-2 text-sm">
      <div className="mb-1.5 text-xs">
        <a
          href={sentenceHref(projectId, c)}
          target="_blank"
          rel="noopener noreferrer"
          className="inline-flex items-center gap-1.5 font-medium text-foreground hover:underline"
          title="Open this sentence in the editor"
        >
          <ExternalLink className="h-3.5 w-3.5 text-muted-foreground" />
          {citationTitle(c)}
        </a>
      </div>
      <div className="overflow-x-auto">
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
                {r.cells.map((v, j) => (
                  <td
                    key={j}
                    className={cn(
                      'px-1.5 align-top leading-5',
                      r.kind === 'surface' && 'font-medium',
                      r.kind === 'morphemes' && 'font-mono text-xs',
                      r.kind !== 'surface' && r.kind !== 'morphemes' && 'text-xs',
                      c.word === words[j].index && 'bg-primary/15',
                      c.word === words[j].index && i === 0 && 'rounded-t',
                      c.word === words[j].index && i === rows.length - 1 && 'rounded-b',
                    )}
                  >
                    {v}
                  </td>
                ))}
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
// inline-only citations' cards after the text.
const CitedMarkdown = ({ text, citations, projectId }) => {
  const byKey = new Map((citations || []).map((c) => [c.key, c]));
  if (byKey.size === 0) return <AssistantMarkdown>{text}</AssistantMarkdown>;
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
    md.replace(CITE_RE, (m) => {
      const c = byKey.get(m);
      if (!c) return m;
      if (!shown.has(m) && !inline.includes(c)) inline.push(c);
      return `[${citationTitle(c)}](${sentenceHref(projectId, c)})`;
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

const Turn = ({ item, projectId, canWrite, busy, interrupted, onApprove, onDiscard }) => {
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
    return (
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
        {item.steps?.length > 0 && <ToolTrace steps={item.steps} />}
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

// What the assistant did before answering: a one-line summary, expandable to
// the steps, each expandable to what the tool returned.
const ToolTrace = ({ steps }) => {
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
        {summarizeSteps(steps)}
      </button>
      {open && (
        <ol className="mt-1 flex flex-col gap-0.5 border-l pl-3">
          {steps.map((s, i) => (
            <li key={i}>
              <button
                type="button"
                onClick={() => setShown(shown === i ? null : i)}
                className={cn(
                  'flex w-full items-start gap-1 rounded px-1 py-0.5 text-left hover:bg-muted hover:text-foreground',
                  s.error && 'text-destructive',
                )}
                title={s.name}
              >
                {shown === i ? (
                  <ChevronDown className="mt-0.5 h-3 w-3 shrink-0" />
                ) : (
                  <ChevronRight className="mt-0.5 h-3 w-3 shrink-0" />
                )}
                <span>{describeStep(s)}</span>
              </button>
              {shown === i && (
                <pre className="my-1 max-h-72 overflow-auto whitespace-pre-wrap rounded bg-muted p-2 font-mono text-[11px] leading-4 text-foreground">
                  {s.result || '(no output)'}
                </pre>
              )}
            </li>
          ))}
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
