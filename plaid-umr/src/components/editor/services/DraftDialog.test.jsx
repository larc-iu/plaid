import { describe, it, expect } from 'vitest';
import { renderComponent } from '@ui/test/renderComponent.jsx';
import { DraftDialog } from './DraftDialog.jsx';

const emptySpot = {
  empty: true,
  options: [],
  selection: null,
  choose: () => {},
  service: null,
  builtin: null,
  params: { errors: {} },
  fields: [],
};

describe('DraftDialog', () => {
  // The method row says no service is online, and the dialog's notice said it
  // a second time underneath.
  it.each([
    [false, 'No drafting service is online for this project.'],
    [true, 'Looking for a drafting service.'],
  ])('says once that there is no service (discovering: %s)', async (isDiscovering, line) => {
    const draft = { spot: emptySpot, run: { running: false }, start: () => {}, cancel: () => {} };
    const r = await renderComponent(<DraftDialog draft={draft} isDiscovering={isDiscovering} />);
    const button = [...r.container.querySelectorAll('button')].find(
      (b) => b.textContent.trim() === 'Draft',
    );
    await r.step(() => button.click());
    const dialog = document.querySelector('[role="dialog"]');
    expect(dialog.textContent.split(line).length - 1).toBe(1);
    await r.unmount();
  });
});
