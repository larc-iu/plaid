import { describe, it, expect, vi } from 'vitest';
import { renderComponent, all } from '../../test/renderComponent.jsx';
import { PlanCard } from './PlanCard.jsx';
import { conversationToMarkdown } from './exportMarkdown.js';
import { conversationToHtml } from './exportHtml.js';

vi.mock('../../lib/notify.js', () => ({
  notifySuccess: vi.fn(),
  notifyError: vi.fn(),
  notifyWarning: vi.fn(),
}));

// A settled plan keeps its first rows (FX10-CARD, 2026-10-08): the service
// keeps the first SETTLED_ROWS_MAX of a settled plan's card and counts the rest
// (plaid_agent/core/conversation.py `compact_plan`, tested there). The card
// and both exports say how many more there were, with the plan's own totals.

const SETTLED_ROWS_MAX = 200;

const N = 2631;

const row = (i) => ({
  label: `s${i} Gloss = eat`,
  change: 'Gloss = eat',
  where: { kind: 'token', documentId: `d${i % 3}`, documentName: `Text ${i % 3}`, sentence: i },
  writesText: i % 100 === 0,
  replacesWork: i % 50 === 0 ? 2 : 0,
});

const bigPlan = () => {
  const changes = Array.from({ length: N }, (_, i) => row(i));
  return {
    id: 'p1',
    summary: `${N} glosses`,
    labels: changes.map((c) => c.label),
    changes,
    ops: changes.map(() => ({ kind: 'set_span' })),
    documents: [{ id: 'd0', version: 3 }],
    proposed: [['set_span', 't1', 'eat']],
    proposedCount: N,
  };
};

const adapter = {
  textName: 'the text',
  groupOf: (_p, where) => ({ key: where?.documentId, title: where?.documentName, href: null }),
  changePlace: () => null,
};

describe('a long settled plan', () => {
  // As the service keeps it.
  const settled = () => {
    const { ops, documents: _d, changes, labels, ...plan } = bigPlan();
    const rest = changes.slice(SETTLED_ROWS_MAX);
    return {
      ...plan,
      opCount: ops.length,
      changes: changes.slice(0, SETTLED_ROWS_MAX),
      labels: labels.slice(0, SETTLED_ROWS_MAX),
      omitted: {
        count: rest.length,
        writesText: rest.filter((c) => c.writesText).length,
        replacesWork: rest.reduce((n, c) => n + c.replacesWork, 0),
      },
    };
  };

  it('ends its card with how many more changes it had, and states its totals', async () => {
    const plan = settled();
    const view = await renderComponent(
      <PlanCard
        plan={plan}
        status="applied"
        canWrite
        busy={false}
        onApprove={() => {}}
        onDiscard={() => {}}
        projectId="pr1"
        adapter={adapter}
      />,
    );
    const text = () => view.container.textContent;
    const button = all(view.container, 'button').find((b) => b.textContent.includes('Show'));
    expect(button.textContent.trim()).toBe(`Show ${SETTLED_ROWS_MAX}`);
    expect(view.container.querySelector('[data-testid=rows-omitted]')).toBeNull();
    // The plan's own totals, not those of the rows kept.
    const full = bigPlan().changes;
    expect(text()).toContain(
      `${full.filter((c) => c.writesText).length} changes rewrite the text.`,
    );
    expect(text()).toContain(
      `${full.reduce((n, c) => n + c.replacesWork, 0)} changes replace accepted work.`,
    );
    await view.step(() => button.click());
    expect(view.container.querySelector('[data-testid=rows-omitted]').textContent).toBe(
      'and 2,431 more changes',
    );
    expect(view.container.querySelectorAll('tbody tr td:last-child').length).toBe(
      SETTLED_ROWS_MAX + 1,
    );
    await view.unmount();
  });

  it('says the same in both exports', async () => {
    const conv = {
      id: 'c1',
      messages: [],
      display: [{ kind: 'assistant', text: 'Done.', plan: settled(), status: 'applied' }],
    };
    const md = conversationToMarkdown(conv, { title: 'T' }, { adapter });
    expect(md).toContain(`${SETTLED_ROWS_MAX}. s199 Gloss = eat\n\nand 2,431 more changes`);
    const html = await conversationToHtml(
      conv,
      { title: 'T' },
      { projectId: 'pr1', adapter, readable: new Set(['pr1']), sheets: [] },
    );
    expect(html).toContain('and 2,431 more changes');
  });
});
