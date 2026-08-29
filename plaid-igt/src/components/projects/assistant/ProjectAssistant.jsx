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
  const bottomRef = useRef(null);
  const inputRef = useRef(null);
  const activeRef = useRef(active);
  activeRef.current = active;
  const convsRef = useRef(convs);
  convsRef.current = convs;
  // Saves run one after another: two overlapping PUTs could otherwise land
  // out of order and leave the older transcript on the server.
  const saveQueue = useRef(Promise.resolve());

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
    if (!userId) return;
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
    } catch (e) {
      console.error('[Assistant] could not load conversations', e);
      notifyError(humanizeError(e, 'Past conversations could not be loaded.'));
    } finally {
      setLoadingList(false);
    }
  }, [client, userId, projectId]);

  useEffect(() => {
    loadList();
    setActive(null);
  }, [loadList]);

  // Write the active conversation (transcript + sidebar entry). Called after
  // every change to it; the sidebar list is updated in place so it never
  // waits on a re-fetch.
  const persist = useCallback(
    (conv, meta) => {
      if (!userId) return;
      setConvs((prev) => [meta, ...prev.filter((m) => m.id !== meta.id)]);
      saveQueue.current = saveQueue.current.then(async () => {
        try {
          await client.userData.put(userId, convKey(projectId, conv.id), {
            messages: conv.messages,
            display: conv.display,
          });
          await client.userData.put(userId, metaKey(projectId, conv.id), meta);
        } catch (e) {
          console.error('[Assistant] could not save the conversation', e);
          notifyError(humanizeError(e, 'The conversation could not be saved.'));
        }
      });
    },
    [client, userId, projectId],
  );

  // Apply `fn` to the active conversation and persist the result.
  const update = useCallback(
    (fn) => {
      const cur = activeRef.current;
      const next = fn(cur);
      activeRef.current = next;
      setActive(next);
      const firstUser = next.display.find((d) => d.kind === 'user');
      const prevMeta = convsRef.current.find((m) => m.id === next.id);
      persist(next, {
        id: next.id,
        title: prevMeta?.title || (firstUser ? titleFrom(firstUser.text) : 'New conversation'),
        createdAt: prevMeta?.createdAt || new Date().toISOString(),
        updatedAt: new Date().toISOString(),
        serviceId: service?.serviceId || prevMeta?.serviceId || null,
        model: model || prevMeta?.model || null,
        turns: next.display.filter((d) => d.kind === 'user').length,
      });
    },
    [persist, service, model],
  );

  const open = async (id) => {
    if (busy || active?.id === id) return;
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
    if (busy) return;
    try {
      await Promise.allSettled([
        client.userData.delete(userId, convKey(projectId, id)),
        client.userData.delete(userId, metaKey(projectId, id)),
      ]);
      setConvs((prev) => prev.filter((m) => m.id !== id));
      if (active?.id === id) setActive(null);
    } catch (e) {
      notifyError(humanizeError(e, 'The conversation could not be deleted.'));
    }
  };

  const startNew = () => {
    if (busy) return;
    setActive(null);
    setInput('');
    inputRef.current?.focus();
  };

  // --- turns -----------------------------------------------------------------
  useEffect(() => {
    bottomRef.current?.scrollIntoView({ block: 'end' });
  }, [active?.display.length, busy, progress]);

  const request = useCallback(
    (data) =>
      client.messages.requestService(
        projectId,
        service.serviceId,
        { projectId, ...data },
        TURN_TIMEOUT_MS,
        (p) => setProgress(p?.message || ''),
      ),
    [client, projectId, service],
  );

  const send = async (textOverride) => {
    const text = (textOverride ?? input).trim();
    if (!text || !service || busy) return;
    setInput('');
    if (!activeRef.current) {
      activeRef.current = { id: newId(), messages: [], display: [] };
      setActive(activeRef.current);
    }
    const userMsg = { role: 'user', content: text };
    const priorMessages = activeRef.current.messages;
    update((c) => ({
      ...c,
      messages: [...c.messages, userMsg],
      display: [...c.display, { kind: 'user', text }],
    }));
    setBusy('turn');
    setProgress('Thinking…');
    try {
      const result = await request({ messages: [...priorMessages, userMsg] });
      if (result?.kind !== 'turn') throw new Error('Unexpected reply from the assistant service');
      update((c) => ({
        ...c,
        messages: [...c.messages, ...(result.messages || [])],
        display: [
          ...c.display,
          {
            kind: 'assistant',
            text: result.message || '',
            plan: result.plan || null,
            status: null,
            model,
          },
        ],
      }));
    } catch (e) {
      const msg = humanizeError(e, 'The assistant could not answer.');
      update((c) => ({
        ...c,
        // Drop the failed user turn from the model transcript so a retry
        // does not send it twice; keep it visible with the error.
        messages: c.messages.slice(0, -1),
        display: [...c.display, { kind: 'error', text: msg }],
      }));
    } finally {
      setBusy(null);
      setProgress('');
      inputRef.current?.focus();
    }
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
      await request({ approve: { ops: plan.ops, label: `Assistant: ${plan.summary}` } });
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
              <div className="flex items-center gap-2 text-sm text-muted-foreground">
                <Loader2 className="h-4 w-4 animate-spin" />
                <span className="animate-pulse">
                  {progress || (busy === 'apply' ? 'Applying changes…' : 'Thinking…')}
                </span>
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
        {item.text && <AssistantMarkdown>{item.text}</AssistantMarkdown>}
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
