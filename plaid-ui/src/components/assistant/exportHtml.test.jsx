import { describe, it, expect, afterEach, vi } from 'vitest';
import { conversationToHtml, leftOutLine, parseTable, prepareExport } from './exportHtml.js';
import { usedCss } from './exportCss.js';
import { ExportMenu } from './ConversationList.jsx';
import { renderComponent } from '../../test/renderComponent.jsx';

// The web page export: one .html file that reads offline, with no script, and
// shows every part of a turn the panel shows.

const HOME = 'p-home';
const OPEN = 'p-open';
const CLOSED = 'p-closed';

const adapter = {
  app: 'igt',
  textName: 'the text',
  CITE_RE: /\{\{[^}]+\}\}/g,
  citationTitle: (c) => c.title,
  citationHref: (_origin, projectId, c) => `#/projects/${projectId}/${c.key}`,
  parseCitationHref: () => null,
  opensProject: () => true,
  groupOf: (_projectId, where) => ({
    key: where?.doc || '-',
    title: where?.doc || 'Elsewhere',
    href: `#/projects/${HOME}/documents/${where?.doc}`,
  }),
  changePlace: (_projectId, where) =>
    where && { name: `s${where.s}`, href: `#/projects/${HOME}/s/${where.s}`, title: 'Open' },
  ExampleCard: ({ c }) => (
    <div data-card={c.key} className="example-card">
      <a href={`#/cards/${c.key}`}>{c.title}</a>
      <button type="button">Tree</button>
      <span dir="rtl">{c.text}</span>
    </div>
  ),
};

const ARABIC = 'ما معنى هذه الجملة؟';

// The conversation's stored rounds (rounds.js), which the steps open to.
const ROUNDS = [
  {
    id: 'r1',
    n: 1,
    asked: 'Gloss the verbs in Text 1.',
    calls: [
      {
        id: 't1',
        name: 'read_document',
        arguments: '{"document": "Text 1"}',
        result: 'Text 1: 12 sentences',
      },
      { id: 't2', name: 'search', arguments: '{"pattern": "x"}', result: 'x'.repeat(9000) },
    ],
  },
  {
    id: 'r2',
    n: 1,
    calls: [
      {
        id: 't3',
        name: 'read_document',
        arguments: '{"document": "B"}',
        result: 'Read from the other project',
      },
    ],
  },
];
const STORED = new Map(ROUNDS.map((r) => [r.id, r]));
const listRounds = vi.fn(async (_user, { prefix }) =>
  prefix.includes(':round:c1:') ? ROUNDS.map((r) => ({ key: `${prefix}${r.id}`, value: r })) : [],
);

const conv = {
  id: 'c1',
  messages: [],
  display: [
    {
      kind: 'user',
      text: 'Gloss the verbs in Text 1.',
      createdAt: '2026-09-01T10:00:00.000Z',
      where: { kind: 'document', id: 'd1', name: 'Text 1' },
      files: [{ id: 'fa', name: 'wordlist.csv', bytes: 2048 }],
    },
    {
      kind: 'assistant',
      model: 'glm-5.2',
      createdAt: '2026-09-01T10:01:00.000Z',
      stepsSummary: 'Read 1 document',
      steps: [
        {
          id: 't1',
          name: 'read_document',
          label: 'Read Text 1',
          round: 'r1',
          said: 'Reading first.',
        },
        { id: 't2', name: 'search', label: 'Searched', round: 'r1' },
      ],
      elapsedMs: 12000,
      contextNote: 'Guidelines: 2 pages',
      text: 'Here is the clearest case:\n\n{{home}}\n\nCompare {{inline}}, and see [the grammar](https://example.org/grammar).',
      citations: [
        { key: '{{home}}', title: 'Text 1, sentence 3', text: 'kitab' },
        { key: '{{inline}}', title: 'Text 1, sentence 4', text: 'qalam' },
      ],
      files: [
        { id: 'fm', name: 'verbs.csv', bytes: 60, made: true, chunks: 1 },
        { id: 'fw', name: 'grammar.pdf', bytes: 90000, source: 'https://example.org/g.pdf' },
      ],
      plan: {
        id: 'pl1',
        summary: '2 glosses',
        opCount: 2,
        changes: [
          { where: { doc: 'Text 1', s: 3 }, change: 'Gloss = eat', label: 's3 Gloss = eat' },
          { where: { doc: 'Text 1', s: 4 }, change: 'Gloss = drink', label: 's4 Gloss = drink' },
        ],
      },
      status: 'applied',
    },
    {
      kind: 'user',
      text: ARABIC,
      createdAt: '2026-09-03T09:00:00.000Z',
      projects: [
        { id: OPEN, name: 'Lamkang B' },
        { id: CLOSED, name: 'Secret corpus' },
      ],
    },
    {
      kind: 'assistant',
      model: 'glm-5.2',
      createdAt: '2026-09-03T09:02:00.000Z',
      stepsSummary: 'Read 1 document',
      steps: [{ id: 't3', name: 'read_document', label: 'Read a document', round: 'r2' }],
      text: 'As in {{closed}} and {{open}}.',
      citations: [
        { key: '{{closed}}', title: 'Hidden, sentence 1', text: 'hidden', projectId: CLOSED },
        { key: '{{open}}', title: 'Lamkang B text, sentence 2', text: 'open', projectId: OPEN },
      ],
      unavailableProjects: [{ id: CLOSED, name: 'Secret corpus' }],
      plan: { id: 'pl2', summary: '1 gloss', opCount: 1, labels: ['s5 Gloss = go'] },
      status: null,
    },
    { kind: 'error', text: 'The assistant stopped answering.', createdAt: '2026-09-03T09:03:00Z' },
  ],
};

const store = {
  client: {
    userData: {
      get: vi.fn(async () => ({ value: 'verb,gloss\r\nakal,"eat, consume"\r\nshirib,drink\r\n' })),
      list: listRounds,
    },
  },
  userId: 'ada@example.com',
  app: 'igt',
  projectId: HOME,
};

// The app's stylesheet, in miniature: a rule the page uses, one it does not,
// a dark variant, a hover state, a web font and an external image.
const APP_CSS = `
:root { --card: 0 0% 100%; }
.dark { --warning: 1 2% 3%; }
.bg-card { background-color: hsl(var(--card)); }
.unused-rule-xyz { color: red; }
.hover\\:bg-muted:hover { background-color: gray; }
.dark\\:prose-invert:is(.dark *) { --tw-prose-body: white; }
.example-card { background-image: url(https://example.org/tile.png); color: blue; }
@font-face { font-family: 'Charis Plaid'; src: url(https://example.org/charis.woff2); }
@media (min-width: 640px) { .bg-card { padding: 1px; } .unused-rule-xyz { padding: 2px; } }
`;

const sheetOf = (css) => {
  const style = document.createElement('style');
  style.textContent = css;
  document.head.append(style);
  return style;
};

const build = (extra = {}) =>
  conversationToHtml(
    conv,
    { title: 'Verbs in Text 1', model: 'glm-5.2' },
    {
      projectId: HOME,
      projectName: 'Lamkang A',
      adapter,
      store,
      readable: new Set([HOME, OPEN]),
      exporter: 'Ada',
      appLabel: 'Plaid IGT',
      sheets: [],
      now: new Date('2026-10-08T12:00:00Z'),
      ...extra,
    },
  );

const parse = (html) => new DOMParser().parseFromString(html, 'text/html');

afterEach(() => {
  for (const s of document.head.querySelectorAll('style')) s.remove();
});

describe('the web page export', () => {
  it('is one file that fetches nothing and needs no script', async () => {
    const style = sheetOf(APP_CSS);
    const html = await build({ sheets: [style.sheet] });
    expect(html.startsWith('<!doctype html>')).toBe(true);
    expect(html).not.toMatch(/<script/i);
    expect(html).not.toMatch(/<link\b/i);
    expect(html).not.toMatch(/\s(src|srcset|action|formaction)=/i);
    expect(html).not.toMatch(/@import/i);
    expect(html).not.toMatch(/\son[a-z]+=/i);
    // The only web addresses are the links the reply made (and their
    // tooltips) and the SVG namespace, and nothing loads a url().
    const withoutLinks = html
      .replace(/(href|title)="https:\/\/example\.org\/[^"]*"/g, '')
      .replaceAll('xmlns="http://www.w3.org/2000/svg"', '');
    expect(withoutLinks).not.toMatch(/https?:/i);
    expect(html).not.toMatch(/url\(\s*['"]?(?!data:|#)/i);
    // No control is left that would do nothing.
    const doc = parse(html);
    expect(doc.querySelectorAll('button, input, select, textarea')).toHaveLength(0);
    // A link into the app is its text: it would open nothing from a file.
    expect([...doc.querySelectorAll('a')].map((a) => a.getAttribute('href')).sort()).toEqual([
      'https://example.org/g.pdf',
      'https://example.org/grammar',
    ]);
  });

  it('carries only the CSS the page uses, with dark mode on the system setting', async () => {
    const style = sheetOf(APP_CSS);
    const css = parse(await build({ sheets: [style.sheet] })).querySelector('style').textContent;
    expect(css).toContain('.bg-card');
    expect(css).not.toContain('unused-rule-xyz');
    expect(css).toContain('.hover\\:bg-muted:hover');
    expect(css).not.toContain('@font-face');
    expect(css).toContain('color: blue');
    // The class the app would set is gone, the rule is under the media query.
    const dark = css.slice(css.indexOf('@media (prefers-color-scheme: dark)'));
    expect(dark).toContain('.dark\\:prose-invert {');
    expect(dark).toContain('--warning: 1 2% 3%');
    expect(css).not.toMatch(/:is\(\.dark \*\)/);
    expect(css).toMatch(/@media \(min-width: 640px\) \{\s*\.bg-card/);
  });

  it('draws every part of a turn', async () => {
    const doc = parse(await build());
    const text = doc.body.textContent;
    // The header.
    expect(doc.title).toBe('Verbs in Text 1');
    expect(doc.querySelector('h1').textContent).toBe('Verbs in Text 1');
    const header = doc.querySelector('.plaid-export-header').textContent;
    expect(header).toContain('Plaid IGT');
    expect(header).toContain('Project: Lamkang A');
    expect(header).toContain('Assistant: glm-5.2');
    expect(header).toContain('Exported by Ada');
    expect(header).toContain(' to ');
    // Messages, the place a question was asked from, an error.
    expect(text).toContain('Gloss the verbs in Text 1.');
    expect(text).toContain('Text 1');
    expect(text).toContain('The assistant stopped answering.');
    expect(text).toContain('Answered in');
    expect(text).toContain('Guidelines: 2 pages');
    // The tool steps fold shut, each step's output under it, a long one cut.
    const trace = [...doc.querySelectorAll('details')].find((d) =>
      d.querySelector('summary').textContent.includes('Read 1 document'),
    );
    expect(trace.hasAttribute('open')).toBe(false);
    expect(trace.textContent).toContain('Text 1: 12 sentences');
    expect(trace.textContent).not.toContain('x'.repeat(5000));
    // The cards: one in place, one folded under the reply.
    expect(doc.querySelector('[data-card="{{home}}"]')).not.toBeNull();
    const fold = [...doc.querySelectorAll('details')].find((d) =>
      d.querySelector('summary').textContent.includes('cited example'),
    );
    expect(fold.querySelector('[data-card="{{inline}}"]')).not.toBeNull();
    // The plans: settled, with the place each change targeted.
    expect(text).toContain('Applied');
    expect(text).toContain('s3');
    expect(text).toContain('Gloss = drink');
    expect(text).toContain('Not approved');
    expect(text).toContain('s5 Gloss = go');
    // Files: the chips with their sizes, and the made table shown in full.
    expect(text).toContain('wordlist.csv');
    expect(text).toContain('2 KB');
    expect(text).toContain('grammar.pdf');
    const table = doc.querySelector('.plaid-export-table');
    expect([...table.querySelectorAll('th')].map((t) => t.textContent)).toEqual(['verb', 'gloss']);
    expect(table.querySelectorAll('tbody tr')).toHaveLength(2);
    expect(table.textContent).toContain('eat, consume');
    // Text in its own direction.
    const asked = [...doc.querySelectorAll('[dir="auto"]')].find((n) => n.textContent === ARABIC);
    expect(asked).toBeTruthy();
    expect(doc.querySelector('[dir="rtl"]')).not.toBeNull();
  });

  it('holds nothing from a project the exporter cannot open, and says what is left out', async () => {
    const doc = parse(await build());
    const text = doc.body.textContent;
    expect(text).not.toContain('Secret corpus');
    expect(text).not.toContain('Hidden, sentence 1');
    expect(text).not.toContain('Read from the other project');
    expect(text).toContain('Another project');
    expect(text).toContain('Lamkang B');
    expect(doc.querySelector('[data-card="{{open}}"]')).not.toBeNull();
    expect(doc.querySelector('.plaid-export-header').textContent).toContain(
      'Not included: 1 cited example from other projects, 1 tool output. 1 long tool output is shortened.',
    );
  });

  it('shows no table made by a turn that read a closed project, only its name', async () => {
    const reading = conv.display.findIndex((d) => d.kind === 'assistant' && d.unavailableProjects);
    const display = conv.display.map((d, i) =>
      i === reading
        ? { ...d, files: [{ id: 'fc', name: 'compared.csv', bytes: 60, made: true, chunks: 1 }] }
        : d,
    );
    const read = vi.fn(async (_user, key) => ({
      value: key.includes(':fc:') ? 'form,gloss\nzz,CLOSED-ROW\n' : 'verb,gloss\nakal,eat\n',
    }));
    const doc = parse(
      await conversationToHtml(
        { ...conv, display },
        { title: 'Verbs in Text 1' },
        {
          projectId: HOME,
          adapter,
          store: { ...store, client: { userData: { get: read, list: listRounds } } },
          readable: new Set([HOME, OPEN]),
        },
      ),
    );
    expect(doc.body.textContent).not.toContain('CLOSED-ROW');
    expect(doc.body.textContent).toContain('compared.csv');
    expect(doc.querySelector('.plaid-export-header').textContent).toContain(
      'the content of compared.csv',
    );
    // The table the first turn made, which read the home project only, is shown.
    expect(doc.querySelector('.plaid-export-table').textContent).toContain('akal');
    expect(
      read.mock.calls.some(([, key]) => key.includes(':fc:')),
      'the closed turn file is never read',
    ).toBe(false);
  });

  it('counts a long tool output left out as left out, not as shortened', () => {
    const stored = new Map([
      [
        'rm',
        {
          id: 'rm',
          calls: Array.from({ length: 300 }, (_, i) => ({ id: `t${i}`, result: 'y'.repeat(9000) })),
        },
      ],
    ]);
    const many = {
      messages: [],
      display: [
        { kind: 'user', text: 'Go.' },
        {
          kind: 'assistant',
          text: 'Done.',
          steps: Array.from({ length: 300 }, (_, i) => ({
            id: `t${i}`,
            label: `Step ${i}`,
            round: 'rm',
          })),
        },
      ],
    };
    const { left } = prepareExport(many, { projectId: HOME, readable: null, stored });
    expect(left.shortened + left.results).toBe(300);
    expect(left.results).toBeGreaterThan(0);
  });

  it('names a made table it does not show', async () => {
    const big = {
      ...conv,
      display: [
        {
          kind: 'assistant',
          text: 'Done.',
          files: [{ id: 'fb', name: 'all.tsv', bytes: 5_000_000, made: true }],
        },
      ],
    };
    const doc = parse(
      await conversationToHtml(big, {}, { projectId: HOME, adapter, store, readable: null }),
    );
    expect(doc.querySelector('.plaid-export-table')).toBeNull();
    expect(doc.body.textContent).toContain('Not included: the content of all.tsv.');
    expect(doc.title).toBe('Conversation');
  });
});

describe('its parts', () => {
  it('reads a CSV and a TSV as the host writes them', () => {
    expect(parseTable('\uFEFFa,b\n"x ""y""","1\n2"\n', 'f.csv')).toEqual({
      header: ['a', 'b'],
      rows: [['x "y"', '1\n2']],
    });
    expect(parseTable('a\tb\nc\td', 'f.tsv')).toEqual({ header: ['a', 'b'], rows: [['c', 'd']] });
  });

  it('leaves a turn that read only open projects whole', () => {
    const { left, results } = prepareExport(conv, {
      projectId: HOME,
      readable: new Set([HOME, OPEN, CLOSED]),
      stored: STORED,
    });
    expect(left).toEqual({ citations: 0, results: 0, shortened: 1 });
    expect(results.get('t3')).toBe('Read from the other project');
    expect(leftOutLine({ citations: 0, results: 0, shortened: 0 }, [])).toBeNull();
  });

  it('keeps a rule for the page root and drops one for nothing on it', () => {
    const style = sheetOf(
      ':root { --x: 1; } .nowhere { color: red; } body::before { content: ""; }',
    );
    const doc = parse('<html><body><p>hi</p></body></html>');
    const css = usedCss([style.sheet], doc);
    expect(css).toContain(':root');
    expect(css).toContain('body::before');
    expect(css).not.toContain('.nowhere');
  });
});

describe('the export menu', () => {
  it('downloads the conversation as a web page', async () => {
    const saved = [];
    const createObjectURL = vi.fn((blob) => {
      saved.push(blob);
      return 'blob:x';
    });
    const realCreate = URL.createObjectURL;
    const realRevoke = URL.revokeObjectURL;
    URL.createObjectURL = createObjectURL;
    URL.revokeObjectURL = () => {};
    const clicked = [];
    const click = vi.spyOn(HTMLAnchorElement.prototype, 'click').mockImplementation(function () {
      clicked.push(this.download);
    });
    const client = {
      projects: { list: vi.fn(async () => [{ id: HOME }]) },
      userData: store.client.userData,
    };
    try {
      const view = await renderComponent(
        <ExportMenu
          conv={conv}
          meta={{ title: 'Verbs in Text 1' }}
          projectId={HOME}
          projectName="Lamkang A"
          adapter={adapter}
          client={client}
          owner="ada@example.com"
        />,
      );
      const trigger = view.container.querySelector('button[title="Export this conversation"]');
      await view.step(() => {
        trigger.dispatchEvent(new PointerEvent('pointerdown', { bubbles: true, button: 0 }));
      });
      const item = [...document.querySelectorAll('[role="menuitem"]')].find((n) =>
        n.textContent.includes('Download as web page'),
      );
      expect(item).toBeTruthy();
      await view.step(async () => {
        item.click();
        await vi.waitFor(() => expect(clicked).toHaveLength(1));
      });
      expect(clicked).toEqual(['verbs-in-text-1.html']);
      expect(saved[0].type).toBe('text/html;charset=utf-8');
      const html = await saved[0].text();
      expect(html).toContain('<h1 dir="auto">Verbs in Text 1</h1>');
      // Only the home project is open to this reader.
      expect(html).not.toContain('Lamkang B text, sentence 2');
      expect(client.projects.list).toHaveBeenCalled();
      await view.unmount();
    } finally {
      click.mockRestore();
      URL.createObjectURL = realCreate;
      URL.revokeObjectURL = realRevoke;
    }
  });
});
