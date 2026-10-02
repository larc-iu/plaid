import { describe, it, expect } from 'vitest';
import { renderComponent, all } from '@ui/test/renderComponent.jsx';
import { ParseDialog } from './ParseDialog.jsx';

// With no parsing service online, the dialog said so twice: once as its notice
// and once in the method row, in the same words.

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
const parse = { spot: emptySpot, run: { running: false }, start: () => {}, cancel: () => {} };

const openDialog = async (props) => {
  const view = await renderComponent(<ParseDialog parse={parse} writeLockHeld={null} {...props} />);
  const button = all(view.container, 'button').find((b) => b.textContent.includes('Parse'));
  await view.step(() => button.click());
  return view;
};

const count = (needle) => document.body.textContent.split(needle).length - 1;

describe('the Parse dialog', () => {
  it('says once that no parsing service is online', async () => {
    const view = await openDialog({ isDiscovering: false });
    expect(count('No parsing service is online')).toBe(1);
    await view.unmount();
  });

  it('says once that it is looking for one', async () => {
    const view = await openDialog({ isDiscovering: true });
    expect(count('Looking for a parsing service')).toBe(1);
    await view.unmount();
  });

  // Q2-UD-POLISH-6: a parser that came online after the page loaded stayed
  // "not online" until a reload, since services were looked for once.
  it('looks for services again each time it opens', async () => {
    let looked = 0;
    const view = await openDialog({ isDiscovering: false, onOpen: () => (looked += 1) });
    expect(looked).toBe(1);
    await view.unmount();
  });
});
