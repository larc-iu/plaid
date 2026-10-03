import { describe, it, expect, vi } from 'vitest';
import { renderComponent, all } from '@ui/test/renderComponent.jsx';
import { FieldsManager } from './FieldsManager';
import { annotatedWordFormsQuery, hiddenWordCount } from '@/domain/ignoredChange';
import { storedIgnoredTokens } from '@/domain/igtConfig';

// A word the ignored-tokens rule excludes is drawn with no values, and exports
// and copies follow the grid. So a rule change that makes annotated words
// ignored says how many before it saves (ruling, 2026-10-03). A change that
// hides none saves at once, as before.

const typeInto = (input, text) => {
  const setter = Object.getOwnPropertyDescriptor(window.HTMLInputElement.prototype, 'value').set;
  setter.call(input, text);
  input.dispatchEvent(new Event('input', { bubbles: true }));
};

// The project's annotated word forms: "uh" four times, "dog" twice, a lone
// apostrophe once (a word while ' is letter-like).
const FORMS = [
  ['uh', 4],
  ['dog', 2],
  ["'", 1],
];
const counter = () =>
  vi.fn(async (before, after) =>
    hiddenWordCount(FORMS, storedIgnoredTokens(before), storedIgnoredTokens(after)),
  );

const mount = async (ignoredTokens) => {
  const onSaveChanges = vi.fn(async () => {});
  const onCountHiddenWords = counter();
  const r = await renderComponent(
    <FieldsManager
      initialData={{ fields: [{ name: 'Gloss', scope: 'Word', isCustom: false }], ignoredTokens }}
      onSaveChanges={onSaveChanges}
      onCountHiddenWords={onCountHiddenWords}
      projectId="p1"
    />,
  );
  return { ...r, onSaveChanges, onCountHiddenWords };
};

const EXPLICIT = {
  mode: 'explicit-list',
  unicodePunctuationExceptions: [],
  explicitIgnoredTokens: ['.'],
};
const PUNCT = {
  mode: 'unicode-punctuation',
  unicodePunctuationExceptions: ["'"],
  explicitIgnoredTokens: [],
};

const input = (c, placeholder) =>
  all(c, 'input').find((i) => (i.placeholder || '').includes(placeholder));
const button = (c, label) => all(c, 'button').find((b) => b.textContent.trim() === label);

describe('a rule change that hides annotated words', () => {
  it('adding an annotated word to the explicit list waits for Save, with the count', async () => {
    const { container, step, onSaveChanges, unmount } = await mount(EXPLICIT);
    await step(async () => typeInto(input(container, 'Add tokens'), '., uh'));
    expect(onSaveChanges).not.toHaveBeenCalled();
    expect(container.textContent).toContain('hides the annotations on 4 words');
    // What was typed stays, comma and all.
    expect(input(container, 'Add tokens').value).toBe('., uh');
    await step(async () => button(container, 'Save').click());
    expect(onSaveChanges).toHaveBeenCalledTimes(1);
    expect(onSaveChanges.mock.calls[0][0].ignoredTokens.explicitIgnoredTokens).toEqual(['.', 'uh']);
    expect(container.textContent).not.toContain('hides the annotations');
    await unmount();
  });

  it('Cancel puts the list back and saves nothing', async () => {
    const { container, step, onSaveChanges, unmount } = await mount(EXPLICIT);
    await step(async () => typeInto(input(container, 'Add tokens'), '., uh'));
    await step(async () => button(container, 'Cancel').click());
    expect(onSaveChanges).not.toHaveBeenCalled();
    expect(input(container, 'Add tokens').value).toBe('.');
    await unmount();
  });

  it('a change that hides no annotated word saves at once', async () => {
    const { container, step, onSaveChanges, unmount } = await mount(EXPLICIT);
    await step(async () => typeInto(input(container, 'Add tokens'), '., ;'));
    expect(onSaveChanges).toHaveBeenCalledTimes(1);
    expect(container.textContent).not.toContain('Not saved');
    await unmount();
  });

  it('taking a character off the letter-like list counts the words it leaves ignored', async () => {
    const { container, step, onSaveChanges, unmount } = await mount(PUNCT);
    await step(async () => typeInto(input(container, 'Separate with commas'), ''));
    expect(onSaveChanges).not.toHaveBeenCalled();
    expect(container.textContent).toContain('hides the annotations on 1 word.');
    await unmount();
  });

  it('switching to the explicit list is held too, and the section shows the held mode', async () => {
    const { container, step, onSaveChanges, unmount } = await mount({
      ...PUNCT,
      explicitIgnoredTokens: ['uh'],
    });
    const explicitRadio = all(container, 'input[type="radio"]').find(
      (r) => r.value === 'explicit-list',
    );
    await step(async () => explicitRadio.click());
    expect(onSaveChanges).not.toHaveBeenCalled();
    expect(container.textContent).toContain('hides the annotations on 4 words');
    expect(input(container, 'Add tokens').value).toBe('uh');
    // Typed back to what is saved: nothing held, nothing saved.
    const punctRadio = all(container, 'input[type="radio"]').find(
      (r) => r.value === 'unicode-punctuation',
    );
    await step(async () => punctRadio.click());
    expect(container.textContent).not.toContain('Not saved');
    expect(onSaveChanges).not.toHaveBeenCalled();
    await unmount();
  });

  it('a count that fails says so and still lets the change be saved', async () => {
    const onSaveChanges = vi.fn(async () => {});
    const { container, step, unmount } = await renderComponent(
      <FieldsManager
        initialData={{ fields: [], ignoredTokens: EXPLICIT }}
        onSaveChanges={onSaveChanges}
        onCountHiddenWords={async () => {
          throw new Error('HTTP 408');
        }}
        projectId="p1"
      />,
    );
    await step(async () => typeInto(input(container, 'Add tokens'), '., uh'));
    expect(container.textContent).toContain('could not be counted');
    await step(async () => button(container, 'Save').click());
    expect(onSaveChanges).toHaveBeenCalledTimes(1);
    await unmount();
  });
});

describe('hiddenWordCount', () => {
  const punct = (whitelist) => ({ type: 'unicodePunctuation', whitelist });
  it('counts only the words the new rule ignores and the old one did not', () => {
    expect(hiddenWordCount(FORMS, punct(["'"]), punct([]))).toBe(1);
    expect(hiddenWordCount(FORMS, punct([]), punct(["'"]))).toBe(0);
    expect(hiddenWordCount(FORMS, punct([]), { type: 'blacklist', blacklist: ['uh', 'dog'] })).toBe(
      6,
    );
  });
});

describe('annotatedWordFormsQuery', () => {
  it('counts words, with each kind of value in its own branch', () => {
    const q = annotatedWordFormsQuery({
      wordLayerId: 'w',
      morphLayerId: 'm',
      wordSpanLayerIds: ['g'],
      morphSpanLayerIds: ['mg'],
    });
    expect(q.return).toEqual({ group: ['?val'], aggregates: [['count']] });
    const [, , or] = q.where;
    expect(or[0]).toBe('or');
    expect(or.slice(1)).toHaveLength(4);
  });

  it('asks the link branch twice when it is the only one', () => {
    const q = annotatedWordFormsQuery({ wordLayerId: 'w' });
    const [, , or] = q.where;
    expect(or.slice(1)).toEqual([[['link-token', '?wl', '?t']], [['link-token', '?wl', '?t']]]);
  });
});
