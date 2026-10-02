import { describe, it, expect, vi, beforeEach } from 'vitest';
import { MemoryRouter } from 'react-router-dom';
import { renderComponent, byText } from '@ui/test/renderComponent.jsx';

const run = { result: null };
vi.mock('@/export/runExport', () => ({
  ExportCancelled: class ExportCancelled extends Error {},
  runExport: async () => {
    if (run.result instanceof Error) throw run.result;
    return run.result;
  },
}));
const downloads = [];
vi.mock('@/export/files', () => ({ downloadBlob: (name) => downloads.push(name) }));

const { ExportRunner } = await import('./ExportRunner.jsx');

const PROJECT = {
  id: 'p1',
  name: 'P',
  config: {
    igt: { export: { presets: [{ id: 'x', name: 'Archive', format: 'plaid-igt-json' }] } },
  },
};

const mount = () =>
  renderComponent(
    <MemoryRouter>
      <ExportRunner
        client={{}}
        project={PROJECT}
        defaultScope={{ type: 'document', id: 'd1', name: 'D' }}
      />
    </MemoryRouter>,
  );

const exportButton = (root) => byText(root, 'button', 'Export');
const outcome = (root) => root.querySelector('[data-testid="export-outcome"]');

describe('ExportRunner', () => {
  beforeEach(() => {
    downloads.length = 0;
  });

  it('says on the page, until dismissed, that an export failed and nothing was downloaded', async () => {
    run.result = new Error('"EP00" could not be read: Failed to reach the server.');
    const view = await mount();
    await view.step(async () => exportButton(view.container).click());
    expect(downloads).toEqual([]);
    const box = outcome(view.container);
    expect(box.getAttribute('data-tone')).toBe('error');
    expect(box.textContent).toContain('Failed to export');
    expect(box.textContent).toContain('"EP00" could not be read');
    expect(box.textContent).toContain('Nothing was downloaded.');
    await view.step(async () => box.querySelector('button[aria-label="Dismiss"]').click());
    expect(outcome(view.container)).toBeNull();
    await view.unmount();
  });

  it('lists the warnings of a finished export on the page', async () => {
    run.result = { filename: 'D.zip', blob: new Blob([]), warnings: ['one', 'two'] };
    const view = await mount();
    await view.step(async () => exportButton(view.container).click());
    expect(downloads).toEqual(['D.zip']);
    const box = outcome(view.container);
    expect(box.getAttribute('data-tone')).toBe('warning');
    expect(box.textContent).toContain('Downloaded D.zip with 2 warnings');
    expect([...box.querySelectorAll('li')].map((li) => li.textContent)).toEqual(['one', 'two']);
    await view.unmount();
  });
});
