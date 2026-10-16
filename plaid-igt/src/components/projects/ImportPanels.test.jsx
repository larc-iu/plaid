import { describe, it, expect, vi } from 'vitest';
import { MemoryRouter } from 'react-router-dom';
import { renderComponent, all } from '@ui/test/renderComponent.jsx';
import { FileDropZone, Panel, WarningLog, ImportRunPanel } from './ImportPanels.jsx';
import { NewProjectChooser } from './NewProjectChooser.jsx';

// The wizards' boxed notices wear the shared Notice tones, so a warning in an
// import reads like a warning anywhere else, and the amber of a contributor's
// value in the Analyze grid is never borrowed for one.

describe('the import wizards’ notices', () => {
  it('draws warnings, errors and results in the shared tones', async () => {
    const view = await renderComponent(
      <div>
        <Panel tone="warning" title="Finish the mapping" />
        <Panel tone="error" title="Failed to import" />
        <Panel tone="success" title="Import complete" />
        <Panel title="Plain" />
      </div>,
    );
    const toned = all(view.container, '[data-tone]');
    expect(toned.map((n) => [n.getAttribute('data-tone'), n.textContent])).toEqual([
      ['warning', 'Finish the mapping'],
      ['error', 'Failed to import'],
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
  it('uses the shared breadcrumb, which leads back to Projects', async () => {
    const view = await renderComponent(
      <MemoryRouter>
        <NewProjectChooser />
      </MemoryRouter>,
    );
    const nav = view.container.querySelector('nav[aria-label="Breadcrumb"]');
    expect(all(nav, 'a').map((a) => [a.textContent, a.getAttribute('href')])).toEqual([
      ['Projects', '/projects'],
    ]);
    await view.unmount();
  });
});

// The wizards' drop box is the one every app's import screens share: a stop
// in the tab order that Enter opens the picker from, given the dropped files.
describe('the import wizards’ drop box', () => {
  const dropOn = (el, files) => {
    const e = new Event('drop', { bubbles: true, cancelable: true });
    e.dataTransfer = { files };
    el.dispatchEvent(e);
  };

  it('opens its own picker from the keyboard and takes a drop', async () => {
    const onFiles = vi.fn();
    const view = await renderComponent(
      <FileDropZone onFiles={onFiles} title="Drop a .zip here" hint="hint" accept=".zip" />,
    );
    const zone = view.container.querySelector('[role="button"]');
    expect(zone.tabIndex).toBe(0);
    const input = view.container.querySelector('input[type="file"]');
    expect(input.accept).toBe('.zip');
    const clicked = vi.spyOn(input, 'click').mockImplementation(() => {});
    await view.step(() =>
      zone.dispatchEvent(new KeyboardEvent('keydown', { key: 'Enter', bubbles: true })),
    );
    expect(clicked).toHaveBeenCalledTimes(1);
    const f = new File(['x'], 'a.zip');
    await view.step(() => dropOn(zone, [f]));
    expect(onFiles).toHaveBeenCalledWith([f]);
    await view.unmount();
  });

  it('with the page’s own picker, holds its button and is no button itself', async () => {
    const onChoose = vi.fn();
    const view = await renderComponent(
      <FileDropZone onFiles={() => {}} hint="hint" onChoose={onChoose} chooseLabel="Choose" />,
    );
    expect(view.container.querySelector('[role="button"]')).toBeNull();
    expect(view.container.querySelector('input[type="file"]')).toBeNull();
    const button = [...view.container.querySelectorAll('button')].find(
      (b) => b.textContent === 'Choose',
    );
    await view.step(() => button.click());
    expect(onChoose).toHaveBeenCalledTimes(1);
    await view.unmount();
  });
});
