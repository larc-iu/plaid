import { describe, it, expect, vi } from 'vitest';
import { renderComponent, all } from '../../test/renderComponent.jsx';
import { compactPlan, SETTLED_ROWS_MAX } from './planRecord.js';
import { planRows } from './planChanges.js';
import { PlanCard } from './PlanCard.jsx';
import { conversationToMarkdown } from './exportMarkdown.js';
import { conversationToHtml } from './exportHtml.js';

vi.mock('../../lib/notify.js', () => ({
  notifySuccess: vi.fn(),
  notifyError: vi.fn(),
  notifyWarning: vi.fn(),
}));

const { persistConv } = await import('./jobs.js');

// A settled plan keeps its first rows (FX10-CARD, 2026-10-08): a prod
// conversation hit the 5MB record limit with a 40KB transcript, because each
// settled plan of thousands of changes kept every row of its card.

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
  it('keeps its first rows and counts the rest, with what the card states of them', () => {
    const full = bigPlan();
    const done = compactPlan({ kind: 'assistant', plan: full, status: 'applied' });
    expect(done.plan.changes).toEqual(full.changes.slice(0, SETTLED_ROWS_MAX));
    expect(done.plan.labels).toEqual(full.labels.slice(0, SETTLED_ROWS_MAX));
    expect(done.plan.opCount).toBe(N);
    const rest = full.changes.slice(SETTLED_ROWS_MAX);
    expect(done.plan.omitted).toEqual({
      count: N - SETTLED_ROWS_MAX,
      writesText: rest.filter((c) => c.writesText).length,
      replacesWork: rest.reduce((n, c) => n + c.replacesWork, 0),
    });
    expect(done.plan.proposed).toEqual(full.proposed);
    expect(done.plan.proposedCount).toBe(N);
    // The kept rows still line up with the plan's ops, so each keeps its place.
    expect(planRows(done.plan).map((r) => r.where)).toEqual(
      full.changes.slice(0, SETTLED_ROWS_MAX).map((c) => c.where),
    );
    // Nothing more to drop: the same item.
    expect(compactPlan(done)).toBe(done);
  });

  it('is cut on its next compaction when an earlier one kept every row', () => {
    const full = bigPlan();
    const { ops, documents, ...old } = full;
    const stored = { kind: 'assistant', plan: { ...old, opCount: ops.length }, status: 'stale' };
    const done = compactPlan(stored);
    expect(done.plan.changes).toHaveLength(SETTLED_ROWS_MAX);
    expect(done.plan.omitted.count).toBe(N - SETTLED_ROWS_MAX);
    expect(done.plan.opCount).toBe(N);
    expect(documents).toBeTruthy();
  });

  it('is left whole while undecided, and a short settled one keeps every row', () => {
    const undecided = { kind: 'assistant', plan: bigPlan(), status: null };
    expect(compactPlan(undecided)).toBe(undecided);
    const short = compactPlan({
      kind: 'assistant',
      plan: { id: 'p', labels: ['a'], changes: [{ label: 'a' }], ops: [{}] },
      status: 'discarded',
    });
    expect(short.plan).not.toHaveProperty('omitted');
    expect(short.plan.changes).toHaveLength(1);
  });

  const settled = () => compactPlan({ kind: 'assistant', plan: bigPlan(), status: 'applied' }).plan;

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

  it('is cut when the page writes the record, whenever it was settled', async () => {
    const put = vi.fn(async () => ({ version: 2 }));
    const store = { client: { userData: { put } }, userId: 'u1', app: 'igt', projectId: 'p1' };
    const { ops, documents: _d, ...old } = bigPlan();
    const conv = {
      id: 'c-big',
      messages: [],
      display: [
        { kind: 'assistant', plan: { ...old, opCount: ops.length }, status: 'replaced' },
        { kind: 'assistant', plan: bigPlan(), status: null },
      ],
      rev: { conv: 1, meta: 1 },
    };
    await persistConv(store, conv, { id: 'c-big' });
    const written = put.mock.calls[0][2];
    expect(written.display[0].plan.changes).toHaveLength(SETTLED_ROWS_MAX);
    expect(written.display[0].plan.omitted.count).toBe(N - SETTLED_ROWS_MAX);
    expect(written.display[1].plan.changes).toHaveLength(N);
    expect(written.display[1].plan.ops).toHaveLength(N);
  });
});
