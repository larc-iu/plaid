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
import { cn } from '@/lib/utils';
import { notifySuccess, notifyError, humanizeError } from '@/utils/feedback';

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
    ['search', 'field_values', 'concordance', 'analyses_of', 'check_consistency'].includes(s.name),
  ).length;
  const planned = steps.filter((s) => /^(set_|respell|link_|unlink_|create_)/.test(s.name)).length;
  const parts = [];
  if (docs.size) parts.push(`read ${docs.size} document${docs.size === 1 ? '' : 's'}`);
  if (searches) parts.push(`${searches} search${searches === 1 ? '' : 'es'}`);
  if (planned) parts.push(`${planned} planned change${planned === 1 ? '' : 's'}`);
  const head = parts.length
    ? parts.join(' · ')
    : `${steps.length} step${steps.length === 1 ? '' : 's'}`;
  return parts.length ? `${head} · ${steps.length} step${steps.length === 1 ? '' : 's'}` : head;
};

// --- turns that outlive the component ------------------------------------------
// A turn can take minutes, and meanwhile the user may switch tabs (which
// unmounts this component) or a dev reload may remount it. So a turn runs
// here, at module level, persists its own outcome, and the component only
// subscribes to whatever is in flight for the conversation it shows.
const saveQueues = new Map(); // conversation id -> Promise (writes in order)
const turns = new Map(); // conversation id -> turn in flight
const turnListeners = new Set(); // mounted components

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
    });
  saveQueues.set(conv.id, next);
  return next;
};

const notifyTurn = (t) => turnListeners.forEach((fn) => fn(t));

// Run one turn for `conv`, whose last message is the user's. The outcome
// (the assistant's reply, or an error item) is persisted here, then handed to
// whichever component is mounted.
const startTurn = ({ client, userId, projectId, service, conv, prevMeta }) => {
  const t = {
    id: conv.id,
    projectId,
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
          notifyTurn(t);
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
    persistConv(client, userId, projectId, next, meta);
    t.done = true;
    t.result = { conv: next, meta };
    turns.delete(conv.id);
    notifyTurn(t);
    return t.result;
  })();
  return t;
};

const EXAMPLES = [
  'Which words in this project are still unglossed?',
  'Are the glosses for the most common suffix consistent?',
  'Summarize the noun morphology you can see in the corpus.',
];

export const ProjectAssistant = ({ projectId, client, userId, canWrite }) => {
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

  // On mount: a turn still running for this project (we were unmounted
  // mid-turn) is shown first; otherwise the most recent conversation, the
  // way a chat app reopens where you left off. "+" starts a fresh one.
  useEffect(() => {
    let cancelled = false;
    const inFlight = [...turns.values()].find((t) => t.projectId === projectId);
    setActive(inFlight ? inFlight.conv : null);
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

  // Reflect turns as they progress and finish, for whichever conversation
  // is shown; finished turns always refresh the sidebar entry.
  useEffect(() => {
    const onTurn = (t) => {
      if (t.done) setConvs(upsert(t.result.meta));
      if (activeRef.current?.id !== t.id) return;
      if (t.done) {
        activeRef.current = t.result.conv;
        setActive(t.result.conv);
        setBusy(null);
        setProgress('');
        setLiveSteps([]);
        inputRef.current?.focus();
      } else {
        setBusy('turn');
        setProgress(t.progress);
        setLiveSteps(t.steps);
      }
    };
    turnListeners.add(onTurn);
    return () => turnListeners.delete(onTurn);
  }, []);

  // Switching conversations: pick up a turn in flight for the new one.
  useEffect(() => {
    const t = active ? turns.get(active.id) : null;
    if (t) {
      setBusy('turn');
      setProgress(t.progress);
      setLiveSteps(t.steps);
    } else if (busy === 'turn') {
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
    if (busy === 'apply' || active?.id === id) return;
    const t = turns.get(id);
    if (t) {
      setActive(t.conv);
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
    if (turns.has(id)) {
      notifyError('That conversation is still waiting for an answer.');
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
    if (busy === 'apply') return;
    setActive(null);
    setInput('');
    inputRef.current?.focus();
  };

  // --- turns -----------------------------------------------------------------
  useEffect(() => {
    bottomRef.current?.scrollIntoView({ block: 'end' });
  }, [active?.display.length, busy, progress]);

  const send = (textOverride) => {
    const text = (textOverride ?? input).trim();
    if (!text || !service || busy) return;
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

  // The plan's outcome is told to the model as a user-role note, so the next
  // turn knows whether its proposal happened.
  const settlePlan = (index, status, note) =>
    update((c) => ({
      ...c,
      messages: [...c.messages, { role: 'user', content: note }],
      display: c.display.map((d, i) => (i === index ? { ...d, status } : d)),
    }));

  const approve = async (index, plan) => {
    if (busy) return;
    setBusy('apply');
    setProgress('Applying changes…');
    try {
      await client.messages.requestService(
        projectId,
        service.serviceId,
        { projectId, approve: { ops: plan.ops, label: `Assistant: ${plan.summary}` } },
        TURN_TIMEOUT_MS,
        (p) => setProgress(p?.message || ''),
      );
      settlePlan(index, 'applied', `(note) The plan was approved and applied: ${plan.summary}.`);
      notifySuccess(`Applied ${plan.summary}.`, 'Changes applied');
    } catch (e) {
      notifyError(humanizeError(e, 'The changes could not be applied.'), 'Not applied');
    } finally {
      setBusy(null);
      setProgress('');
    }
  };

  const discard = (index) =>
    settlePlan(index, 'discarded', '(note) The user discarded the plan; nothing was changed.');

  const onKeyDown = (e) => {
    if (e.key === 'Enter' && !e.shiftKey) {
      e.preventDefault();
      send();
    }
  };

  const display = active?.display || [];
  const pendingPlan = display.some((d) => d.plan && d.status === null);

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
            disabled={!!busy}
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
                  disabled={!!busy}
                  className="min-w-0 flex-1 text-left"
                >
                  <div className="flex items-center gap-1.5">
                    <MessageSquare className="h-3.5 w-3.5 shrink-0 text-muted-foreground" />
                    <span className="truncate">{m.title || 'Untitled'}</span>
                  </div>
                  <div className="pl-5 text-[11px] text-muted-foreground">
                    {opening === m.id ? 'Opening…' : timeAgo(m.updatedAt)}
                    {m.model ? ` · ${m.model.split('/').pop()}` : ''}
                  </div>
                </button>
                <button
                  type="button"
                  onClick={() => remove(m.id)}
                  disabled={!!busy}
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
                      disabled={!service}
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
                canWrite={canWrite}
                busy={!!busy}
                onApprove={() => approve(i, d.plan)}
                onDiscard={() => discard(i)}
              />
            ))}
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
                  : pendingPlan
                    ? 'Approve or discard the plan above, or keep talking'
                    : 'Message the assistant… (Enter to send, Shift+Enter for a new line)'
              }
              disabled={!service || !!busy}
              rows={2}
              className="min-h-[2.5rem] flex-1 resize-none border-0 bg-transparent p-1 shadow-none focus-visible:ring-0"
            />
            <Button
              type="button"
              size="sm"
              onClick={() => send()}
              disabled={!service || !!busy || !input.trim()}
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
  <div className="prose prose-sm max-w-none dark:prose-invert prose-p:my-2 prose-headings:mt-4 prose-headings:mb-2 prose-pre:my-2 prose-table:my-2 prose-li:my-0.5">
    <Markdown remarkPlugins={[remarkGfm]} components={mdComponents}>
      {children}
    </Markdown>
  </div>
);

const Turn = ({ item, canWrite, busy, onApprove, onDiscard }) => {
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
          <AssistantMarkdown>{item.text}</AssistantMarkdown>
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
const PlanCard = ({ plan, status, canWrite, busy, onApprove, onDiscard }) => {
  const labels = plan.labels || [];
  const [expanded, setExpanded] = useState(labels.length <= 12);
  const shown = expanded ? labels : labels.slice(0, 12);
  return (
    <div
      className={cn(
        'rounded-lg border px-3 py-2 text-sm',
        status === null && 'border-primary/40 bg-primary/5',
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
      </div>
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
      {status === null && (
        <div className="mt-2 flex items-center gap-2">
          {canWrite ? (
            <Button type="button" size="sm" onClick={onApprove} disabled={busy}>
              <Check className="h-4 w-4" /> Approve and apply
            </Button>
          ) : (
            <span className="text-muted-foreground">Applying needs write access.</span>
          )}
          <Button type="button" size="sm" variant="outline" onClick={onDiscard} disabled={busy}>
            <X className="h-4 w-4" /> Discard
          </Button>
        </div>
      )}
    </div>
  );
};
