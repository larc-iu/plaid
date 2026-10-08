import { describe, it, expect } from 'vitest';
import { renderComponent, all, byText, texts } from '../../test/renderComponent.jsx';
import { PlanCard } from './PlanCard.jsx';
import { ExportContext } from './exportContext.js';
import { collapseGroups, groupRows, planRows } from './planChanges.js';
import { conversationToMarkdown } from './exportMarkdown.js';

// A rule's row (core/rules.py in plaid-agent): one stored change standing for
// many, with its count in each document and a sample of its changes.

const adapter = {
  textName: 'the text',
  groupOf: (projectId, where) =>
    where
      ? {
          key: `doc:${where.documentId}`,
          title: where.documentName,
          href: `#/projects/${projectId}/documents/${where.documentId}`,
        }
      : { key: 'other', title: 'Other changes', href: null },
  changePlace: (projectId, where) =>
    where?.kind === 'token'
      ? { href: '#w', title: '', name: where.surface, detail: 's1.w2' }
      : null,
};

const documents = Array.from({ length: 12 }, (_, i) => [`d${i}`, `Text ${i}`, 120 - i * 5]);

const ruleRow = (extra = {}) => ({
  label: 'Gloss: replace "VASP" with "ASP" (part of a value), 1,240 values in 14 documents',
  where: null,
  change: 'Gloss "VASP" → "ASP"',
  writesText: false,
  replacesWork: 1100,
  rule: {
    tool: 'replace_in_field',
    args: { field: 'Gloss', pattern: 'VASP', replacement: 'ASP' },
    total: 1240,
    kinds: { setSpan: 1240 },
    documents,
    documentsMore: [2, 31],
    sample: [
      {
        label: 'Text 0 s1.w2 "kuru": Gloss "VASP.3SG" → "ASP.3SG"',
        where: { kind: 'token', documentId: 'd0', surface: 'kuru' },
        change: 'Gloss "VASP.3SG" → "ASP.3SG"',
        replacesWork: 1,
      },
    ],
  },
  ...extra,
});

const plan = (changes) => ({
  id: 'p1',
  summary: '1,240 field values',
  ops: changes.map(() => ({ kind: 'bulk_scope' })),
  changes,
});

const mount = (p, props = {}, wrap = (x) => x) =>
  renderComponent(
    wrap(
      <PlanCard
        plan={p}
        status={null}
        canWrite
        busy={false}
        onApprove={() => {}}
        onDiscard={() => {}}
        projectId="pr1"
        adapter={adapter}
        {...props}
      />,
    ),
  );

describe('a rule on the plan card', () => {
  it('says the rule, its total and what it replaces, and shows where on request', async () => {
    const view = await mount(plan([ruleRow()]));
    const row = view.container.querySelector('tr[data-rule]');
    expect(row.textContent).toContain('Gloss "VASP" → "ASP"');
    expect(row.textContent).toContain('1,240 changes in 14 documents, 1,100 replace accepted work');
    expect(byText(view.container, 'p', '1100 changes replace accepted work.')).not.toBeNull();
    expect(all(view.container, 'tr[data-rule-document]')).toHaveLength(0);
    const toggle = byText(view.container, 'button', 'Show where');
    await view.step(() => toggle.click());
    const docs = all(view.container, 'tr[data-rule-document]');
    expect(docs).toHaveLength(10);
    expect(docs[0].querySelector('a').getAttribute('href')).toBe('#/projects/pr1/documents/d0');
    expect(docs[0].textContent).toBe('Text 0120');
    // Two named past the first ten and two the record only counts.
    const rest = byText(view.container, 'td', 'and 4 more documents');
    expect(rest.textContent).toBe('and 4 more documents (166 changes)');
    expect(byText(view.container, 'th', 'For example')).not.toBeNull();
    expect(texts(view.container, 'tr a')).toContain('kuru');
    await view.step(() => byText(view.container, 'button', 'Hide').click());
    expect(all(view.container, 'tr[data-rule-document]')).toHaveLength(0);
    await view.unmount();
  });

  it('is shown unfolded in the web page export', async () => {
    const view = await mount(plan([ruleRow()]), {}, (card) => (
      <ExportContext.Provider value={{}}>{card}</ExportContext.Provider>
    ));
    expect(all(view.container, 'tr[data-rule-document]')).toHaveLength(12);
    expect(byText(view.container, 'td', 'and 2 more documents (31 changes)')).not.toBeNull();
    expect(byText(view.container, 'button', 'Show where')).toBeNull();
    await view.unmount();
  });

  it('is never folded away, and a rule kept past a settled plan’s cap keeps its place', () => {
    const rows = Array.from({ length: 30 }, (_, i) => ({
      label: `r${i}`,
      change: 'x',
      where: null,
    }));
    const p = plan([...rows, ruleRow()]);
    const shown = collapseGroups(groupRows(planRows(p), 'pr1', adapter));
    expect(shown.groups.some((g) => g.rule)).toBe(true);
    const settled = {
      ...p,
      ops: undefined,
      opCount: 260,
      omitted: { count: 59 },
      changes: [...rows, { ...ruleRow(), row: 251 }],
    };
    settled.changes = [
      ...Array.from({ length: 200 }, (_, i) => ({ label: `r${i}` })),
      { ...ruleRow(), row: 251 },
    ];
    const got = planRows(settled);
    expect(got).toHaveLength(201);
    expect(got[200].index).toBe(251);
    expect(got[200].rule.total).toBe(1240);
  });

  it('reads a plan with no labels from its changes', () => {
    const p = { id: 'p', changes: [{ label: 'a' }, { label: 'b' }], opCount: 5 };
    expect(planRows(p).map((r) => r.label)).toEqual(['a', 'b']);
  });
});

describe('a rule that matches differently at approval', () => {
  it('shows the card out of date with the reason, and that nothing was changed', async () => {
    const reason =
      'Gloss "VASP" → "ASP" now matches 1,180 places in 17 documents, not the 1,171 shown when it was planned (9 more in "Text 4")';
    const view = await mount(plan([ruleRow()]), { status: 'stale', reason });
    const said = view.container.querySelector('[data-testid=stale-reason]');
    expect(said.textContent).toBe(`${reason}. Nothing was changed.`);
    expect(byText(view.container, 'p', 'Ask again to plan on the current version.')).not.toBeNull();
    expect(byText(view.container, 'p', 'Changed since this plan was made')).toBeNull();
    await view.unmount();
  });
});

describe('a rule in the Markdown export', () => {
  it('prints the rule, its count, its documents and its sample', () => {
    const conv = {
      display: [
        { kind: 'user', text: 'rename' },
        { kind: 'assistant', text: 'Planned.', plan: plan([ruleRow()]), status: 'applied' },
      ],
    };
    const md = conversationToMarkdown(conv, { title: 'T' }, { adapter, projectId: 'pr1' });
    expect(md).toContain(
      '1. Gloss: replace "VASP" with "ASP" (part of a value), 1,240 values in 14 documents',
    );
    expect(md).toContain('   - 1,240 changes in 14 documents, 1,100 replace accepted work');
    expect(md).toContain('   - Text 0: 120');
    expect(md).toContain('   - and 2 more documents (31 changes)');
    expect(md).toContain('   - For example: Text 0 s1.w2 "kuru": Gloss "VASP.3SG" → "ASP.3SG"');
  });
});
