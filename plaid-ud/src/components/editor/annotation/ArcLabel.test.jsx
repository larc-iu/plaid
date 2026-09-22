import { describe, it, expect, vi } from 'vitest';
import { renderComponent, all } from '@ui/test/renderComponent.jsx';
import { press } from '../../../test/keyboard.js';
import { ArcLabel } from './ArcLabel.jsx';
import {
  ACTIVE_BLUE,
  afterDeleting,
  arcColor,
  commitsLabel,
  stepThrough,
} from './arcLabelRules.js';
import { LABEL_EDITOR_LIFT } from '../../../utils/arcLayout.js';
import { EditorSessionContext } from './editorSession.js';

// One label, drawn and walked the same way above the words and below them.
// The tree and the band each had their own copy of this and had already
// drifted: the editor sat two pixels apart in the two, and Tab wrapped by a
// modulo in one and a nested ternary in the other.

const RELATION = { id: 'r1', value: 'nsubj', metadata: {} };
const MACHINE = { id: 'r2', value: 'obl', metadata: { prov: 'inferred' } };

const mount = (props) =>
  renderComponent(
    <EditorSessionContext.Provider value={{ vocab: { deprel: ['nsubj', 'obj'] } }}>
      <svg>
        <ArcLabel relation={RELATION} at={{ x: 100, y: 60 }} color="#111" {...props} />
      </svg>
    </EditorSessionContext.Provider>,
  );

const label = (container) => all(container, 'text')[0];

describe('the arc label walks the same way wherever it is drawn', () => {
  it('steps right and left with the arrows and with Tab', async () => {
    const onStep = vi.fn();
    const { container, unmount } = await mount({ onStep });
    press(label(container), 'ArrowRight');
    press(label(container), 'Tab');
    press(label(container), 'ArrowLeft');
    press(label(container), 'Tab', { shiftKey: true });
    expect(onStep.mock.calls.map(([d]) => d)).toEqual([1, 1, -1, -1]);
    await unmount();
  });

  it('opens on Enter and bails on Escape', async () => {
    const onOpen = vi.fn();
    const onEscape = vi.fn();
    const { container, unmount } = await mount({ onOpen, onEscape });
    press(label(container), 'Enter');
    press(label(container), 'Escape');
    expect(onOpen).toHaveBeenCalledOnce();
    expect(onEscape).toHaveBeenCalledOnce();
    await unmount();
  });

  it('drops into the grid on ArrowDown, and lets the key through when there is nowhere to land', async () => {
    const went = vi.fn(() => true);
    const { container, unmount } = await mount({ onExitDown: went });
    const taken = !label(container).dispatchEvent(
      new KeyboardEvent('keydown', { key: 'ArrowDown', bubbles: true, cancelable: true }),
    );
    expect(went).toHaveBeenCalled();
    expect(taken).toBe(true);
    await unmount();

    const stayed = vi.fn(() => false);
    const second = await mount({ onExitDown: stayed });
    const stillFree = second.container
      .querySelector('text')
      .dispatchEvent(
        new KeyboardEvent('keydown', { key: 'ArrowDown', bubbles: true, cancelable: true }),
      );
    expect(stillFree).toBe(true);
    await second.unmount();
  });

  it('gives the caller first refusal on every key', async () => {
    // Ctrl/Cmd+E suppresses in the tree and Ctrl/Cmd+D leaves the band
    // upwards; neither may fall through to the shared walk.
    const onChord = vi.fn(() => true);
    const onStep = vi.fn();
    const onOpen = vi.fn();
    const { container, unmount } = await mount({ onChord, onStep, onOpen });
    press(label(container), 'e', { ctrlKey: true });
    press(label(container), 'ArrowRight');
    press(label(container), 'Enter');
    expect(onChord).toHaveBeenCalledTimes(3);
    expect(onStep).not.toHaveBeenCalled();
    expect(onOpen).not.toHaveBeenCalled();
    await unmount();
  });

  it('opens its editor one lift above the label, wherever the label is', async () => {
    const { container, unmount } = await mount({ editing: true });
    const box = all(container, 'foreignObject')[0];
    expect(Number(box.getAttribute('y'))).toBe(60 - LABEL_EDITOR_LIFT);
    // Centred on the label's own x.
    expect(Number(box.getAttribute('x')) + Number(box.getAttribute('width')) / 2).toBe(100);
    await unmount();
  });

  it('wears a hover record for machine material, or the one the caller gives it', async () => {
    const machine = await mount({ relation: MACHINE });
    expect(all(machine.container, 'title').length).toBe(1);
    await machine.unmount();

    const plain = await mount({ relation: RELATION });
    expect(all(plain.container, 'title').length).toBe(0);
    await plain.unmount();

    // A suppressed relation says that instead, and says it once.
    const suppressed = await mount({ relation: MACHINE, title: 'Not in the enhanced graph' });
    expect(all(suppressed.container, 'title').map((t) => t.textContent)).toEqual([
      'Not in the enhanced graph',
    ]);
    await suppressed.unmount();
  });
});

describe('the rules that go with a label', () => {
  it('colours by what is being worked on, then provenance, then the deprel', () => {
    expect(arcColor(MACHINE, true, {})).toBe(ACTIVE_BLUE);
    expect(arcColor(MACHINE, false, {})).toBe('#6d28d9');
    expect(arcColor(RELATION, false, { nsubj: '#123456' })).toBe('#123456');
  });

  it('writes a changed label, and an unchanged one only when it confirms a guess', () => {
    expect(commitsLabel(RELATION, 'obj', false)).toBe(true);
    expect(commitsLabel(RELATION, 'nsubj', true)).toBe(false);
    expect(commitsLabel(MACHINE, 'obl', true)).toBe(true);
    expect(commitsLabel(MACHINE, 'obl', false)).toBe(false);
  });

  it('wraps at either end of the row, and does not wrap after a delete', () => {
    const row = [{ id: 'a' }, { id: 'b' }, { id: 'c' }];
    expect(stepThrough(row, 'c', 1).id).toBe('a');
    expect(stepThrough(row, 'a', -1).id).toBe('c');
    expect(stepThrough([], 'a', 1)).toBe(null);
    // The row is one shorter after a delete, so the last one falls back left.
    expect(afterDeleting(row, 'a').id).toBe('b');
    expect(afterDeleting(row, 'c').id).toBe('b');
    expect(afterDeleting([{ id: 'a' }], 'a')).toBe(null);
  });
});
