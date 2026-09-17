import { describe, it, expect, vi } from 'vitest';
import { renderComponent, all } from '@ui/test/renderComponent.jsx';
import { type, focus, blur, press } from '../../../test/keyboard.js';
import { DeprelEditor } from './DeprelEditor.jsx';
import { EditorSessionContext } from './editorSession.js';

// The second argument of onCommit / onTab is the provenance question: did the
// annotator put this label here, or did they only pass through? Re-entering a
// parser's own label is a confirmation of it; tabbing across the sentence is
// not, and a tree full of parser labels must not be verified wholesale by
// someone walking it.
//
// `pristine` cannot answer that question, because it also drives the list:
// every focus reopens the list and so resets it. The same conflation in the
// grid's cells meant that opening the precedent list on a machine value and
// pressing Escape verified it (e2e/precedent.spec.js), which is what `typedRef`
// was split out for there.

const RELATION = { id: 'r1', value: 'nsubj', metadata: { prov: 'inferred' } };
const VOCAB = ['nsubj', 'obj', 'obl', 'det'];

// The editor reads the DEPREL vocabulary, its rule and its glosses off the
// grid's session, the way every cell reads its own field's.
const mount = ({ session, ...props } = {}) =>
  renderComponent(
    <EditorSessionContext.Provider value={{ vocab: { deprel: VOCAB }, ...session }}>
      <DeprelEditor
        relation={RELATION}
        onCommit={() => {}}
        onCancel={() => {}}
        onDelete={() => {}}
        onTab={() => {}}
        {...props}
      />
    </EditorSessionContext.Provider>,
  );

describe('DeprelEditor', () => {
  it('confirms nothing when the label is only passed through', async () => {
    const onCommit = vi.fn();
    const { container, step, unmount } = await mount({ onCommit });
    const input = all(container, 'input')[0];

    await step(async () => focus(input));
    await step(async () => blur(input));

    expect(onCommit).toHaveBeenCalledWith('nsubj', false);
    await unmount();
  });

  it('reports a re-typed label as typed, so the machine guess is confirmed', async () => {
    const onCommit = vi.fn();
    const { container, step, unmount } = await mount({ onCommit });
    const input = all(container, 'input')[0];

    await step(async () => type(input, 'nsubj'));
    await step(async () => blur(input));

    expect(onCommit).toHaveBeenCalledWith('nsubj', true);
    await unmount();
  });

  it('does not forget what was typed when focus returns to the input', async () => {
    // The split itself. A focus is not an arrival: the editor mounts once per
    // edit, so anything typed before a later focus is still the annotator's.
    const onCommit = vi.fn();
    const { container, step, unmount } = await mount({ onCommit });
    const input = all(container, 'input')[0];

    await step(async () => type(input, 'nsubj'));
    await step(async () => focus(input));
    await step(async () => blur(input));

    expect(onCommit).toHaveBeenCalledWith('nsubj', true);
    await unmount();
  });

  it('tabs through an untouched label without writing to it', async () => {
    const onTab = vi.fn();
    const { container, step, unmount } = await mount({ onTab });
    const input = all(container, 'input')[0];

    await step(async () => focus(input));
    await step(async () => press(input, 'Tab'));

    expect(onTab).toHaveBeenCalledWith('nsubj', false, false);
    await unmount();
  });

  it('refuses an off-list value only when something is being committed', async () => {
    // A closed vocabulary must not warn about a label nobody touched: that is
    // one toast per label as you tab across a parsed sentence.
    const validate = vi.fn(() => 'obl:tmod is not in the list.');
    const onCommit = vi.fn();
    const onCancel = vi.fn();
    const { container, step, unmount } = await mount({
      relation: { id: 'r2', value: 'obl:tmod', metadata: {} },
      session: { validators: { deprel: validate } },
      onCommit,
      onCancel,
    });
    const input = all(container, 'input')[0];

    await step(async () => focus(input));
    await step(async () => blur(input));

    expect(validate).not.toHaveBeenCalled();
    expect(onCommit).toHaveBeenCalledWith('obl:tmod', false);
    expect(onCancel).not.toHaveBeenCalled();
    await unmount();
  });

  // A deprel subtype is typed with Shift down for its colon, so the delete
  // chord is live only until something has been typed.
  it('deletes on Shift+Backspace while the label is as it opened', async () => {
    const onDelete = vi.fn();
    const { container, step, unmount } = await mount({ onDelete });
    const input = all(container, 'input')[0];

    await step(async () => focus(input));
    await step(async () => press(input, 'Backspace', { shiftKey: true }));

    expect(onDelete).toHaveBeenCalledTimes(1);
    await unmount();
  });

  it('reads Shift+Backspace as a Backspace once something has been typed', async () => {
    const onDelete = vi.fn();
    const { container, step, unmount } = await mount({ onDelete });
    const input = all(container, 'input')[0];

    await step(async () => focus(input));
    await step(async () => type(input, 'nmod:'));
    await step(async () => press(input, 'Backspace', { shiftKey: true }));
    await step(async () => press(input, 'Delete', { shiftKey: true }));

    expect(onDelete).not.toHaveBeenCalled();
    await unmount();
  });
});
