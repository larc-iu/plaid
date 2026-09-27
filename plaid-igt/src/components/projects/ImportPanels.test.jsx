import { describe, it, expect } from 'vitest';
import { MemoryRouter } from 'react-router-dom';
import { renderComponent, all } from '@ui/test/renderComponent.jsx';
import { Panel, WarningLog, ImportRunPanel } from './ImportPanels.jsx';
import { NewProjectChooser } from './NewProjectChooser.jsx';

// The wizards' boxed notices wear the shared Notice tones, so a warning in an
// import reads like a warning anywhere else, and the amber of a contributor's
// value in the Analyze grid is never borrowed for one.

describe('the import wizards’ notices', () => {
  it('draws warnings, errors and results in the shared tones', async () => {
    const view = await renderComponent(
      <div>
        <Panel tone="warning" title="Finish the mapping" />
        <Panel tone="error" title="Import failed" />
        <Panel tone="success" title="Import complete" />
        <Panel title="Plain" />
      </div>,
    );
    const toned = all(view.container, '[data-tone]');
    expect(toned.map((n) => [n.getAttribute('data-tone'), n.textContent])).toEqual([
      ['warning', 'Finish the mapping'],
      ['error', 'Import failed'],
      ['success', 'Import complete'],
    ]);
    // No hand-mixed amber anywhere in the box.
    expect(view.container.innerHTML).not.toMatch(/amber-|green-\d/);
    await view.unmount();
  });

  it('puts the warning log and a failed run in those tones', async () => {
    const view = await renderComponent(
      <div>
        <WarningLog log={[{ text: 'Word "Dog" capitalised.', document: 'a.eaf' }]} />
        <ImportRunPanel stage="review" runError="Could not reach the server" />
      </div>,
    );
    expect(all(view.container, '[data-tone]').map((n) => n.getAttribute('data-tone'))).toEqual([
      'warning',
      'error',
    ]);
    await view.unmount();
  });
});

describe('the new project chooser', () => {
  it('uses the shared breadcrumb, its own page dark and not a link', async () => {
    const view = await renderComponent(
      <MemoryRouter>
        <NewProjectChooser />
      </MemoryRouter>,
    );
    const nav = view.container.querySelector('nav[aria-label="Breadcrumb"]');
    expect(all(nav, 'a').map((a) => [a.textContent, a.getAttribute('href')])).toEqual([
      ['Projects', '/projects'],
    ]);
    expect(nav.querySelector('[aria-current="page"]').textContent).toBe('New Project');
    await view.unmount();
  });
});
