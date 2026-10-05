import { describe, it, expect } from 'vitest';
import { renderComponent, all, byText } from '../../test/renderComponent.jsx';
import { CitedMarkdown, Turn } from './Turn.jsx';
import { couldNotOpen, withProjects } from './projectReach.js';

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

  it('names the home project alone where the reader removed the others', async () => {
    const view = await draw(
      { kind: 'user', text: 'just here' },
      { reachChanged: true, homeName: 'Lamkang A' },
    );
    expect(view.container.textContent).toContain('Lamkang A only');
    expect(view.container.textContent).not.toContain('With');
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

  // Two projects may each hold a "Text 1", so a card and a link into another
  // project say which. Every app titles a citation from its document's name.
  const titledAdapter = {
    ...adapter,
    citationTitle: (c) => `${c.documentName}, sentence ${c.sentence}`,
    ExampleCard: ({ c }) => (
      <div data-card={c.key}>{`${c.documentName}, sentence ${c.sentence}`}</div>
    ),
  };
  const isolates = /[\u2068\u2069]/g;
  const titled = [
    { key: '{{here}}', documentName: 'Text 1', sentence: 3 },
    { key: '{{there}}', documentName: 'Text 1', sentence: 3, projectId: 'pB' },
  ];

  it('names the other project before the title of a card and a link into it', async () => {
    const view = await draw(
      {
        kind: 'assistant',
        text: '{{there}}\n\nCompare {{here}} and {{there}}.',
        citations: titled,
      },
      { adapter: titledAdapter, citeNames: new Map([['pB', 'Lamkang B']]) },
    );
    const card = (key) =>
      view.container.querySelector(`[data-card="${key}"]`).textContent.replace(isolates, '');
    expect(card('{{there}}')).toBe('Lamkang B: Text 1, sentence 3');
    const links = all(view.container, 'a').map((a) => a.textContent.replace(isolates, ''));
    expect(links).toEqual(['Text 1, sentence 3', 'Lamkang B: Text 1, sentence 3']);
    await view.step(() => byText(view.container, 'button', 'cited example').click());
    expect(card('{{here}}')).toBe('Text 1, sentence 3');
    await view.unmount();
  });

  it('draws a one-project reply exactly as before', async () => {
    const item = { kind: 'assistant', text: 'See {{here}}.', citations: [titled[0]] };
    const before = await draw(item, { adapter: titledAdapter });
    // The mark's clip-path id is React's own, one per mount.
    const markup = (v) => v.container.innerHTML.replace(/_r_\w+_/g, 'ID');
    const html = markup(before);
    await before.unmount();
    const after = await draw(item, { adapter: titledAdapter, citeNames: new Map() });
    expect(markup(after)).toBe(html);
    expect(html).not.toMatch(isolates);
    await after.unmount();
  });
});

// A project's name is data, in whatever script it was written in. Each name is
// isolated, so two Arabic names in a row are not read as one right-to-left run
// that puts the second first, and a long name wraps rather than running off
// the message.
describe('Turn and the names of other projects', () => {
  const R1 = { id: 'r1', name: 'مدونة الحجاز' };
  const R2 = { id: 'r2', name: 'نصوص نجد' };
  const draw = (item, extra = {}) =>
    renderComponent(
      <Turn
        item={item}
        projectId="pA"
        adapter={adapter}
        results={new Map()}
        movedHere={false}
        {...extra}
      />,
    );
  const isolated = (container) => all(container, 'bdi').map((n) => n.textContent);

  it('isolates each name in the "With" line, which may wrap', async () => {
    const view = await draw(
      { kind: 'user', text: 'compare', projects: [R1, R2] },
      { reachChanged: true },
    );
    expect(isolated(view.container)).toEqual([R1.name, R2.name]);
    const line = view.container.querySelector('bdi').parentElement;
    // The words the export writes.
    expect(line.textContent).toBe(withProjects([R1, R2]));
    expect(line.className).toContain('[overflow-wrap:anywhere]');
    await view.unmount();
  });

  it('isolates each name in the could-not-open line, which may wrap', async () => {
    const view = await draw({ kind: 'assistant', text: 'Here.', unavailableProjects: [R1, R2] });
    expect(isolated(view.container)).toEqual([R1.name, R2.name]);
    const line = view.container.querySelector('bdi').parentElement;
    expect(line.textContent).toBe(couldNotOpen([R1, R2]));
    expect(line.className).toContain('[overflow-wrap:anywhere]');
    await view.unmount();
  });

  it('isolates the place a message was asked from, which may wrap', async () => {
    const view = await draw(
      { kind: 'user', text: 'here', where: { kind: 'document', id: 'd', name: R1.name } },
      { movedHere: true },
    );
    expect(isolated(view.container)).toEqual([R1.name]);
    expect(view.container.querySelector('bdi').parentElement.className).toContain(
      '[overflow-wrap:anywhere]',
    );
    await view.unmount();
  });
});

describe('Turn and what a reply kept', () => {
  it('shows a PDF the reply fetched as a chip that links to where it came from', async () => {
    const view = await renderComponent(
      <Turn
        item={{
          kind: 'assistant',
          text: 'Section 9 says...',
          files: [
            {
              id: 'f1',
              name: 'grammar.pdf',
              bytes: 130000,
              lines: 1900,
              chunks: 1,
              source: 'https://repo.example/grammar.pdf',
            },
          ],
        }}
        projectId="pA"
        adapter={adapter}
        results={new Map()}
        movedHere={false}
      />,
    );
    const link = view.container.querySelector('a[href="https://repo.example/grammar.pdf"]');
    expect(link).not.toBeNull();
    expect(link.textContent).toContain('grammar.pdf');
    expect(link.textContent).toContain('130 KB');
    await view.unmount();
  });
});
