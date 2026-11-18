import { describe, it, expect } from 'vitest';
import { renderComponent } from '../../test/renderComponent.jsx';
import { Turn } from './Turn.jsx';
import { conversationToMarkdown } from './exportMarkdown.js';
import { stagedLine } from './planChanges.js';

// A reply that staged something carries one line above its card, built from
// the plan as the record holds it (`proposedCount`, the changes the plan
// holds, each change a folded row or a rule stands for counted, as the
// model's own plan line counts them), never from the reply's words (survey
// 2026-11-17: 1,807 changes said for a card of 801). An ordinary answer has
// none, and neither has a job card, which stages nothing.

const adapter = {
  textName: 'the text',
  CITE_RE: /\{\{[^}]+\}\}/g,
  citationTitle: (c) => c.title,
  citationHref: () => null,
  parseCitationHref: () => null,
  opensProject: () => true,
  ExampleCard: () => null,
  groupOf: (_p, where) => ({ key: where?.doc ?? 'x', title: where?.doc ?? 'x', href: null }),
  changePlace: () => null,
  JobCard: ({ card }) => <div data-job={card.id}>Job</div>,
};

// A plan of 801 changes whose card shows 40 rows, most folding many changes,
// with a reply that says something else.
const plan = (extra = {}) => ({
  id: 'p1',
  summary: '801 glosses',
  opCount: 40,
  changes: Array.from({ length: 40 }, (_, i) => ({
    label: `Gloss = g${i}`,
    change: `Gloss = g${i}`,
    where: { doc: 'Text 1' },
  })),
  proposedCount: 801,
  ...extra,
});

const reply = (extra = {}) => ({
  kind: 'assistant',
  text: 'I staged 1,807 changes.',
  plan: plan(),
  status: null,
  ...extra,
});

const draw = (item, extra = {}) =>
  renderComponent(
    <Turn
      item={item}
      projectId="p"
      adapter={adapter}
      canWrite
      busy={false}
      onApprove={() => {}}
      onDiscard={() => {}}
      {...extra}
    />,
  );

const line = (container) => container.querySelector('[data-testid="staged-line"]');

describe('the staged line', () => {
  it('counts the changes the plan holds, not what the reply says', async () => {
    const view = await draw(reply());
    expect(line(view.container).textContent).toBe('Staged: 801 changes');
    expect(view.container.textContent).toContain('I staged 1,807 changes.');
    await view.unmount();
  });

  it('sits right above the card, after the reply', async () => {
    const view = await draw(reply());
    const l = line(view.container);
    const card = l.nextElementSibling;
    expect(card.textContent).toContain('Proposed changes');
    expect(l.previousElementSibling.textContent).toContain('I staged 1,807 changes.');
    await view.unmount();
  });

  it('is not a control', async () => {
    const view = await draw(reply());
    const l = line(view.container);
    expect(l.querySelector('button, a, input')).toBeNull();
    expect(l.closest('button, a')).toBeNull();
    await view.unmount();
  });

  it('says one change in the singular, and groups thousands as the card does', () => {
    expect(stagedLine(plan({ proposedCount: 1 }))).toBe('Staged: 1 change');
    expect(stagedLine(plan({ proposedCount: 6244 }))).toBe('Staged: 6,244 changes');
    expect(stagedLine(plan({ proposedCount: 0 }))).toBe('Staged: 0 changes');
  });

  // The fact of the turn: the card says what became of the plan, and the line
  // what this reply staged, which none of that changes.
  for (const [status, extra] of [
    [null, {}],
    ['applied', {}],
    ['discarded', {}],
    ['replaced', {}],
    ['stale', { reason: 'A document changed.' }],
    ['partial', { outcome: '400 of 801 changes written.', written: [0, 1] }],
  ]) {
    it(`stays the same on a plan that is ${status ?? 'undecided'}`, async () => {
      const view = await draw(reply({ status, ...extra }));
      expect(line(view.container).textContent).toBe('Staged: 801 changes');
      await view.unmount();
    });
  }

  it('stays on a settled plan cut to its first rows', async () => {
    const settled = plan({
      changes: plan().changes.slice(0, 10),
      omitted: { count: 30 },
    });
    const view = await draw(reply({ plan: settled, status: 'applied' }));
    expect(line(view.container).textContent).toBe('Staged: 801 changes');
    await view.unmount();
  });

  it('is shown to a reader who cannot decide the plan', async () => {
    const view = await draw(reply(), { readOnly: true });
    expect(line(view.container).textContent).toBe('Staged: 801 changes');
    await view.unmount();
  });

  it('is not under an ordinary answer', async () => {
    const view = await draw({ kind: 'assistant', text: 'Three of them are verbs.' });
    expect(line(view.container)).toBeNull();
    expect(view.container.textContent).not.toContain('Staged');
    await view.unmount();
  });

  it('is not under a job card, which stages nothing', async () => {
    const view = await draw({
      kind: 'assistant',
      text: 'Here is the job.',
      job: { id: 'j1', status: null, summary: 'glossing 3 documents' },
    });
    expect(view.container.querySelector('[data-job]')).not.toBeNull();
    expect(line(view.container)).toBeNull();
    await view.unmount();
  });

  it('is not drawn for a plan the record holds no count for', async () => {
    const { proposedCount: _n, ...old } = plan();
    const view = await draw(reply({ plan: old }));
    expect(line(view.container)).toBeNull();
    expect(view.container.textContent).toContain('Proposed changes');
    await view.unmount();
  });
});

describe('the staged line in the Markdown export', () => {
  const md = (display) =>
    conversationToMarkdown({ display }, { title: 'T' }, { origin: '', projectId: 'p', adapter });

  it('comes right before the plan, after the reply', () => {
    const out = md([{ kind: 'user', text: 'Gloss it.' }, reply({ status: 'discarded' })]);
    const at = out.indexOf('*Staged: 801 changes*');
    expect(at).toBeGreaterThan(out.indexOf('I staged 1,807 changes.'));
    expect(out.indexOf('**Proposed changes')).toBeGreaterThan(at);
  });

  it('is not written for an ordinary answer or a job card', () => {
    const out = md([
      { kind: 'assistant', text: 'Three of them are verbs.' },
      { kind: 'assistant', text: 'Job.', job: { id: 'j', status: null, documents: [] } },
    ]);
    expect(out).not.toContain('Staged');
  });
});
