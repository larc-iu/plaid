import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { MemoryRouter, Routes, Route } from 'react-router-dom';
import { renderComponent, byText } from '../../test/renderComponent.jsx';
import { configureUi } from '../../lib/uiConfig.js';

// The setup page plaid-ud and plaid-umr share, over plain data in place of an
// app's setup.

const auth = vi.hoisted(() => ({ getClient: vi.fn(), user: { id: 'u' } }));
vi.mock('../../contexts/useAuth.js', () => ({ useAuth: () => auth }));
vi.mock('../../lib/notify.js', () => ({
  notifySuccess: vi.fn(),
  notifyError: vi.fn(),
  notifyWarning: vi.fn(),
}));

const { ProjectSetupPage } = await import('./ProjectSetupPage.jsx');

const project = (over = {}) => ({ id: 'p1', name: 'Ay', maintainers: ['u'], ...over });

const SETUP = {
  app: 'XY',
  adopt: vi.fn(async () => {
    throw new Error('half done');
  }),
  missingLabels: (info) => info.missing,
  allSet: 'Every XY layer is set up.',
  card: { title: 'XY layers', body: 'Added beside the text.', layers: <li>Nodes</li> },
  blocked: (info, projectId, p) =>
    p.blocked ? { title: 'No text to annotate', body: 'Make text first.' } : null,
  unfinished: (p) => !!p.unfinished,
};

const layerInfo = (p) => ({ isConfigured: !!p?.done, missing: p?.done ? [] : ['Nodes'] });

const mount = async (reads) => {
  const get = vi.fn(async () => reads.shift() ?? reads.at(-1));
  auth.getClient.mockReturnValue({ projects: { get } });
  const view = await renderComponent(
    <MemoryRouter initialEntries={['/projects/p1/configuration']}>
      <Routes>
        <Route
          path="/projects/:projectId/configuration"
          element={<ProjectSetupPage layerInfo={layerInfo} setup={SETUP} />}
        />
      </Routes>
    </MemoryRouter>,
  );
  await view.step(() => new Promise((r) => setTimeout(r, 0)));
  return { view, get };
};

// What the igt suite this runs under configures, put back after.
const RESTORE = { appPrefix: 'plaid_igt', configNamespace: 'igt', appName: 'Plaid IGT' };
beforeEach(() => configureUi({ ...RESTORE, appRoutes: { documents: (id) => `/docs/${id}` } }));
afterEach(() => configureUi(RESTORE));

describe('ProjectSetupPage', () => {
  it('says what is missing and offers the button', async () => {
    const { view } = await mount([project()]);
    expect(view.container.textContent).toContain('Missing: Nodes');
    expect(byText(view.container, 'button', 'Set up for XY')).toBeTruthy();
    await view.unmount();
  });

  it('shows what the app cannot make in place of the button', async () => {
    const { view } = await mount([project({ blocked: true })]);
    expect(view.container.textContent).toContain('No text to annotate');
    expect(byText(view.container, 'button', 'Set up for XY')).toBeFalsy();
    await view.unmount();
  });

  it('reads the project again after a setup that failed part way', async () => {
    const { view, get } = await mount([project(), project({ done: true })]);
    await view.step(() => byText(view.container, 'button', 'Set up for XY').click());
    await view.step(() => new Promise((r) => setTimeout(r, 0)));
    expect(get).toHaveBeenCalledTimes(2);
    expect(view.container.textContent).toContain('Every XY layer is set up.');
    await view.unmount();
  });

  // REV-FIX5 M2: the layers landed and a later step did not, so the project
  // reads as set up, and the button stays to finish it.
  it('offers to finish a set-up that stopped after the layers', async () => {
    const { view } = await mount([project({ done: true, unfinished: true })]);
    expect(view.container.textContent).toContain('The last set-up stopped before it finished.');
    expect(view.container.textContent).not.toContain('Every XY layer is set up.');
    expect(byText(view.container, 'button', 'Finish setting up for XY')).toBeTruthy();
    await view.unmount();
  });

  it('offers no button once every layer is set up', async () => {
    const { view } = await mount([project({ done: true })]);
    expect(view.container.textContent).toContain('Every XY layer is set up.');
    expect(view.container.querySelector('button')).toBeFalsy();
    await view.unmount();
  });

  it('sends a writer back to the documents', async () => {
    const { view } = await mount([project({ maintainers: [], writers: ['u'] })]);
    expect(view.container.textContent).toContain(
      'Only a project maintainer can set a project up for XY.',
    );
    expect(view.container.querySelector('a').getAttribute('href')).toBe('/docs/p1');
    await view.unmount();
  });
});
