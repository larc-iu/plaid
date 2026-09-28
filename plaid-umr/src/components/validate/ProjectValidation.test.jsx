import { describe, it, expect, vi } from 'vitest';
import { MemoryRouter } from 'react-router-dom';
import { renderComponent, texts, byText } from '@ui/test/renderComponent.jsx';

// The Validation tab shows the temporal contradictions one stated relation
// sets off as one row, counted, with the list under it on request.

const project = { name: 'P' };
const client = {};
vi.mock('@ui/hooks/useManagedProject.js', () => ({
  useManagedProject: () => ({ project, projectId: 'p1', loading: false, canConfigure: true }),
}));
vi.mock('@ui/hooks/useDocumentTitle.js', () => ({ useDocumentTitle: () => {} }));
vi.mock('../../contexts/AuthContext.jsx', () => ({
  useAuth: () => ({ user: null, getClient: () => client }),
}));
vi.mock('../projects/ProjectTabs.jsx', () => ({ ProjectTabs: () => null }));
vi.mock('../../utils/umrLayerUtils.js', () => ({
  getUmrLayerInfo: () => ({ isConfigured: true, conceptLayer: null, wordTokenLayer: null }),
}));
const details = ['Contradiction 1.', 'Contradiction 2.', 'Contradiction 3.'];
vi.mock('../../domain/validationQueries.js', () => ({
  validateProject: async () => [
    {
      documentId: 'd1',
      documentName: 'Timeline',
      sentenceIndex: 4,
      level: 'error',
      code: 'temporal-mismatch',
      message: '3 contradictions follow from the temporal relation (s4y :before s1x).',
      var: 's4y',
      details,
    },
    {
      documentId: 'd1',
      documentName: 'Timeline',
      sentenceIndex: 5,
      level: 'error',
      code: 'unreached',
      message: 'Not reached.',
      var: null,
    },
  ],
}));

const { ProjectValidation } = await import('./ProjectValidation.jsx');

describe('ProjectValidation', () => {
  it('lists the contradictions under their row only when it is opened', async () => {
    const r = await renderComponent(
      <MemoryRouter>
        <ProjectValidation />
      </MemoryRouter>,
    );
    await r.step(async () => {});
    expect(texts(r.container, 'li')).toEqual([]);
    const show = byText(r.container, 'button', 'Show list');
    expect(show).not.toBeNull();
    expect(show.getAttribute('aria-expanded')).toBe('false');
    // A row with no list has no toggle.
    expect(texts(r.container, 'button').filter((t) => t === 'Show list')).toHaveLength(1);
    await r.step(() => show.click());
    expect(texts(r.container, 'li')).toEqual(details);
    const hide = byText(r.container, 'button', 'Hide list');
    expect(hide.getAttribute('aria-expanded')).toBe('true');
    await r.step(() => hide.click());
    expect(texts(r.container, 'li')).toEqual([]);
    await r.unmount();
  });
});
