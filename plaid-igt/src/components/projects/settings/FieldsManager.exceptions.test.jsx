import { describe, it, expect, vi } from 'vitest';
import { renderComponent, all } from '@ui/test/renderComponent.jsx';
import { FieldsManager } from './FieldsManager';

// The exceptions list is what makes a character behave as a letter: it is read
// per CHARACTER by the tokenizer and by domain/igtConfig.js. An entry of two or
// more characters can therefore never match anything, and one sat in a real
// project doing nothing. The field takes characters and says what it refused.

const typeInto = (input, text) => {
  const setter = Object.getOwnPropertyDescriptor(window.HTMLInputElement.prototype, 'value').set;
  setter.call(input, text);
  input.dispatchEvent(new Event('input', { bubbles: true }));
};

// A FRESH initialData object each time, the way the settings screen hands one
// down: it memoizes on `project`, and the project is re-read after every save.
const props = (exceptions, onSaveChanges) => ({
  initialData: {
    fields: [{ name: 'Gloss', scope: 'Word', isCustom: false }],
    ignoredTokens: {
      mode: 'unicode-punctuation',
      unicodePunctuationExceptions: exceptions,
      explicitIgnoredTokens: [],
    },
  },
  onSaveChanges,
  projectId: 'p1',
});

const mount = (initialExceptions = []) => {
  const onSaveChanges = vi.fn(async () => {});
  return renderComponent(<FieldsManager {...props(initialExceptions, onSaveChanges)} />).then(
    (r) => ({
      ...r,
      onSaveChanges,
      // What the parent does after a save lands.
      reloadWith: (exceptions) =>
        r.rerender(<FieldsManager {...props(exceptions, onSaveChanges)} />),
    }),
  );
};

const exceptionsInput = (container) =>
  all(container, 'input').find((i) => (i.placeholder || '').includes('Separate with commas'));

const savedExceptions = (onSaveChanges) =>
  onSaveChanges.mock.calls.at(-1)?.[0]?.ignoredTokens?.unicodePunctuationExceptions;

describe('FieldsManager letter-like characters', () => {
  it('shows what the project already has', async () => {
    const { container, unmount } = await mount(["'", '-']);
    expect(exceptionsInput(container).value).toBe("', -");
    await unmount();
  });

  it('saves single characters', async () => {
    const { container, step, onSaveChanges, unmount } = await mount([]);
    await step(async () => typeInto(exceptionsInput(container), "', `, -"));
    expect(savedExceptions(onSaveChanges)).toEqual(["'", '`', '-']);
    expect(container.textContent).not.toContain('Not saved');
    await unmount();
  });

  it('refuses an entry longer than one character, and names it', async () => {
    const { container, step, onSaveChanges, unmount } = await mount([]);
    await step(async () => typeInto(exceptionsInput(container), "', -ab"));
    expect(savedExceptions(onSaveChanges)).toEqual(["'"]);
    expect(container.textContent).toContain('One character each');
    expect(container.textContent).toContain('-ab');
    await unmount();
  });

  it('keeps the refused entry on screen so it can be corrected in place', async () => {
    // Dropping it from the field as it was typed would make the second
    // character of any entry impossible to reach.
    const { container, step, unmount } = await mount([]);
    await step(async () => typeInto(exceptionsInput(container), '-ab'));
    expect(exceptionsInput(container).value).toBe('-ab');
    await step(async () => typeInto(exceptionsInput(container), '-'));
    expect(container.textContent).not.toContain('Not saved');
    await unmount();
  });

  it('survives the reload the parent does after each save', async () => {
    // The settings screen re-reads the project after a save and hands down a
    // new initialData, which re-runs the load. Adopting the stored list
    // unconditionally wiped the field mid-edit: the browser showed an empty
    // box while "-ab, xy" was still being typed.
    const { container, step, reloadWith, unmount } = await mount([]);
    await step(async () => typeInto(exceptionsInput(container), '-ab, xy'));
    await step(async () => reloadWith([])); // nothing valid was saved
    expect(exceptionsInput(container).value).toBe('-ab, xy');
    expect(container.textContent).toContain('Not saved');

    // A list that actually differs is still adopted — a change made elsewhere.
    await step(async () => reloadWith(["'"]));
    expect(exceptionsInput(container).value).toBe("'");
    await unmount();
  });

  it('leaves the field alone when the reload agrees with what was typed', async () => {
    const { container, step, reloadWith, unmount } = await mount([]);
    await step(async () => typeInto(exceptionsInput(container), "', -"));
    await step(async () => reloadWith(["'", '-']));
    // Not renormalized to "', -" from the array: the caret stays put.
    expect(exceptionsInput(container).value).toBe("', -");
    await unmount();
  });

  it('counts an astral character as one character', async () => {
    const { container, step, onSaveChanges, unmount } = await mount([]);
    await step(async () => typeInto(exceptionsInput(container), '\u{1D7CE}'));
    expect(savedExceptions(onSaveChanges)).toEqual(['\u{1D7CE}']);
    expect(container.textContent).not.toContain('Not saved');
    await unmount();
  });
});
