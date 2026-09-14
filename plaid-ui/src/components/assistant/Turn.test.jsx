import { describe, it, expect } from 'vitest';
import { renderComponent, all, byText } from '../../test/renderComponent.jsx';
import { CitedMarkdown } from './Turn.jsx';

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
