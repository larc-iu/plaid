import { describe, it, expect } from 'vitest';
import { Info } from 'lucide-react';
import { renderComponent } from '../../test/renderComponent.jsx';
import { Notice } from './Notice.jsx';

// A banner in one of four tones, each coloured from its token.

const box = (view) => view.container.firstElementChild;

describe('Notice', () => {
  it.each([
    ['info', 'border-primary/30', 'bg-primary/5'],
    ['warning', 'border-warning/40', 'bg-warning/10'],
    ['error', 'border-destructive/40', 'bg-destructive/10'],
    ['success', 'border-success/40', 'bg-success/10'],
  ])('draws the %s tone from its colour token, with an icon', async (tone, border, bg) => {
    const view = await renderComponent(<Notice tone={tone}>Something to say.</Notice>);
    const el = box(view);
    expect(el.getAttribute('data-tone')).toBe(tone);
    expect(el.className).toContain(border);
    expect(el.className).toContain(bg);
    expect(el.textContent).toBe('Something to say.');
    const icon = el.querySelector('svg');
    expect(icon).not.toBeNull();
    expect(icon.getAttribute('aria-hidden')).toBe('true');
    await view.unmount();
  });

  it('writes an error in the darker red, the red itself left to the border and icon', async () => {
    const view = await renderComponent(<Notice tone="error">Import failed.</Notice>);
    const classes = box(view).className.split(' ');
    // The red on its own tint measured 3.3:1. The strong red passes AA.
    expect(classes).toContain('text-destructive-strong');
    expect(classes).not.toContain('text-destructive');
    expect(box(view).querySelector('svg').getAttribute('class')).toContain('text-destructive');
    await view.unmount();
  });

  it('is an info notice when no tone is named', async () => {
    const view = await renderComponent(<Notice>Plain.</Notice>);
    expect(box(view).getAttribute('data-tone')).toBe('info');
    await view.unmount();
  });

  it('takes another icon, or none', async () => {
    const other = await renderComponent(
      <Notice tone="warning" icon={Info}>
        Read-only.
      </Notice>,
    );
    expect(box(other).querySelector('svg').getAttribute('class')).toContain('lucide-info');
    await other.unmount();

    const none = await renderComponent(
      <Notice tone="error" icon={null}>
        Could not save.
      </Notice>,
    );
    expect(box(none).querySelector('svg')).toBeNull();
    await none.unmount();
  });

  it('passes a role and extra classes through to the box', async () => {
    const view = await renderComponent(
      <Notice tone="error" role="alert" className="mb-4">
        Could not save.
      </Notice>,
    );
    expect(box(view).getAttribute('role')).toBe('alert');
    expect(box(view).className).toContain('mb-4');
    await view.unmount();
  });

  it('lets text in any script take its own direction inside the box', async () => {
    const view = await renderComponent(
      <Notice tone="warning">
        <span dir="auto">لا يمكن الحفظ</span>
      </Notice>,
    );
    // The box is chrome and sets no direction, so the text inside decides.
    expect(box(view).hasAttribute('dir')).toBe(false);
    expect(box(view).querySelector('[dir="auto"]').textContent).toBe('لا يمكن الحفظ');
    // Icon first in the DOM: it sits at the start of the line.
    expect(box(view).firstElementChild.tagName.toLowerCase()).toBe('svg');
    // No physical left or right inset anywhere, so nothing is on the wrong
    // side under a right-to-left parent.
    const classes = [box(view), ...box(view).querySelectorAll('*')]
      .map((n) => n.getAttribute('class') || '')
      .join(' ');
    expect(classes).not.toMatch(/(^|\s)(ml|mr|pl|pr|left|right)-/);
    await view.unmount();
  });
});
