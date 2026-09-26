import { describe, it, expect, vi } from 'vitest';
import { renderComponent } from '@ui/test/renderComponent.jsx';
import { AnnotationSettings } from './AnnotationSettings.jsx';

// The off-tagset badge on a field row counts the values the Analyze grid would
// flag, so a morpheme field's values are read by their morpheme's morph type.

const fieldsSettings = vi.hoisted(() => ({ props: null }));
vi.mock('./FieldsSettings.jsx', () => ({
  FieldsSettings: (props) => {
    fieldsSettings.props = props;
    return null;
  },
}));
vi.mock('./TagsetsSettings.jsx', () => ({ TagsetsSettings: () => null }));
vi.mock('./DocumentMetadataSettings.jsx', () => ({ DocumentMetadataSettings: () => null }));

const project = {
  id: 'p-1',
  config: {
    igt: {
      tagsets: { Leipzig: { delimiters: '.:', mode: 'mixed', values: [{ value: '3' }] } },
    },
  },
  textLayers: [
    {
      id: 'tl-1',
      config: { plaid: { role: 'baseline' } },
      tokenLayers: [
        {
          id: 'ml-1',
          config: { plaid: { role: 'morpheme' } },
          spanLayers: [
            { id: 'msl', name: 'Gloss', config: { igt: { scope: 'Morpheme', tagset: 'Leipzig' } } },
          ],
        },
      ],
    },
  ],
};

describe('the off-tagset badge', () => {
  it("counts a suffix's sbj:3.pfv and not a stem's", async () => {
    const client = {
      // The unlinked morphemes' rows, and none linked to an entry.
      query: vi.fn(async (q) => ({
        results: q.where.some((c) => c[0] === 'vocab-link')
          ? []
          : [
              ['sbj:3.pfv', 'suffix', 'ti', 4],
              ['pass:3', 'stem', 'ka', 2],
              ['pass:3', 'suffix', 'ku', 1],
            ],
      })),
    };
    const { step, unmount } = await renderComponent(
      <AnnotationSettings project={project} projectId="p-1" client={client} />,
    );
    await step(async () => {});
    expect(fieldsSettings.props.violations).toEqual({ 'morpheme:Gloss': 2 });
    await unmount();
  });
});
