import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { MemoryRouter, Routes, Route } from 'react-router-dom';
import { renderComponent } from '@ui/test/renderComponent.jsx';

// The skipped list names one document per row and prints its reason verbatim,
// so a raw client message puts the request URL and the document id it carried
// in front of whoever ran the export. `humanizeError` is the one place an
// error becomes a sentence, and this row walked past it.

vi.mock('./ProjectTabs.jsx', () => ({ ProjectTabs: () => null }));
vi.mock('../../domain/ConlluDocument.js', () => ({
  ConlluDocument: {
    load: async () => {
      throw Object.assign(
        new Error('HTTP 503 Service Unavailable at http://localhost:8085/api/v1/documents/d1'),
        { status: 503 },
      );
    },
  },
}));
vi.mock('../../utils/feedback.jsx', async () => {
  const { humanizeError } = await import('@ui/lib/errors.js');
  return {
    notifySuccess: vi.fn(),
    notifyError: vi.fn(),
    notifyWarning: vi.fn(),
    humanizeError,
  };
});

const auth = vi.hoisted(() => ({
  getClient: vi.fn(),
  logout: vi.fn(),
  user: { id: 'u', isAdmin: true },
}));
vi.mock('../../contexts/AuthContext.jsx', () => ({ useAuth: () => auth }));

const { ProjectImportExport } = await import('./ProjectImportExport.jsx');

const app = (
  <MemoryRouter initialEntries={['/projects/A/import-export']}>
    <Routes>
      <Route path="/projects/:projectId/import-export" element={<ProjectImportExport />} />
    </Routes>
  </MemoryRouter>
);

beforeEach(() => {
  auth.getClient.mockReturnValue({
    projects: {
      get: async () => ({ id: 'A', name: 'Ay', maintainers: ['u'], writers: [], readers: [] }),
      listDocuments: async () => [{ id: 'd1', name: 'Doc one' }],
    },
  });
  vi.spyOn(console, 'error').mockImplementation(() => {});
});

afterEach(() => {
  vi.restoreAllMocks();
});

const settle = () => new Promise((r) => setTimeout(r, 0));

describe('the skipped-document rows after an export', () => {
  it('say what went wrong without quoting the request', async () => {
    const view = await renderComponent(app);
    await view.step(settle);

    const button = [...view.container.querySelectorAll('button')].find(
      (b) => b.textContent.trim() === 'Export',
    );
    expect(button).not.toBe(undefined);
    await view.step(async () => {
      button.dispatchEvent(new MouseEvent('click', { bubbles: true }));
      await settle();
      await settle();
    });

    const row = view.container.querySelector('li')?.textContent ?? '';
    expect(row).toBe('Doc one: Could not reach the server. Check your connection and try again.');
    await view.unmount();
  });
});
