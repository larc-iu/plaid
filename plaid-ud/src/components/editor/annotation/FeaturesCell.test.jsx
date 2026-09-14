import { describe, it, expect, vi } from 'vitest';
import { renderComponent, all } from '@ui/test/renderComponent.jsx';
import { type, focus, blur, press } from '../../../test/keyboard.js';
import { readFeatureInventory } from '../../../utils/udVocab.js';
import { FeaturesCell } from './FeaturesCell.jsx';
import { EditorSessionContext } from './editorSession.js';

// FEATS is the one cell whose value is a SET, so the provenance question the
// other cells answer with `typedRef` is answered here by the shape of the
// input: it is always empty on arrival, and only a complete Key=Value written
// into it commits. Re-typing a pair the word already carries is a
// confirmation of the span that holds it (the domain keys a feature write by
// the half before the '=', see test/conlluDocumentMutations.test.js); walking
// across the row with Tab, and Escape after typing, write nothing at all.

vi.mock('../../../utils/feedback.jsx', () => ({ notifyWarning: vi.fn() }));

const MACHINE = { prov: 'inferred', provSource: 'service:stanza-parser' };

// A project that has named its features. Typing a pair the inventory knows
// leaves the suggestion list OPEN over the exact match, which is the state the
// cell has to keep answering for.
const INVENTORY = readFeatureInventory({
  ud: { inventory: [{ key: 'Gender', values: ['Masc', 'Fem'] }] },
});

const mount = (props = {}, session = {}) => {
  const onAnnotationUpdate = vi.fn(() => Promise.resolve());
  const onFeatureDelete = vi.fn(() => Promise.resolve());
  const value = { isReadOnly: false, onAnnotationUpdate, onFeatureDelete, ...session };
  return renderComponent(
    <EditorSessionContext.Provider value={value}>
      <FeaturesCell
        feats={[{ value: 'Gender=Masc', metadata: MACHINE }]}
        spanIds={[{ spanId: 'f1' }]}
        tokenId="t1"
        tokenIndex={0}
        tabIndex={1}
        columnWidth={120}
        {...props}
      />
    </EditorSessionContext.Provider>,
  ).then((view) => ({ ...view, onAnnotationUpdate, onFeatureDelete }));
};

describe('FeaturesCell and the machine value re-typed', () => {
  it('marks the pill of a machine-made feature', async () => {
    const { container, unmount } = await mount();
    expect(all(container, '.feature-text--machine')).toHaveLength(1);
    await unmount();
  });

  it('writes the pair the word already carries, so the span is confirmed', async () => {
    const { container, step, onAnnotationUpdate, unmount } = await mount();
    const input = all(container, 'input')[0];

    await step(async () => focus(input));
    await step(async () => type(input, 'Gender=Masc'));
    await step(async () => press(input, 'Enter'));

    expect(onAnnotationUpdate).toHaveBeenCalledWith('t1', 'features', 'Gender=Masc');
    await unmount();
  });

  it('commits the same pair on the way out, not only on Enter', async () => {
    const { container, step, onAnnotationUpdate, unmount } = await mount();
    const input = all(container, 'input')[0];

    await step(async () => focus(input));
    await step(async () => type(input, 'Gender=Masc'));
    await step(async () => blur(input));

    expect(onAnnotationUpdate).toHaveBeenCalledWith('t1', 'features', 'Gender=Masc');
    await unmount();
  });

  // A space either side of the '=' is a typo, not a second feature name: the
  // pair is trimmed to the one the word already carries, so the span holding
  // `Gender` is the one written (test/feats.test.js and the document tests).
  it('trims the pair before writing it', async () => {
    const { container, step, onAnnotationUpdate, unmount } = await mount();
    const input = all(container, 'input')[0];

    await step(async () => focus(input));
    await step(async () => type(input, ' Gender = Masc '));
    await step(async () => press(input, 'Enter'));

    expect(onAnnotationUpdate).toHaveBeenCalledWith('t1', 'features', 'Gender=Masc');
    await unmount();
  });

  // A space INSIDE a half is not a typo the cell can fix: CoNLL-U cannot write
  // it, and only the annotator knows what was meant. Refused like an off-list
  // pair, and the text stays for them to correct.
  it('refuses a pair with a space inside it and keeps what was typed', async () => {
    const { container, step, onAnnotationUpdate, unmount } = await mount();
    const input = all(container, 'input')[0];

    await step(async () => focus(input));
    await step(async () => type(input, 'Gender=Fem Masc'));
    await step(async () => press(input, 'Enter'));

    expect(onAnnotationUpdate).not.toHaveBeenCalled();
    expect(input.value).toBe('Gender=Fem Masc');

    // And the blur on the way out does not write it either, nor wipe it.
    await step(async () => blur(input));
    expect(onAnnotationUpdate).not.toHaveBeenCalled();
    expect(input.value).toBe('Gender=Fem Masc');
    await unmount();
  });

  it('writes nothing when the cell is only passed through', async () => {
    const { container, step, onAnnotationUpdate, unmount } = await mount();
    const input = all(container, 'input')[0];

    await step(async () => focus(input));
    await step(async () => press(input, 'Enter'));
    await step(async () => blur(input));

    expect(onAnnotationUpdate).not.toHaveBeenCalled();
    await unmount();
  });

  it('writes nothing when Escape cancels what was typed', async () => {
    const { container, step, onAnnotationUpdate, unmount } = await mount();
    const input = all(container, 'input')[0];

    await step(async () => focus(input));
    await step(async () => type(input, 'Gender=Masc'));
    await step(async () => press(input, 'Escape'));
    await step(async () => blur(input));

    expect(onAnnotationUpdate).not.toHaveBeenCalled();
    await unmount();
  });

  // With a configured inventory the list stays open over an exact match, so
  // Escape has a list to close as well as an edit to cancel. It has to do
  // both: gated on the list, the first Escape closed it and the Tab after it
  // reached the blur with nothing cancelled and wrote the pair.
  it('writes nothing when Escape cancels with the suggestion list open', async () => {
    const { container, step, onAnnotationUpdate, unmount } = await mount(
      {},
      { vocab: { featureInventory: INVENTORY } },
    );
    const input = all(container, 'input')[0];

    await step(async () => focus(input));
    await step(async () => type(input, 'Gender=Masc'));
    expect(input.getAttribute('aria-expanded')).toBe('true');

    await step(async () => press(input, 'Escape'));
    await step(async () => blur(input));

    expect(onAnnotationUpdate).not.toHaveBeenCalled();
    await unmount();
  });
});
