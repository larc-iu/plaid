import { describe, it, expect } from 'vitest';
import { renderComponent, byText } from '../../test/renderComponent.jsx';
import { PlanCard } from './PlanCard.jsx';
import { planProjectAt } from './projectReach.js';
import { conversationToMarkdown } from './exportMarkdown.js';

// A4-CROSS-1: in a conversation that reads another project, a plan meant for
// that project was staged in the home one, and neither the card nor the export
// named the project it writes in. Both do now, wherever the turn read others.

const plan = {
  id: 'p1',
  summary: '3 field values',
  labels: ['a'],
  ops: [{ kind: 'x' }],
  changes: [],
};
const other = [{ id: 'lmk', name: 'Lamkang-01 v2' }];
const display = (projects) => [
  { kind: 'user', text: 'Plan it.', ...(projects ? { projects } : {}) },
  { kind: 'assistant', text: 'Planned.', plan, status: null },
];

describe('the project a plan writes in', () => {
  it('is named only where the turn read other projects', () => {
    expect(planProjectAt(display(other), 1, 'Kalamang_v3')).toBe('Kalamang_v3');
    expect(planProjectAt(display(null), 1, 'Kalamang_v3')).toBe(null);
    const named = display(other);
    named[1] = { ...named[1], plan: { ...plan, project: { id: 'kgv', name: 'Kalamang (v3)' } } };
    expect(planProjectAt(named, 1, 'Kalamang_v3')).toBe('Kalamang (v3)');
    expect(planProjectAt(display(other), 0, 'Kalamang_v3')).toBe(null);
  });

  it('is shown on the card and in the export', async () => {
    const view = await renderComponent(
      <PlanCard
        plan={plan}
        status={null}
        canWrite
        busy={false}
        onApprove={() => {}}
        onDiscard={() => {}}
        projectId="kgv"
        planProject="Kalamang_v3"
        adapter={{ groupOf: () => ({ key: 'd', title: 'D' }), changePlace: () => null }}
      />,
    );
    expect(byText(view.container, 'div', 'In Kalamang_v3')).not.toBeNull();
    await view.unmount();
    const md = conversationToMarkdown(
      { display: display(other) },
      { title: 'T' },
      { origin: '', projectId: 'kgv', projectName: 'Kalamang_v3', adapter: {} },
    );
    expect(md).toContain('**Proposed changes in Kalamang\\_v3:** 3 field values');
  });
});
