import { describe, it, expect, vi } from 'vitest';
import { renderComponent, all } from '@ui/test/renderComponent.jsx';
import { FieldsManager } from './FieldsManager';
import { annotatedCounts, annotatedWordsQueries, newlyIgnoredForms } from '@/domain/ignoredChange';
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
const ANNOTATED = new Map(FORMS);
const counter = () =>
  vi.fn(async (before, after) =>
    newlyIgnoredForms(FORMS, storedIgnoredTokens(before), storedIgnoredTokens(after)).reduce(
      (n, f) => n + ANNOTATED.get(f),
      0,
    ),
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

describe('while the count runs', () => {
  it('shows the change at once as counting, with Save disabled until the count lands', async () => {
    let answer;
    const onSaveChanges = vi.fn(async () => {});
    const { container, step, unmount } = await renderComponent(
      <FieldsManager
        initialData={{ fields: [], ignoredTokens: { ...PUNCT, explicitIgnoredTokens: ['uh'] } }}
        onSaveChanges={onSaveChanges}
        onCountHiddenWords={() => new Promise((resolve) => (answer = resolve))}
        projectId="p1"
      />,
    );
    const explicitRadio = all(container, 'input[type="radio"]').find(
      (r) => r.value === 'explicit-list',
    );
    await step(async () => explicitRadio.click());
    // The radio stays where it was clicked, and the list it would apply shows.
    expect(explicitRadio.checked).toBe(true);
    expect(input(container, 'Add tokens').value).toBe('uh');
    expect(container.textContent).toContain('Counting the annotated words this change hides');
    expect(button(container, 'Save').disabled).toBe(true);
    await step(async () => answer(4));
    expect(container.textContent).toContain('hides the annotations on 4 words');
    expect(button(container, 'Save').disabled).toBe(false);
    expect(onSaveChanges).not.toHaveBeenCalled();
    await unmount();
  });
});

describe('newlyIgnoredForms', () => {
  const punct = (whitelist) => ({ type: 'unicodePunctuation', whitelist });
  it('picks only the forms the new rule ignores and the old one did not', () => {
    expect(newlyIgnoredForms(FORMS, punct(["'"]), punct([]))).toEqual(["'"]);
    expect(newlyIgnoredForms(FORMS, punct([]), punct(["'"]))).toEqual([]);
    expect(
      newlyIgnoredForms(FORMS, punct([]), { type: 'blacklist', blacklist: ['uh', 'dog'] }),
    ).toEqual(['uh', 'dog']);
  });
});

describe('annotatedWordsQueries', () => {
  const layers = {
    wordLayerId: 'w',
    morphLayerId: 'm',
    wordSpanLayerIds: ['g'],
    morphSpanLayerIds: ['mg'],
  };

  it('never nests a morpheme in its word, which ran past the time limit on large projects', () => {
    const [q] = annotatedWordsQueries(layers, ['uh']);
    expect(JSON.stringify(q)).not.toContain('within');
    // A morpheme is found by its own surface, which is its word's.
    const [, ...branches] = q.where[0];
    expect(branches).toHaveLength(4);
    for (const b of branches) {
      expect(b[0]).toEqual([
        'token',
        expect.any(String),
        expect.objectContaining({ value: ['uh'], doc: { var: '?d' }, begin: { var: '?b' } }),
      ]);
    }
    expect(q.return).toEqual({ group: ['?val', '?d', '?b'], aggregates: [['count']] });
  });

  it('asks about the forms in chunks, and the link branch twice when it is the only one', () => {
    const forms = Array.from({ length: 450 }, (_, i) => `f${i}`);
    expect(annotatedWordsQueries(layers, forms)).toHaveLength(3);
    const [q] = annotatedWordsQueries({ wordLayerId: 'w' }, ['uh']);
    const [, a, b] = q.where[0];
    expect(a).toEqual(b);
  });

  it('counts a word once however much it carries, and a form with none as 0', () => {
    const rows = [
      ['uh', 'd1', 0, 3],
      ['uh', 'd1', 9, 1],
      ['uh', 'd2', 4, 2],
    ];
    expect(annotatedCounts(['uh', '('], [rows])).toEqual(
      new Map([
        ['uh', 3],
        ['(', 0],
      ]),
    );
  });
});
