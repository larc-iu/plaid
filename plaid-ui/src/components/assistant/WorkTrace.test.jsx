import { describe, it, expect, vi } from 'vitest';
import { renderComponent, all, byText } from '../../test/renderComponent.jsx';
import { TraceSteps, WorkTrace } from './WorkTrace.jsx';
import { Turn } from './Turn.jsx';
import { foldReads, roundReader, runLabel } from './rounds.js';
import { conversationToMarkdown } from './exportMarkdown.js';

// What a turn did, drawn from its steps and opened to its stored rounds:
// the text between calls without a click, each call's input and exactly what
// the tool returned (design/TRANSPARENCY.md).

const CONLLU = '# sent_id = 3\n1\tkitab\tkitab\tNOUN\t_\t_\t0\troot\t_\t_';
const CODE = 'docs = load_all()\nprint(len(docs))';

const ROUND = {
  id: 'r1',
  n: 1,
  asked: '[In "Text 1"] Which verbs?',
  prompt: 'h1',
  calls: [
    {
      id: 'c1',
      name: 'read_document',
      arguments: '{"document": "Text 1", "sentences": [3]}',
      result: CONLLU,
    },
    {
      id: 'c2',
      name: 'run_code',
      arguments: JSON.stringify({ code: CODE }),
      result: '40\n',
      cut: true,
    },
  ],
};

const STEPS = [
  {
    id: 'c1',
    name: 'read_document',
    kind: 'document',
    document: 'Text 1',
    label: 'Read “Text 1”: sentence 3 of 12',
    round: 'r1',
    said: 'Let me read the sentence.',
    saw: [{ n: 1, unit: 'sentence', of: 12, which: '3' }],
  },
  { id: 'c2', name: 'run_code', kind: 'read', label: 'Read across the corpus', round: 'r1' },
];

let n = 0;
const reader = (values, gone = false) => {
  const read = vi.fn(async (key) => values[key.split(':').at(-1)] ?? null);
  // A conversation of its own per test, since rounds are kept for the page's life.
  n += 1;
  return {
    read,
    rounds: roundReader(read, { app: 'igt', projectId: 'p1', convId: `c${n}` }),
    gone,
  };
};

const texts = (root, sel) => all(root, sel).map((e) => e.textContent);

describe('WorkTrace', () => {
  it('shows the text between calls without a click, in order, above its step', async () => {
    const { rounds } = reader({ r1: ROUND });
    const view = await renderComponent(
      <WorkTrace
        steps={STEPS}
        summary="read 1 sentence in 1 document · 2 steps"
        rounds={rounds}
        open
      />,
    );
    const body = view.container.textContent;
    expect(body.indexOf('Let me read the sentence.')).toBeGreaterThan(-1);
    expect(body.indexOf('Let me read the sentence.')).toBeLessThan(body.indexOf('Read “Text 1”'));
    expect(body.indexOf('Read “Text 1”')).toBeLessThan(body.indexOf('Read across the corpus'));
    await view.unmount();
  });

  it('is a real disclosure that opens a step to its input and output, read once per round', async () => {
    const { read, rounds } = reader({ r1: ROUND });
    const view = await renderComponent(
      <WorkTrace steps={STEPS} summary="2 steps" rounds={rounds} />,
    );
    const top = byText(view.container, 'button', '2 steps');
    expect(top.getAttribute('aria-expanded')).toBe('false');
    await view.step(() => top.click());
    expect(top.getAttribute('aria-expanded')).toBe('true');
    const one = byText(view.container, 'button', 'Read “Text 1”: sentence 3 of 12');
    await view.step(() => one.click());
    await view.step(() => byText(view.container, 'button', 'Read across the corpus').click());
    expect(one.getAttribute('aria-expanded')).toBe('true');
    expect(document.getElementById(one.getAttribute('aria-controls'))).not.toBeNull();
    const pres = texts(view.container, 'pre');
    expect(pres).toContain('document: Text 1\nsentences: [\n  3\n]');
    expect(pres).toContain(CONLLU);
    expect(pres).toContain(CODE);
    expect(pres).toContain('40\n');
    expect(view.container.textContent).toContain('Cut at 12,000 characters.');
    expect(texts(view.container, 'span')).toContain('Output');
    expect(read).toHaveBeenCalledTimes(1);
    await view.unmount();
  });

  it('has no opener for a step whose round is not stored, or not yet while the turn runs', async () => {
    const { read, rounds } = reader({ r1: ROUND });
    const steps = [
      { ...STEPS[0], unstored: true },
      { ...STEPS[1], round: 'r2' },
    ];
    const view = await renderComponent(<TraceSteps steps={steps} rounds={rounds} live />);
    expect(all(view.container, 'button')).toHaveLength(0);
    expect(view.container.querySelector('[title="Output not stored."]')).not.toBeNull();
    await view.rerender(
      <TraceSteps steps={[{ ...STEPS[1], stored: true }]} rounds={rounds} live firstRound="r1" />,
    );
    expect(texts(view.container, 'button')).toEqual([
      'Message as received',
      'Instructions',
      'Read across the corpus',
    ]);
    expect(read).not.toHaveBeenCalled();
    await view.unmount();
  });

  it('opens to the message as received and the instructions', async () => {
    const { rounds } = reader({
      r1: ROUND,
      h1: { system: 'You help linguists.', tools: '[{"x": 1}]' },
    });
    const view = await renderComponent(
      <TraceSteps steps={STEPS} rounds={rounds} firstRound="r1" />,
    );
    await view.step(() => byText(view.container, 'button', 'Message as received').click());
    // The message is the whole of its disclosure: no Input heading over it.
    expect(view.container.textContent).not.toContain('Input');
    await view.step(() => byText(view.container, 'button', 'Instructions').click());
    const pres = texts(view.container, 'pre');
    expect(pres).toContain('[In "Text 1"] Which verbs?');
    expect(pres).toContain('You help linguists.');
    expect(pres).toContain('[{"x": 1}]');
    await view.unmount();
  });

  it('says a round went with its deleted conversation', async () => {
    const { rounds } = reader({});
    const view = await renderComponent(<TraceSteps steps={STEPS.slice(1)} rounds={rounds} gone />);
    await view.step(() => byText(view.container, 'button', 'Read across the corpus').click());
    expect(view.container.textContent).toContain('This conversation was deleted.');
    await view.unmount();
  });

  it('shows labels only for steps that name no round', async () => {
    const { rounds } = reader({});
    const view = await renderComponent(
      <TraceSteps steps={[{ id: 'x', kind: 'read', label: 'Searched' }]} rounds={rounds} />,
    );
    expect(view.container.textContent).toContain('Searched');
    expect(all(view.container, 'button')).toHaveLength(0);
    await view.unmount();
  });
});

describe('runs of reads', () => {
  const read = (i, said) => ({
    id: `d${i}`,
    kind: 'document',
    document: `Text ${i % 3}`,
    label: `Read “Text ${i % 3}”`,
    saw: [{ n: 5, unit: 'sentence', of: 50 }],
    ...(said ? { said } : {}),
  });

  it('folds four or more reads in a row into one row, broken by text between them', () => {
    const steps = [read(1), read(2), read(3), read(4), { id: 's', kind: 'read' }, read(5), read(6)];
    const rows = foldReads(steps);
    expect(rows.map((r) => (r.run ? r.run.length : r.step.id))).toEqual([4, 's', 'd5', 'd6']);
    expect(runLabel(rows[0].run)).toBe('Read 20 sentences in 3 documents');
    expect(
      foldReads([read(1), read(2), read(3, 'Now the next.'), read(4)]).every((r) => r.step),
    ).toBe(true);
  });

  it('counts a sentence read again in a run once', () => {
    const again = (id, document, which, n) => ({
      id,
      kind: 'document',
      document,
      saw: [{ n, unit: 'sentence', of: 72, which }],
    });
    const run = [
      ...[1, 2, 3, 4, 5, 6].map((i) => again(`a${i}`, 'D', '1–11', 11)),
      again('b', 'D', '10–12', 3),
      again('c', 'E', '1, 3', 2),
      again('d', 'F', '1, 3, 5, 7, 9, 11, 13, 15, 17, 19, 21, 2…', 30),
    ];
    expect(runLabel(run)).toBe('Read 44 sentences in 3 documents');
  });

  it('draws a run as one row that opens to its reads', async () => {
    const steps = [read(1), read(2), read(3), read(4)];
    const view = await renderComponent(<TraceSteps steps={steps} rounds={null} />);
    expect(texts(view.container, 'button')).toEqual(['Read 20 sentences in 3 documents']);
    await view.step(() => view.container.querySelector('button').click());
    expect(view.container.textContent).toContain('Read “Text 1”');
    await view.unmount();
  });
});

describe('a turn that did not finish', () => {
  it('draws its steps and the text it had written above its line', async () => {
    const { rounds } = reader({ r1: ROUND });
    const item = {
      kind: 'error',
      stopped: true,
      text: 'Stopped.',
      steps: STEPS,
      stepsSummary: '2 steps',
      partial: 'The verbs so far are',
    };
    const view = await renderComponent(
      <Turn item={item} projectId="p1" adapter={{}} rounds={rounds} traceOpen />,
    );
    expect(view.container.textContent).toContain('Let me read the sentence.');
    expect(view.container.textContent).toContain('The verbs so far are');
    expect(view.container.textContent).toContain('Stopped.');
    await view.rerender(
      <Turn item={item} projectId="p1" adapter={{}} rounds={rounds} traceOpen hideLine />,
    );
    expect(view.container.textContent).not.toContain('Stopped.');
    await view.unmount();
  });

  it('is exported to Markdown with its text and labels', () => {
    const md = conversationToMarkdown(
      {
        display: [
          { kind: 'user', text: 'Go.' },
          { kind: 'assistant', text: 'Done.', steps: STEPS, stepsSummary: '2 steps' },
          { kind: 'error', text: 'Stopped.', partial: 'Half' },
        ],
      },
      {},
      { origin: 'http://x', projectId: 'p1', adapter: { CITE_RE: /\{\{[^}]+\}\}/g } },
    );
    expect(md).toContain('> Let me read the sentence.');
    expect(md).toContain('- Read “Text 1”: sentence 3 of 12');
    expect(md).toContain('> Half');
  });
});
