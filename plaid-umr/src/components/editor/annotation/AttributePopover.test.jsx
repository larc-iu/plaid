import { describe, it, expect, vi } from 'vitest';
import { renderComponent, all, texts } from '@ui/test/renderComponent.jsx';
import { AttributePopover } from './AttributePopover.jsx';
import { unknownRelationProblem } from '../../../domain/format/validate.js';

// The picker is portaled out of the mount container (it must escape the
// canvas, which clips), so everything is looked up in the document.
const pressed = () => all(document.body, '[aria-pressed="true"]').map((b) => b.textContent);
const button = (text) => all(document.body, '.umr-attr-value').find((b) => b.textContent === text);
const picker = () => document.body.querySelector('.umr-attr-popover');

describe('AttributePopover', () => {
  it('shows the path to the node value and refines or coarsens on a click', async () => {
    const onChange = vi.fn();
    const attrs = [
      { rel: ':aspect', value: 'performance' },
      { rel: ':polarity', value: '-' },
      { rel: ':quant', value: '3' },
    ];
    const r = await renderComponent(
      <AttributePopover
        attrs={attrs}
        relationProblem={unknownRelationProblem}
        onChange={onChange}
        onClose={() => {}}
      />,
    );
    expect(pressed()).toEqual(['performance', '-']);
    // The aspect row shows four lines: the top level and the children down
    // the path, with the coarser values marked as on the path.
    const aspect = document.body.querySelector('[data-rel=":aspect"]');
    expect(all(aspect, '[data-line]')).toHaveLength(4);
    expect(texts(aspect, '[data-on-path]')).toEqual(['process', 'perfective']);
    // What has no row is the text line.
    expect(document.body.querySelector('.umr-attr-other').value).toBe(':quant 3');

    // Refining keeps the other attributes and their order.
    await r.step(() => button('incremental-accomplishment').click());
    expect(onChange).toHaveBeenLastCalledWith([
      { rel: ':polarity', value: '-' },
      { rel: ':quant', value: '3' },
      { rel: ':aspect', value: 'incremental-accomplishment' },
    ]);
    // Coarsening is a click on a value up the path.
    await r.step(() => button('process').click());
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
      <AttributePopover
        attrs={attrs}
        relationProblem={unknownRelationProblem}
        onChange={onChange}
        onClose={onClose}
      />,
    );
    // Focus opens on the current value of the first row.
    expect(document.activeElement.textContent).toBe('state');
    await r.step(() => document.body.querySelector('[aria-label="Clear aspect"]').click());
    expect(onChange).toHaveBeenLastCalledWith([]);

    await r.step(() => button('singular').click());
    expect(onChange).toHaveBeenLastCalledWith([
      { rel: ':aspect', value: 'state' },
      { rel: ':refer-number', value: 'singular' },
    ]);

    const other = document.body.querySelector('.umr-attr-other');
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
      picker().dispatchEvent(new KeyboardEvent('keydown', { key: 'Escape', bubbles: true })),
    );
    expect(onClose).toHaveBeenCalled();
    await r.unmount();
  });

  // The line is written on the way out, however the picker is left: a click
  // on the canvas or another node closed it and wrote nothing, since the
  // picker was gone before the line could blur.
  it('writes the typed line when a pointer down outside closes it', async () => {
    const onChange = vi.fn();
    const onClose = vi.fn();
    const attrs = [{ rel: ':aspect', value: 'state' }];
    const r = await renderComponent(
      <AttributePopover
        attrs={attrs}
        relationProblem={unknownRelationProblem}
        onChange={onChange}
        onClose={onClose}
      />,
    );
    const other = document.body.querySelector('.umr-attr-other');
    await r.step(() => other.focus());
    await typeLine(r, other, ':mod x');
    await r.step(() => document.body.dispatchEvent(new Event('pointerdown', { bubbles: true })));
    expect(onChange).toHaveBeenCalledTimes(1);
    expect(onChange).toHaveBeenLastCalledWith([
      { rel: ':aspect', value: 'state' },
      { rel: ':mod', value: 'x' },
    ]);
    expect(onClose).toHaveBeenCalled();
    await r.unmount();
  });

  // A line the file cannot hold is not dropped on the way out either: the
  // picker stays with the reason, by a click outside or by focus leaving,
  // and Escape is what gives the line up.
  it('stays open with the reason when a refused line is left', async () => {
    const onChange = vi.fn();
    const onClose = vi.fn();
    const attrs = [{ rel: ':aspect', value: 'state' }];
    const outside = document.createElement('button');
    document.body.appendChild(outside);
    const r = await renderComponent(
      <AttributePopover
        attrs={attrs}
        relationProblem={unknownRelationProblem}
        onChange={onChange}
        onClose={onClose}
      />,
    );
    const other = document.body.querySelector('.umr-attr-other');
    await r.step(() => other.focus());
    await typeLine(r, other, 'quant 4');
    await r.step(() => document.body.dispatchEvent(new Event('pointerdown', { bubbles: true })));
    expect(onClose).not.toHaveBeenCalled();
    expect(document.body.querySelector('.umr-attr-problem')).not.toBe(null);
    await r.step(() => outside.focus());
    expect(onClose).not.toHaveBeenCalled();
    expect(other.value).toBe('quant 4');
    await r.step(() =>
      document.dispatchEvent(new KeyboardEvent('keydown', { key: 'Escape', bubbles: true })),
    );
    expect(onClose).toHaveBeenCalled();
    expect(onChange).not.toHaveBeenCalled();
    await r.unmount();
    outside.remove();
  });

  // A row's pick changes the node's attributes and not the line: resetting
  // the line then dropped a refused one while its reason still showed, and
  // the next click outside closed the picker with nothing written.
  it('keeps a refused line through a pick on a row', async () => {
    const onChange = vi.fn();
    const onClose = vi.fn();
    const popover = (attrs) => (
      <AttributePopover
        attrs={attrs}
        relationProblem={unknownRelationProblem}
        onChange={onChange}
        onClose={onClose}
      />
    );
    const r = await renderComponent(popover([{ rel: ':mod', value: 'x' }]));
    const other = document.body.querySelector('.umr-attr-other');
    await r.step(() => other.focus());
    await typeLine(r, other, 'quant 4');
    await r.step(() => button('-').focus());
    expect(document.body.querySelector('.umr-attr-problem')).not.toBe(null);
    await r.step(() => button('-').click());
    expect(onChange).toHaveBeenLastCalledWith([
      { rel: ':mod', value: 'x' },
      { rel: ':polarity', value: '-' },
    ]);
    await r.rerender(popover(onChange.mock.lastCall[0]));
    expect(other.value).toBe('quant 4');
    expect(document.body.querySelector('.umr-attr-problem')).not.toBe(null);
    await r.step(() => document.body.dispatchEvent(new Event('pointerdown', { bubbles: true })));
    expect(onClose).not.toHaveBeenCalled();
    expect(onChange).toHaveBeenCalledTimes(1);
    await r.unmount();
  });
});

const typeLine = (r, input, text) =>
  r.step(() => {
    const setter = Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, 'value').set;
    setter.call(input, text);
    input.dispatchEvent(new Event('input', { bubbles: true }));
  });

// UMR 1.0 moved modality into the document graph and the Validation tab warns
// on `:modal-strength`. The picker listed it second, as weighty as aspect.
describe('AttributePopover, the deprecated attribute', () => {
  it('lists :modal-strength last, marked deprecated', async () => {
    const r = await renderComponent(
      <AttributePopover
        attrs={[]}
        relationProblem={unknownRelationProblem}
        onChange={() => {}}
        onClose={() => {}}
      />,
    );
    const rels = all(document.body, '.umr-attr-row[data-rel]').map((row) => row.dataset.rel);
    expect(rels.at(-1)).toBe(':modal-strength');
    expect(texts(document.body, '.umr-attr-deprecated')).toEqual(['deprecated']);
    expect(
      document.body.querySelector('[data-rel=":modal-strength"] .umr-attr-deprecated'),
    ).not.toBeNull();
    await r.unmount();
  });
});
