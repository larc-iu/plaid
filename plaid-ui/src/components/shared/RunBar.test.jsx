import { describe, it, expect } from 'vitest';
import { renderComponent } from '../../test/renderComponent.jsx';
import { RunBar, RunBarPager } from './RunBar.jsx';

// The row over an annotation surface: the run first, the help last, the
// help's panel under the row only while it is open.
describe('RunBar', () => {
  it('puts the run first and the help toggle last, closed', async () => {
    const view = await renderComponent(
      <RunBar run={<button>Parse</button>} helpLabel="Gestures and marks" help={<p>Rows</p>} />,
    );
    const buttons = [...view.container.querySelectorAll('button')];
    expect(buttons.map((b) => b.textContent)).toEqual(['Parse', '?Gestures and marks']);
    expect(buttons[1].getAttribute('aria-expanded')).toBe('false');
    expect(view.container.textContent).not.toContain('Rows');
    await view.unmount();
  });

  it('opens the help under the row and closes it again', async () => {
    const view = await renderComponent(<RunBar helpLabel="Keys and marks" help={<p>Rows</p>} />);
    const toggle = view.container.querySelector('button');
    await view.step(() => toggle.click());
    expect(toggle.getAttribute('aria-expanded')).toBe('true');
    const panel = view.container.querySelector(`[id="${toggle.getAttribute('aria-controls')}"]`);
    expect(panel.textContent).toBe('Rows');
    await view.step(() => toggle.click());
    expect(view.container.textContent).not.toContain('Rows');
    await view.unmount();
  });

  it('draws nothing with nothing to carry', async () => {
    const view = await renderComponent(<RunBar helpLabel="Keys and marks" />);
    expect(view.container.innerHTML).toBe('');
    await view.unmount();
  });
});

// The sentences' place in the row: a count on one page, the pager past it.
describe('RunBarPager', () => {
  const paged = (over) => ({
    page: 0,
    pageCount: 1,
    rangeStart: 1,
    rangeEnd: 3,
    total: 3,
    onPage: () => {},
    ...over,
  });

  it('counts the sentences on one page, and draws no bottom pager', async () => {
    const top = await renderComponent(<RunBarPager {...paged()} />);
    expect(top.container.textContent).toBe('3 sentences');
    expect(top.container.querySelector('button')).toBeNull();
    await top.unmount();
    const one = await renderComponent(<RunBarPager {...paged({ total: 1, rangeEnd: 1 })} />);
    expect(one.container.textContent).toBe('1 sentence');
    await one.unmount();
    const bottom = await renderComponent(<RunBarPager {...paged()} position="bottom" />);
    expect(bottom.container.innerHTML).toBe('');
    await bottom.unmount();
  });

  it('draws nothing without sentences', async () => {
    const view = await renderComponent(<RunBarPager {...paged({ total: 0, rangeStart: 0 })} />);
    expect(view.container.innerHTML).toBe('');
    await view.unmount();
  });

  it('pages past one page, its ends disabled where they lead nowhere', async () => {
    const pages = [];
    const view = await renderComponent(
      <RunBarPager
        {...paged({ pageCount: 4, rangeEnd: 25, total: 86, onPage: (p) => pages.push(p) })}
      />,
    );
    const buttons = [...view.container.querySelectorAll('button')];
    expect(buttons.map((b) => b.getAttribute('aria-label'))).toEqual([
      'First page',
      'Previous page',
      'Next page',
      'Last page',
    ]);
    expect(buttons.map((b) => b.disabled)).toEqual([true, true, false, false]);
    expect(view.container.textContent).toBe('1–25 of 86');
    await view.step(() => buttons[2].click());
    await view.step(() => buttons[3].click());
    expect(pages).toEqual([1, 3]);
    await view.unmount();
  });
});
