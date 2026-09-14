import { describe, it, expect, vi } from 'vitest';
import { renderComponent, all } from '@ui/test/renderComponent.jsx';
import { EditableCell } from './EditableCell.jsx';
import { EditorSessionContext } from './editorSession.js';

// Which fields are pickers is a RULE, not the shape of a project's config.
//
// The cell reads the session's `vocab`, `validators` and `descriptions` by its
// own field name, and those maps have no `lemma` key only because nothing that
// builds them writes one. A project config that did would have turned LEMMA
// into a combobox that refuses anything off the list, which is the opposite of
// what a lemma is. So the session below poisons all three with a `lemma` entry
// and the cell has to ignore it.

vi.mock('../../../utils/notify.js', () => ({ notifyWarning: vi.fn() }));
const { notifyWarning } = await import('../../../utils/notify.js');

const POISONED = {
  vocab: { lemma: ['dog', 'cat'], upos: ['NOUN', 'VERB'] },
  validators: {
    lemma: (value) => (value === 'dog' ? null : 'not in the list'),
    upos: () => null,
  },
  descriptions: { lemma: { dog: 'a dog' }, upos: { NOUN: 'a thing' } },
};

const mount = (props, session = {}) => {
  const onAnnotationUpdate = vi.fn(() => Promise.resolve());
  const value = { isReadOnly: false, onAnnotationUpdate, ...POISONED, ...session };
  return renderComponent(
    <EditorSessionContext.Provider value={value}>
      <EditableCell
        value=""
        tokenId="t1"
        tokenIndex={0}
        field="lemma"
        tokenForm="dogs"
        tabIndex={1}
        columnWidth={80}
        {...props}
      />
    </EditorSessionContext.Provider>,
  ).then((view) => ({ ...view, onAnnotationUpdate }));
};

// One character at a time, the way a keyboard does it (see DeprelEditor.test).
const type = (input, text) => {
  const setter = Object.getOwnPropertyDescriptor(window.HTMLInputElement.prototype, 'value').set;
  for (let i = 1; i <= text.length; i++) {
    setter.call(input, text.slice(0, i));
    input.dispatchEvent(new Event('input', { bubbles: true }));
  }
};
const focus = (input) => input.dispatchEvent(new FocusEvent('focusin', { bubbles: true }));
const blur = (input) => input.dispatchEvent(new FocusEvent('focusout', { bubbles: true }));

describe('EditableCell and the controlled fields', () => {
  it('leaves LEMMA a plain input when the session carries a lemma vocabulary', async () => {
    const { container, unmount } = await mount();
    const input = all(container, 'input')[0];
    expect(input.getAttribute('role')).toBe(null);
    expect(input.getAttribute('aria-expanded')).toBe(null);
    await unmount();
  });

  it('writes a lemma that is not on that list, and says nothing about it', async () => {
    const { container, step, onAnnotationUpdate, unmount } = await mount();
    const input = all(container, 'input')[0];

    await step(async () => focus(input));
    await step(async () => type(input, 'wolf'));
    await step(async () => blur(input));

    expect(onAnnotationUpdate).toHaveBeenCalledWith('t1', 'lemma', 'wolf');
    expect(notifyWarning).not.toHaveBeenCalled();
    await unmount();
  });

  it('still makes UPOS a picker, which is what the gate is there to allow', async () => {
    const { container, unmount } = await mount({ field: 'upos', value: 'NOUN' });
    const input = all(container, 'input')[0];
    expect(input.getAttribute('role')).toBe('combobox');
    await unmount();
  });
});
