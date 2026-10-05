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

// Luke's ruling Q4 (2026-09-29): a plan that stopped partway settles as
// "Partly applied: N of M changes written", marks the changes written, and
// offers no Approve. Approving it again wrote nothing and said nothing.
describe('a plan that stopped partway', () => {
  const three = plan([{ label: 'a' }, { label: 'b' }, { label: 'c' }]);

  it('says how many of its changes were written, marks them, and offers nothing to approve', async () => {
    const view = await mount(three, {
      status: 'partial',
      written: [0, 2],
      outcome: '2 of 3 changes written.',
    });
    expect(byText(view.container, 'span, div', 'Partly applied')).not.toBeNull();
    expect(view.container.textContent).toContain('2 of 3 changes written.');
    expect(view.container.textContent).not.toContain('did not answer');
    const rows = all(view.container, 'tr[data-written]').map((r) => r.dataset.written);
    expect(rows).toEqual(['true', 'false', 'true']);
    expect(all(view.container, 'button')).toEqual([]);
    await view.unmount();
  });

  it('says so when the server went quiet on the rest', async () => {
    const view = await mount(three, {
      status: 'partial',
      written: [],
      unknown: true,
      outcome: '0 of 3 changes written.',
    });
    expect(view.container.textContent).toContain(
      '0 of 3 changes written. The server did not answer for the rest.',
    );
    await view.unmount();
  });

  // conc-2026-09-29 REV-W-TAIL: a reopened conversation counted the card's
  // rows, so a row folding 600 changes, 400 of them written, read "0 of 1",
  // and so did a parse that stopped partway, while the toast and the export
  // gave the service's count.
  it("says the service's count for a folded row or a parse written in part", async () => {
    const folded = plan([{ label: 'dep on 600 words' }]);
    const view = await mount(folded, {
      status: 'partial',
      written: [],
      outcome: '400 of 600 changes written.',
    });
    expect(view.container.textContent).toContain('400 of 600 changes written.');
    expect(view.container.textContent).not.toContain('0 of 1');
    await view.unmount();
    const parse = plan([{ label: 'parse 1 document with Stanza parser (en)' }]);
    const again = await mount(parse, {
      status: 'partial',
      written: [],
      outcome: '1 of 1 changes written in part.',
    });
    expect(again.container.textContent).toContain('1 of 1 changes written in part.');
    expect(again.container.textContent).not.toContain('0 of 1');
    await again.unmount();
  });

  it('is exported as partly applied', () => {
    const conv = {
      display: [
        {
          kind: 'assistant',
          text: 'Planned.',
          plan: three,
          status: 'partial',
          written: [1],
          outcome: '1 of 3 changes written.',
        },
      ],
    };
    const md = conversationToMarkdown(conv, { title: 'T' }, { adapter: { ...adapter } });
    expect(md).toContain('(Partly applied: 1 of 3 changes written.)');
  });

  // conc-2026-09-29 REV-W-AUDIT: a row folding 600 changes, 400 of them
  // written, was exported as "0 of 1" while the card said "400 of 600".
  it('is exported with the count of the changes a folded row stands for', () => {
    const folded = plan([{ label: 'dep on 600 words' }]);
    const conv = {
      display: [
        {
          kind: 'assistant',
          text: 'Planned.',
          plan: folded,
          status: 'partial',
          written: [],
          outcome: '400 of 600 changes written.',
        },
      ],
    };
    const md = conversationToMarkdown(conv, { title: 'T' }, { adapter: { ...adapter } });
    expect(md).toContain('(Partly applied: 400 of 600 changes written.)');
    expect(md).not.toContain('0 of 1');
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

describe('expanding a long plan', () => {
  const long = () => plan(Array.from({ length: 20 }, (_, i) => ({ label: `change ${i}` })));
  const showAll = (root) =>
    all(root, 'button').find((b) => b.textContent.trim().startsWith('Show all'));

  it('says so once, when the card is expanded and not before', async () => {
    const opened = [];
    const view = await mount(long(), { onOpen: () => opened.push('p1') });
    expect(opened).toEqual([]);
    await view.step(() => showAll(view.container).click());
    expect(opened).toEqual(['p1']);
    expect(showAll(view.container)).toBeUndefined();
    await view.unmount();
  });

  it('a short plan, already whole, has nothing to expand', async () => {
    const opened = [];
    const view = await mount(plan([{ label: 'one' }]), { onOpen: () => opened.push('p1') });
    expect(showAll(view.container)).toBeUndefined();
    expect(opened).toEqual([]);
    await view.unmount();
  });
});

// REV-FX3-AGENT-4: a reviewed contributor's confirmation verifies nothing,
// and what it did is on the card, not only in the model's record.
describe('an applied plan with notes and rows that wrote nothing', () => {
  it('shows the notes and marks the rows that wrote nothing', async () => {
    const p = plan([{ label: 's9.w1: confirm 1 value' }, { label: 's19.w1: confirm 2 values' }]);
    const view = await mount(p, {
      status: 'applied',
      notes: [
        "2 annotations accepted as your contribution, 1 contributor's annotation left for a reviewer",
      ],
      unwritten: [0],
    });
    const notes = view.container.querySelector('[data-testid=apply-notes]');
    expect(notes.textContent).toBe(
      "2 annotations accepted as your contribution, 1 contributor's annotation left for a reviewer.",
    );
    const rows = all(view.container, 'tr[data-written]');
    expect(rows.map((r) => r.getAttribute('data-written'))).toEqual(['false']);
    expect(rows[0].textContent).toContain('(nothing written)');
    await view.unmount();
  });
});

// Luke's ruling (2026-10-05): a turn that stages a plan replaces any still
// waiting, since the model restates in the new plan what still applies.
describe('a plan a later one replaced', () => {
  it('reads "Replaced" and offers nothing to press', async () => {
    const view = await mount(plan([{ label: 'a' }]), { status: 'replaced' });
    expect(byText(view.container, 'span, div', 'Replaced')).not.toBeNull();
    expect(all(view.container, 'button')).toEqual([]);
    await view.unmount();
  });

  it('is exported as replaced', () => {
    const conv = {
      display: [
        { kind: 'assistant', text: 'Planned.', plan: plan([{ label: 'a' }]), status: 'replaced' },
      ],
    };
    const md = conversationToMarkdown(conv, { title: 'T' }, { adapter: { ...adapter } });
    expect(md).toContain('(Replaced by a later plan.)');
  });
});
