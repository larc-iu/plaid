import { describe, it, expect } from 'vitest';
import { renderComponent, all } from '@ui/test/renderComponent.jsx';
import { FieldsManager } from './FieldsManager';

const mount = (fields) =>
  renderComponent(
    <FieldsManager
      initialData={{
        fields,
        ignoredTokens: {
          mode: 'unicode-punctuation',
          unicodePunctuationExceptions: [],
          explicitIgnoredTokens: [],
        },
      }}
      onSaveChanges={async () => {}}
      projectId="p1"
      tagsetNames={['Leipzig']}
    />,
  );

// H2-IGT-ANALYZE: a field's Tagset picker had no name, so a screen reader read
// only the tagset it shows, with nothing to say which field it is for.
describe('FieldsManager Tagset picker', () => {
  it('names the field it sets the tagset of', async () => {
    const r = await mount([{ name: 'Gloss', scope: 'Word', isCustom: false }]);
    expect(all(r.container, '[aria-label="Tagset of Word Gloss"]')).toHaveLength(1);
    await r.unmount();
  });
});

// HUNT-recent 20: a Word and a Morpheme field of one name had the same
// labels on every control of their rows.
describe('FieldsManager row controls', () => {
  it('name the scope as well as the field', async () => {
    const r = await mount([
      { name: 'Gloss', scope: 'Word', isCustom: false },
      { name: 'Gloss', scope: 'Morpheme', isCustom: false },
    ]);
    const labels = all(r.container, 'tbody [aria-label]').map((n) => n.getAttribute('aria-label'));
    expect(labels).toContain('Language of Morpheme Gloss');
    expect(labels).toContain('Lexicon field of Morpheme Gloss');
    expect(labels).toContain('Tagset of Word Gloss');
    expect(new Set(labels).size).toBe(labels.length);
    await r.unmount();
  });
});
