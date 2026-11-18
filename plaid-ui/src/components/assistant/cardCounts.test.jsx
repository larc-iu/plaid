import { describe, it, expect } from 'vitest';
import { renderComponent, all } from '../../test/renderComponent.jsx';
import { Turn } from './Turn.jsx';
import { conversationToMarkdown } from './exportMarkdown.js';

// The line above a card and the card never disagree (REV-RL1-1): every number
// of changes the card shows (a document's count, a rule's count, "Show all N",
// "and n more changes") counts changes, each row as many as the service says
// it stands for (`count`), the unit of the line. A stored plan whose rows
// carry no count shows no number where it could only count rows.

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
};

const plain = (i, doc, count = 1) => ({
  label: `Gloss = g${i}`,
  change: `Gloss = g${i}`,
  where: { doc },
  count,
});

const rule = (total) => ({
  label: 'Gloss "VASP" → "ASP"',
  change: 'Gloss "VASP" → "ASP"',
  count: total,
  rule: { tool: 'replace_in_field', total, documents: [['d1', 'Text 1', total]] },
});

const planOf = (changes, extra = {}) => ({
  id: 'p1',
  summary: 's',
  opCount: changes.length + (extra.omitted?.count ?? 0),
  changes,
  proposedCount: changes.reduce((n, c) => n + (c.count ?? 0), 0) + (extra.omitted?.changes ?? 0),
  ...extra,
});

// Fourteen rows: twelve plain, one folding 30 changes, one folding 755.
const folded = () =>
  planOf([
    ...Array.from({ length: 12 }, (_, i) => plain(i, i < 6 ? 'Text 1' : 'Text 2')),
    plain(12, 'Text 1', 30),
    plain(13, 'Text 2', 755),
  ]);
const rules = () => planOf([rule(1240), rule(6)]);
const mixed = () =>
  planOf([rule(400), plain(0, 'Text 1', 25), plain(1, 'Text 1'), plain(2, 'Text 2', 0)]);
const cut = () =>
  planOf(
    Array.from({ length: 20 }, (_, i) => plain(i, 'Text 1', i % 2 ? 4 : 1)),
    { omitted: { count: 60, changes: 600 } },
  );

const draw = (plan, status = null) =>
  renderComponent(
    <Turn
      item={{ kind: 'assistant', text: 'Done.', plan, status }}
      projectId="p"
      adapter={adapter}
      canWrite
      busy={false}
      onApprove={() => {}}
      onDiscard={() => {}}
    />,
  );

const num = (s) => Number(String(s).replace(/,/g, ''));
const staged = (c) =>
  num(c.querySelector('[data-testid="staged-line"]').textContent.match(/[\d,]+/)[0]);
// Every number of changes the card holds, read off it: the documents', the
// rules' and the cut plan's last line.
const cardTotal = (c) => {
  const groups = all(c, 'th[scope=colgroup] span').map((s) =>
    num(s.textContent.match(/[\d,]+/)[0]),
  );
  const ruled = all(c, 'tr[data-rule] td span.ml-1\\.5')
    .map((s) => s.textContent.match(/^([\d,]+) changes? in/))
    .filter(Boolean)
    .map((m) => num(m[1]));
  const more = c.querySelector('[data-testid=rows-omitted]');
  const rest = more ? num(more.textContent.match(/[\d,]+/)[0]) : 0;
  return groups.reduce((a, b) => a + b, 0) + ruled.reduce((a, b) => a + b, 0) + rest;
};
const showButton = (c) => all(c, 'button').find((b) => b.textContent.trim().startsWith('Show'));

describe('the card counts changes, as the line does', () => {
  for (const [name, make] of [
    ['folded rows', folded],
    ['rules', rules],
    ['mixed', mixed],
    ['cut to its first rows', cut],
  ]) {
    for (const status of [null, 'applied', 'partial']) {
      it(`agrees with the line: ${name}, ${status ?? 'undecided'}`, async () => {
        const plan = make();
        const view = await draw(plan, status);
        // As first drawn, folded at twelve rows: a document's count is the
        // whole document's, and a cut plan's last line is not drawn yet, so
        // its remainder is the record's (REV-RL1-R2-1).
        const drawn = view.container.querySelector('[data-testid=rows-omitted]')
          ? 0
          : (plan.omitted?.changes ?? 0);
        expect(cardTotal(view.container) + drawn).toBe(staged(view.container));
        const button = showButton(view.container);
        if (button && !/Show where/.test(button.textContent)) await view.step(() => button.click());
        expect(cardTotal(view.container)).toBe(staged(view.container));
        await view.unmount();
      });
    }
  }

  it('heads each document with all its changes while the card is folded', async () => {
    const view = await draw(folded());
    expect(showButton(view.container).textContent.trim()).toBe('Show all 797');
    const heads = all(view.container, 'th[scope=colgroup]').map((t) => t.textContent);
    expect(heads).toEqual(['Text 136', 'Text 2761']);
    await view.unmount();
  });

  it('counts a rule by its row, as the line does', async () => {
    const p = planOf([{ ...rule(400), rule: { ...rule(400).rule, total: 399 } }]);
    const view = await draw(p);
    expect(staged(view.container)).toBe(400);
    expect(view.container.querySelector('tr[data-rule]').textContent).toContain(
      '400 changes in 1 document',
    );
    await view.unmount();
  });

  it('says how many changes "Show all" opens', async () => {
    const view = await draw(folded());
    expect(showButton(view.container).textContent.trim()).toBe('Show all 797');
    await view.unmount();
  });

  it('says how many changes the rows of a cut plan hold, then how many more', async () => {
    const view = await draw(cut(), 'applied');
    expect(showButton(view.container).textContent.trim()).toBe('Show 50');
    await view.step(() => showButton(view.container).click());
    expect(view.container.querySelector('[data-testid=rows-omitted]').textContent).toBe(
      'and 600 more changes',
    );
    await view.unmount();
  });

  it('writes the same counts in the Markdown export', () => {
    const md = conversationToMarkdown(
      { display: [{ kind: 'assistant', text: 'Done.', plan: cut(), status: 'applied' }] },
      { title: 'T' },
      { origin: '', projectId: 'p', adapter },
    );
    expect(md).toContain('*Staged: 650 changes*');
    expect(md).toContain('and 600 more changes');
  });
});

describe('a stored plan whose rows carry no count', () => {
  const old = () => {
    const p = cut();
    return {
      ...p,
      changes: p.changes.map(({ count: _c, ...r }) => r),
      omitted: { count: 60 },
    };
  };

  it('shows no number where it could only count rows', async () => {
    const view = await draw(old(), 'applied');
    expect(all(view.container, 'th[scope=colgroup] span')).toHaveLength(0);
    expect(showButton(view.container).textContent.trim()).toBe('Show more');
    await view.step(() => showButton(view.container).click());
    expect(view.container.querySelector('[data-testid=rows-omitted]').textContent).toBe(
      'and more changes',
    );
    await view.unmount();
  });

  it('says so in the Markdown export too', () => {
    const md = conversationToMarkdown(
      { display: [{ kind: 'assistant', text: 'Done.', plan: old(), status: 'applied' }] },
      { title: 'T' },
      { origin: '', projectId: 'p', adapter },
    );
    expect(md).toContain('and more changes');
    expect(md).not.toMatch(/and \d+ more changes/);
  });
});
