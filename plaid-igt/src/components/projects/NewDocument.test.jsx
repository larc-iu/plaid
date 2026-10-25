import { describe, it, expect, vi } from 'vitest';
import { MemoryRouter, Route, Routes, useLocation } from 'react-router-dom';
import { renderComponent, byText } from '@ui/test/renderComponent.jsx';

// New document makes the document alone and opens it on Baseline. Its text
// is made by the first write that needs one (A3-8), so nothing after the
// create can fail and leave the dialog open, where Create again made a second
// document (REV2-idempotency).
const feedback = vi.hoisted(() => ({ notifySuccess: vi.fn(), notifyError: vi.fn() }));
vi.mock('@/utils/feedback', () => feedback);
const { NewDocument } = await import('./NewDocument.jsx');

const type = (input, value) => {
  const setter = Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, 'value').set;
  setter.call(input, value);
  input.dispatchEvent(new Event('input', { bubbles: true }));
};

const Where = ({ onAt }) => {
  onAt(useLocation().pathname);
  return null;
};

describe('New document', () => {
  it('makes the document and no text, and opens it', async () => {
    const client = {
      documents: { create: vi.fn(async (_p, _n, _m, _a, { id }) => ({ id })) },
      projects: { get: vi.fn() },
      texts: { create: vi.fn() },
    };
    let at = null;
    const v = await renderComponent(
      <MemoryRouter initialEntries={['/projects/p1']}>
        <Routes>
          <Route
            path="*"
            element={
              <>
                <NewDocument projectId="p1" client={client} canManage={false} />
                <Where onAt={(p) => (at = p)} />
              </>
            }
          />
        </Routes>
      </MemoryRouter>,
    );
    await v.step(() => byText(v.container, 'button', 'New document').click());
    await v.step(() => type(document.body.querySelector('#doc-name'), 'Story'));
    await v.step(async () => {
      byText(document.body, 'button', 'Create').click();
    });
    await v.step(async () => {});
    const made = client.documents.create.mock.calls[0][4].id;
    expect(client.documents.create).toHaveBeenCalledTimes(1);
    expect(client.texts.create).not.toHaveBeenCalled();
    expect(client.projects.get).not.toHaveBeenCalled();
    expect(at).toBe(`/projects/p1/documents/${made}`);
    expect(feedback.notifyError).not.toHaveBeenCalled();
    expect(document.body.querySelector('#doc-name')).toBe(null);
    await v.unmount();
  });
});
