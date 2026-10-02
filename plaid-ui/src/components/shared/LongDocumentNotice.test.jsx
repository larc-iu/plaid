import { describe, it, expect } from 'vitest';
import { renderComponent } from '../../test/renderComponent.jsx';
import { LongDocumentNotice } from './LongDocumentNotice.jsx';
import { LONG_DOCUMENT_WORDS } from '../../domain/longDocument.js';

// Luke's ruling (2026-10-02): a document too long to edit quickly is not
// engineered for, its editor says to split it.
describe('LongDocumentNotice', () => {
  it('shows over a document past the limit, with its count, and not at or under it', async () => {
    const long = await renderComponent(<LongDocumentNotice words={21817} />);
    expect(long.container.textContent).toContain('Long document');
    expect(long.container.textContent).toContain(`${(21817).toLocaleString()} words.`);
    expect(long.container.textContent).toContain('Split it into shorter documents.');
    await long.unmount();
    for (const words of [LONG_DOCUMENT_WORDS, 378, undefined]) {
      const view = await renderComponent(<LongDocumentNotice words={words} />);
      expect(view.container.textContent).toBe('');
      await view.unmount();
    }
  });
});
