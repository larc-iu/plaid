import { describe, it, expect } from 'vitest';
import { renderComponent } from '../../test/renderComponent.jsx';
import { HistoricalBanner } from './HistoricalBanner.jsx';

// The line over a document at a past state. It is never a fault, so it is
// never drawn in a warm tone: a red or amber banner means something is broken.

const entry = { id: 'e1', time: '2026-11-16T10:00:00Z' };
const box = (view) => view.container.firstElementChild;

describe('HistoricalBanner', () => {
  it('says the document is read-only as plain information', async () => {
    const view = await renderComponent(<HistoricalBanner entry={entry} />);
    expect(box(view).textContent).toContain('Read-only. This is the document as of');
    expect(box(view).getAttribute('data-tone')).toBe('info');
  });

  it('keeps the same tone while the past document loads', async () => {
    const view = await renderComponent(<HistoricalBanner entry={entry} loading />);
    expect(box(view).textContent).toContain('Loading the document as of');
    expect(box(view).getAttribute('data-tone')).toBe('info');
  });

  it('draws nothing without an entry', async () => {
    const view = await renderComponent(<HistoricalBanner entry={null} />);
    expect(view.container.firstElementChild).toBeNull();
  });
});
