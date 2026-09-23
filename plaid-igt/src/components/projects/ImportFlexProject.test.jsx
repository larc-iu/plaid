import { describe, it, expect, vi } from 'vitest';
import { MemoryRouter } from 'react-router-dom';
import { renderComponent } from '@ui/test/renderComponent.jsx';

// A resumed import locks its review to the first run's answers. Reading the
// file again ("Choose another file") must give the same answers again, not
// the defaults: locked, the defaults could not be unticked, and the resume
// would import every text the first run left out.

const auth = vi.hoisted(() => ({ client: {}, user: { id: 'u', isAdmin: true } }));
vi.mock('../../contexts/AuthContext', () => ({ useAuth: () => auth }));

const TEXT = (n) => `
  <interlinear-text guid="bbbbbbbb-0000-0000-0000-00000000000${n}">
    <item type="title" lang="xx">Text ${n}</item>
    <paragraphs><paragraph><phrases><phrase><words>
      <word><item type="txt" lang="xx">dogs</item><item type="gls" lang="en">dogs</item><item type="gls" lang="fr">chiens</item></word>
      <word><item type="txt" lang="xx">run</item><item type="gls" lang="en">run</item><item type="gls" lang="fr">courent</item></word>
    </words></phrase></phrases></paragraph></paragraphs>
    <languages><language lang="xx" vernacular="true"/><language lang="en"/><language lang="fr"/></languages>
  </interlinear-text>`;
const FLEXTEXT = `<?xml version="1.0" encoding="utf-8"?><document version="2">${TEXT(1)}${TEXT(2)}${TEXT(3)}</document>`;

const RECORD = {
  kind: 'FLEx .flextext',
  source: 'three.flextext',
  vocabId: null,
  choices: {
    texts: ['bbbbbbbb-0000-0000-0000-000000000002'],
    analysisWss: ['en'],
    posWs: null,
    lexiconFields: [],
    orthoNames: {},
    importVariants: false,
  },
};
vi.mock('@/hooks/useResumeImport', () => ({
  useResumeImport: () => ({
    resumeId: 'p1',
    resumeName: 'Three',
    resumeProject: { id: 'p1', name: 'Three', vocabs: [], config: { igt: { import: RECORD } } },
    finishAsIs: () => {},
  }),
}));

const { ImportFlexProject } = await import('./ImportFlexProject.jsx');

const pick = async (view) => {
  const input = view.container.querySelector('input[type="file"]');
  const file = new File([FLEXTEXT], 'three.flextext', { type: 'text/xml' });
  Object.defineProperty(input, 'files', { value: [file], configurable: true });
  await view.step(async () => {
    input.dispatchEvent(new Event('change', { bubbles: true }));
    // The reader yields 50ms before parsing, so the spinner can paint.
    await new Promise((r) => setTimeout(r, 120));
  });
};

const ticked = (view) => {
  const boxes = [...view.container.querySelectorAll('label')]
    .filter((l) => l.querySelector('input[type="checkbox"]'))
    .map((l) => ({ text: l.textContent, on: l.querySelector('input').checked }));
  return boxes.filter((b) => b.on).map((b) => b.text.replace(/\s+/g, ' ').trim());
};

describe('ImportFlexProject on a resume', () => {
  it('gives every read of the file the first run’s answers', async () => {
    const view = await renderComponent(
      <MemoryRouter>
        <ImportFlexProject format="flextext" />
      </MemoryRouter>,
    );
    await pick(view);
    const first = ticked(view);
    expect(first.some((t) => t.startsWith('Text 2'))).toBe(true);
    expect(first.some((t) => t.startsWith('Text 1') || t.startsWith('Text 3'))).toBe(false);
    expect(first).toContain('en');
    expect(first).not.toContain('fr');

    const again = [...view.container.querySelectorAll('button')].find(
      (b) => b.textContent === 'Choose another file',
    );
    await view.step(async () => again.click());
    await pick(view);
    expect(ticked(view)).toEqual(first);
    expect(view.container.textContent).toContain('1 of 3 selected');
    await view.unmount();
  });
});
