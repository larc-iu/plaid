import { describe, it, expect, vi } from 'vitest';
import { renderComponent, all } from '@ui/test/renderComponent.jsx';
import { FieldsManager } from './FieldsManager';

// "Tokenize new text", beside Ignored tokens in Settings, Annotation: shown
// at once when changed, put back when the save is refused, and absent from
// the setup wizard, which has no word layer to write it on.

const IGNORED = {
  mode: 'unicode-punctuation',
  unicodePunctuationExceptions: [],
  explicitIgnoredTokens: [],
};

const mount = async (props) =>
  renderComponent(
    <FieldsManager
      initialData={{
        fields: [{ name: 'Gloss', scope: 'Word', isCustom: false }],
        ignoredTokens: IGNORED,
      }}
      onSaveChanges={vi.fn(async () => {})}
      projectId="p1"
      {...props}
    />,
  );

const checkbox = (c) =>
  all(c, 'label')
    .find((l) => l.textContent.includes('Tokenize new text'))
    ?.querySelector('input');

describe('Tokenize new text', () => {
  it('shows what is saved and saves a change', async () => {
    const onTokenizeNewTextChange = vi.fn(async () => {});
    const { container, step, unmount } = await mount({
      tokenizeNewText: true,
      onTokenizeNewTextChange,
    });
    expect(checkbox(container).checked).toBe(true);
    await step(async () => checkbox(container).click());
    expect(onTokenizeNewTextChange).toHaveBeenCalledWith(false);
    await unmount();
  });

  it('puts the box back when the save is refused', async () => {
    const onError = vi.fn();
    let refuse;
    const onTokenizeNewTextChange = vi.fn(
      () =>
        new Promise((_, reject) => {
          refuse = reject;
        }),
    );
    const { container, step, unmount } = await mount({
      tokenizeNewText: true,
      onTokenizeNewTextChange,
      onError,
    });
    await step(async () => checkbox(container).click());
    // shown at once
    expect(checkbox(container).checked).toBe(false);
    await step(async () => refuse(new Error('HTTP 409 Changed elsewhere')));
    expect(checkbox(container).checked).toBe(true);
    expect(onError).toHaveBeenCalledTimes(1);
    await unmount();
  });

  it('is not offered without a save for it (the setup wizard)', async () => {
    const { container, unmount } = await mount({});
    expect(checkbox(container)).toBeUndefined();
    await unmount();
  });

  it('names what the punctuation rule ignores', async () => {
    const { container, unmount } = await mount({});
    expect(container.textContent).toContain('Ignore punctuation and symbols');
    expect(container.textContent).not.toContain("category 'P'");
    await unmount();
  });
});
