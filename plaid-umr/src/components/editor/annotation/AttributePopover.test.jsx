import { describe, it, expect, vi } from 'vitest';
import { renderComponent, all, texts } from '@ui/test/renderComponent.jsx';
import { AttributePopover } from './AttributePopover.jsx';

const pressed = (container) => all(container, '[aria-pressed="true"]').map((b) => b.textContent);
const button = (container, text) =>
  all(container, '.umr-attr-value').find((b) => b.textContent === text);

describe('AttributePopover', () => {
  it('shows the path to the node value and refines or coarsens on a click', async () => {
    const onChange = vi.fn();
    const attrs = [
      { rel: ':aspect', value: 'performance' },
      { rel: ':polarity', value: '-' },
      { rel: ':quant', value: '3' },
    ];
    const r = await renderComponent(
      <AttributePopover x={0} y={0} attrs={attrs} onChange={onChange} onClose={() => {}} />,
    );
    expect(pressed(r.container)).toEqual(['performance', '-']);
    // The aspect row shows four lines: the top level and the children down
    // the path, with the coarser values marked as on the path.
    const aspect = r.container.querySelector('[data-rel=":aspect"]');
    expect(all(aspect, '[data-line]')).toHaveLength(4);
    expect(texts(aspect, '[data-on-path]')).toEqual(['process', 'perfective']);
    // What has no row is the text line.
    expect(r.container.querySelector('.umr-attr-other').value).toBe(':quant 3');

    // Refining keeps the other attributes and their order.
    await r.step(() => button(r.container, 'incremental-accomplishment').click());
    expect(onChange).toHaveBeenLastCalledWith([
      { rel: ':polarity', value: '-' },
      { rel: ':quant', value: '3' },
      { rel: ':aspect', value: 'incremental-accomplishment' },
    ]);
    // Coarsening is a click on a value up the path.
    await r.step(() => button(r.container, 'process').click());
    expect(onChange).toHaveBeenLastCalledWith([
      { rel: ':polarity', value: '-' },
      { rel: ':quant', value: '3' },
      { rel: ':aspect', value: 'process' },
    ]);
    await r.unmount();
  });

  it('clears a row, sets an unset one, and edits the text line', async () => {
    const onChange = vi.fn();
    const onClose = vi.fn();
    const attrs = [{ rel: ':aspect', value: 'state' }];
    const r = await renderComponent(
      <AttributePopover x={0} y={0} attrs={attrs} onChange={onChange} onClose={onClose} />,
    );
    // Focus opens on the current value of the first row.
    expect(document.activeElement.textContent).toBe('state');
    await r.step(() => r.container.querySelector('[aria-label="Clear aspect"]').click());
    expect(onChange).toHaveBeenLastCalledWith([]);

    await r.step(() => button(r.container, 'singular').click());
    expect(onChange).toHaveBeenLastCalledWith([
      { rel: ':aspect', value: 'state' },
      { rel: ':refer-number', value: 'singular' },
    ]);

    const other = r.container.querySelector('.umr-attr-other');
    await r.step(() => {
      const setter = Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, 'value').set;
      setter.call(other, ':wiki "Q42" :quant 2');
      other.dispatchEvent(new Event('input', { bubbles: true }));
    });
    await r.step(() =>
      other.dispatchEvent(new KeyboardEvent('keydown', { key: 'Enter', bubbles: true })),
    );
    expect(onChange).toHaveBeenLastCalledWith([
      { rel: ':aspect', value: 'state' },
      { rel: ':wiki', value: '"Q42"' },
      { rel: ':quant', value: '2' },
    ]);

    await r.step(() =>
      r.container
        .querySelector('.umr-attr-popover')
        .dispatchEvent(new KeyboardEvent('keydown', { key: 'Escape', bubbles: true })),
    );
    expect(onClose).toHaveBeenCalled();
    await r.unmount();
  });
});
