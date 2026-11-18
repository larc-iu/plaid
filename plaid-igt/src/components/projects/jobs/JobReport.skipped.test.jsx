import { describe, it, expect } from 'vitest';
import { MemoryRouter } from 'react-router-dom';
import { renderComponent } from '@ui/test/renderComponent.jsx';
import { SkippedDocument } from './JobReport.jsx';

// D11 (JR2's page half, REV-JOIN18-10): a document's sentences too long for a
// job past its skipped list are said under it, apart from the skipped ones.
describe('a document’s skipped sentences', () => {
  it('says the too-long sentences past its list, and a document with only overflow', async () => {
    const d = {
      documentId: 'd1',
      name: 'Story A',
      skipped: [{ sentence: 's1', sentenceId: 'sen1', reason: 'too-long' }],
      counts: { skippedMore: 2, tooLongMore: 3 },
    };
    const v = await renderComponent(
      <MemoryRouter>
        <SkippedDocument d={d} projectId="p1" />
        <SkippedDocument
          d={{ documentId: 'd2', name: 'Story B', counts: { tooLongMore: 1 } }}
          projectId="p1"
        />
      </MemoryRouter>,
    );
    const t = v.container.textContent;
    expect(t).toContain('And 2 more skipped.');
    expect(t).toContain('And 3 more too long.');
    expect(t).toContain('And 1 more too long.');
    await v.unmount();
  });
});
