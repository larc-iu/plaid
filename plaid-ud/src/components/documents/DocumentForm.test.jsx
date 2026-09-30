import { describe, it, expect, vi } from 'vitest';
import { MemoryRouter } from 'react-router-dom';
import { renderComponent } from '@ui/test/renderComponent.jsx';
import { DocumentForm } from './DocumentForm.jsx';

// REV-idempotency F4: the form kept the id of a create whose answer was lost
// for as long as the list was mounted, so a DIFFERENT document made later
// from the same list opened the first one and was never made. The id is kept
// only for one name in one opening of the dialog.

const create = vi.fn();
vi.mock('../../contexts/AuthContext', () => ({
  useAuth: () => ({ getClient: () => ({ documents: { create } }) }),
}));

const lost = () =>
  Object.assign(new Error('Request timed out at http://x/api/v1/documents'), {
    status: 0,
    method: 'POST',
  });

const type = (input, text) => {
  const setter = Object.getOwnPropertyDescriptor(window.HTMLInputElement.prototype, 'value').set;
  setter.call(input, text);
  input.dispatchEvent(new Event('input', { bubbles: true }));
};

const mount = (isOpen) =>
  renderComponent(
    <MemoryRouter>
      <DocumentForm projectId="p1" isOpen={isOpen} onClose={() => {}} />
    </MemoryRouter>,
  );

const submit = async (step, name) => {
  await step(() => type(document.querySelector('#document-name'), name));
  await step(() =>
    document
      .querySelector('form')
      .dispatchEvent(new Event('submit', { bubbles: true, cancelable: true })),
  );
};

const idOf = (call) => call.at(-1).id;

describe('the new-document form after a create whose answer was lost', () => {
  it('names the same id when Create is pressed again for the same name', async () => {
    create.mockReset();
    create.mockRejectedValueOnce(lost()).mockResolvedValueOnce({ id: 'x' });
    const { step, unmount } = await mount(true);
    await submit(step, 'Alpha');
    await step(() =>
      document
        .querySelector('form')
        .dispatchEvent(new Event('submit', { bubbles: true, cancelable: true })),
    );
    expect(create).toHaveBeenCalledTimes(2);
    expect(idOf(create.mock.calls[1])).toBe(idOf(create.mock.calls[0]));
    await unmount();
  });

  it('names a new id once the name changes', async () => {
    create.mockReset();
    create.mockRejectedValueOnce(lost()).mockResolvedValueOnce({ id: 'x' });
    const { step, unmount } = await mount(true);
    await submit(step, 'Alpha');
    await submit(step, 'Beta');
    expect(create).toHaveBeenCalledTimes(2);
    expect(idOf(create.mock.calls[1])).not.toBe(idOf(create.mock.calls[0]));
    await unmount();
  });

  it('names a new id once the dialog was closed and opened again', async () => {
    create.mockReset();
    create.mockRejectedValueOnce(lost()).mockResolvedValueOnce({ id: 'x' });
    const view = await renderComponent(
      <MemoryRouter>
        <DocumentForm projectId="p1" isOpen onClose={() => {}} />
      </MemoryRouter>,
    );
    await submit(view.step, 'Alpha');
    await view.step(() =>
      view.rerender(
        <MemoryRouter>
          <DocumentForm projectId="p1" isOpen={false} onClose={() => {}} />
        </MemoryRouter>,
      ),
    );
    await view.step(() =>
      view.rerender(
        <MemoryRouter>
          <DocumentForm projectId="p1" isOpen onClose={() => {}} />
        </MemoryRouter>,
      ),
    );
    await view.step(() =>
      document
        .querySelector('form')
        .dispatchEvent(new Event('submit', { bubbles: true, cancelable: true })),
    );
    expect(create).toHaveBeenCalledTimes(2);
    expect(idOf(create.mock.calls[1])).not.toBe(idOf(create.mock.calls[0]));
    await view.unmount();
  });
});
