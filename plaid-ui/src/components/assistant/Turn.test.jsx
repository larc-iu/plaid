import { describe, it, expect } from 'vitest';
import { renderComponent, all, byText } from '../../test/renderComponent.jsx';
import { CitedMarkdown, Turn } from './Turn.jsx';

// The smallest adapter the citation half of a turn reads: a citation is
// `{{key}}`, it is titled and linked by its key, and its card is one div.
const adapter = {
  CITE_RE: /\{\{[^}]+\}\}/g,
  citationTitle: (c) => c.title,
  citationHref: (_origin, projectId, c) => `/p/${projectId}/${c.key}`,
  parseCitationHref: () => null,
  ExampleCard: ({ c }) => <div data-card={c.key}>{c.title}</div>,
};

const citations = [
  { key: '{{one}}', title: 'Text 1, sentence 1' },
  { key: '{{two}}', title: 'Text 1, sentence 2' },
];

const mount = (text) =>
  renderComponent(
    <CitedMarkdown text={text} citations={citations} projectId="p1" adapter={adapter} />,
  );

describe('CitedMarkdown', () => {
  it('folds the cards for inline-only citations away, and counts them', async () => {
    const view = await mount('As in {{one}} and {{two}}, the pattern holds.');
    expect(all(view.container, '[data-card]')).toHaveLength(0);
    const toggle = view.container.querySelector('button');
    expect(toggle.textContent).toContain('2 cited examples');

    await view.step(() => toggle.click());
    expect(all(view.container, '[data-card]').map((n) => n.dataset.card)).toEqual([
      '{{one}}',
      '{{two}}',
    ]);

    await view.step(() => toggle.click());
    expect(all(view.container, '[data-card]')).toHaveLength(0);
    await view.unmount();
  });

  it('says one cited example, not 1 cited examples', async () => {
    const view = await mount('As in {{one}}, the pattern holds.');
    expect(view.container.querySelector('button').textContent).toContain('1 cited example');
    expect(view.container.querySelector('button').textContent).not.toContain('examples');
    await view.unmount();
  });

  // A citation on its own line is a card the model placed in the reply, not a
  // footnote to it: it is drawn where it was written and is not counted below.
  it('leaves a card in the text open, and out of the fold', async () => {
    const view = await mount('The clearest case:\n\n{{one}}\n\nCompare {{two}}.');
    expect(all(view.container, '[data-card]').map((n) => n.dataset.card)).toEqual(['{{one}}']);
    expect(view.container.querySelector('button').textContent).toContain('1 cited example');

    await view.step(() => view.container.querySelector('button').click());
    expect(all(view.container, '[data-card]').map((n) => n.dataset.card)).toEqual([
      '{{one}}',
      '{{two}}',
    ]);
    await view.unmount();
  });

  it('has no fold when nothing was cited inline', async () => {
    const view = await mount('No citations here.');
    expect(view.container.querySelector('button')).toBeNull();
    expect(byText(view.container, 'div', 'cited example')).toBeNull();
    await view.unmount();
  });
});

// A conversation may read other projects beside its own. The set is named on a
// message only where it changed, a reply says which projects it could not read,
// and a citation into another project is drawn and linked there.
describe('Turn and the other projects', () => {
  const B = { id: 'pB', name: 'Lamkang B' };
  const C = { id: 'pC', name: 'Lamkang C' };
  const cardAdapter = {
    ...adapter,
    ExampleCard: ({ c, projectId }) => <div data-card={c.key} data-project={projectId} />,
  };
  const draw = (item, extra = {}) =>
    renderComponent(
      <Turn
        item={item}
        projectId="pA"
        adapter={cardAdapter}
        results={new Map()}
        movedHere={false}
        {...extra}
      />,
    );

  it('names the projects a message reads where the set changed', async () => {
    const view = await draw(
      { kind: 'user', text: 'compare', projects: [B, C] },
      { reachChanged: true },
    );
    expect(view.container.textContent).toContain('With Lamkang B, Lamkang C');
    await view.unmount();
  });

  it('says nothing where the set is the one before', async () => {
    const view = await draw(
      { kind: 'user', text: 'again', projects: [B] },
      { reachChanged: false },
    );
    expect(view.container.textContent).not.toContain('With');
    await view.unmount();
  });

  it('names under a reply each project it could not read', async () => {
    const view = await draw({ kind: 'assistant', text: 'Here.', unavailableProjects: [C] });
    expect(view.container.textContent).toContain('Lamkang C could not be opened.');
    await view.unmount();
  });

  it('draws and links a citation into the project it names', async () => {
    const cites = [
      { key: '{{here}}', title: 'Here' },
      { key: '{{there}}', title: 'There', projectId: 'pB' },
    ];
    const view = await draw({
      kind: 'assistant',
      text: '{{there}}\n\nCompare {{here}} and {{there}}.',
      citations: cites,
    });
    expect(view.container.querySelector('[data-card="{{there}}"]').dataset.project).toBe('pB');
    const hrefs = all(view.container, 'a').map((a) => decodeURIComponent(a.getAttribute('href')));
    expect(hrefs).toContain('/p/pB/{{there}}');
    expect(hrefs).toContain('/p/pA/{{here}}');
    // The inline-only card, unfolded, is the home project's.
    await view.step(() => byText(view.container, 'button', 'cited example').click());
    expect(view.container.querySelector('[data-card="{{here}}"]').dataset.project).toBe('pA');
    await view.unmount();
  });
});
