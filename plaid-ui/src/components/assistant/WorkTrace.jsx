import { useEffect, useId, useState } from 'react';
import { Check, ChevronDown, ChevronRight, Copy, Wrench } from 'lucide-react';
import { cn } from '../../lib/utils.js';
import { AssistantMarkdown } from './AssistantMarkdown.jsx';
import { useExport } from './exportContext.js';
import { callInput, callOf, foldReads, runLabel } from './rounds.js';

// What the assistant did for one turn, in the order it happened: the text it
// wrote between its tool calls, and each call, which opens to what it was
// asked (Input) and exactly what the tool returned to the model (Output),
// read from the turn's stored rounds (rounds.js). Drawn the same live, while
// the turn runs, and after, for an answer, a failure or a stop.
//
// `steps` are the turn's steps (plaid_agent/core/trace.py), `summary` the
// line it collapses to, `partial` text written after the last step (a turn
// that stopped or failed mid-sentence), `rounds` the conversation's round
// reader, `firstRound` the round holding the question as received. A step
// opens only when its round is stored: `live` steps say so with `stored`.

const MUTED = 'text-xs text-muted-foreground';
const PRE =
  'max-h-72 overflow-auto whitespace-pre-wrap break-words rounded bg-muted p-2 font-mono text-[11px] leading-4 text-foreground';

const CUT_LINE = 'Cut at 12,000 characters.';
const NOT_STORED = 'Output not stored.';
const GONE = 'This conversation was deleted.';

// A disclosure: a button that says whether it is open and which region it
// opens, and the region under it.
const Disclosure = ({ label, title, className, open: startOpen = false, children }) => {
  const [open, setOpen] = useState(startOpen);
  const id = useId();
  return (
    <div>
      <button
        type="button"
        aria-expanded={open}
        aria-controls={id}
        onClick={() => setOpen((o) => !o)}
        title={title}
        className={cn(
          'flex w-full items-start gap-1 rounded px-1 py-0.5 text-left hover:bg-muted hover:text-foreground',
          className,
        )}
      >
        {open ? (
          <ChevronDown className="mt-0.5 h-3 w-3 shrink-0" />
        ) : (
          <ChevronRight className="mt-0.5 h-3 w-3 shrink-0" />
        )}
        <span className="min-w-0 [overflow-wrap:anywhere]">{label}</span>
      </button>
      <div id={id} hidden={!open}>
        {open && children}
      </div>
    </div>
  );
};

// The same disclosure in the web page export, which runs no script.
const Details = ({ label, className, children }) => (
  <details>
    <summary
      className={cn(
        'flex cursor-pointer list-none items-start gap-1 rounded px-1 py-0.5',
        className,
      )}
    >
      <ChevronRight className="plaid-export-chevron mt-0.5 h-3 w-3 shrink-0" />
      <span className="min-w-0 [overflow-wrap:anywhere]">{label}</span>
    </summary>
    {children}
  </details>
);

const CopyButton = ({ text }) => {
  const [done, setDone] = useState(false);
  useEffect(() => {
    if (!done) return undefined;
    const t = setTimeout(() => setDone(false), 1500);
    return () => clearTimeout(t);
  }, [done]);
  return (
    <button
      type="button"
      onClick={() =>
        navigator.clipboard?.writeText(text).then(
          () => setDone(true),
          () => {},
        )
      }
      className="flex items-center gap-1 rounded px-1 py-0.5 hover:bg-muted hover:text-foreground"
    >
      {done ? <Check className="h-3 w-3" /> : <Copy className="h-3 w-3" />}
      Copy
    </button>
  );
};

// A block of text as it was: monospace, scrollable, with Copy. A block
// that is the whole of its disclosure needs no heading of its own.
const Block = ({ heading, text, after, exported }) => (
  <div className="my-1 flex flex-col gap-0.5">
    <div className={cn('flex items-center gap-2', heading ? 'justify-between' : 'justify-end')}>
      {heading && <span className="font-medium">{heading}</span>}
      {!exported && <CopyButton text={text} />}
    </div>
    <pre className={PRE}>{text}</pre>
    {after && <span>{after}</span>}
  </div>
);

const InputBlock = ({ call, exported }) => {
  const input = callInput(call.name, call.arguments);
  const lines = (input.lines || []).map(([k, v]) => `${k}: ${v}`).join('\n');
  if (input.raw !== undefined)
    return <Block heading="Input" text={input.raw} exported={exported} />;
  const main = input.code ?? input.query;
  if (main !== undefined)
    return (
      <>
        <Block heading="Input" text={main} exported={exported} />
        {lines && <pre className={PRE}>{lines}</pre>}
      </>
    );
  return lines ? <Block heading="Input" text={lines} exported={exported} /> : null;
};

// One call's input and output, once its round is read.
const CallDetail = ({ call, exported }) => (
  <div className="mb-1 ml-4 flex flex-col">
    <InputBlock call={call} exported={exported} />
    <Block
      heading="Output"
      text={call.result ?? ''}
      after={call.cut ? CUT_LINE : null}
      exported={exported}
    />
  </div>
);

// Reads a round when it is opened. `pick` takes what to show from it.
const useRound = (rounds, id, gone) => {
  const [state, setState] = useState(() => {
    const had = id && rounds?.peek?.(id);
    return had ? { round: had } : { loading: !!id };
  });
  useEffect(() => {
    if (!id || !rounds || state.round) return undefined;
    let live = true;
    rounds.round(id).then(
      (round) => live && setState(round ? { round } : { missing: gone ? GONE : NOT_STORED }),
      () => live && setState({ missing: NOT_STORED }),
    );
    return () => {
      live = false;
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [id, rounds]);
  return state;
};

const RoundStatus = ({ state }) =>
  state.missing ? <p className="mb-1 ml-4">{state.missing}</p> : <p className="mb-1 ml-4">…</p>;

const StepDetail = ({ step, rounds, gone }) => {
  const state = useRound(rounds, step.round, gone);
  const call = callOf(state.round, step);
  if (!state.round) return <RoundStatus state={state} />;
  if (!call) return <p className="mb-1 ml-4">{NOT_STORED}</p>;
  return <CallDetail call={call} />;
};

// Whether a step's round can be read: it names one, the service wrote it,
// and, while the turn runs, it is stored already.
const openable = (step, live) => !!step.round && !step.unstored && (!live || !!step.stored);

const StepRow = ({ step, rounds, live, gone, exported }) => {
  const className = cn(step.failed && 'text-destructive');
  if (exported) {
    const call = openable(step, false) ? callOf(rounds?.peek?.(step.round), step) : null;
    if (!call) return <div className={cn('px-1 py-0.5 pl-5', className)}>{step.label}</div>;
    return (
      <Details label={step.label} className={className}>
        <CallDetail call={call} exported />
      </Details>
    );
  }
  if (!rounds || !openable(step, live))
    return (
      <div
        className={cn('px-1 py-0.5 pl-5 [overflow-wrap:anywhere]', className)}
        title={step.unstored ? NOT_STORED : undefined}
      >
        {step.label}
      </div>
    );
  return (
    <Disclosure label={step.label} className={className} title={step.name}>
      <StepDetail step={step} rounds={rounds} gone={gone} />
    </Disclosure>
  );
};

// The text the model wrote between calls, in muted type above the steps it
// preceded.
const Said = ({ text }) => (
  <div dir="auto" className="py-1 pl-1 text-muted-foreground [&_*]:text-muted-foreground">
    <AssistantMarkdown>{text}</AssistantMarkdown>
  </div>
);

// The question as the model received it, and the instructions it was given,
// each read when it is opened.
const Received = ({ rounds, id, gone }) => (
  <>
    <Disclosure label="Message as received">
      <Asked rounds={rounds} id={id} gone={gone} />
    </Disclosure>
    <Disclosure label="Instructions">
      <PromptOf rounds={rounds} id={id} gone={gone} />
    </Disclosure>
  </>
);

const Asked = ({ rounds, id, gone }) => {
  const state = useRound(rounds, id, gone);
  if (!state.round) return <RoundStatus state={state} />;
  return (
    <div className="mb-1 ml-4">
      <Block text={state.round.asked ?? ''} />
    </div>
  );
};

const PromptOf = ({ rounds, id, gone }) => {
  const state = useRound(rounds, id, gone);
  if (!state.round) return <RoundStatus state={state} />;
  if (!state.round.prompt) return <p className="mb-1 ml-4">{NOT_STORED}</p>;
  return <Instructions rounds={rounds} hash={state.round.prompt} gone={gone} />;
};

const Instructions = ({ rounds, hash, gone }) => {
  const [state, setState] = useState(() => {
    const had = rounds?.peekPrompt?.(hash);
    return had ? { prompt: had } : {};
  });
  useEffect(() => {
    if (state.prompt) return undefined;
    let live = true;
    rounds.prompt(hash).then(
      (prompt) => live && setState(prompt ? { prompt } : { missing: gone ? GONE : NOT_STORED }),
      () => live && setState({ missing: NOT_STORED }),
    );
    return () => {
      live = false;
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [hash, rounds]);
  if (!state.prompt) return <RoundStatus state={state} />;
  return (
    <div className="mb-1 ml-4 flex flex-col">
      <Block heading="System prompt" text={state.prompt.system ?? ''} />
      <Block heading="Tools" text={state.prompt.tools ?? ''} />
    </div>
  );
};

// The steps in order, with the text before each, runs of reads folded.
export const TraceSteps = ({ steps, partial, rounds, live = false, gone = false, firstRound }) => {
  const exported = !!useExport();
  const rows = foldReads(steps);
  const row = (s) => (
    <li key={s.id}>
      {s.said && <Said text={s.said} />}
      <StepRow step={s} rounds={rounds} live={live} gone={gone} exported={exported} />
    </li>
  );
  const firstOpenable =
    firstRound && (!live || (steps || []).some((s) => s.round === firstRound && s.stored));
  return (
    <ol className="mt-1 flex flex-col gap-0.5 border-l pl-3">
      {rounds && firstOpenable && !exported && (
        <li>
          <Received rounds={rounds} id={firstRound} gone={gone} />
        </li>
      )}
      {rows.map((r, i) =>
        r.step ? (
          row(r.step)
        ) : (
          <li key={`run-${i}`}>
            {r.run[0].said && <Said text={r.run[0].said} />}
            {exported ? (
              <Details label={runLabel(r.run)}>
                <ol className="ml-3 flex flex-col gap-0.5 border-l pl-3">
                  {r.run.map((s) => (
                    <li key={s.id}>
                      <StepRow step={s} rounds={rounds} exported />
                    </li>
                  ))}
                </ol>
              </Details>
            ) : (
              <Disclosure label={runLabel(r.run)}>
                <ol className="ml-3 flex flex-col gap-0.5 border-l pl-3">
                  {r.run.map((s) => (
                    <li key={s.id}>
                      <StepRow step={s} rounds={rounds} live={live} gone={gone} />
                    </li>
                  ))}
                </ol>
              </Disclosure>
            )}
          </li>
        ),
      )}
      {partial && (
        <li>
          <Said text={partial} />
        </li>
      )}
    </ol>
  );
};

// The summary line, opening to the turn's work.
export const WorkTrace = ({ steps, summary, partial, rounds, gone, firstRound, open = false }) => {
  const exported = !!useExport();
  const [shown, setShown] = useState(open);
  // A turn that landed in the tab that watched it stays open there.
  useEffect(() => {
    if (open) setShown(true);
  }, [open]);
  const id = useId();
  const label = (
    <>
      <Wrench className="h-3 w-3 shrink-0" />
      {summary}
    </>
  );
  const body = (
    <TraceSteps
      steps={steps}
      partial={partial}
      rounds={rounds}
      gone={gone}
      firstRound={firstRound}
    />
  );
  if (exported)
    return (
      <details className={MUTED}>
        <summary className="flex w-fit cursor-pointer list-none items-center gap-1 rounded px-1 py-0.5">
          <ChevronRight className="plaid-export-chevron h-3 w-3" />
          {label}
        </summary>
        {body}
      </details>
    );
  return (
    <div className={MUTED}>
      <button
        type="button"
        aria-expanded={shown}
        aria-controls={id}
        onClick={() => setShown((o) => !o)}
        className="flex items-center gap-1 rounded px-1 py-0.5 text-left hover:bg-muted hover:text-foreground"
      >
        {shown ? (
          <ChevronDown className="h-3 w-3 shrink-0" />
        ) : (
          <ChevronRight className="h-3 w-3 shrink-0" />
        )}
        {label}
      </button>
      <div id={id} hidden={!shown}>
        {shown && body}
      </div>
    </div>
  );
};
