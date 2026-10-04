import { describe, it, expect, vi, afterEach } from 'vitest';
import { renderComponent, byText } from '../../test/renderComponent.jsx';
import { RestoreDialog } from './RestoreDialog.jsx';

// In strict mode the dry run carries the document version the page last read.
// On a stale page it is refused with a 409, and the dialog used to stop there
// for good: nothing reloaded, so every retry sent the same stale version. A
// 409 now reloads the document (onRestored) and asks again.

const conflict = () => new Error('HTTP 409 Document version mismatch at http://x/y');
const summary = { name: true };
const entry = { time: '2026-09-01T00:00:00.000000001Z', label: 'Set a span' };

const mount = (client, onRestored, raw = {}) =>
  renderComponent(
    <RestoreDialog
      open
      onOpenChange={() => {}}
      client={client}
      documentId="d1"
      raw={raw}
      roleWords={{}}
      entry={entry}
      onRestored={onRestored}
    />,
  );

const settle = async (view) => {
  for (let i = 0; i < 5; i++) await view.step(() => new Promise((r) => setTimeout(r, 0)));
};

let view;
afterEach(async () => {
  await view?.unmount();
  view = null;
});

describe('RestoreDialog', () => {
  it('reloads and runs the dry run again when the page is stale', async () => {
    const restore = vi.fn().mockRejectedValueOnce(conflict()).mockResolvedValueOnce(summary);
    const onRestored = vi.fn().mockResolvedValue(undefined);
    view = await mount({ documents: { restore } }, onRestored);
    await settle(view);

    expect(onRestored).toHaveBeenCalledTimes(1);
    expect(restore).toHaveBeenCalledTimes(2);
    expect(restore.mock.calls[1]).toEqual(['d1', entry.time, { dryRun: true }]);
    expect(byText(document.body, 'li', 'The document name')).not.toBeNull();
    expect(byText(document.body, 'p', 'Changed elsewhere')).toBeNull();
    const button = byText(document.body, 'button', 'Restore');
    expect(button.disabled).toBe(false);
  });

  it('shows the error when the dry run is refused again after the reload', async () => {
    const restore = vi.fn().mockRejectedValue(conflict());
    const onRestored = vi.fn().mockResolvedValue(undefined);
    view = await mount({ documents: { restore } }, onRestored);
    await settle(view);

    expect(onRestored).toHaveBeenCalledTimes(1);
    expect(restore).toHaveBeenCalledTimes(2);
    expect(byText(document.body, 'p', 'Changed elsewhere')).not.toBeNull();
  });

  it('does not reload on a dry run that fails for another reason', async () => {
    const restore = vi.fn().mockRejectedValue(new Error('HTTP 500 boom at http://x/y'));
    const onRestored = vi.fn();
    view = await mount({ documents: { restore } }, onRestored);
    await settle(view);

    expect(onRestored).not.toHaveBeenCalled();
    expect(restore).toHaveBeenCalledTimes(1);
  });

  it('reads the changes again after a refused restore, which reloads the page', async () => {
    const restore = vi
      .fn()
      .mockResolvedValueOnce(summary) // dry run
      .mockRejectedValueOnce(conflict()) // the restore
      .mockResolvedValueOnce({ texts: { inserted: 1 } }); // dry run after the reload
    const onRestored = vi.fn().mockResolvedValue(undefined);
    const audit = vi.fn().mockResolvedValue([]);
    view = await mount({ documents: { restore, audit } }, onRestored);
    await settle(view);
    expect(byText(document.body, 'li', 'The document name')).not.toBeNull();

    await view.step(() => byText(document.body, 'button', 'Restore').click());
    await settle(view);

    expect(onRestored).toHaveBeenCalledTimes(1);
    expect(restore).toHaveBeenCalledTimes(3);
    expect(restore.mock.calls[2]).toEqual(['d1', entry.time, { dryRun: true }]);
    expect(byText(document.body, 'li', 'The document name')).toBeNull();
    expect(byText(document.body, 'li', 'The text')).not.toBeNull();
  });

  it('heads each kind of change, and says a recording added since is not changed', async () => {
    const restore = vi.fn().mockResolvedValue({ texts: { inserted: 1 }, name: true });
    const audit = vi.fn().mockResolvedValue([
      {
        time: '2026-09-02T00:00:00.000000000Z',
        ops: [{ type: 'media/upload', time: '2026-09-02T00:00:00.000000000Z' }],
      },
    ]);
    view = await mount({ documents: { restore, audit } }, vi.fn(), { mediaUrl: '/m?v=2' });
    await settle(view);

    expect(audit).toHaveBeenCalledWith('d1', entry.time, undefined, [
      'media/upload',
      'media/delete',
    ]);
    expect(byText(document.body, 'p', 'Brought back')).not.toBeNull();
    expect(byText(document.body, 'p', 'Changed back')).not.toBeNull();
    expect(byText(document.body, 'p', 'Removed')).toBeNull();
    expect(byText(document.body, 'p', 'The recording is not changed.')).not.toBeNull();
  });

  it('says a recording deleted since cannot come back', async () => {
    const restore = vi.fn().mockResolvedValue({ name: true });
    const audit = vi.fn().mockResolvedValue([
      {
        time: '2026-09-02T00:00:00.000000000Z',
        ops: [{ type: 'media/delete', time: '2026-09-02T00:00:00.000000000Z' }],
      },
    ]);
    view = await mount({ documents: { restore, audit } }, vi.fn(), {});
    await settle(view);

    expect(byText(document.body, 'li', 'The deleted recording cannot come back.')).not.toBeNull();
    expect(byText(document.body, 'p', 'The recording is not changed.')).toBeNull();
  });
});
