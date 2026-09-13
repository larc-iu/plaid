import { describe, it, expect } from 'vitest';
import { renderComponent } from '../test/renderComponent.jsx';

import { useDocumentTitle } from './useDocumentTitle.js';

const Titled = ({ segments }) => {
  useDocumentTitle(...segments);
  return null;
};

describe('useDocumentTitle', () => {
  it('ends the title with the app the entry point named', async () => {
    const { unmount } = await renderComponent(<Titled segments={['Analyze', 'A text']} />);
    expect(document.title).toBe('Analyze · A text · Plaid IGT');
    await unmount();
    expect(document.title).toBe('Plaid IGT');
  });

  it('drops the segments a screen has not loaded yet', async () => {
    const { unmount } = await renderComponent(<Titled segments={[null, 'Projects', undefined]} />);
    expect(document.title).toBe('Projects · Plaid IGT');
    await unmount();
  });
});
