import { describe, it, expect } from 'vitest';
import { renderComponent, all } from '@ui/test/renderComponent.jsx';
import { FieldsManager } from './FieldsManager';

// H2-IGT-ANALYZE: a field's Tagset picker had no name, so a screen reader read
// only the tagset it shows, with nothing to say which field it is for.
describe('FieldsManager Tagset picker', () => {
  it('names the field it sets the tagset of', async () => {
    const r = await renderComponent(
      <FieldsManager
        initialData={{
          fields: [{ name: 'Gloss', scope: 'Word', isCustom: false }],
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
    expect(all(r.container, '[aria-label="Tagset of Gloss"]')).toHaveLength(1);
    await r.unmount();
  });
});
