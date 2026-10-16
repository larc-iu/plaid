import { describe, it, expect, vi } from 'vitest';
import { MemoryRouter } from 'react-router-dom';
import { renderComponent, all } from '@ui/test/renderComponent.jsx';

vi.mock('@/contexts/AuthContext', () => ({ useAuth: () => ({ user: { id: 'u1' } }) }));
const { ProjectBulkEdit } = await import('./ProjectBulkEdit.jsx');

// The activity rides in `?op=` beside `?tab=bulk`, and the triggers are real
// links, so each one's href has to reproduce the page it lands on.

const PROJECT = {
  id: 'p1',
  textLayers: [
    {
      id: 'tl',
      config: { plaid: { role: 'baseline' } },
      tokenLayers: [{ id: 'wl', config: { plaid: { role: 'word' } }, spanLayers: [] }],
    },
  ],
};

const mount = (url) =>
  renderComponent(
    <MemoryRouter initialEntries={[url]}>
      <ProjectBulkEdit project={PROJECT} projectId="p1" client={{}} />
    </MemoryRouter>,
  );

const hrefs = (container) =>
  all(container, 'a[role="tab"], [role="tablist"] a').map((a) => a.getAttribute('href'));

describe('ProjectBulkEdit', () => {
  it('keeps the tab it is inside in every activity href', async () => {
    const { container, unmount } = await mount('/projects/p1?tab=bulk');
    const links = hrefs(container);
    expect(links.length).toBeGreaterThan(1);
    for (const href of links) expect(href).toContain('tab=bulk');
    await unmount();
  });

  // Hand-built, the href named `?tab=bulk&op=` and nothing else, so
  // middle-clicking an activity threw away whatever else the reader had in the
  // address bar. The setter had always kept it.
  it('keeps the rest of the query string too', async () => {
    const { container, unmount } = await mount('/projects/p1?tab=bulk&q=hello&match=exact');
    for (const href of hrefs(container)) {
      expect(href).toContain('q=hello');
      expect(href).toContain('match=exact');
    }
    await unmount();
  });

  it('writes no op for the activity that is the default', async () => {
    const { container, unmount } = await mount('/projects/p1?tab=bulk');
    const respell = hrefs(container)[0];
    expect(respell).not.toContain('op=');
    await unmount();
  });
});

// Validation's "Fix in Bulk Edit" names the field and the value in the link,
// and the field replace opens with them filled in.
describe('ProjectBulkEdit, a link that fills in the field replace', () => {
  const WITH_GLOSS = {
    ...PROJECT,
    textLayers: [
      {
        ...PROJECT.textLayers[0],
        tokenLayers: [
          {
            id: 'wl',
            config: { plaid: { role: 'word' } },
            spanLayers: [
              { id: 'g1', name: 'Gloss', config: { igt: { scope: 'Word' } } },
              { id: 'g2', name: 'Note', config: { igt: { scope: 'Word' } } },
            ],
          },
        ],
      },
    ],
  };
  const open = (url) =>
    renderComponent(
      <MemoryRouter initialEntries={[url]}>
        <ProjectBulkEdit project={WITH_GLOSS} projectId="p1" client={{}} />
      </MemoryRouter>,
    );
  const inputs = (c) => all(c, 'input').map((i) => i.value);

  it('fills in the field, the value and the replacement', async () => {
    const { container, unmount } = await open(
      '/projects/p1?tab=bulk&op=field&in=span%3Ag2&q=1SG.ABL&match=exact&repl=%E2%88%85',
    );
    expect(container.textContent).toContain('Note (word)');
    expect(container.textContent).toContain('is exactly');
    expect(inputs(container)).toEqual(expect.arrayContaining(['1SG.ABL', '\u2205']));
    await unmount();
  });

  it('opens empty without them', async () => {
    const { container, unmount } = await open('/projects/p1?tab=bulk&op=field');
    expect(container.textContent).toContain('Gloss (word)');
    expect(container.textContent).toContain('contains');
    expect(inputs(container).every((v) => v === '')).toBe(true);
    await unmount();
  });
});
