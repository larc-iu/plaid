import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { Bot, Send, RotateCcw, Check, X, Loader2 } from 'lucide-react';
import Markdown from 'react-markdown';
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
import { mdComponents } from '../../documents/services/ServiceSummary.jsx';

// The Assistant tab: a chat with whatever `assist` service the operator runs
// (see ../../../../../plaid-igt-agent). The browser owns the conversation: it
// keeps the model-facing transcript (`messages`, including the assistant's
// tool calls and their results, so a later turn can build on an earlier one)
// and sends the whole thing with every turn, so the service is stateless.
// The assistant never writes during a turn; a turn that would change data
// comes back with a plan, shown here as a list of concrete changes with
// Approve / Discard. Approving sends the plan back for the service to apply
// under the user's own account (the service delegates, so Plaid mints the
// user a short-lived token per request).
//
// The conversation survives tab switches and reloads via sessionStorage, per
// project, and is dropped with "New conversation".

const TURN_TIMEOUT_MS = 30 * 60 * 1000;
const storageKey = (projectId) => `igt:assistant:${projectId}`;

const readSaved = (projectId) => {
  try {
    const raw = sessionStorage.getItem(storageKey(projectId));
    const v = raw ? JSON.parse(raw) : null;
    if (v && Array.isArray(v.messages) && Array.isArray(v.display)) return v;
  } catch {
    /* ignore */
  }
  return { messages: [], display: [] };
};

const writeSaved = (projectId, state) => {
  try {
    sessionStorage.setItem(storageKey(projectId), JSON.stringify(state));
  } catch {
    /* ignore */
  }
};

export const ProjectAssistant = ({ projectId, client, canWrite }) => {
  const [services, setServices] = useState([]);
  const [discovering, setDiscovering] = useState(true);
  const [choice, setChoice] = useState(null);
  const [saved, setSaved] = useState(() => readSaved(projectId));
  const [input, setInput] = useState('');
  const [busy, setBusy] = useState(null); // null | 'turn' | 'apply'
  const [progress, setProgress] = useState('');
  const bottomRef = useRef(null);
  const inputRef = useRef(null);

  const { messages, display } = saved;
  const update = useCallback(
    (fn) => {
      setSaved((prev) => {
        const next = fn(prev);
        writeSaved(projectId, next);
        return next;
      });
    },
    [projectId],
  );

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

  useEffect(() => {
    bottomRef.current?.scrollIntoView({ block: 'end' });
  }, [display.length, busy, progress]);

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

  const send = async () => {
    const text = input.trim();
    if (!text || !service || busy) return;
    setInput('');
    const userMsg = { role: 'user', content: text };
    update((s) => ({
      messages: [...s.messages, userMsg],
      display: [...s.display, { kind: 'user', text }],
    }));
    setBusy('turn');
    setProgress('Thinking…');
    try {
      const result = await request({ messages: [...messages, userMsg] });
      if (result?.kind !== 'turn') throw new Error('Unexpected reply from the assistant service');
      update((s) => ({
        messages: [...s.messages, ...(result.messages || [])],
        display: [
          ...s.display,
          {
            kind: 'assistant',
            text: result.message || '',
            plan: result.plan || null,
            status: null,
          },
        ],
      }));
    } catch (e) {
      const msg = humanizeError(e, 'The assistant could not answer.');
      update((s) => ({
        // Drop the failed user turn from the model transcript so a retry
        // does not send it twice; keep it visible with the error.
        messages: s.messages.slice(0, -1),
        display: [...s.display, { kind: 'error', text: msg }],
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
    update((s) => ({
      messages: [...s.messages, { role: 'user', content: note }],
      display: s.display.map((d, i) => (i === index ? { ...d, status } : d)),
    }));

  const approve = async (index, plan) => {
    if (busy) return;
    setBusy('apply');
    setProgress('Applying changes…');
    try {
      await request({
        approve: { ops: plan.ops, label: `Assistant: ${plan.summary}` },
      });
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

  const reset = () => {
    if (busy) return;
    update(() => ({ messages: [], display: [] }));
    setInput('');
    inputRef.current?.focus();
  };

  const onKeyDown = (e) => {
    if (e.key === 'Enter' && !e.shiftKey) {
      e.preventDefault();
      send();
    }
  };

  const pendingPlan = display.some((d) => d.plan && d.status === null);

  return (
    <div className="tw flex flex-col gap-3">
      <div className="flex flex-wrap items-center gap-2 rounded-lg border bg-card px-3 py-2 text-sm">
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
            {assistants.length > 1 ? (
              <Select value={service.serviceId} onValueChange={setChoice}>
                <SelectTrigger className="h-8 w-56">
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
            ) : (
              <span className="font-medium">{service.serviceName}</span>
            )}
            {model && <Badge variant="secondary">{model}</Badge>}
            {!canWrite && (
              <span className="text-muted-foreground">
                Read-only access: you can ask questions, but plans cannot be applied.
              </span>
            )}
          </>
        )}
        <div className="ml-auto flex items-center gap-1">
          <Button type="button" variant="ghost" size="sm" onClick={discover} disabled={discovering}>
            <RotateCcw className={cn('h-4 w-4', discovering && 'animate-spin')} />
            <span className="sr-only">Refresh services</span>
          </Button>
          {display.length > 0 && (
            <Button type="button" variant="outline" size="sm" onClick={reset} disabled={!!busy}>
              New conversation
            </Button>
          )}
        </div>
      </div>

      <div className="flex min-h-64 flex-col gap-3 rounded-lg border bg-card p-4">
        {display.length === 0 && (
          <div className="text-sm text-muted-foreground">
            Ask about the corpus or the lexicon, or ask for changes. The assistant reads the project
            and answers with evidence; anything that would change data comes back as a plan for you
            to approve. Examples: “Which words in Text 3 are still unglossed?”, “Are the glosses for
            -di consistent across the project?”, “Gloss every ‘kar’ as ‘do’ and link it to the entry
            kar”.
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
            {progress || (busy === 'apply' ? 'Applying changes…' : 'Thinking…')}
          </div>
        )}
        <div ref={bottomRef} />
      </div>

      <div className="flex items-end gap-2">
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
                : 'Ask the assistant… (Enter to send, Shift+Enter for a new line)'
          }
          disabled={!service || !!busy}
          rows={2}
          className="min-h-[2.5rem] flex-1"
        />
        <Button type="button" onClick={send} disabled={!service || !!busy || !input.trim()}>
          <Send className="h-4 w-4" /> Send
        </Button>
      </div>
    </div>
  );
};

const Turn = ({ item, canWrite, busy, onApprove, onDiscard }) => {
  if (item.kind === 'user') {
    return (
      <div className="ml-8 self-end whitespace-pre-wrap rounded-lg bg-primary px-3 py-2 text-sm text-primary-foreground">
        {item.text}
      </div>
    );
  }
  if (item.kind === 'error') {
    return (
      <div
        role="alert"
        className="mr-8 rounded-lg border border-destructive/40 bg-destructive/10 px-3 py-2 text-sm text-destructive"
      >
        {item.text}
      </div>
    );
  }
  return (
    <div className="mr-8 flex flex-col gap-2">
      {item.text && (
        <div className="rounded-lg bg-muted px-3 py-2 text-sm">
          <Markdown components={mdComponents}>{item.text}</Markdown>
        </div>
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
  );
};

// A proposed plan: what it does in one line, every change as a row, and the
// decision. Once settled it stays in the transcript as a record.
const PlanCard = ({ plan, status, canWrite, busy, onApprove, onDiscard }) => {
  const labels = plan.labels || [];
  return (
    <div
      className={cn(
        'rounded-lg border px-3 py-2 text-sm',
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
        {labels.map((l, i) => (
          <li key={i}>{l}</li>
        ))}
      </ol>
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
