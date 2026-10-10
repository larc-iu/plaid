import { describe, it, expect } from 'vitest';
import {
  atProjectCap,
  chipRemoveLabels,
  couldNotOpen,
  lastProjects,
  namedCitations,
  notThere,
  projectCandidates,
  projectNamesAt,
  projectsToSend,
  reachChanged,
  withProjects,
} from './projectReach.js';
import { linkLabel, linkifyCitations } from './citations.js';
import { conversationToMarkdown } from './exportMarkdown.js';

// A conversation reads its home project and whichever others the reader added.
// The set rides on each user message, and the service reads it off the last one.

const B = { id: 'pB', name: 'Lamkang B' };
const C = { id: 'pC', name: 'Lamkang C' };
const user = (projects, text = 'q') => ({ kind: 'user', text, ...(projects ? { projects } : {}) });
const reply = { kind: 'assistant', text: 'a' };

describe('projectCandidates', () => {
  it('offers every project but the home one and those already added', () => {
    const all = [{ id: 'pA', name: 'Lamkang A' }, B, C, { id: 'pD', name: 'Other' }];
    expect(projectCandidates(all, 'pA', [B]).map((p) => p.id)).toEqual(['pC', 'pD']);
  });

  it('offers nothing before the projects are read', () => {
    expect(projectCandidates(null, 'pA', [])).toEqual([]);
  });
});

describe('atProjectCap', () => {
  // The number the assistant advertises counts the home project.
  it('is full at four others when the assistant reads five', () => {
    expect(atProjectCap([B, C, { id: 'd' }], 5)).toBe(false);
    expect(atProjectCap([B, C, { id: 'd' }, { id: 'e' }], 5)).toBe(true);
  });

  it('never caps an assistant that names no number', () => {
    expect(atProjectCap([B, C], null)).toBe(false);
  });
});

describe('notThere', () => {
  const same = { serviceId: 'igt:assist:one', online: true };
  const why = (found) => notThere(found, 'igt:assist:one', 'IGT Assistant', 'Kalamang');
  it('joins where the same assistant is online', () => {
    expect(why([same])).toBe(null);
    expect(why([{ ...same, runnerName: 'Ana', servesYou: true }])).toBe(null);
  });

  it('refuses where that assistant is offline', () => {
    expect(why([{ ...same, online: false }])).toBe('IGT Assistant is not running in Kalamang.');
  });

  it('refuses where only a different assistant runs', () => {
    expect(why([{ serviceId: 'igt:assist:two', online: true }])).toBe(
      'IGT Assistant is not running in Kalamang.',
    );
  });

  it('refuses where discovery found nothing', () => {
    expect(why([])).toBe('IGT Assistant is not running in Kalamang.');
    expect(why(null)).toBe('IGT Assistant is not running in Kalamang.');
  });

  it('refuses where whoever runs it does not maintain the project', () => {
    expect(why([{ ...same, runnerName: 'Ana', servesYou: false }])).toBe(
      'This assistant is run by Ana, who is not a maintainer of Kalamang.',
    );
  });
});

describe('projectsToSend', () => {
  it('writes the others once each and never the home project', () => {
    expect(projectsToSend([B, { id: 'pA', name: 'Home' }, B, C], 'pA')).toEqual([B, C]);
  });

  it('keeps only the id and the name', () => {
    expect(projectsToSend([{ ...B, extra: 1 }], 'pA')).toEqual([B]);
  });
});

describe('lastProjects', () => {
  it('reads the set off the last user message', () => {
    expect(lastProjects([user([B]), reply, user([B, C]), reply])).toEqual([B, C]);
  });

  it('is empty when the last message carried none, whatever came before', () => {
    expect(lastProjects([user([B]), reply, user(null), reply])).toEqual([]);
  });

  it('is empty for a new conversation', () => {
    expect(lastProjects([])).toEqual([]);
    expect(lastProjects(undefined)).toEqual([]);
  });
});

describe('reachChanged', () => {
  it('marks the first message that reads another project', () => {
    expect(reachChanged([user([B])], 0)).toBe(true);
  });

  it('does not mark a message that reads the same set, in any order', () => {
    const display = [user([B, C]), reply, user([C, B])];
    expect(reachChanged(display, 2)).toBe(false);
  });

  it('marks a message whose set grew', () => {
    const display = [user([B]), reply, user([B, C])];
    expect(reachChanged(display, 2)).toBe(true);
  });

  it('marks a set that comes back after a message without one', () => {
    const display = [user([B]), reply, user(null), reply, user([B])];
    expect(reachChanged(display, 4)).toBe(true);
  });

  it('marks a message whose set emptied, and nothing in a thread that never had one', () => {
    expect(reachChanged([user([B]), reply, user(null)], 2)).toBe(true);
    expect(reachChanged([user([B]), reply, user(null), reply, user([])], 4)).toBe(false);
    expect(reachChanged([user(null)], 0)).toBe(false);
    expect(reachChanged([user(null), reply, user([])], 2)).toBe(false);
  });

  it('marks nothing on a reply', () => {
    expect(reachChanged([user([B]), reply], 1)).toBe(false);
  });
});

describe('the words', () => {
  it('names the projects a message reads', () => {
    expect(withProjects([B, C])).toBe('With Lamkang B, Lamkang C');
  });

  it('names each project that could not be read', () => {
    expect(couldNotOpen([C])).toBe('Lamkang C could not be opened.');
  });
});

// The smallest adapter a citation link reads.
const adapter = {
  CITE_RE: /\{\{[^}]+\}\}/g,
  citationTitle: (c) => c.title,
  citationHref: (origin, projectId, c) => `${origin}/p/${projectId}/${c.documentId}`,
  citationToMarkdown: (c, { origin, projectId }) => `CARD ${origin}/p/${projectId}/${c.documentId}`,
};

describe('a citation into another project', () => {
  const home = { key: '{{here}}', title: 'Here', documentId: 'd1' };
  const there = { key: '{{there}}', title: 'There', documentId: 'd9', projectId: 'pB' };
  const byKey = new Map([
    [home.key, home],
    [there.key, there],
  ]);

  it('links into the project it names, and a home one into home', () => {
    const md = linkifyCitations(adapter, '{{here}} and {{there}}', byKey, {
      origin: 'o',
      projectId: 'pA',
    });
    expect(md).toContain('(o/p/pA/d1)');
    expect(md).toContain('(o/p/pB/d9)');
  });

  it('exports its card linked into that project', () => {
    const conv = {
      display: [
        user([B]),
        { kind: 'assistant', text: 'Compare\n{{there}}\nand {{here}}', citations: [home, there] },
      ],
    };
    const md = conversationToMarkdown(conv, null, { origin: 'o', projectId: 'pA', adapter });
    expect(md).toContain('CARD o/p/pB/d9');
    expect(md).toContain('CARD o/p/pA/d1');
  });
});

describe('the export', () => {
  const ctx = { origin: '', projectId: 'pA', adapter };

  it('names the projects where the set changed, and only there', () => {
    const conv = { display: [user([B], 'one'), reply, user([B], 'two'), reply, user([B, C])] };
    const md = conversationToMarkdown(conv, null, ctx);
    expect(md.match(/\*With Lamkang B\*/g)).toHaveLength(1);
    expect(md).toContain('*With Lamkang B, Lamkang C*');
  });

  it('names the home project alone where the reader removed the others', () => {
    const conv = {
      display: [user([B], 'one'), reply, user(null, 'two'), reply, user(null, 'three')],
    };
    const md = conversationToMarkdown(conv, null, { ...ctx, projectName: 'Lamkang *A*' });
    expect(md.match(/\*Lamkang \\\*A\\\* only\*/g)).toHaveLength(1);
    expect(conversationToMarkdown({ display: [user(null)] }, null, ctx)).not.toContain(' only*');
  });

  it('says which projects a reply could not read', () => {
    const conv = { display: [user([B, C]), { ...reply, unavailableProjects: [C] }] };
    expect(conversationToMarkdown(conv, null, ctx)).toContain('*Lamkang C could not be opened.*');
  });

  // A project is named by whoever made it, so a name can end a link's label,
  // start a link of its own, or break the line into a heading.
  it('writes a project name as one line of literal text', () => {
    const odd = { id: 'x', name: 'B](javascript:alert(1))\n# Heading' };
    const conv = {
      display: [user([odd]), { ...reply, unavailableProjects: [odd] }],
    };
    const md = conversationToMarkdown(conv, null, ctx);
    const escaped = 'B\\]\\(javascript:alert\\(1)) \\# Heading';
    expect(md).toContain(`*With ${escaped}*`);
    expect(md).toContain(`*${escaped} could not be opened.*`);
    expect(md).not.toMatch(/^# Heading/m);
    expect(md).not.toContain('](javascript');
  });

  it('escapes a project name', () => {
    const conv = { display: [user([{ id: 'x', name: 'a*b [c]' }])] };
    expect(conversationToMarkdown(conv, null, ctx)).toContain('*With a\\*b \\[c\\]*');
  });
});

// A citation into another project is titled with that project's name, the
// name the conversation's messages carried as of that turn. Every app titles a
// citation from its document's name, so that is where the project goes.
describe('namedCitations', () => {
  const FSI = String.fromCharCode(0x2068);
  const PDI = String.fromCharCode(0x2069);
  const home = { key: 'h', documentName: 'Text 1', sentence: 3 };
  const there = { key: 't', documentName: 'Text 1', sentence: 3, projectId: 'pB' };

  it('names the project a foreign citation is in, and leaves a home one alone', () => {
    const [h, t] = namedCitations([home, there], 'pA', new Map([['pB', 'Lamkang B']]));
    expect(h).toBe(home);
    expect(t.documentName).toBe(`${FSI}Lamkang B${PDI}: Text 1`);
    expect(t.key).toBe('t');
    expect(there.documentName).toBe('Text 1');
  });

  it('leaves a citation that carries the home project id alone', () => {
    const own = { ...home, projectId: 'pA' };
    expect(namedCitations([own], 'pA', new Map([['pA', 'Lamkang A']]))[0]).toBe(own);
  });

  it('changes nothing in a thread that reads one project', () => {
    const cites = [home];
    expect(namedCitations(cites, 'pA', new Map())).toBe(cites);
    expect(namedCitations(undefined, 'pA', new Map([['pB', 'B']]))).toBeUndefined();
  });

  it('takes each project’s name as of the turn, not a later one', () => {
    const display = [
      user([B], 'one'),
      reply,
      user([{ id: 'pB', name: 'Lamkang North' }], 'two'),
      reply,
    ];
    expect(projectNamesAt(display, 1).get('pB')).toBe('Lamkang B');
    expect(projectNamesAt(display, 3).get('pB')).toBe('Lamkang North');
    expect(projectNamesAt(display, 99).get('pB')).toBe('Lamkang North');
    expect(projectNamesAt([], 0).size).toBe(0);
  });
});

describe('the export of a citation into another project', () => {
  const titled = {
    CITE_RE: /\{\{[^}]*\}\}/g,
    citationTitle: (c) => `${c.documentName}, sentence ${c.sentence}`,
    citationHref: (origin, projectId, c) => `${origin}/p/${projectId}/${c.documentId}`,
    citationToMarkdown: (c, { origin, projectId }) =>
      `**[${linkLabel(`${c.documentName}, sentence ${c.sentence}`)}](${origin}/p/${projectId}/${c.documentId})**`,
  };
  const ctx = { origin: 'o', projectId: 'pA', adapter: titled };
  const home = { key: '{{here}}', documentName: 'Text 1', sentence: 3, documentId: 'd1' };
  const there = { ...home, key: '{{there}}', documentId: 'd9', projectId: 'pB' };
  const strip = (md) => md.replace(/[\u2068\u2069]/g, '');

  it('names the project before the title, in the card and the inline link', () => {
    const conv = {
      display: [
        user([B]),
        {
          kind: 'assistant',
          text: '{{there}}\nand {{here}} and {{there}}',
          citations: [home, there],
        },
      ],
    };
    const md = strip(conversationToMarkdown(conv, null, ctx));
    expect(md).toContain('**[Lamkang B: Text 1, sentence 3](o/p/pB/d9)**');
    expect(md).toContain('[Lamkang B: Text 1, sentence 3](o/p/pB/d9)');
    expect(md).toContain('**[Text 1, sentence 3](o/p/pA/d1)**');
    expect(md).not.toContain('Lamkang B: Text 1, sentence 3](o/p/pA');
  });

  it('writes a one-project thread exactly as before', () => {
    const conv = {
      display: [user(null), { kind: 'assistant', text: '{{here}}', citations: [home] }],
    };
    const md = conversationToMarkdown(conv, null, ctx);
    expect(md).toBe(
      '# Conversation\n\n## You\n\nq\n\n## Assistant\n\n**[Text 1, sentence 3](o/p/pA/d1)**\n',
    );
  });

  it('escapes the project name inside the link label', () => {
    const odd = { id: 'pB', name: 'B](javascript:alert(1))\n# H' };
    const conv = {
      display: [user([odd]), { kind: 'assistant', text: '{{there}}', citations: [there] }],
    };
    const md = strip(conversationToMarkdown(conv, null, ctx));
    expect(md).toContain(
      '**[B\\]\\(javascript:alert\\(1)) \\# H: Text 1, sentence 3](o/p/pB/d9)**',
    );
    expect(md).not.toMatch(/^# H/m);
  });
});

// Two projects may share a name. Their chips' remove buttons are numbered
// only then, so each still has a name of its own.
describe('chipRemoveLabels', () => {
  it('says the name alone where names differ', () => {
    expect(chipRemoveLabels([B, C])).toEqual(['Remove Lamkang B', 'Remove Lamkang C']);
  });

  it('numbers the ones that share a name, in the order shown', () => {
    const twin = { id: 'pB2', name: 'Lamkang B' };
    expect(chipRemoveLabels([B, C, twin])).toEqual([
      'Remove Lamkang B (1)',
      'Remove Lamkang C',
      'Remove Lamkang B (2)',
    ]);
    expect(new Set(chipRemoveLabels([B, twin])).size).toBe(2);
  });

  it('gives nothing for no chips', () => {
    expect(chipRemoveLabels([])).toEqual([]);
  });
});

describe('closedTurns', () => {
  it('names the turns after a message that read a project the viewer cannot open', async () => {
    const { closedTurns } = await import('./projectReach.js');
    const display = [
      { kind: 'user', projects: [{ id: 'p2' }] },
      { kind: 'assistant' },
      { kind: 'error' },
      { kind: 'user' },
      { kind: 'assistant' },
      { kind: 'user', projects: [{ id: 'p3' }] },
      { kind: 'assistant' },
    ];
    const opens = (id) => id === 'p3';
    expect([...closedTurns(display, opens)]).toEqual([1, 2]);
    expect([...closedTurns(display, () => false)]).toEqual([1, 2, 6]);
  });
});
