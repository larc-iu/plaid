import { describe, it, expect, vi } from 'vitest';
import { MemoryRouter } from 'react-router-dom';
import { renderComponent } from '@ui/test/renderComponent.jsx';

// The Compare dialog's document picker. Core lists a project's documents in
// plain string order, "(10)" before "(2)", so the picker orders them itself.
// The dialog and the Radix select are stood in for by plain elements: what is
// under test is the order of the choices, not the popover.

const client = {
  projects: {
    listDocuments: async () =>
      ['(1) One', '(10) Ten', '(2) Two', 'This one'].map((name, i) => ({
        id: i === 3 ? 'd1' : `o${i}`,
        name,
      })),
  },
};
vi.mock('@ui/hooks/useDocumentEditor.js', () => ({
  useDocumentEditor: () => ({
    projectId: 'p1',
    documentId: 'd1',
    doc: { name: 'This one', layerInfo: { nodeTokenLayer: { tokens: [] } }, sentences: [] },
    project: { name: 'P' },
    services: { compare: { spot: { empty: true, params: { errors: {} } }, start: () => {} } },
    writeLockHeld: null,
  }),
}));
vi.mock('@ui/hooks/useDocumentTitle.js', () => ({ useDocumentTitle: () => {} }));
vi.mock('@ui/domain/permissions.js', () => ({ canEditProject: () => true }));
vi.mock('../../contexts/AuthContext.jsx', () => ({
  useAuth: () => ({ user: { id: 'u' }, getClient: () => client }),
}));
vi.mock('@ui/components/services/ServiceRunDialog.jsx', () => ({
  ServiceRunDialog: ({ children }) => <div>{children}</div>,
}));
vi.mock('@ui/components/services/ServiceMethodRow.jsx', () => ({ ServiceMethodRow: () => null }));
vi.mock('@ui/components/services/ServiceRunButton.jsx', () => ({ ServiceRunButton: () => null }));
vi.mock('@ui/components/ui/select', () => ({
  Select: ({ children }) => <div>{children}</div>,
  SelectTrigger: () => null,
  SelectValue: () => null,
  SelectContent: ({ children }) => <ul data-testid="choices">{children}</ul>,
  SelectItem: ({ children }) => <li>{children}</li>,
}));

const { CompareEditor } = await import('./CompareEditor.jsx');

describe('CompareEditor document picker', () => {
  it('offers the other documents by name in number order', async () => {
    const r = await renderComponent(
      <MemoryRouter>
        <CompareEditor />
      </MemoryRouter>,
    );
    await r.step(async () => {});
    const choices = [...r.container.querySelectorAll('[data-testid="choices"] li')].map(
      (li) => li.textContent,
    );
    expect(choices).toEqual(['(1) One', '(2) Two', '(10) Ten']);
    await r.unmount();
  });
});
