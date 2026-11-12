import { describe, it, expect, vi } from 'vitest';
import { renderComponent, byText } from '../../test/renderComponent.jsx';
import { ServiceSpotDialog } from './ServiceSpotDialog.jsx';

// Luke (2026-11-12): "modal should be closed as soon as you hit start". The
// banner over the document shows the run and has its Stop, so the dialog
// closes on its verb, and while the run holds the document its opener turns
// and cannot open the dialog again.

const spot = (over = {}) => ({
  options: [{ value: 'builtin:x', label: 'Built-in' }],
  selection: 'builtin:x',
  choose: () => {},
  service: null,
  builtin: { name: 'x', label: 'Built-in' },
  params: { schema: [], errors: {}, coerced: () => ({}) },
  fields: null,
  ...over,
});

const dialog = () => document.body.querySelector('[role="dialog"]');
const inDialog = (label) =>
  [...(dialog()?.querySelectorAll('button') ?? [])].find((b) => b.textContent.trim() === label);

const mount = (props) =>
  renderComponent(<ServiceSpotDialog label="Parse" spot={spot()} onRun={() => {}} {...props} />);

describe('ServiceSpotDialog', () => {
  it('closes as soon as its verb is pressed, and starts the run', async () => {
    const onRun = vi.fn();
    const view = await mount({ onRun });
    await view.step(() => byText(view.container, 'button', 'Parse').click());
    expect(dialog()).not.toBe(null);
    await view.step(() => inDialog('Parse').click());
    expect(onRun).toHaveBeenCalledTimes(1);
    expect(dialog()).toBe(null);
    await view.unmount();
  });

  it('stays open with Run disabled while a required option is missing', async () => {
    const onRun = vi.fn();
    const view = await mount({
      onRun,
      spot: spot({
        params: { schema: [], errors: { model: 'Choose a model.' }, coerced: () => ({}) },
      }),
    });
    await view.step(() => byText(view.container, 'button', 'Parse').click());
    expect(inDialog('Parse').disabled).toBe(true);
    await view.step(() => inDialog('Parse').click());
    expect(onRun).not.toHaveBeenCalled();
    expect(dialog()).not.toBe(null);
    await view.unmount();
  });

  it('turns its opener and disables it while its own run holds the document', async () => {
    const view = await mount({ writeLock: { label: 'Parse' } });
    const opener = byText(view.container, 'button', 'Parse');
    expect(opener.disabled).toBe(true);
    expect(opener.querySelector('svg.animate-spin')).not.toBe(null);
    // No clock and no percent on it: the banner shows them.
    expect(opener.textContent.trim()).toBe('Parse');
    await view.unmount();
  });

  it('opens while another run holds the document, and says which one', async () => {
    const view = await mount({ writeLock: { label: 'Tokenize' } });
    const opener = byText(view.container, 'button', 'Parse');
    expect(opener.disabled).toBe(false);
    expect(opener.querySelector('svg.animate-spin')).toBe(null);
    await view.step(() => opener.click());
    expect(dialog().textContent).toContain('Tokenize is running. One run at a time on a document.');
    expect(inDialog('Parse').disabled).toBe(true);
    await view.unmount();
  });
});
