import { describe, it, expect } from 'vitest';
import { renderComponent } from '../../test/renderComponent.jsx';
import { RunBanner } from './RunBanner.jsx';

// The banner is the one place a run's progress shows. It is information, not a
// warning (Luke, 2026-11-12: "red means error and this is not an error"): the
// info tone, with an icon that turns because the run is moving.

const text = (el) => el.textContent.replace(/\s+/g, ' ').trim();
const bar = (view) => view.container.querySelector('[role="progressbar"]');
const status = (view) => view.container.querySelector('[role="status"]');

describe('RunBanner', () => {
  it("is an info notice with a turning icon, the run's name, the clock and that editing is paused", async () => {
    const view = await renderComponent(
      <RunBanner
        label="Parse"
        startedAt={Date.now() - 65_000}
        steps={['Parse']}
        percent={null}
        message="Sentence 3 of 40."
      />,
    );
    const box = view.container.querySelector('[data-tone]');
    expect(box.getAttribute('data-tone')).toBe('info');
    expect(box.querySelector('svg.animate-spin')).not.toBe(null);
    expect(box.textContent).toMatch(/^ParseEditing paused\.1:05/);
    // One step lists no steps and counts none.
    expect(view.container.querySelector('ol')).toBe(null);
    expect(text(status(view))).toBe('Sentence 3 of 40.');
    expect(view.container.innerHTML).not.toMatch(/warning|destructive|amber-/);
    await view.unmount();
  });

  it('pulses its bar while the fraction is unknown, and fills it once it is known', async () => {
    const at = (percent) => (
      <RunBanner label="Parse" startedAt={Date.now()} steps={['Parse']} percent={percent} />
    );
    const view = await renderComponent(at(null));
    expect(bar(view).getAttribute('aria-valuenow')).toBe(null);
    expect(bar(view).querySelector('.animate-pulse')).not.toBe(null);
    await view.rerender(at(42));
    expect(bar(view).getAttribute('aria-valuenow')).toBe('42');
    await view.unmount();
  });

  it('lists the steps of a run that has several, marks the one it is on and counts it', async () => {
    const view = await renderComponent(
      <RunBanner
        label="Auto-analyze"
        startedAt={Date.now()}
        steps={['Propose translations', 'Copy previous analyses', 'Link to the lexicon']}
        stepIndex={1}
        percent={50}
        message="Reading 3 documents…"
      />,
    );
    const items = [...view.container.querySelectorAll('ol li')];
    expect(items.map(text)).toEqual([
      'Propose translations',
      'Copy previous analyses',
      'Link to the lexicon',
    ]);
    expect(items.map((li) => li.getAttribute('aria-current'))).toEqual([null, 'step', null]);
    // The step done is ticked.
    expect(items[0].querySelector('svg')).not.toBe(null);
    expect(text(status(view))).toBe('Step 2 of 3. Reading 3 documents…');
    // Half of the second of three steps is half the run.
    expect(bar(view).getAttribute('aria-valuenow')).toBe('50');
    expect(bar(view).getAttribute('aria-label')).toBe('Step 2 of 3');
    await view.unmount();
  });

  it('never leaves its status line blank', async () => {
    const view = await renderComponent(
      <RunBanner label="Auto-analyze" startedAt={Date.now()} steps={['Translate', 'Link']} />,
    );
    // A step that has said nothing yet is named.
    expect(text(status(view))).toBe('Step 1 of 2. Translate');
    await view.rerender(<RunBanner label="Tokenize" startedAt={Date.now()} steps={['Tokenize']} />);
    expect(text(status(view))).toBe('Working…');
    await view.unmount();
  });

  it('has Stop only when the run can stop', async () => {
    let stopped = 0;
    const view = await renderComponent(
      <RunBanner
        label="Parse"
        startedAt={Date.now()}
        steps={['Parse']}
        cancel={() => (stopped += 1)}
      />,
    );
    const stop = [...view.container.querySelectorAll('button')].find(
      (b) => b.textContent === 'Stop',
    );
    expect(stop).toBeTruthy();
    await view.step(() => stop.click());
    expect(stopped).toBe(1);
    await view.rerender(<RunBanner label="Parse" startedAt={Date.now()} steps={['Parse']} />);
    expect(view.container.querySelector('button')).toBe(null);
    await view.unmount();
  });
});
