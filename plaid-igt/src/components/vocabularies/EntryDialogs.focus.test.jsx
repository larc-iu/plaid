import { describe, it, expect, afterEach } from 'vitest';
import { renderComponent, all } from '@ui/test/renderComponent.jsx';
import { EntryDialogs } from './EntryDialogs';

// Delete entry asked again on a new count (links out of sight, or links that
// changed while it was open) starts on Cancel, as the first question does.
// In the browser a refusal that comes back while the dialog is still closing
// reopens the same content with focus left on Delete entry, so a second
// Enter confirmed the larger count unread (REV-W-VOCAB D2). Here the dialog
// stays mounted and focus is put on Delete entry by hand, which is the state
// the browser is in.

const dog = { id: 'e1', form: 'dog' };
const props = (over = {}) => ({
  dialog: { kind: 'delete' },
  dispatch: () => {},
  selectedItem: dog,
  usageCounts: { e1: 1 },
  deleteRefPatches: [],
  deleteFreesSenses: false,
  onConfirmDelete: () => {},
  ...over,
});
const button = (label) => all(document.body, 'button').find((b) => b.textContent.trim() === label);

let r = null;
const mount = async (element) => (r = await renderComponent(element));
afterEach(async () => {
  await r?.unmount();
  r = null;
});

describe('Delete entry asked again', () => {
  it('moves focus to Cancel when the server gives a larger count', async () => {
    await mount(<EntryDialogs {...props()} />);
    button('Delete entry').focus();
    expect(document.activeElement.textContent.trim()).toBe('Delete entry');
    await r.rerender(<EntryDialogs {...props({ deleteHidden: { total: 2, hidden: 1 } })} />);
    expect(document.activeElement.textContent.trim()).toBe('Cancel');
    expect(document.body.textContent).toContain('1 of them in projects you cannot open');
  });

  it('moves focus to Cancel when the links changed while it was open', async () => {
    await mount(<EntryDialogs {...props()} />);
    button('Delete entry').focus();
    await r.rerender(<EntryDialogs {...props({ deleteLinksChanged: true })} />);
    expect(document.activeElement.textContent.trim()).toBe('Cancel');
  });

  it('still names the entry while the entry is closed under it', async () => {
    await mount(<EntryDialogs {...props()} />);
    await r.rerender(<EntryDialogs {...props({ selectedItem: null })} />);
    expect(document.body.textContent).toContain('"dog"');
  });
});

describe('Delete entry', () => {
  it('names a homonym with its number', async () => {
    await mount(<EntryDialogs {...props({ numbers: new Map([['e1', '2']]) })} />);
    const sub = document.body.querySelector('[role="alertdialog"] sub');
    expect(sub?.textContent).toBe('2');
    expect(sub.parentElement.textContent).toBe('dog2');
  });

  it('puts focus in the entry list when what opened it is gone', async () => {
    const opener = document.createElement('button');
    const row = document.createElement('a');
    row.href = '#';
    document.body.append(opener, row);
    opener.focus();
    const focusAfterClose = () => {
      row.focus();
      return true;
    };
    await mount(<EntryDialogs {...props({ dialog: null, focusAfterClose })} />);
    await r.rerender(<EntryDialogs {...props({ focusAfterClose })} />);
    expect(document.activeElement.textContent.trim()).toBe('Cancel');
    opener.remove();
    await r.rerender(<EntryDialogs {...props({ dialog: null, focusAfterClose })} />);
    await r.step(async () => {
      for (let i = 0; i < 3; i++) await new Promise((res) => setTimeout(res, 0));
    });
    expect(document.activeElement).toBe(row);
    row.remove();
  });
});
