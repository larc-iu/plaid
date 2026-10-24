import { describe, it, expect } from 'vitest';
import { renderComponent, all } from '@ui/test/renderComponent.jsx';
import { FieldsManager } from './FieldsManager';

// Q1-IGT-POLISH: the list follows the Analyze grid's order of scopes (word,
// morpheme, sentence), and a field moves past a field of another scope stored
// between it and the next of its own, where it could not be moved at all.
describe('FieldsManager order', () => {
  it('lists the fields by scope as the grid does, and moves one within its scope', async () => {
    const saved = [];
    const r = await renderComponent(
      <FieldsManager
        initialData={{
          fields: [
            { name: 'Translation', scope: 'Sentence', isCustom: false },
            { name: 'Gloss', scope: 'Morpheme', isCustom: false },
            { name: 'Word Gloss', scope: 'Word', isCustom: false },
            { name: 'Note', scope: 'Sentence', isCustom: true },
            { name: 'POS', scope: 'Morpheme', isCustom: true },
          ],
          ignoredTokens: {
            mode: 'unicode-punctuation',
            unicodePunctuationExceptions: [],
            explicitIgnoredTokens: [],
          },
        }}
        onSaveChanges={async (data) => saved.push(data.fields.map((f) => f.name))}
        projectId="p1"
      />,
    );
    const names = () =>
      all(r.container, 'tbody tr').map((tr) => tr.querySelectorAll('td')[1].textContent);
    expect(names()).toEqual(['Word Gloss', 'Gloss', 'POS', 'Translation', 'Note']);
    const up = r.container.querySelector('[aria-label="Move Morpheme POS up"]');
    expect(up.disabled).toBe(false);
    await r.step(() => up.click());
    expect(names()).toEqual(['Word Gloss', 'POS', 'Gloss', 'Translation', 'Note']);
    await r.unmount();
  });
});
