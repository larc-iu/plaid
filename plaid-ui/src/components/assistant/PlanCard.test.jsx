import { describe, it, expect } from 'vitest';
import { renderComponent, all, byText, texts } from '../../test/renderComponent.jsx';
import { PlanCard } from './PlanCard.jsx';
import { collapseGroups, planRows, workReplaced } from './planChanges.js';
import { conversationToMarkdown } from './exportMarkdown.js';

// Every row lands in one document, and a row is named by its label.
const adapter = {
  textName: 'the text',
  groupOf: () => ({ key: 'd1', title: 'Story', href: null }),
  changePlace: () => null,
};

const plan = (changes) => ({
  id: 'p1',
  summary: `${changes.length} changes`,
  labels: changes.map((c) => c.label),
  ops: changes.map(() => ({ kind: 'x' })),
  changes,
});

const mount = (p, props = {}) =>
  renderComponent(
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
  );

describe('a plan refused as out of date', () => {
  it('reads "Out of date" and offers only a disabled Approve', async () => {
    const view = await mount(plan([{ label: 's1b: :aspect state' }]), { status: 'stale' });
    expect(byText(view.container, 'span, div', 'Out of date')).not.toBeNull();
    const buttons = all(view.container, 'button');
    expect(buttons.map((b) => b.textContent.trim())).toEqual(['Approve and apply']);
    expect(buttons[0].disabled).toBe(true);
    expect(view.container.querySelector('input[type=checkbox]')).toBeNull();
    await view.unmount();
  });

  it('is exported as out of date', () => {
    const conv = {
      display: [
        { kind: 'assistant', text: 'Planned.', plan: plan([{ label: 'a' }]), status: 'stale' },
      ],
    };
    const md = conversationToMarkdown(conv, { title: 'T' }, { adapter: { ...adapter } });
    expect(md).toContain('(Out of date.)');
  });
});

describe('changes that replace accepted work', () => {
  it('are counted in a line above the list and marked on their rows', async () => {
    const view = await mount(
      plan([
        { label: 's1d: dog becomes cat', replacesWork: true },
        { label: 'add (s1x / thing)' },
        { label: 'remove (s1m / morning)', replacesWork: true },
      ]),
    );
    expect(byText(view.container, 'p', 'replace accepted work').textContent).toBe(
      '2 changes replace accepted work.',
    );
    const marked = all(view.container, 'tr')
      .filter((tr) => tr.textContent.includes('Accepted'))
      .map((tr) => tr.textContent.replace('Accepted', '').trim());
    expect(marked).toEqual(['s1d: dog becomes cat', 'remove (s1m / morning)']);
    await view.unmount();
  });

  it('says one change in the singular, and nothing when there is none', async () => {
    let view = await mount(plan([{ label: 'a', replacesWork: true }, { label: 'b' }]));
    expect(byText(view.container, 'p', 'accepted work').textContent).toBe(
      '1 change replaces accepted work.',
    );
    await view.unmount();
    view = await mount(plan([{ label: 'a' }, { label: 'b' }]));
    expect(byText(view.container, 'p', 'accepted work')).toBeNull();
    expect(texts(view.container, 'tr')).not.toContain('Accepted');
    await view.unmount();
  });

  it('are never folded away on a collapsed card', () => {
    const changes = Array.from({ length: 30 }, (_, i) => ({
      label: `change ${i}`,
      replacesWork: i === 25,
    }));
    const rows = planRows(plan(changes));
    expect(workReplaced(rows)).toBe(1);
    const { groups, hidden } = collapseGroups([{ key: 'd1', rows }]);
    const shown = groups.flatMap((g) => g.rows.map((r) => r.label));
    expect(shown).toContain('change 25');
    expect(shown).toHaveLength(12);
    expect(hidden).toBe(18);
  });

  it('reads the count off the service row and defaults it to none', () => {
    const rows = planRows(
      plan([{ label: 'a', replacesWork: 1 }, { label: 'b' }, { label: 'c', replacesWork: 38 }]),
    );
    expect(rows.map((r) => r.replacesWork)).toEqual([1, 0, 38]);
    expect(planRows({ labels: ['x'] })[0].replacesWork).toBe(0);
  });

  it('counts a corpus-wide replace by the accepted values it replaces', async () => {
    const view = await mount(
      plan([
        {
          label: 'replace_in_field: 400 changes in 40 documents, 38 of them replace accepted work',
          replacesWork: 38,
        },
        { label: 's1d: dog becomes cat', replacesWork: 1 },
        { label: 'add (s1x / thing)', replacesWork: 0 },
      ]),
    );
    expect(byText(view.container, 'p', 'replace accepted work').textContent).toBe(
      '39 changes replace accepted work.',
    );
    expect(
      all(view.container, 'tr').filter((tr) => tr.textContent.includes('Accepted')),
    ).toHaveLength(2);
    // A count of none is not written out on its row.
    const last = all(view.container, 'tr').at(-1);
    expect(last.textContent.trim()).toBe('add (s1x / thing)');
    await view.unmount();
  });
});
